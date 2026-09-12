// api/ask-ai.js
// Auth: Google Service Account JWT (permanent, never expires)
// Environment variables required in Vercel:
//   GEMINI_PROJECT_ID   = gen-lang-client-0113633451
//   GEMINI_CLIENT_EMAIL = projects-59199348167@gen-lang-client-0113633451.iam.gserviceaccount.com
//   GEMINI_PRIVATE_KEY  = -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n

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

// ── Service Account JWT Authentication ───────────────────────────────────────
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

  // Replace literal \n string with actual newline characters
  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/generative-language',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  function b64url(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
  }

  const unsigned = `${b64url(header)}.${b64url(payload)}`;

  const keyBuf = Buffer.from(
    privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, ''),
    'base64'
  );

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuf,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
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
  _tokenExpiry = now + 3500; // Cache token for ~58 minutes
  return _cachedToken;
}

// ── Request Builder ─────────────────────────────────────────────────────────
async function buildGeminiRequest(model, bodyStr) {
  if (process.env.GEMINI_CLIENT_EMAIL && process.env.GEMINI_PRIVATE_KEY) {
    const token = await getAccessToken();
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: bodyStr
    };
  }

  // Fallback to legacy GEMINI_API_KEY
  const apiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) throw new Error('No Gemini credentials found. Set GEMINI_CLIENT_EMAIL + GEMINI_PRIVATE_KEY in Vercel.');

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

// ── Main Handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, context } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

  const fullPrompt = context ? `Context:\n${context}\n\nQuestion: ${prompt}` : prompt;
  const bodyObj = {
    contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 600 }
  };
  const bodyStr = JSON.stringify(bodyObj);

  const errors = [];
  for (const model of MODELS) {
    let reqConfig;
    try {
      reqConfig = await buildGeminiRequest(model, bodyStr);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    try {
      const r = await fetch(reqConfig.url, {
        method: 'POST',
        headers: reqConfig.headers,
        body: reqConfig.body,
        signal: AbortSignal.timeout(20000)
      });

      if (r.status === 404) { errors.push(`${model}: 404`); continue; }
      if (r.status === 429) { errors.push(`${model}: 429 quota`); continue; }
      if (r.status === 401) {
        _cachedToken = null;
        errors.push(`${model}: 401 auth`);
        continue;
      }

      if (!r.ok) {
        const errTxt = await r.text();
        errors.push(`${model}: HTTP ${r.status} - ${errTxt.substring(0, 100)}`);
        continue;
      }

      const data = await r.json();
      const answer = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (answer) {
        return res.status(200).json({ answer });
      }
    } catch (e) {
      errors.push(`${model}: ${e?.message}`);
    }
  }

  console.error('ask-ai ALL models failed:', errors.join(' | '));
  return res.status(502).json({ error: 'AI service unavailable. Please check your Vercel logs.' });
}
