// api/check-photo.js
// Vercel Serverless Function. Reads GEMINI_API_KEY server-side (never exposed
// to the browser) and compares a staff-taken photo against a product's own
// reference "good" and "reject" photos, using ONLY that product's own
// accept/reject data as the standard — not general knowledge about produce.
//
// Uses Google's Gemini API (Google AI Studio), same account/key as ask-ai.js.
// Path: api/check-photo.js in your repo root (same level as ask-ai.js).
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
    return res.status(400).json({ error: 'A photo to check is required.' });
  }
  if (!product || !product.name) {
    return res.status(400).json({ error: 'Product context is required.' });
  }
  if (!referenceGoodUrl) {
    return res.status(400).json({ error: 'This product has no reference "good" photo to compare against yet.' });
  }

  // staffPhoto arrives as a data: URL (e.g. "data:image/jpeg;base64,/9j/4AAQ...").
  // Split it into the mime type + raw base64 Gemini expects.
  const staffPhotoParts = parseDataUrl(staffPhoto);
  if (!staffPhotoParts) {
    return res.status(400).json({ error: 'That photo could not be read. Please try again.' });
  }

  // Reference photos come in as short-lived Supabase signed URLs — fetch them
  // server-side and inline them as base64 too, since Gemini's inlineData
  // needs actual bytes, not an arbitrary URL.
  let referenceGoodImage, referenceRejectImage;
  try {
    referenceGoodImage = await urlToInlineImage(referenceGoodUrl);
  } catch (err) {
    console.error('Failed to fetch reference good photo:', err);
    return res.status(502).json({ error: "Couldn't load this product's reference photo. Please try again." });
  }
  if (referenceRejectUrl) {
    try {
      referenceRejectImage = await urlToInlineImage(referenceRejectUrl);
    } catch (err) {
      console.error('Failed to fetch reference reject photo:', err);
      // Not fatal — the reject example is optional context. Continue without it.
      referenceRejectImage = null;
    }
  }

  // Same guardrail approach as ask-ai.js: stay strictly inside this product's
  // own recorded standard, don't reason from general food-quality knowledge.
  const systemPrompt = `You are the Pezzano Quality Assistant. Warehouse staff show you a photo of stock they are about to pack, and you compare it against this specific product's own reference photos and written standard — nothing else.

Rules:
- Judge ONLY against the reference photos and product data provided below. Do not use outside knowledge about produce, food safety, or quality standards in general.
- The first reference image is the ACCEPTABLE / GOOD standard for this product. If provided, the second reference image is a REJECT example.
- The last image is the STAFF PHOTO — the one you are judging.
- If the staff photo is a different product entirely, is too blurry/unclear to judge, or the data provided doesn't let you decide confidently, respond with verdict "uncertain" and say so plainly — do not guess.
- Keep the explanation short and practical (2-3 sentences max) — this is read on a warehouse floor, not in an office.
- Respond with ONLY a single JSON object, no markdown formatting, no code fences, no extra text, in exactly this shape:
{"verdict":"pass","confidence":0.0,"explanation":"..."}
verdict must be exactly one of: "pass", "fail", "uncertain".
confidence is a number between 0 and 1.
explanation must end with this exact sentence: "This is an AI recommendation based on Pezzano standards. If you are unsure or the product has unusual defects, follow your department's escalation procedure."

Product data:
- Name: ${product.name}
- Department: ${product.department || 'unknown'}
- Category: ${product.category || 'unknown'}
- Accept criteria / good quality standard: ${product.description || 'not recorded'}
- Reject criteria / why it fails standard: ${product.reject_note || 'not recorded'}
- Keywords: ${product.keywords || 'none'}`;

  const userParts = [
    { text: 'Reference photo — ACCEPTABLE / GOOD standard for this product:' },
    { inlineData: { mimeType: referenceGoodImage.mimeType, data: referenceGoodImage.data } }
  ];
  if (referenceRejectImage) {
    userParts.push(
      { text: 'Reference photo — REJECT example for this product:' },
      { inlineData: { mimeType: referenceRejectImage.mimeType, data: referenceRejectImage.data } }
    );
  }
  userParts.push(
    { text: 'Staff photo to judge:' },
    { inlineData: { mimeType: staffPhotoParts.mimeType, data: staffPhotoParts.data } }
  );

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: userParts }],
          generationConfig: { maxOutputTokens: 400 }
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini error:', errText);
      return res.status(502).json({ error: 'The AI service returned an error. Please try again.' });
    }

    const data = await geminiRes.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw) {
      console.error('Gemini returned no text:', JSON.stringify(data));
      return res.status(502).json({ error: 'No result was returned. Please try again.' });
    }

    const parsed = parseVerdictJson(raw);
    if (!parsed) {
      console.error('Gemini returned unparseable verdict:', raw);
      return res.status(502).json({ error: 'Could not read the AI result. Please try again.' });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('check-photo function error:', err);
    return res.status(500).json({ error: 'Something went wrong reaching the AI service.' });
  }
}

// "data:image/jpeg;base64,/9j/4AAQ..." -> { mimeType, data }
function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

// Fetch a signed URL server-side and return it as base64 + mime type.
async function urlToInlineImage(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status}`);
  const mimeType = resp.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { mimeType, data: buffer.toString('base64') };
}

// Strips accidental markdown code fences and parses/validates the verdict JSON.
function parseVerdictJson(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let obj;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const verdict = String(obj.verdict || '').toLowerCase();
  if (!['pass', 'fail', 'uncertain'].includes(verdict)) return null;
  const confidence = typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : undefined;
  const explanation = typeof obj.explanation === 'string' ? obj.explanation.trim() : '';
  return { verdict, confidence, explanation };
}
