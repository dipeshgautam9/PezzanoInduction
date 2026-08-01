// api/ask-ai.js
// Vercel Serverless Function. Reads GEMINI_API_KEY server-side.
//
// Accepts EITHER:
//   { question, product: {...} }         — single product (legacy/per-product page usage)
//   { question, products: [{...}, ...] } — multiple retrieved products (dashboard usage)
// The client is responsible for retrieval (searching its own product data for
// anything relevant to the question) — this function just answers strictly
// from whatever product data it's given, and says so honestly if nothing
// relevant was found.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set on this Vercel project.' });
  }

  const { question, product, products } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'A question is required.' });
  }

  // Normalize to a single array regardless of which shape the client sent.
  let productList = [];
  if (Array.isArray(products)) productList = products.filter(p => p && p.name);
  else if (product && product.name) productList = [product];

  const productBlock = productList.length
    ? productList.map((p, i) => `${productList.length > 1 ? `Product ${i + 1}:\n` : ''}- Name: ${p.name}
- Department: ${p.department || 'unknown'}
- Category: ${p.category || 'unknown'}
- Accept criteria / good quality standard: ${p.description || 'not recorded'}
- Reject criteria / why it fails standard: ${p.reject_note || 'not recorded'}
- Keywords: ${p.keywords || 'none'}`).join('\n\n')
    : '(No matching product was found in the library for this question.)';

  const systemPrompt = `You are the Pezzano Quality Assistant. You help warehouse staff quickly check whether a product meets Pezzano's quality standards, or find quick answers about quality procedures.

Rules:
- You have been given the product(s) below because they were found to be relevant to the question — treat this as your knowledge base for this answer. Use it actively: read the accept/reject criteria and keywords carefully and apply them to answer the actual question asked, don't just repeat the data back.
- If multiple products are listed, pick whichever one the question is actually about and answer using that one's data. Ignore the others.
- Only say you don't have the information if truly none of the product data below is relevant to the question, or if the relevant product is listed but its accept/reject fields say "not recorded" AND the question can't be reasonably answered from what IS there (e.g. name, category). In that case say so plainly and tell the person to follow their department's escalation procedure — don't guess at quality criteria that were never entered.
- Keep answers short and practical — this is being read on a warehouse floor, not in an office.
- Always end your answer with this exact line on its own: "This is an AI recommendation based on Pezzano standards. If you are unsure or the product has unusual defects, follow your department's escalation procedure."

Product data:
${productBlock}`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
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
      const errText = await geminiRes.text();
      console.error('Gemini error:', errText);
      return res.status(502).json({ error: 'The AI service returned an error. Please try again.' });
    }

    const data = await geminiRes.json();
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!answer) {
      return res.status(502).json({ error: 'No answer was returned. Please try again.' });
    }

    return res.status(200).json({ answer });
  } catch (err) {
    console.error('ask-ai function error:', err);
    return res.status(500).json({ error: 'Something went wrong reaching the AI service.' });
  }
}
