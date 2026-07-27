// api/ask-ai.js
// Vercel Serverless Function. Reads GEMINI_API_KEY server-side (never exposed
// to the browser) and answers a staff question using ONLY the product's own
// accept/reject data sent up from the portal — not general knowledge.
//
// Uses Google's Gemini API (Google AI Studio) — free tier, no credit card,
// no trial expiration, ~1,500 requests/day on gemini-2.5-lite.
//
// This file replaces the previous OpenAI version. Path stays the same:
// api/ask-ai.js in your repo root (same level as pezzano-portal-COMPLETE.html).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set on this Vercel project.' });
  }

  const { question, product } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'A question is required.' });
  }
  if (!product || !product.name) {
    return res.status(400).json({ error: 'Product context is required.' });
  }

  // Keep the model strictly inside the product's own data — this is the
  // guardrail that makes it a "Pezzano Quality Assistant" and not a general
  // chatbot. If the answer isn't in the data, it must say so.
  const systemPrompt = `You are the Pezzano Quality Assistant. You help warehouse staff quickly check whether a product meets Pezzano's quality standards.

Rules:
- Answer ONLY using the product data provided below. Do not use outside knowledge about produce, food safety, or quality standards in general.
- If the data provided doesn't answer the question, say so plainly and tell the person to follow their department's escalation procedure — do not guess.
- Keep answers short and practical — this is being read on a warehouse floor, not in an office.
- Always end your answer with this exact line on its own: "This is an AI recommendation based on Pezzano standards. If you are unsure or the product has unusual defects, follow your department's escalation procedure."

Product data:
- Name: ${product.name}
- Department: ${product.department || 'unknown'}
- Category: ${product.category || 'unknown'}
- Accept criteria / good quality standard: ${product.description || 'not recorded'}
- Reject criteria / why it fails standard: ${product.reject_note || 'not recorded'}
- Keywords: ${product.keywords || 'none'}`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: question.trim() }] }],
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
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!answer) {
      console.error('Gemini returned no text:', JSON.stringify(data));
      return res.status(502).json({ error: 'No answer was returned. Please try again.' });
    }

    return res.status(200).json({ answer });
  } catch (err) {
    console.error('ask-ai function error:', err);
    return res.status(500).json({ error: 'Something went wrong reaching the AI service.' });
  }
}
