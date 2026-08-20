// api/check-photo.js — Pezzano AI Photo Check
// Works with both AIza and AQ. Gemini API keys

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel environment variables.' });

  const { staffPhoto, product, referenceGoodUrl, referenceRejectUrl, textOnlyMode } = req.body || {};
  if (!staffPhoto) return res.status(400).json({ error: 'A staff photo is required.' });
  if (!product?.name) return res.status(400).json({ error: 'Product context is required.' });

  function splitDataUrl(dataUrl) {
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    return m ? { mimeType: m[1], base64: m[2] } : null;
  }

  async function urlToBase64(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      const mimeType = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
      return { mimeType, base64: Buffer.from(buf).toString('base64') };
    } catch { return null; }
  }

  const staffImg = splitDataUrl(staffPhoto);
  if (!staffImg) return res.status(400).json({ error: 'Photo format not readable. Please try a JPG or PNG.' });

  const productInfo = [
    `Product: ${product.name}`,
    `Category: ${product.category || 'unknown'}`,
    `Accept criteria (GOOD): ${product.description || 'not recorded'}`,
    `Reject criteria (FAILS standard): ${product.reject_note || 'not recorded'}`,
    `Keywords: ${product.keywords || 'none'}`
  ].join('\n');

  let parts;
  try {
    if (textOnlyMode || !referenceGoodUrl) {
      parts = [
        { text: `You are the Pezzano Quality Assistant. A warehouse staff member has uploaded a photo of a product batch. Assess it against these quality criteria:\n\n${productInfo}\n\nJudge whether the photo shows product that meets the accept criteria or fails the reject criteria. Be direct and practical.\n\nRespond with STRICT JSON only — no markdown:\n{"verdict":"pass"|"fail"|"uncertain","confidence":0.0-1.0,"explanation":"one or two plain sentences for a warehouse floor worker"}` },
        { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } }
      ];
    } else {
      const goodImg = await urlToBase64(referenceGoodUrl);
      if (!goodImg) return res.status(502).json({ error: 'Could not load the reference photo. Please try again.' });
      const rejectImg = referenceRejectUrl ? await urlToBase64(referenceRejectUrl) : null;

      parts = [
        { text: `You are the Pezzano Quality Assistant. Compare the STAFF PHOTO against the REFERENCE photos and quality criteria for ${product.name}.\n\n${productInfo}\n\nJudge on visual appearance: colour, damage, ripeness, shape, blemishes. If the staff photo is too dark, blurry, or unclear to judge fairly, say "uncertain".\n\nRespond with STRICT JSON only — no markdown:\n{"verdict":"pass"|"fail"|"uncertain","confidence":0.0-1.0,"explanation":"one or two plain sentences for a warehouse floor worker"}` },
        { text: `REFERENCE — GOOD/ACCEPTABLE example of ${product.name}:` },
        { inline_data: { mime_type: goodImg.mimeType, data: goodImg.base64 } }
      ];
      if (rejectImg) {
        parts.push({ text: `REFERENCE — REJECTED/BELOW-STANDARD example of ${product.name}:` });
        parts.push({ inline_data: { mime_type: rejectImg.mimeType, data: rejectImg.base64 } });
      }
      parts.push({ text: `STAFF PHOTO — this is the batch in front of the staff member right now. Compare it against the reference(s) above:` });
      parts.push({ inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to prepare photo data: ' + err.message });
  }

  // Vision-capable models — tries each in order, stops at first success
  const MODELS = [
    'gemini-3.6-flash',
    'gemini-2.5-flash',
    'gemini-2.5-flash-8b',
    'gemini-2.0-flash',
    'gemini-1.5-flash'
  ];

  const errors = [];
  for (const model of MODELS) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey   // works for both AIza and AQ. keys
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 300 }
          })
        }
      );

      const responseText = await response.text();
      if (!response.ok) {
        let msg = response.status.toString();
        try { msg += ' ' + JSON.parse(responseText)?.error?.message; } catch {}
        errors.push(`${model}: ${msg}`);
        continue;
      }

      const data = JSON.parse(responseText);
      let raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const vm = raw.match(/"verdict"\s*:\s*"(pass|fail|uncertain)"/i);
        const em = raw.match(/"explanation"\s*:\s*"([^"]+)"/);
        if (vm) return res.status(200).json({ verdict: vm[1].toLowerCase(), confidence: null, explanation: em?.[1] || '' });
        errors.push(`${model}: JSON parse failed — ${raw.substring(0, 80)}`);
        continue;
      }

      return res.status(200).json({
        verdict: ['pass', 'fail', 'uncertain'].includes(parsed.verdict) ? parsed.verdict : 'uncertain',
        confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : null,
        explanation: typeof parsed.explanation === 'string' ? parsed.explanation : ''
      });
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
    }
  }

  console.error('All Gemini models failed (check-photo). Key prefix:', apiKey.slice(0, 6), 'Errors:', errors);
  return res.status(502).json({ error: `AI service unavailable. Details: ${errors.slice(0, 3).join(' | ')}` });
}
