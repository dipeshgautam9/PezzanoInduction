// api/ask-ai.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel environment variables.' });

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
- Be direct. 1–3 sentences is usually enough.
- If the answer is clearly "no, reject it", say so firmly.
- If unsure or borderline, say to escalate to the supervisor.
- Only use the product data above — don't invent Pezzano-specific policies.

QUESTION: ${question.trim()}`;

  const MODELS = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-001',
    'gemini-1.5-flash-002',
    'gemini-1.5-flash-8b',
    'gemini-1.5-pro',
    'gemini-1.5-pro-001',
    'gemini-1.5-pro-002',
  ];

  async function callGemini() {
    const errors = [];
    for (const model of MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      let r;
      try {
        r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 300 }
          }),
          signal: AbortSignal.timeout(20000)
        });
      } catch (e) {
        errors.push(`${model}: ${e?.message}`);
        continue;
      }

      if (r.status === 404) { errors.push(`${model}: 404`); continue; }
      if (r.status === 429) { errors.push(`${model}: 429 quota`); continue; }

      console.log(`ask-ai: using model ${model}, HTTP ${r.status}`);
      return { response: r, model };
    }
    console.error('ask-ai: ALL models failed. Key prefix:', apiKey.substring(0, 8), '| Errors:', errors.join(' | '));
    return { response: null };
  }

  try {
    const { response: geminiRes, model } = await callGemini();

    if (!geminiRes) {
      return res.status(502).json({
        error: `AI service unavailable — tried ${MODELS.length} models, all failed. Check that your GEMINI_API_KEY in Vercel is a valid Google AI Studio key (starts with "AIza") from aistudio.google.com.`
      });
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error(`ask-ai: HTTP ${geminiRes.status} from ${model}:`, errText.substring(0, 400));
      if (geminiRes.status === 403) return res.status(502).json({ error: 'API key does not have permission. Check your key at aistudio.google.com.' });
      if (geminiRes.status === 429) return res.status(502).json({ error: 'AI service is busy — wait a moment and try again.' });
      return res.status(502).json({ error: `AI service error (${geminiRes.status}). Please try again.` });
    }

    const data = await geminiRes.json();
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    if (!answer) {
      console.error('ask-ai: empty response from', model, JSON.stringify(data).substring(0, 300));
      return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });
    }

    return res.status(200).json({ answer });

  } catch (err) {
    console.error('ask-ai: unhandled error:', err?.message || err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
