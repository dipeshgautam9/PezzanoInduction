// api/ask-ai.js — Pezzano Quality Assistant
// Accepts { question, product } or { question, products: [...] }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is not set on this Vercel project.' });

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

Use the product data below to answer the question. Read accept/reject criteria carefully and apply them directly to the question. If the data says "not recorded", say so and suggest the escalation procedure.

Keep answers short, clear, and practical — this will be read on a warehouse floor.

Always end with: "This is an AI recommendation based on Pezzano standards. If you are unsure or the product has unusual defects, follow your department's escalation procedure."

Product data:
${productBlock}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: question.trim() }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 400 }
        })
      }
    );

    const responseText = await response.text();
    if (!response.ok) {
      console.error('Gemini ask-ai error:', response.status, responseText);
      // Parse the error to give a helpful message
      let errMsg = 'AI service error. Please try again.';
      try {
        const errData = JSON.parse(responseText);
        if (errData?.error?.message) errMsg = `AI error: ${errData.error.message}`;
      } catch {}
      return res.status(502).json({ error: errMsg });
    }

    const data = JSON.parse(responseText);
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!answer) {
      console.error('Gemini ask-ai: no answer in response:', JSON.stringify(data));
      return res.status(502).json({ error: 'No answer returned. Please try again.' });
    }
    return res.status(200).json({ answer });
  } catch (err) {
    console.error('ask-ai function error:', err);
    return res.status(500).json({ error: 'Connection error. Please try again.' });
  }
}
