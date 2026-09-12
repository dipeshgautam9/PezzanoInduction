// api/check-photo.js
// Auth: Google Service Account JWT (permanent, never expires)
// Set these in Vercel environment variables:
//   GEMINI_PROJECT_ID   = gen-lang-client-0113633451
//   GEMINI_CLIENT_EMAIL = projects-59199348167@gen-lang-client-0113633451.iam.gserviceaccount.com
//   GEMINI_PRIVATE_KEY  = -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n

const MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-001',
  'gemini-1.5-flash-002',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
];

// ── JWT / OAuth token generation for service accounts ──────────────────────
let _cachedToken = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && now < _tokenExpiry) return _cachedToken;

  const clientEmail = process.env.GEMINI_CLIENT_EMAIL;
  const privateKeyRaw = process.env.GEMINI_PRIVATE_KEY;

  if (!clientEmail || !privateKeyRaw) {
    throw new Error('GEMINI_CLIENT_EMAIL and GEMINI_PRIVATE_KEY must be set in Vercel environment variables.');
  }

  // Vercel stores \n as literal backslash-n — replace them with real newlines
  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

  // Build JWT header + payload
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/generative-language',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  function b64url(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
  }

  const unsigned = `${b64url(header)}.${b64url(payload)}`;

  // Import private key and sign
  const keyBuf = Buffer.from(
    privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, ''),
    'base64'
  );

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuf,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, Buffer.from(unsigned));
  const jwt = `${unsigned}.${Buffer.from(sig).toString('base64url')}`;

  // Exchange JWT for access token
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    signal: AbortSignal.timeout(10000)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${err.substring(0, 200)}`);
  }

  const data = await resp.json();
  _cachedToken = data.access_token;
  _tokenExpiry = now + 3500; // refresh 100s before actual expiry
  return _cachedToken;
}

// ── Build request URL + headers based on available credentials ──────────────
async function buildGeminiRequest(model, bodyStr) {
  // Prefer service account (permanent) over API key
  if (process.env.GEMINI_CLIENT_EMAIL && process.env.GEMINI_PRIVATE_KEY) {
    const token = await getAccessToken();
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: bodyStr
    };
  }

  // Legacy: API key (AIzaSy...) or OAuth Bearer (AQ.)
  const apiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) throw new Error('No Gemini credentials found. Set GEMINI_CLIENT_EMAIL + GEMINI_PRIVATE_KEY in Vercel.');

  const isBearer = apiKey.startsWith('AQ.') || apiKey.startsWith('ya29.');
  return {
    url: isBearer ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    headers: isBearer ? {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    } : {
      'Content-Type': 'application/json'
    },
    body: bodyStr
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { staffPhoto, product, referenceGoodUrl, referenceRejectUrl, textOnlyMode, identifyMode, identifyCandidates } = req.body || {};
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
    } catch {
      return { mimeType, base64 };
    }
  }

  async function urlToBase64(url) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) {
        console.error(`urlToBase64 HTTP ${resp.status}`);
        return null;
      }
      const buf = await resp.arrayBuffer();
      const mimeType = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0];
      return { mimeType, base64: Buffer.from(buf).toString('base64') };
    } catch (e) {
      console.error('urlToBase64:', e?.message);
      return null;
    }
  }

  async function callGemini(parts, maxTokens = 400) {
    const errors = [];
    const bodyObj = {
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens }
    };

    for (const model of MODELS) {
      let req2;
      try {
        req2 = await buildGeminiRequest(model, JSON.stringify(bodyObj));
      } catch (e) {
        return { response: null, errorMsg: e.message };
      }

      let r;
      try {
        r = await fetch(req2.url, {
          method: 'POST',
          headers: req2.headers,
          body: req2.body,
          signal: AbortSignal.timeout(25000)
        });
      } catch (e) {
        errors.push(`${model}: ${e?.message}`);
        continue;
      }

      if (r.status === 404) { errors.push(`${model}: 404`); continue; }
      if (r.status === 429) { errors.push(`${model}: 429 quota`); continue; }
      if (r.status === 401) {
        _cachedToken = null; // clear cached token so next call re-fetches
        errors.push(`${model}: 401 auth`);
        continue;
      }

      console.log(`check-photo: using ${model} HTTP ${r.status}`);
      return { response: r, model };
    }

    console.error('check-photo ALL models failed. Errors:', errors.join(' | '));
    return { response: null, errorMsg: 'AI service unavailable — could not connect to Gemini. Check Vercel function logs.' };
  }

  function parseJSON(raw) {
    raw = (raw || '').replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(raw); } catch { return null; }
  }

  // ── MODE 1: Identify product ────────────────────────────────────────────
  if (identifyMode) {
    if (!identifyCandidates?.length) return res.status(400).json({ error: 'No candidate products provided.' });
    const staffImgRaw = splitDataUrl(staffPhoto);
    if (!staffImgRaw) return res.status(400).json({ error: 'Photo format not readable.' });

    const staffImg = await resizeBase64(staffImgRaw.mimeType, staffImgRaw.base64, 900);

    // Step 1: guess category (fast)
    const categories = [...new Set(identifyCandidates.map(c => c.category).filter(Boolean))];
    let filteredCandidates = identifyCandidates;

    if (categories.length > 1) {
      try {
        const catParts = [
          { text: `Look at this product photo. Which ONE category from the list below best describes what you see?\nCategories: ${categories.join(', ')}\nReturn ONLY the exact category name — nothing else.` },
          { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } }
        ];
        const { response: catRes } = await callGemini(catParts, 30);
        if (catRes?.ok) {
          const catData = await catRes.json();
          const guess = (catData.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
          const matched = categories.find(c =>
            c.toLowerCase() === guess.toLowerCase() ||
            guess.toLowerCase().includes(c.toLowerCase()) ||
            c.toLowerCase().includes(guess.toLowerCase())
          );
          if (matched) {
            const inCat = identifyCandidates.filter(c => c.category === matched);
            if (inCat.length > 0 && inCat.length < identifyCandidates.length) {
              console.log(`identify: narrowed to ${inCat.length} in "${matched}"`);
              filteredCandidates = inCat;
            }
          }
        }
      } catch (e) {
        console.warn('identify step1 failed:', e?.message);
      }
    }

    // Step 2: visual match (max 20)
    const refs = (await Promise.all(
      filteredCandidates.slice(0, 20).map(async c => {
        if (!c.referenceUrl) return null;
        const img = await urlToBase64(c.referenceUrl);
        if (!img) return null;
        const resized = await resizeBase64(img.mimeType, img.base64, 480);
        return { id: c.id, name: c.name, img: resized };
      })
    )).filter(Boolean);

    if (!refs.length) return res.status(502).json({ error: 'Could not load reference photos. Check your connection.' });

    const parts = [
      { text: `You are a product identification assistant for Pezzano Enterprises warehouse in Perth, WA.\n\nA staff member has taken a photo of a product. Identify WHICH product it is by visually comparing the staff photo against each reference photo below.\n\nLook at: shape, colour, size, texture, packaging, labels, visible text.\n\nCANDIDATES (${refs.length} products):\n${refs.map((r, i) => `${i + 1}. Name: "${r.name}" | ID: "${r.id}"`).join('\n')}\n\nRules:\n- Compare the STAFF PHOTO carefully against EACH reference photo.\n- Return ONLY valid JSON, no markdown.\n- If confident (>35%): {"productId":"<exact id>","productName":"<exact name>","confidence":0.0-1.0}\n- If no match: {"productId":null,"productName":null,"confidence":0}\n\nSTAFF PHOTO (identify this):` },
      { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } },
      { text: '--- REFERENCE PHOTOS ---' }
    ];

    for (const ref of refs) {
      parts.push({ text: `"${ref.name}" (ID: ${ref.id})` });
      parts.push({ inline_data: { mime_type: ref.img.mimeType, data: ref.img.base64 } });
    }

    try {
      const { response: geminiRes, errorMsg } = await callGemini(parts, 120);
      if (!geminiRes) return res.status(502).json({ error: errorMsg || 'AI unavailable.' });

      if (!geminiRes.ok) {
        const e = await geminiRes.text();
        return res.status(502).json({ error: `AI error (${geminiRes.status}). Try again.` });
      }

      const data = await geminiRes.json();
      const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      const parsed = parseJSON(raw);

      if (parsed) return res.status(200).json({
        productId: parsed.productId || null,
        productName: parsed.productName || null,
        confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0
      });

      const idM = raw.match(/"productId"\s*:\s*"([^"]+)"/);
      const nmM = raw.match(/"productName"\s*:\s*"([^"]+)"/);
      const cfM = raw.match(/"confidence"\s*:\s*([\d.]+)/);

      return res.status(200).json({
        productId: idM?.[1] || null,
        productName: nmM?.[1] || null,
        confidence: cfM ? parseFloat(cfM[1]) : 0
      });
    } catch (err) {
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }

  // ── MODE 2: Quality check ───────────────────────────────────────────────
  if (!product?.name) return res.status(400).json({ error: 'Product context is required.' });
  if (!referenceGoodUrl && !textOnlyMode) return res.status(400).json({ error: 'No reference photo yet — upload one from Edit Product first.' });

  try {
    const staffImgRaw = splitDataUrl(staffPhoto);
    if (!staffImgRaw) return res.status(400).json({ error: 'Photo format not readable.' });

    const staffImg = await resizeBase64(staffImgRaw.mimeType, staffImgRaw.base64, 1024);
    const productInfo = `Product: ${product.name}\nCategory: ${product.category || 'unknown'}\nDepartment: ${product.department || 'unknown'}\nAccept criteria: ${product.description || 'not recorded'}\nReject criteria: ${product.reject_note || 'not recorded'}\nKeywords: ${product.keywords || 'none'}`;
    const jsonSchema = `Respond with STRICT JSON ONLY:\n{"verdict":"pass"|"fail"|"uncertain","confidence":0.0-1.0,"similarity":0-100,"explanation":"1-2 plain sentences","breakdown":[{"label":"Colour","ok":true}]}\nbreakdown: up to 5 visible attributes only.`;

    let parts;
    if (textOnlyMode || !referenceGoodUrl) {
      parts = [
        { text: `You are the Pezzano Quality Assistant. Assess from criteria text and visual judgement.\n\n${productInfo}\n\nsimilarity (0-100): how closely the batch matches an acceptable version.\n\n${jsonSchema}` },
        { text: 'STAFF PHOTO:' },
        { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } }
      ];
    } else {
      const goodImgRaw = await urlToBase64(referenceGoodUrl);
      if (!goodImgRaw) return res.status(502).json({ error: 'Could not load reference photo — it may have expired. Refresh and try again.' });

      const goodImg = await resizeBase64(goodImgRaw.mimeType, goodImgRaw.base64, 1024);
      parts = [
        { text: `You are the Pezzano Quality Assistant. Compare the STAFF PHOTO against the reference and give a quality verdict.\n\n${productInfo}\n\nRules: judge on colour, damage, ripeness, shape, blemishes. If too dark/blurry, return "uncertain". Be direct.\n\nsimilarity (0-100): how closely staff photo matches the GOOD reference.\n\n${jsonSchema}` },
        { text: `REFERENCE — GOOD ${product.name}:` },
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

    const { response: geminiRes, errorMsg } = await callGemini(parts, 400);
    if (!geminiRes) return res.status(502).json({ error: errorMsg || 'AI unavailable.' });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error(`quality HTTP ${geminiRes.status}:`, errText.substring(0, 300));
      if (geminiRes.status === 400) return res.status(502).json({ error: 'Photo could not be processed — try a smaller or clearer photo.' });
      return res.status(502).json({ error: `AI error (${geminiRes.status}). Please try again.` });
    }

    const data = await geminiRes.json();
    const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    if (!raw) return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });

    const parsed = parseJSON(raw);
    if (!parsed) {
      const vm = raw.match(/"verdict"\s*:\s*"(pass|fail|uncertain)"/i);
      const em = raw.match(/"explanation"\s*:\s*"([^"]+)"/);
      const cm = raw.match(/"confidence"\s*:\s*([\d.]+)/);
      const sm = raw.match(/"similarity"\s*:\s*(\d+)/);

      if (vm) return res.status(200).json({
        verdict: vm[1].toLowerCase(),
        confidence: cm ? parseFloat(cm[1]) : null,
        similarity: sm ? parseInt(sm[1]) : null,
        explanation: em?.[1] || '',
        breakdown: []
      });

      return res.status(502).json({ error: 'Could not read the AI response. Please try again.' });
    }

    return res.status(200).json({
      verdict:     ['pass','fail','uncertain'].includes(parsed.verdict) ? parsed.verdict : 'uncertain',
      confidence:  typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : null,
      similarity:  typeof parsed.similarity === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.similarity))) : null,
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
      breakdown:   (Array.isArray(parsed.breakdown) ? parsed.breakdown : []).filter(b => b && typeof b.label === 'string' && typeof b.ok === 'boolean').slice(0, 5)
    });

  } catch (err) {
    console.error('check-photo error:', err?.message || err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
