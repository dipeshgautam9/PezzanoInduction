// api/ask-ai.js
// Auth: Google Service Account JWT (permanent, never expires)
// Set in Vercel environment variables:
//   GEMINI_CLIENT_EMAIL = projects-59199348167@gen-lang-client-0113633451.iam.gserviceaccount.com
//   GEMINI_PRIVATE_KEY  = -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
//   GEMINI_PROJECT_ID   = gen-lang-client-0113633451

const MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-001',
  'gemini-1.5-flash-002',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
];

let _cachedToken = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && now < _tokenExpiry) return _cachedToken;

  const clientEmail = process.env.GEMINI_CLIENT_EMAIL;
  const privateKeyRaw = process.env.GEMINI_PRIVATE_KEY;
  if (!clientEmail || !privateKeyRaw) {
    throw new Error('GEMINI_CLIENT_EMAIL and GEMINI_PRIVATE_KEY must be set in Vercel environment variables.');
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

  function b64url(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
  }

  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss:   clientEmail,
    scope: 'https://www.googleapis.com/auth/generative-language',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };

  const unsigned = `${b64url(header)}.${b64url(payload)}`;

  const keyBuf = Buffer.from(
    privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, ''),
    'base64'
  );
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBuf,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, Buffer.from(unsigned));
  const jwt = `${unsigned}.${Buffer.from(sig).toString('base64url')}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    signal: AbortSignal.timeout(10000)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${err.substring(0, 200)}`);
  }

  const data = await resp.json();
  _cachedToken = data.access_token;
  _tokenExpiry = now + 3500;
  return _cachedToken;
}

async function buildRequest(model, bodyStr) {
  // Prefer service account JWT
  if (process.env.GEMINI_CLIENT_EMAIL && process.env.GEMINI_PRIVATE_KEY) {
    const token = await getAccessToken();
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: bodyStr
    };
  }
  // Fallback: API key or AQ. bearer token
  const apiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) throw new Error('No Gemini credentials. Set GEMINI_CLIENT_EMAIL + GEMINI_PRIVATE_KEY in Vercel.');
  const isBearer = apiKey.startsWith('AQ.') || apiKey.startsWith('ya29.');
  return {
    url: isBearer
      ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    headers: isBearer
      ? { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }
      : { 'Content-Type': 'application/json' },
    body: bodyStr
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
- Only use the product data above — do not invent Pezzano-specific policies.

QUESTION: ${question.trim()}`;

  const bodyStr = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 300 }
  });

  const errors = [];
  let lastErrorMsg = 'AI service unavailable — check Vercel function logs.';

  for (const model of MODELS) {
    let reqObj;
    try {
      reqObj = await buildRequest(model, bodyStr);
    } catch (e) {
      lastErrorMsg = e.message;
      console.error('ask-ai buildRequest error:', e.message);
      break; // credential error — no point trying other models
    }

    let r;
    try {
      r = await fetch(reqObj.url, {
        method: 'POST', headers: reqObj.headers, body: reqObj.body,
        signal: AbortSignal.timeout(20000)
      });
    } catch (e) { errors.push(`${model}: ${e?.message}`); continue; }

    if (r.status === 404) { errors.push(`${model}: 404`); continue; }
    if (r.status === 429) { errors.push(`${model}: 429 quota`); continue; }
    if (r.status === 401) {
      _cachedToken = null;
      errors.push(`${model}: 401 auth`);
      continue;
    }

    if (!r.ok) {
      const errText = await r.text();
      console.error(`ask-ai HTTP ${r.status} from ${model}:`, errText.substring(0, 300));
      if (r.status === 403) return res.status(502).json({ error: 'API credentials do not have permission. Check your Vercel environment variables.' });
      errors.push(`${model}: ${r.status}`);
      continue;
    }

    const data = await r.json();
    const answer = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    if (!answer) {
      console.error('ask-ai: empty response from', model);
      errors.push(`${model}: empty response`);
      continue;
    }

    console.log(`ask-ai: success with ${model}`);
    return res.status(200).json({ answer });
  }

  console.error('ask-ai: ALL models failed. Errors:', errors.join(' | '));
  return res.status(502).json({ error: lastErrorMsg });
}
