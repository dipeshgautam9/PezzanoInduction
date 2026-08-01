// api/check-photo.js
// Vercel Serverless Function. Uses Gemini's vision capability (same
// GEMINI_API_KEY as api/ask-ai.js — no new secret needed) to compare a
// staff-submitted photo against a product's reference good/reject photos.
//
// Add this file at: api/check-photo.js in your repo root (same level as
// pezzano-portal-COMPLETE.html and api/ask-ai.js).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set on this Vercel project.' });
  }

  const { staffPhoto, product, referenceGoodUrl, referenceRejectUrl } = req.body || {};
  if (!staffPhoto || typeof staffPhoto !== 'string') {
    return res.status(400).json({ error: 'A staff photo is required.' });
  }
  if (!product || !product.name) {
    return res.status(400).json({ error: 'Product context is required.' });
  }
  if (!referenceGoodUrl) {
    return res.status(400).json({ error: 'This product has no reference photo to compare against yet.' });
  }

  // Splits a "data:image/jpeg;base64,...." string into mime type + raw base64.
  function splitDataUrl(dataUrl) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) return null;
    return { mimeType: match[1], base64: match[2] };
  }

  // Fetches an image URL (e.g. a Supabase signed URL) and returns it as base64 —
  // Gemini needs inline image bytes, it can't fetch arbitrary external URLs itself.
  async function urlToBase64(url) {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    const buf = await resp.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    return { mimeType: contentType.split(';')[0], base64 };
  }

  try {
    const staffImg = splitDataUrl(staffPhoto);
    if (!staffImg) {
      return res.status(400).json({ error: 'The staff photo was not in a readable format.' });
    }

    const goodImg = await urlToBase64(referenceGoodUrl);
    const rejectImg = referenceRejectUrl ? await urlToBase64(referenceRejectUrl) : null;
    if (!goodImg) {
      return res.status(502).json({ error: 'Could not load this product\'s reference photo. Please try again.' });
    }

    const systemPrompt = `You are the Pezzano Quality Assistant, checking a warehouse photo against Pezzano's own reference standard for one product. This is a support tool for staff — not a replacement for their own judgement.

Rules:
- Compare the STAFF PHOTO only against the REFERENCE photos and text data provided for THIS product. Do not use general knowledge about produce quality beyond what is shown/given here.
- Judge primarily on what is visually comparable: colour, blemishes, damage, shape, ripeness signs, size where visible.
- If the staff photo is unclear, too dark, cropped, or doesn't show enough of the product to judge fairly, respond with verdict "uncertain" and say why in the explanation — do not guess.
- Respond with STRICT JSON ONLY, no markdown, no code fences, no extra text, in exactly this shape:
{"verdict":"pass"|"fail"|"uncertain","confidence":0.0-1.0,"explanation":"one or two short sentences, plain language for a warehouse floor"}

Product: ${product.name}
Department: ${product.department || 'unknown'}
Category: ${product.category || 'unknown'}
Accept criteria / good quality standard: ${product.description || 'not recorded'}
Reject criteria / why it fails standard: ${product.reject_note || 'not recorded'}`;

    const parts = [
      { text: systemPrompt },
      { text: 'REFERENCE — this is what GOOD/acceptable looks like for this product:' },
      { inline_data: { mime_type: goodImg.mimeType, data: goodImg.base64 } }
    ];
    if (rejectImg) {
      parts.push({ text: 'REFERENCE — this is an example of REJECTED/below-standard stock for this product:' });
      parts.push({ inline_data: { mime_type: rejectImg.mimeType, data: rejectImg.base64 } });
    }
    parts.push({ text: 'STAFF PHOTO — this is the batch in front of the staff member right now. Compare it against the reference(s) above and respond with the JSON verdict.' });
    parts.push({ inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } });

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 300 }
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini error (check-photo):', errText);
      return res.status(502).json({ error: 'The AI service returned an error. Please try again.' });
    }

    const data = await geminiRes.json();
    let raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw) {
      console.error('Gemini returned no text (check-photo):', JSON.stringify(data));
      return res.status(502).json({ error: 'No result was returned. Please try again.' });
    }

    // Models occasionally wrap JSON in ```json fences despite instructions — strip if present.
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.error('Could not parse Gemini JSON (check-photo):', raw);
      return res.status(502).json({ error: 'Could not understand the AI response. Please try again.' });
    }

    const verdict = ['pass', 'fail', 'uncertain'].includes(parsed.verdict) ? parsed.verdict : 'uncertain';
    const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : null;
    const explanation = typeof parsed.explanation === 'string' ? parsed.explanation : '';

    return res.status(200).json({ verdict, confidence, explanation });
  } catch (err) {
    console.error('check-photo function error:', err);
    return res.status(500).json({ error: 'Something went wrong reaching the AI service.' });
  }
}
