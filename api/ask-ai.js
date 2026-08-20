// api/ask-ai.js — Pezzano Quality Assistant
// Works with both AIza and AQ. Gemini API keys

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel environment variables.' });

  const { question, product, products } = req.body || {};
  if (!question?.trim()) return res.status(400).json({ error: 'A question is required.' });

  let productList = [];
  if (Array.isArray(products) && products.length) productList = products.filter(p => p?.name);
  else if (product?.name) productList = [product];

  const productBlock = productList.length
    ? productList.map((p, i) => [
        productList.length > 1 ? `--- Product ${i + 1}: ${p.name} ---` : `--- Product: ${p.name} ---`,
        `Category: ${p.category || 'unknown'}`,
        `Accept / good quality: ${p.description || 'not recorded'}`,
        `Reject / fails standard: ${p.reject_note || 'not recorded'}`,
        `Keywords: ${p.keywords || 'none'}`
      ].join('\n')).join('\n\n')
    : 'No specific product data matched — answer using general Pezzano warehouse quality principles if possible.';

  const systemPrompt = `You are the Pezzano Quality Assistant helping warehouse staff with quick quality decisions.

Use the product data below to answer the question directly and practically. Read the accept/reject criteria carefully and apply them to the question. Keep answers short and clear — this is read on a warehouse floor.

Always end with: "This is an AI recommendation based on Pezzano standards. If you are unsure or the product has unusual defects, follow your department's escalation procedure."

Product data:
${productBlock}`;

  // Try models in order — stops at first success
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
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: question.trim() }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 400 }
          })
        }
      );

      const data = await response.json();
      if (!response.ok) {
        errors.push(`${model}: ${response.status} ${data?.error?.message || ''}`);
        continue; // try next model
      }

      const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!answer) { errors.push(`${model}: empty response`); continue; }

      return res.status(200).json({ answer });
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
    }
  }

  console.error('All Gemini models failed (ask-ai):', errors);
  return res.status(502).json({ error: `AI service unavailable. Tried: ${errors.join(' | ')}` });
}
