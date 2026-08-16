// api/check-photo.js — Pezzano AI Photo Check
// Compares a staff photo against product reference photos + quality criteria

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is not set on this Vercel project.' });

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

  try {
    const staffImg = splitDataUrl(staffPhoto);
    if (!staffImg) return res.status(400).json({ error: 'Photo format not readable. Please try again.' });

    const productInfo = [
      `Product: ${product.name}`,
      `Category: ${product.category || 'unknown'}`,
      `Accept criteria (GOOD): ${product.description || 'not recorded'}`,
      `Reject criteria (FAILS): ${product.reject_note || 'not recorded'}`,
      `Keywords: ${product.keywords || 'none'}`
    ].join('\n');

    let parts;

    if (textOnlyMode || !referenceGoodUrl) {
      // No reference photo — assess from criteria text + visual judgement
      parts = [
        { text: `You are the Pezzano Quality Assistant. Assess the photo against these quality criteria for ${product.name}:\n\n${productInfo}\n\nLook at the staff photo and judge whether it meets the accept criteria or fails the reject criteria. Be direct and practical.\n\nRespond with STRICT JSON only (no markdown):\n{"verdict":"pass"|"fail"|"uncertain","confidence":0.0-1.0,"explanation":"one or two plain sentences"}` },
        { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } }
      ];
    } else {
      // Full visual comparison
      const goodImg = await urlToBase64(referenceGoodUrl);
      if (!goodImg) return res.status(502).json({ error: 'Could not load reference photo. Please try again.' });
      const rejectImg = referenceRejectUrl ? await urlToBase64(referenceRejectUrl) : null;

      parts = [
        { text: `You are the Pezzano Quality Assistant. Compare the STAFF PHOTO against the REFERENCE photos for ${product.name} and give a quality verdict.\n\n${productInfo}\n\nJudge on visual appearance: colour, damage, ripeness, shape, blemishes. If the staff photo is too dark or blurry to judge fairly, say "uncertain".\n\nRespond with STRICT JSON only (no markdown):\n{"verdict":"pass"|"fail"|"uncertain","confidence":0.0-1.0,"explanation":"one or two plain sentences for warehouse staff"}` },
        { text: `REFERENCE — GOOD/ACCEPTABLE ${product.name}:` },
        { inline_data: { mime_type: goodImg.mimeType, data: goodImg.base64 } }
      ];
      if (rejectImg) {
        parts.push({ text: `REFERENCE — REJECTED/BELOW-STANDARD ${product.name}:` });
        parts.push({ inline_data: { mime_type: rejectImg.mimeType, data: rejectImg.base64 } });
      }
      parts.push({ text: `STAFF PHOTO — compare this to the reference(s) above:` });
      parts.push({ inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 300 }
        })
      }
    );

    const responseText = await response.text();
    if (!response.ok) {
      console.error('Gemini check-photo error:', response.status, responseText);
      let errMsg = 'AI service error. Please try again.';
      try {
        const errData = JSON.parse(responseText);
        if (errData?.error?.message) errMsg = `AI error: ${errData.error.message}`;
      } catch {}
      return res.status(502).json({ error: errMsg });
    }

    const data = JSON.parse(responseText);
    let raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Try to extract verdict even if JSON is malformed
      const vm = raw.match(/"verdict"\s*:\s*"(pass|fail|uncertain)"/i);
      const em = raw.match(/"explanation"\s*:\s*"([^"]+)"/);
      if (vm) return res.status(200).json({ verdict: vm[1].toLowerCase(), confidence: null, explanation: em ? em[1] : 'See result above.' });
      console.error('check-photo parse error:', raw);
      return res.status(502).json({ error: 'Could not read AI response. Please try again.' });
    }

    return res.status(200).json({
      verdict: ['pass', 'fail', 'uncertain'].includes(parsed.verdict) ? parsed.verdict : 'uncertain',
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : null,
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : ''
    });
  } catch (err) {
    console.error('check-photo error:', err);
    return res.status(500).json({ error: 'Connection error. Please try again.' });
  }
}
