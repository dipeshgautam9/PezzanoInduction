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

  // ── Helpers ──────────────────────────────────────────────────────────────

  function splitDataUrl(dataUrl) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) return null;
    return { mimeType: match[1], base64: match[2] };
  }

  // Resize a base64 image to fit within maxDim px on the longest side.
  // Returns { mimeType, base64 } — always JPEG after resize to keep payload small.
  async function resizeBase64(mimeType, base64, maxDim = 1024) {
    try {
      // Use sharp if available (Vercel Node runtime); fall back to returning as-is.
      const sharp = (await import('sharp').catch(() => null))?.default;
      if (!sharp) return { mimeType, base64 }; // no resize available
      const buf = Buffer.from(base64, 'base64');
      const resized = await sharp(buf)
        .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      return { mimeType: 'image/jpeg', base64: resized.toString('base64') };
    } catch {
      return { mimeType, base64 }; // resize failed — send original
    }
  }

  async function urlToBase64(url) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) {
        console.error(`urlToBase64 failed: HTTP ${resp.status} for ${url.substring(0, 80)}`);
        return null;
      }
      const buf = await resp.arrayBuffer();
      const mimeType = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0];
      return { mimeType, base64: Buffer.from(buf).toString('base64') };
    } catch (e) {
      console.error('urlToBase64 error:', e?.message || e);
      return null;
    }
  }

  // ── Main ─────────────────────────────────────────────────────────────────

  try {
    const staffImgRaw = splitDataUrl(staffPhoto);
    if (!staffImgRaw) return res.status(400).json({ error: 'Photo format not readable.' });

    // Resize staff photo — phones can produce 8–15 MB images which blow the Gemini limit
    const staffImg = await resizeBase64(staffImgRaw.mimeType, staffImgRaw.base64, 1024);

    const productInfo = `Product: ${product.name}
Category: ${product.category || 'unknown'}
Department: ${product.department || 'unknown'}
Accept criteria (what GOOD looks like): ${product.description || 'not recorded'}
Reject criteria (what FAILS standard): ${product.reject_note || 'not recorded'}
Keywords: ${product.keywords || 'none'}`;

    const jsonSchema = `Respond with STRICT JSON ONLY — no markdown, no extra text:
{
  "verdict": "pass" | "fail" | "uncertain",
  "confidence": 0.0–1.0,
  "similarity": 0–100,
  "explanation": "one or two plain sentences for a warehouse floor worker",
  "breakdown": [
    { "label": "Colour", "ok": true },
    { "label": "Ripeness", "ok": false }
  ]
}
breakdown: up to 5 attributes you can actually SEE in the photo (e.g. Colour, Ripeness, Damage, Shape, Cleanliness, Freshness). Do NOT include attributes you cannot observe.`;

    let parts;

    if (textOnlyMode || !referenceGoodUrl) {
      // ── Text-only mode ──
      parts = [
        {
          text: `You are the Pezzano Quality Assistant. No reference photo is available for this product yet — assess purely from the criteria text and your visual judgement of the staff photo.

${productInfo}

similarity score: how closely the batch matches what an acceptable version of this product should look like (100 = perfect, 0 = completely wrong).

${jsonSchema}`
        },
        { text: 'STAFF PHOTO to assess:' },
        { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } }
      ];

    } else {
      // ── Full visual comparison mode ──
      const goodImgRaw = await urlToBase64(referenceGoodUrl);
      if (!goodImgRaw) {
        console.error('check-photo: could not fetch reference good photo:', referenceGoodUrl?.substring(0, 100));
        return res.status(502).json({ error: 'Could not load the reference photo — the signed URL may have expired. Please refresh the page and try again.' });
      }
      const goodImg = await resizeBase64(goodImgRaw.mimeType, goodImgRaw.base64, 1024);

      parts = [
        {
          text: `You are the Pezzano Quality Assistant. Compare the STAFF PHOTO against the reference photo(s) and give a quality verdict.

${productInfo}

Rules:
- Judge on what you can see: colour, damage, ripeness, shape, blemishes.
- If the staff photo is too dark, blurry, or unclear to judge reliably, return "uncertain".
- Be direct and practical — this answer goes to a warehouse floor worker.

similarity score: how closely the staff photo matches the GOOD reference photo (100 = identical quality, 0 = completely different).

${jsonSchema}`
        },
        { text: `REFERENCE — GOOD/ACCEPTABLE ${product.name}:` },
        { inline_data: { mime_type: goodImg.mimeType, data: goodImg.base64 } }
      ];

      if (referenceRejectUrl) {
        const rejectImgRaw = await urlToBase64(referenceRejectUrl);
        if (rejectImgRaw) {
          const rejectImg = await resizeBase64(rejectImgRaw.mimeType, rejectImgRaw.base64, 1024);
          parts.push({ text: `REFERENCE — REJECTED/BELOW-STANDARD ${product.name}:` });
          parts.push({ inline_data: { mime_type: rejectImg.mimeType, data: rejectImg.base64 } });
        }
      }

      parts.push({ text: 'STAFF PHOTO — assess this against the reference(s) above:' });
      parts.push({ inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } });
    }

    // ── Call Gemini ──────────────────────────────────────────────────────

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 400 }
        }),
        signal: AbortSignal.timeout(25000) // 25 s — Vercel hobby limit is 30 s
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error(`Gemini HTTP ${geminiRes.status}:`, errText.substring(0, 500));
      // Surface a clearer message for the most common errors
      if (geminiRes.status === 400) return res.status(502).json({ error: 'The photo could not be processed — it may be too large or in an unsupported format. Try a smaller/clearer photo.' });
      if (geminiRes.status === 429) return res.status(502).json({ error: 'AI service is busy — please wait a moment and try again.' });
      return res.status(502).json({ error: `AI service error (${geminiRes.status}). Please try again.` });
    }

    const data = await geminiRes.json();

    // Log finish reason to help diagnose truncated responses
    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      console.warn('Gemini finishReason:', finishReason);
    }

    let raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

    if (!raw) {
      console.error('check-photo: empty Gemini response. Full response:', JSON.stringify(data).substring(0, 500));
      return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });
    }

    // ── Parse response ───────────────────────────────────────────────────

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('check-photo JSON parse error. Raw:', raw.substring(0, 300));
      // Graceful fallback: extract what we can via regex
      const verdictMatch = raw.match(/"verdict"\s*:\s*"(pass|fail|uncertain)"/i);
      const explanationMatch = raw.match(/"explanation"\s*:\s*"([^"]+)"/);
      const confidenceMatch = raw.match(/"confidence"\s*:\s*([\d.]+)/);
      const similarityMatch = raw.match(/"similarity"\s*:\s*(\d+)/);
      if (verdictMatch) {
        return res.status(200).json({
          verdict: verdictMatch[1].toLowerCase(),
          confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : null,
          similarity: similarityMatch ? parseInt(similarityMatch[1], 10) : null,
          explanation: explanationMatch ? explanationMatch[1] : 'Could not parse full AI response.',
          breakdown: []
        });
      }
      return res.status(502).json({ error: 'Could not read the AI response. Please try again.' });
    }

    // Validate breakdown
    const rawBreakdown = Array.isArray(parsed.breakdown) ? parsed.breakdown : [];
    const breakdown = rawBreakdown
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
    console.error('check-photo unhandled error:', err?.message || err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
