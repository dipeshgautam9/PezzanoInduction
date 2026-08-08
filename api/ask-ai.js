// api/ask-ai.js
// Vercel Serverless Function. Reads GEMINI_API_KEY server-side.
// Accepts { question, product } or { question, products: [...] }
// Always sends real retrieved product data — never a blank placeholder.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is not set.' });

  const { question, product, products } = req.body || {};
  if (!question?.trim()) return res.status(400).json({ error: 'A question is required.' });

  let productList = [];
  if (Array.isArray(products)) productList = products.filter(p => p?.name);
  else if (product?.name) productList = [product];

  const productBlock = productList.length
    ? productList.map((p, i) => `${productList.length > 1 ? `Product ${i + 1}:\n` : ''}- Name: ${p.name}
- Department: ${p.department || 'unknown'}
- Category: ${p.category || 'unknown'}
- Accept criteria (good quality): ${p.description || 'not recorded'}
- Reject criteria (fails standard): ${p.reject_note || 'not recorded'}
- Keywords: ${p.keywords || 'none'}`).join('\n\n')
    : '(No specific product data was matched — answer based on general Pezzano warehouse quality principles.)';

  const systemPrompt = `You are the Pezzano Quality Assistant. You help warehouse staff with quality questions about produce and products.

You have been given product data below. Use it actively to answer the question — read the accept/reject criteria and apply them. If multiple products are listed, focus on the one the question is about.

Only say you don't have data if the relevant product fields genuinely say "not recorded" AND the question cannot be answered from what IS available.

Keep answers short, clear, and practical — this is being read on a warehouse floor.

Always end with this exact line: "This is an AI recommendation based on Pezzano standards. If you are unsure or the product has unusual defects, follow your department's escalation procedure."

Product data:
${productBlock}`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`,
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
    if (!geminiRes.ok) {
      console.error('Gemini ask-ai error:', await geminiRes.text());
      return res.status(502).json({ error: 'AI service error. Please try again.' });
    }
    const data = await geminiRes.json();
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!answer) return res.status(502).json({ error: 'No answer returned. Please try again.' });
    return res.status(200).json({ answer });
  } catch (err) {
    console.error('ask-ai error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
