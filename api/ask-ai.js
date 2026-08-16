// api/ask-ai.js
// Answers quality standard questions using Pezzano product data as context.

const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-latest',
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is not set.' });

  const { question, products } = req.body || {};
  if (!question?.trim()) return res.status(400).json({ error: 'A question is required.' });

  const productContext = Array.isArray(products) && products.length
    ? products.map(p =>
        `• ${p.name} (${p.category || 'uncategorised'}, ${p.department || ''})\n` +
        `  Accept: ${p.description || 'not recorded'}\n` +
        `  Reject: ${p.reject_note || 'not recorded'}`
      ).join('\n')
    : 'No product data available.';

  const prompt = `You are the Pezzano Quality Assistant — a practical, direct helper for warehouse floor staff at Pezzano Enterprises in Perth, WA.

Your job: answer questions about produce quality standards, packing procedures, and what to do when a product looks questionable.

PEZZANO PRODUCT REFERENCE DATA:
${productContext}

RULES:
- Answer in plain, simple English — this is a busy warehouse floor.
- Be direct. Don't pad. 1–3 sentences is usually enough.
- If the answer is clearly "no, reject it", say so firmly.
- If you're unsure or it's a borderline case, say to escalate to the supervisor.
- Only use the product data above — don't invent Pezzano-specific policies.

QUESTION: ${question.trim()}`;

  async function callGemini() {
    for (const model of GEMINI_MODELS) {
      let r;
      try {
        r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 300 }
            }),
            signal: AbortSignal.timeout(20000)
          }
        );
      } catch (e) { console.error(`ask-ai fetch error (${model}):`, e?.message); continue; }
      if (r.status === 404) { console.warn(`Model not found: ${model}`); continue; }
      console.log(`ask-ai using model: ${model} — HTTP ${r.status}`);
      return r;
    }
    return null;
  }

  try {
    const geminiRes = await callGemini();
    if (!geminiRes) return res.status(502).json({ error: 'No Gemini model available — check that your GEMINI_API_KEY is valid.' });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error(`ask-ai Gemini HTTP ${geminiRes.status}:`, errText.substring(0, 400));
      if (geminiRes.status === 429) return res.status(502).json({ error: 'AI service is busy — wait a moment and try again.' });
      if (geminiRes.status === 403) return res.status(502).json({ error: 'API key does not have permission. Check your Google AI Studio key.' });
      return res.status(502).json({ error: `AI service error (${geminiRes.status}). Please try again.` });
    }

    const data = await geminiRes.json();
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    if (!answer) return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });

    return res.status(200).json({ answer });

  } catch (err) {
    console.error('ask-ai error:', err?.message || err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
