// api/check-photo.js
// Compares a staff photo against a product's reference photos using Gemini vision.
// Supports textOnlyMode when no reference photo exists yet.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is not set.' });

  const { staffPhoto, product, referenceGoodUrl, referenceRejectUrl, textOnlyMode } = req.body || {};
  if (!staffPhoto) return res.status(400).json({ error: 'A staff photo is required.' });
  if (!product?.name) return res.status(400).json({ error: 'Product context is required.' });
  if (!referenceGoodUrl && !textOnlyMode) {
    return res.status(400).json({ error: 'This product has no reference photo yet — upload one from Edit Product first, or try the text-only assessment.' });
  }

  function splitDataUrl(dataUrl) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) return null;
    return { mimeType: match[1], base64: match[2] };
  }

  async function urlToBase64(url) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      return { mimeType: (resp.headers.get('content-type') || 'image/jpeg').split(';')[0], base64: Buffer.from(buf).toString('base64') };
    } catch { return null; }
  }

  try {
    const staffImg = splitDataUrl(staffPhoto);
    if (!staffImg) return res.status(400).json({ error: 'Photo format not readable.' });

    const productInfo = `Product: ${product.name}
Category: ${product.category || 'unknown'}
Department: ${product.department || 'unknown'}
Accept criteria (what GOOD looks like): ${product.description || 'not recorded'}
Reject criteria (what FAILS standard): ${product.reject_note || 'not recorded'}
Keywords: ${product.keywords || 'none'}`;

    let parts, systemText;

    if (textOnlyMode || !referenceGoodUrl) {
      // Text-only mode: no reference photos, assess from criteria text + visual judgement
      systemText = `You are the Pezzano Quality Assistant checking a warehouse product photo against Pezzano's quality standards. No reference photo is available for this product yet, so assess based on general produce quality knowledge combined with the criteria text below, and what you can visually see.

${productInfo}

Look at the staff's photo and assess whether the product appears to meet the accept criteria or fails the reject criteria. Be practical and direct.

Also score similarity (0–100) based on how closely the batch matches what an acceptable version of this product should look like — 100 means perfect, 0 means completely wrong.

Include a breakdown of up to 5 visual attributes you can actually observe (e.g. Colour, Ripeness, Damage, Size, Cleanliness). Only include attributes visible in the photo — do not invent ones you cannot see.

Respond with STRICT JSON ONLY — no markdown, no extra text:
{
  "verdict": "pass" | "fail" | "uncertain",
  "confidence": 0.0–1.0,
  "similarity": 0–100,
  "explanation": "one or two plain sentences for a warehouse floor worker",
  "breakdown": [
    { "label": "Colour", "ok": true },
    { "label": "Ripeness", "ok": false }
  ]
}`;

      parts = [
        { text: systemText },
        { text: 'STAFF PHOTO to assess:' },
        { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } }
      ];

    } else {
      // Full visual comparison mode with reference photos
      const goodImg = await urlToBase64(referenceGoodUrl);
      const rejectImg = referenceRejectUrl ? await urlToBase64(referenceRejectUrl) : null;
      if (!goodImg) return res.status(502).json({ error: 'Could not load the reference photo. Please try again.' });

      systemText = `You are the Pezzano Quality Assistant. Compare the STAFF PHOTO against Pezzano's reference photos for this product and give a quality verdict.

${productInfo}

Rules:
- Judge primarily on what you can see: colour, damage, ripeness, shape, blemishes.
- If the staff photo is too dark, blurry, or unclear to judge, say "uncertain" — don't guess.
- Be direct and practical — this answer goes to a warehouse floor worker.

Also score similarity (0–100) based on how closely the staff photo matches the GOOD reference photo — 100 means identical quality, 0 means completely different.

Include a breakdown of up to 5 visual attributes you can actually observe (e.g. Colour, Firmness, Damage, Shape, Freshness). Only include attributes that are visible in the photos — do not invent ones you cannot see.

Respond with STRICT JSON ONLY — no markdown, no extra text:
{
  "verdict": "pass" | "fail" | "uncertain",
  "confidence": 0.0–1.0,
  "similarity": 0–100,
  "explanation": "one or two plain sentences for a warehouse floor worker",
  "breakdown": [
    { "label": "Colour", "ok": true },
    { "label": "Firmness", "ok": false }
  ]
}`;

      parts = [
        { text: systemText },
        { text: `REFERENCE — GOOD/ACCEPTABLE ${product.name}:` },
        { inline_data: { mime_type: goodImg.mimeType, data: goodImg.base64 } }
      ];
      if (rejectImg) {
        parts.push({ text: `REFERENCE — REJECTED/BELOW-STANDARD ${product.name}:` });
        parts.push({ inline_data: { mime_type: rejectImg.mimeType, data: rejectImg.base64 } });
      }
      parts.push({ text: `STAFF PHOTO — assess this against the reference(s) above:` });
      parts.push({ inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } });
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 400 }
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini check-photo error:', errText);
      return res.status(502).json({ error: 'AI service error. Please try again.' });
    }

    const data = await geminiRes.json();
    let raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      console.error('check-photo parse error:', raw);
      // Try to extract verdict and explanation even if full JSON parse fails
      const verdictMatch = raw.match(/"verdict"\s*:\s*"(pass|fail|uncertain)"/i);
      const explanationMatch = raw.match(/"explanation"\s*:\s*"([^"]+)"/);
      if (verdictMatch) {
        return res.status(200).json({
          verdict: verdictMatch[1].toLowerCase(),
          confidence: null,
          similarity: null,
          explanation: explanationMatch ? explanationMatch[1] : raw.replace(/[{}"]/g, '').substring(0, 200),
          breakdown: []
        });
      }
      return res.status(502).json({ error: 'Could not read the AI response. Please try again.' });
    }

    // Validate and sanitise breakdown: must be array of {label:string, ok:boolean}, max 5 items
    const rawBreakdown = Array.isArray(parsed.breakdown) ? parsed.breakdown : [];
    const breakdown = rawBreakdown
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
    console.error('check-photo error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
