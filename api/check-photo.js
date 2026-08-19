// api/check-photo.js
// Compares a staff photo against a product's reference photos using Gemini vision.

// Try models in order — first non-404 response wins.
// These are the current valid model IDs for Google AI Studio (generativelanguage.googleapis.com).
const GEMINI_MODELS = [
  'gemini-2.0-flash-001',
  'gemini-2.0-flash',
  'gemini-1.5-flash-002',
  'gemini-1.5-flash-001',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is not set.' });

  const { staffPhoto, product, referenceGoodUrl, referenceRejectUrl, textOnlyMode } = req.body || {};
  if (!staffPhoto) return res.status(400).json({ error: 'A staff photo is required.' });
  if (!product?.name) return res.status(400).json({ error: 'Product context is required.' });
  if (!referenceGoodUrl && !textOnlyMode) {
    return res.status(400).json({ error: 'No reference photo yet — upload one from Edit Product first.' });
  }

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

  async function callGemini(parts) {
    for (const model of GEMINI_MODELS) {
      let r;
      try {
        r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 400 }
            }),
            signal: AbortSignal.timeout(25000)
          }
        );
      } catch (e) { console.error(`Gemini fetch error (${model}):`, e?.message); continue; }
      if (r.status === 404) { console.warn(`Model not found: ${model}`); continue; }
      console.log(`Using model: ${model} — HTTP ${r.status}`);
      return r;
    }
    return null;
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
breakdown: up to 5 attributes you can actually SEE — e.g. Colour, Ripeness, Damage, Shape, Freshness. Omit any you cannot observe.`;

    let parts;

    if (textOnlyMode || !referenceGoodUrl) {
      parts = [
        { text: `You are the Pezzano Quality Assistant. No reference photo available — assess from criteria text and your visual judgement.

${productInfo}

similarity: how closely the batch matches an acceptable version of this product (100=perfect, 0=wrong).

${jsonSchema}` },
        { text: 'STAFF PHOTO to assess:' },
        { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } }
      ];
    } else {
      const goodImgRaw = await urlToBase64(referenceGoodUrl);
      if (!goodImgRaw) return res.status(502).json({ error: 'Could not load reference photo — it may have expired. Refresh and try again.' });
      const goodImg = await resizeBase64(goodImgRaw.mimeType, goodImgRaw.base64, 1024);

      parts = [
        { text: `You are the Pezzano Quality Assistant. Compare the STAFF PHOTO against the reference photo(s) and give a quality verdict.

${productInfo}

Rules:
- Judge on what you can see: colour, damage, ripeness, shape, blemishes.
- If the staff photo is too dark or blurry to judge, return "uncertain".
- Be direct — this answer goes to a warehouse floor worker.

similarity: how closely the staff photo matches the GOOD reference (100=identical quality, 0=completely different).

${jsonSchema}` },
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

    const geminiRes = await callGemini(parts);
    if (!geminiRes) return res.status(502).json({ error: 'No Gemini model available — check that your GEMINI_API_KEY is valid.' });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error(`Gemini HTTP ${geminiRes.status}:`, errText.substring(0, 400));
      if (geminiRes.status === 400) return res.status(502).json({ error: 'Photo could not be processed — try a smaller or clearer photo.' });
      if (geminiRes.status === 429) return res.status(502).json({ error: 'AI service is busy — wait a moment and try again.' });
      if (geminiRes.status === 403) return res.status(502).json({ error: 'API key does not have permission. Check your Google AI Studio key.' });
      return res.status(502).json({ error: `AI service error (${geminiRes.status}). Please try again.` });
    }

    const data = await geminiRes.json();
    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') console.warn('finishReason:', finishReason);

    let raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

    if (!raw) {
      console.error('Empty Gemini response:', JSON.stringify(data).substring(0, 400));
      return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });
    }

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      console.error('JSON parse error. Raw:', raw.substring(0, 300));
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
      verdict:     ['pass','fail','uncertain'].includes(parsed.verdict) ? parsed.verdict : 'uncertain',
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
