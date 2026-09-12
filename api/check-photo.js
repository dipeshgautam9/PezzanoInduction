// api/check-photo.js
// Handles two modes:
//   1. Quality check  — compares staff photo against reference good/reject photos
//   2. Identify mode  — finds which product a staff photo matches from a candidate list
//
// Supports both key formats:
//   AIzaSy... → Google AI Studio API key (query param ?key=)
//   AQ.       → OAuth2 Bearer token     (Authorization: Bearer header)

const MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-001',
  'gemini-1.5-flash-002',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-1.5-pro-001',
  'gemini-1.5-pro-002',
];

// Build the correct URL and headers based on key type
function geminiUrl(model, apiKey) {
  if (apiKey.startsWith('AQ.') || apiKey.startsWith('ya29.')) {
    // OAuth2 Bearer token — key goes in Authorization header, not URL
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }
    };
  }
  // Standard API key — goes in query string
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    headers: { 'Content-Type': 'application/json' }
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel environment variables.' });

  const {
    staffPhoto, product,
    referenceGoodUrl, referenceRejectUrl, textOnlyMode,
    identifyMode, identifyCandidates   // ← new identify-mode fields
  } = req.body || {};

  if (!staffPhoto) return res.status(400).json({ error: 'A staff photo is required.' });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function splitDataUrl(dataUrl) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) return null;
    return { mimeType: match[1], base64: match[2] };
  }

  async function resizeBase64(mimeType, base64, maxDim = 1024) {
    try {
      const sharp = (await import('sharp').catch(() => null))?.default;
      if (!sharp) return { mimeType, base64 };
      const buf = Buffer.from(base64, 'base64');
      const resized = await sharp(buf)
        .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      return { mimeType: 'image/jpeg', base64: resized.toString('base64') };
    } catch { return { mimeType, base64 }; }
  }

  async function urlToBase64(url) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) { console.error(`urlToBase64 HTTP ${resp.status}`); return null; }
      const buf = await resp.arrayBuffer();
      const mimeType = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0];
      return { mimeType, base64: Buffer.from(buf).toString('base64') };
    } catch (e) { console.error('urlToBase64:', e?.message); return null; }
  }

  async function callGemini(parts, maxTokens = 400) {
    const errors = [];
    for (const model of MODELS) {
      let r;
      try {
        r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts }],
              generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens }
            }),
            signal: AbortSignal.timeout(25000)
          }
        );
      } catch (e) { errors.push(`${model}: ${e?.message}`); continue; }
      if (r.status === 404) { errors.push(`${model}: 404`); continue; }
      if (r.status === 429) { errors.push(`${model}: 429 quota`); continue; }
      console.log(`check-photo: using ${model} HTTP ${r.status}`);
      return { response: r, model };
    }
    console.error('check-photo: ALL models failed. Key prefix:', apiKey.substring(0, 8), '| Errors:', errors.join(' | '));
    return { response: null };
  }
  async function callGemini(parts, maxTokens = 400) {
    const errors = [];
    for (const model of MODELS) {
      const { url, headers } = geminiUrl(model, apiKey);
      let r;
      try {
        r = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens }
          }),
          signal: AbortSignal.timeout(25000)
        });
      } catch (e) { errors.push(`${model}: ${e?.message}`); continue; }
      if (r.status === 404) { errors.push(`${model}: 404`); continue; }
      if (r.status === 429) { errors.push(`${model}: 429 quota`); continue; }
      if (r.status === 401) { errors.push(`${model}: 401 auth`); continue; }
      console.log(`check-photo: using ${model} HTTP ${r.status} keyType=${apiKey.substring(0,3)}`);
      return { response: r, model };
    }
    console.error('check-photo: ALL models failed. Key prefix:', apiKey.substring(0, 8), '| Errors:', errors.join(' | '));
    return { response: null };
  }

  function parseJSON(raw) {
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(raw); } catch { return null; }
  }

  // ── MODE 1: Identify product from photo ─────────────────────────────────
  // Two-step approach to avoid timeout with large product libraries:
  // Step 1 — Gemini looks at the staff photo and picks the most likely CATEGORY
  //           from a text list (fast, no images needed, <2s)
  // Step 2 — Only fetch + send reference images for that category (typically
  //           5-20 products instead of 96), then do a real visual comparison
  //           This keeps the request well under Vercel's 30s limit.

  if (identifyMode) {
    if (!identifyCandidates?.length) {
      return res.status(400).json({ error: 'No candidate products provided.' });
    }

    const staffImgRaw = splitDataUrl(staffPhoto);
    if (!staffImgRaw) return res.status(400).json({ error: 'Photo format not readable.' });
    const staffImg = await resizeBase64(staffImgRaw.mimeType, staffImgRaw.base64, 900);

    // ── Step 1: Guess category from the photo (text-only, fast) ──────────
    const categories = [...new Set(identifyCandidates.map(c => c.category).filter(Boolean))];
    let filteredCandidates = identifyCandidates;

    if (categories.length > 1) {
      try {
        const catParts = [
          {
            text: `Look at this product photo. Which ONE category from the list below best describes what you see?
Categories: ${categories.join(', ')}
Return ONLY the exact category name as plain text — nothing else.`
          },
          { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } }
        ];

        const { response: catRes } = await callGemini(catParts, 30);
        if (catRes && catRes.ok) {
          const catData = await catRes.json();
          const guessedCat = catData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
          console.log('identify step1 category guess:', guessedCat);
          // Match the guess against known categories (case-insensitive partial match)
          const matched = categories.find(c =>
            c.toLowerCase() === guessedCat.toLowerCase() ||
            guessedCat.toLowerCase().includes(c.toLowerCase()) ||
            c.toLowerCase().includes(guessedCat.toLowerCase())
          );
          if (matched) {
            const inCat = identifyCandidates.filter(c => c.category === matched);
            if (inCat.length > 0 && inCat.length < identifyCandidates.length) {
              console.log(`identify: narrowed from ${identifyCandidates.length} to ${inCat.length} (${matched})`);
              filteredCandidates = inCat;
            }
          }
        }
      } catch (e) {
        console.warn('identify step1 category guess failed, using all:', e?.message);
        // Continue with all candidates — step 2 will still work, just slower
      }
    }

    // ── Step 2: Visual comparison against the filtered candidate set ──────
    // Fetch reference images in parallel, max 20 to stay under token/time limit
    const toFetch = filteredCandidates.slice(0, 20);
    const refResults = await Promise.all(
      toFetch.map(async c => {
        if (!c.referenceUrl) return null;
        const img = await urlToBase64(c.referenceUrl);
        if (!img) return null;
        const resized = await resizeBase64(img.mimeType, img.base64, 480);
        return { id: c.id, name: c.name, category: c.category || '', img: resized };
      })
    );
    const refs = refResults.filter(Boolean);

    if (!refs.length) {
      return res.status(502).json({ error: 'Could not load reference photos. Check your connection and try again.' });
    }

    console.log(`identify step2: visual compare against ${refs.length} products`);

    const parts = [
      {
        text: `You are a product identification assistant for Pezzano Enterprises warehouse in Perth, WA.

A warehouse staff member has taken a photo of a product. Identify WHICH product it is by visually comparing the staff photo against each reference photo below.

Look at: shape, colour, size, texture, packaging, labels, visible text.

CANDIDATES (${refs.length} products):
${refs.map((r, i) => `${i + 1}. Name: "${r.name}" | ID: "${r.id}"`).join('\n')}

Rules:
- Compare the STAFF PHOTO carefully against EACH reference photo shown below.
- Return ONLY valid JSON, no markdown, no extra text.
- If confident match (>35%): {"productId":"<exact id>","productName":"<exact name>","confidence":0.0-1.0}
- If no match: {"productId":null,"productName":null,"confidence":0}

STAFF PHOTO (identify this):`
      },
      { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } },
      { text: '--- REFERENCE PHOTOS ---' }
    ];

    for (const ref of refs) {
      parts.push({ text: `"${ref.name}" (ID: ${ref.id})` });
      parts.push({ inline_data: { mime_type: ref.img.mimeType, data: ref.img.base64 } });
    }

    try {
      const { response: geminiRes } = await callGemini(parts, 120);

      if (!geminiRes) {
        return res.status(502).json({
          error: `AI service unavailable. Make sure GEMINI_API_KEY in Vercel starts with "AIza" from aistudio.google.com.`
        });
      }

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        console.error('identify step2 HTTP error:', geminiRes.status, errText.substring(0, 300));
        return res.status(502).json({ error: `AI error (${geminiRes.status}). Please try again.` });
      }

      const data = await geminiRes.json();
      const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      console.log('identify step2 raw:', raw.substring(0, 200));

      const parsed = parseJSON(raw);
      if (parsed) {
        return res.status(200).json({
          productId:   parsed.productId   || null,
          productName: parsed.productName || null,
          confidence:  typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0
        });
      }
      // Regex fallback
      const idM = raw.match(/"productId"\s*:\s*"([^"]+)"/);
      const nmM = raw.match(/"productName"\s*:\s*"([^"]+)"/);
      const cfM = raw.match(/"confidence"\s*:\s*([\d.]+)/);
      return res.status(200).json({
        productId:   idM ? idM[1]             : null,
        productName: nmM ? nmM[1]             : null,
        confidence:  cfM ? parseFloat(cfM[1]) : 0
      });

    } catch (err) {
      console.error('identify step2 error:', err?.message);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }

  // ── MODE 2: Quality check ────────────────────────────────────────────────

  if (!product?.name) return res.status(400).json({ error: 'Product context is required.' });
  if (!referenceGoodUrl && !textOnlyMode) {
    return res.status(400).json({ error: 'No reference photo yet — upload one from Edit Product first.' });
  }

  try {
    const staffImgRaw = splitDataUrl(staffPhoto);
    if (!staffImgRaw) return res.status(400).json({ error: 'Photo format not readable.' });
    const staffImg = await resizeBase64(staffImgRaw.mimeType, staffImgRaw.base64, 1024);

    const productInfo = `Product: ${product.name}
Category: ${product.category || 'unknown'}
Department: ${product.department || 'unknown'}
Accept criteria: ${product.description || 'not recorded'}
Reject criteria: ${product.reject_note || 'not recorded'}
Keywords: ${product.keywords || 'none'}`;

    const jsonSchema = `Respond with STRICT JSON ONLY — no markdown, no extra text:
{
  "verdict": "pass" | "fail" | "uncertain",
  "confidence": 0.0–1.0,
  "similarity": 0–100,
  "explanation": "one or two plain sentences for a warehouse floor worker",
  "breakdown": [{"label": "Colour", "ok": true}, {"label": "Damage", "ok": false}]
}
breakdown: up to 5 visual attributes you can actually SEE. Do NOT include attributes you cannot observe.`;

    let parts;

    if (textOnlyMode || !referenceGoodUrl) {
      parts = [
        {
          text: `You are the Pezzano Quality Assistant. No reference photo available — assess from criteria text and visual judgement.

${productInfo}

similarity (0–100): how closely the batch matches an acceptable version of this product.

${jsonSchema}`
        },
        { text: 'STAFF PHOTO to assess:' },
        { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } }
      ];
    } else {
      const goodImgRaw = await urlToBase64(referenceGoodUrl);
      if (!goodImgRaw) return res.status(502).json({ error: 'Could not load reference photo — it may have expired. Refresh and try again.' });
      const goodImg = await resizeBase64(goodImgRaw.mimeType, goodImgRaw.base64, 1024);

      parts = [
        {
          text: `You are the Pezzano Quality Assistant. Compare the STAFF PHOTO against the reference photo(s) and give a quality verdict.

${productInfo}

Rules:
- Judge on what you can see: colour, damage, ripeness, shape, blemishes.
- If the staff photo is too dark or blurry, return "uncertain".
- Be direct — this answer goes to a warehouse floor worker.

similarity (0–100): how closely the staff photo matches the GOOD reference.

${jsonSchema}`
        },
        { text: `REFERENCE — GOOD/ACCEPTABLE ${product.name}:` },
        { inline_data: { mime_type: goodImg.mimeType, data: goodImg.base64 } }
      ];

      if (referenceRejectUrl) {
        const rjRaw = await urlToBase64(referenceRejectUrl);
        if (rjRaw) {
          const rjImg = await resizeBase64(rjRaw.mimeType, rjRaw.base64, 1024);
          parts.push({ text: `REFERENCE — REJECTED ${product.name}:` });
          parts.push({ inline_data: { mime_type: rjImg.mimeType, data: rjImg.base64 } });
        }
      }
      parts.push({ text: 'STAFF PHOTO — assess this:' });
      parts.push({ inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } });
    }

    const { response: geminiRes, model } = await callGemini(parts, 400);

    if (!geminiRes) {
      return res.status(502).json({
        error: `AI service unavailable — tried ${MODELS.length} models. Make sure GEMINI_API_KEY in Vercel starts with "AIza" and is from aistudio.google.com.`
      });
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error(`check-photo quality HTTP ${geminiRes.status}:`, errText.substring(0, 400));
      if (geminiRes.status === 400) return res.status(502).json({ error: 'Photo could not be processed — try a smaller or clearer photo.' });
      if (geminiRes.status === 403) return res.status(502).json({ error: 'API key does not have permission. Check your key at aistudio.google.com.' });
      return res.status(502).json({ error: `AI error (${geminiRes.status}). Please try again.` });
    }

    const data = await geminiRes.json();
    let raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    if (!raw) return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });

    const parsed = parseJSON(raw);
    if (!parsed) {
      const vm = raw.match(/"verdict"\s*:\s*"(pass|fail|uncertain)"/i);
      const em = raw.match(/"explanation"\s*:\s*"([^"]+)"/);
      const cm = raw.match(/"confidence"\s*:\s*([\d.]+)/);
      const sm = raw.match(/"similarity"\s*:\s*(\d+)/);
      if (vm) return res.status(200).json({ verdict: vm[1].toLowerCase(), confidence: cm ? parseFloat(cm[1]) : null, similarity: sm ? parseInt(sm[1]) : null, explanation: em ? em[1] : '', breakdown: [] });
      return res.status(502).json({ error: 'Could not read the AI response. Please try again.' });
    }

    const breakdown = (Array.isArray(parsed.breakdown) ? parsed.breakdown : [])
      .filter(b => b && typeof b.label === 'string' && typeof b.ok === 'boolean')
      .slice(0, 5);

    return res.status(200).json({
      verdict:     ['pass', 'fail', 'uncertain'].includes(parsed.verdict) ? parsed.verdict : 'uncertain',
      confidence:  typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : null,
      similarity:  typeof parsed.similarity === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.similarity))) : null,
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
      breakdown
    });

  } catch (err) {
    console.error('check-photo error:', err?.message || err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
