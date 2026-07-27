// api/ask-ai.js
// Vercel Serverless Function. Reads OPENAI_API_KEY server-side (never exposed
// to the browser) and answers a staff question using ONLY the product's own
// accept/reject data sent up from the portal — not general knowledge.
//
// Add this file at: api/ask-ai.js in your repo root (same level as portal.html).
// Vercel auto-detects anything under /api as a serverless function — no
// framework or build step required.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not set on this Vercel project.' });
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
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question.trim() }
        ]
      })
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('OpenAI error:', errText);
      return res.status(502).json({ error: 'The AI service returned an error. Please try again.' });
    }

    const data = await openaiRes.json();
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      return res.status(502).json({ error: 'No answer was returned. Please try again.' });
    }

    return res.status(200).json({ answer });
  } catch (err) {
    console.error('ask-ai function error:', err);
    return res.status(500).json({ error: 'Something went wrong reaching the AI service.' });
  }
}
