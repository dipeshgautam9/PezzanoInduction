// app/api/check-photo/route.ts
// Next.js App Router — POST handler
// Auth: Google Service Account JWT (permanent, never expires)
// Set in Vercel environment variables:
//   GEMINI_CLIENT_EMAIL  = projects-59199348167@gen-lang-client-0113633451.iam.gserviceaccount.com
//   GEMINI_PRIVATE_KEY   = -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
//   GEMINI_PROJECT_ID    = gen-lang-client-0113633451

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 60; // seconds — Vercel Pro allows up to 60s

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

// ── Token cache ─────────────────────────────────────────────────────────────
let _cachedToken: string | null = null;
let _tokenExpiry = 0;

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && now < _tokenExpiry) return _cachedToken;

  const clientEmail = process.env.GEMINI_CLIENT_EMAIL;
  const privateKeyRaw = process.env.GEMINI_PRIVATE_KEY;
  if (!clientEmail || !privateKeyRaw) {
    throw new Error('GEMINI_CLIENT_EMAIL and GEMINI_PRIVATE_KEY must be set in Vercel environment variables.');
  }

  // Vercel stores \n as literal backslash-n — fix them
  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

  function b64url(obj: object): string {
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
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${err.substring(0, 200)}`);
  }

  const data = await resp.json();
  _cachedToken = data.access_token;
  _tokenExpiry = now + 3500; // refresh 100s before actual expiry
  return _cachedToken!;
}

interface GeminiReq { url: string; headers: Record<string, string>; body: string; }

async function buildRequest(model: string, bodyStr: string): Promise<GeminiReq> {
  if (process.env.GEMINI_CLIENT_EMAIL && process.env.GEMINI_PRIVATE_KEY) {
    const token = await getAccessToken();
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: bodyStr,
    };
  }
  // Fallback: raw API key or AQ. bearer
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
    body: bodyStr,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function splitDataUrl(dataUrl: string) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

async function resizeBase64(mimeType: string, base64: string, maxDim = 1024) {
  try {
    const sharp = (await import('sharp').catch(() => null))?.default;
    if (!sharp) return { mimeType, base64 };
    const buf = Buffer.from(base64, 'base64');
    const resized = await sharp(buf)
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { mimeType: 'image/jpeg', base64: resized.toString('base64') };
  } catch { return { mimeType, base64 }; }
}

async function urlToBase64(url: string) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) { console.error(`urlToBase64 HTTP ${resp.status}`); return null; }
    const buf = await resp.arrayBuffer();
    const mimeType = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0];
    return { mimeType, base64: Buffer.from(buf).toString('base64') };
  } catch (e: any) { console.error('urlToBase64:', e?.message); return null; }
}

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

async function callGemini(parts: Part[], maxTokens = 400): Promise<{ response: Response | null; model?: string; errorMsg?: string }> {
  const errors: string[] = [];
  const bodyObj = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens },
  };

  for (const model of MODELS) {
    let reqObj: GeminiReq;
    try {
      reqObj = await buildRequest(model, JSON.stringify(bodyObj));
    } catch (e: any) {
      return { response: null, errorMsg: e.message };
    }

    let r: Response;
    try {
      r = await fetch(reqObj.url, {
        method: 'POST', headers: reqObj.headers, body: reqObj.body,
        signal: AbortSignal.timeout(25000),
      });
    } catch (e: any) { errors.push(`${model}: ${e?.message}`); continue; }

    if (r.status === 404) { errors.push(`${model}: 404`); continue; }
    if (r.status === 429) { errors.push(`${model}: 429 quota`); continue; }
    if (r.status === 401) { _cachedToken = null; errors.push(`${model}: 401`); continue; }

    console.log(`check-photo: using ${model} HTTP ${r.status}`);
    return { response: r, model };
  }

  console.error('check-photo ALL models failed:', errors.join(' | '));
  return { response: null, errorMsg: 'AI service unavailable — check Vercel function logs for details.' };
}

function parseJSON(raw: string) {
  raw = (raw || '').replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      staffPhoto, product,
      referenceGoodUrl, referenceRejectUrl, textOnlyMode,
      identifyMode, identifyCandidates,
    } = body;

    if (!staffPhoto) return NextResponse.json({ error: 'A staff photo is required.' }, { status: 400 });

    // ── MODE 1: Identify product ──────────────────────────────────────────────
    if (identifyMode) {
      if (!identifyCandidates?.length) return NextResponse.json({ error: 'No candidate products provided.' }, { status: 400 });

      const staffImgRaw = splitDataUrl(staffPhoto);
      if (!staffImgRaw) return NextResponse.json({ error: 'Photo format not readable.' }, { status: 400 });
      const staffImg = await resizeBase64(staffImgRaw.mimeType, staffImgRaw.base64, 900);

      // Step 1: guess category (fast — no reference images needed)
      const categories = [...new Set<string>(identifyCandidates.map((c: any) => c.category).filter(Boolean))];
      let filteredCandidates = identifyCandidates;

      if (categories.length > 1) {
        try {
          const catParts: Part[] = [
            { text: `Look at this product photo. Which ONE category from the list below best describes what you see?\nCategories: ${categories.join(', ')}\nReturn ONLY the exact category name — nothing else.` },
            { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } },
          ];
          const { response: catRes } = await callGemini(catParts, 30);
          if (catRes?.ok) {
            const catData = await catRes.json();
            const guess = (catData.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
            console.log('identify step1 guess:', guess);
            const matched = categories.find((c: string) =>
              c.toLowerCase() === guess.toLowerCase() ||
              guess.toLowerCase().includes(c.toLowerCase()) ||
              c.toLowerCase().includes(guess.toLowerCase())
            );
            if (matched) {
              const inCat = identifyCandidates.filter((c: any) => c.category === matched);
              if (inCat.length > 0 && inCat.length < identifyCandidates.length) {
                console.log(`identify: narrowed to ${inCat.length} in "${matched}"`);
                filteredCandidates = inCat;
              }
            }
          }
        } catch (e: any) { console.warn('identify step1 failed:', e?.message); }
      }

      // Step 2: visual match against narrowed set (max 20)
      const refs = (await Promise.all(
        filteredCandidates.slice(0, 20).map(async (c: any) => {
          if (!c.referenceUrl) return null;
          const img = await urlToBase64(c.referenceUrl);
          if (!img) return null;
          const resized = await resizeBase64(img.mimeType, img.base64, 480);
          return { id: c.id, name: c.name, img: resized };
        })
      )).filter(Boolean) as { id: string; name: string; img: { mimeType: string; base64: string } }[];

      if (!refs.length) return NextResponse.json({ error: 'Could not load reference photos. Check your connection.' }, { status: 502 });

      console.log(`identify step2: visual compare against ${refs.length} products`);

      const parts: Part[] = [
        {
          text: `You are a product identification assistant for Pezzano Enterprises warehouse in Perth, WA.\n\nA staff member has taken a photo of a product. Identify WHICH product it is by visually comparing the staff photo against each reference photo below.\n\nLook at: shape, colour, size, texture, packaging, labels, visible text.\n\nCANDIDATES (${refs.length} products):\n${refs.map((r, i) => `${i + 1}. Name: "${r.name}" | ID: "${r.id}"`).join('\n')}\n\nRules:\n- Compare the STAFF PHOTO carefully against EACH reference photo.\n- Return ONLY valid JSON, no markdown.\n- If confident (>35%): {"productId":"<exact id>","productName":"<exact name>","confidence":0.0-1.0}\n- If no match: {"productId":null,"productName":null,"confidence":0}\n\nSTAFF PHOTO (identify this):`
        },
        { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } },
        { text: '--- REFERENCE PHOTOS ---' },
      ];
      for (const ref of refs) {
        parts.push({ text: `"${ref.name}" (ID: ${ref.id})` });
        parts.push({ inline_data: { mime_type: ref.img.mimeType, data: ref.img.base64 } });
      }

      const { response: geminiRes, errorMsg } = await callGemini(parts, 120);
      if (!geminiRes) return NextResponse.json({ error: errorMsg || 'AI unavailable.' }, { status: 502 });
      if (!geminiRes.ok) return NextResponse.json({ error: `AI error (${geminiRes.status}). Try again.` }, { status: 502 });

      const gdata = await geminiRes.json();
      const raw = (gdata.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      console.log('identify raw:', raw.substring(0, 200));

      const parsed = parseJSON(raw);
      if (parsed) return NextResponse.json({ productId: parsed.productId || null, productName: parsed.productName || null, confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0 });
      const idM = raw.match(/"productId"\s*:\s*"([^"]+)"/);
      const nmM = raw.match(/"productName"\s*:\s*"([^"]+)"/);
      const cfM = raw.match(/"confidence"\s*:\s*([\d.]+)/);
      return NextResponse.json({ productId: idM?.[1] || null, productName: nmM?.[1] || null, confidence: cfM ? parseFloat(cfM[1]) : 0 });
    }

    // ── MODE 2: Quality check ─────────────────────────────────────────────────
    if (!product?.name) return NextResponse.json({ error: 'Product context is required.' }, { status: 400 });
    if (!referenceGoodUrl && !textOnlyMode) return NextResponse.json({ error: 'No reference photo yet — upload one from Edit Product first.' }, { status: 400 });

    const staffImgRaw = splitDataUrl(staffPhoto);
    if (!staffImgRaw) return NextResponse.json({ error: 'Photo format not readable.' }, { status: 400 });
    const staffImg = await resizeBase64(staffImgRaw.mimeType, staffImgRaw.base64, 1024);

    const productInfo = `Product: ${product.name}\nCategory: ${product.category || 'unknown'}\nDepartment: ${product.department || 'unknown'}\nAccept criteria: ${product.description || 'not recorded'}\nReject criteria: ${product.reject_note || 'not recorded'}\nKeywords: ${product.keywords || 'none'}`;
    const jsonSchema = `Respond with STRICT JSON ONLY:\n{"verdict":"pass"|"fail"|"uncertain","confidence":0.0-1.0,"similarity":0-100,"explanation":"1-2 plain sentences for warehouse staff","breakdown":[{"label":"Colour","ok":true}]}\nbreakdown: up to 5 visual attributes you can actually see.`;

    let parts: Part[];

    if (textOnlyMode || !referenceGoodUrl) {
      parts = [
        { text: `You are the Pezzano Quality Assistant. Assess from criteria text and visual judgement.\n\n${productInfo}\n\nsimilarity (0-100): how closely the batch matches an acceptable version.\n\n${jsonSchema}` },
        { text: 'STAFF PHOTO:' },
        { inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } },
      ];
    } else {
      const goodImgRaw = await urlToBase64(referenceGoodUrl);
      if (!goodImgRaw) return NextResponse.json({ error: 'Could not load reference photo — it may have expired. Refresh and try again.' }, { status: 502 });
      const goodImg = await resizeBase64(goodImgRaw.mimeType, goodImgRaw.base64, 1024);

      parts = [
        { text: `You are the Pezzano Quality Assistant. Compare STAFF PHOTO against the reference and give a quality verdict.\n\n${productInfo}\n\nRules: judge on colour, damage, ripeness, shape, blemishes. If too dark/blurry return "uncertain". Be direct.\n\nsimilarity (0-100): how closely staff photo matches GOOD reference.\n\n${jsonSchema}` },
        { text: `REFERENCE — GOOD ${product.name}:` },
        { inline_data: { mime_type: goodImg.mimeType, data: goodImg.base64 } },
      ];

      if (referenceRejectUrl) {
        const rjRaw = await urlToBase64(referenceRejectUrl);
        if (rjRaw) {
          const rjImg = await resizeBase64(rjRaw.mimeType, rjRaw.base64, 1024);
          parts.push({ text: `REFERENCE — REJECTED ${product.name}:` });
          parts.push({ inline_data: { mime_type: rjImg.mimeType, data: rjImg.base64 } });
        }
      }
      parts.push({ text: 'STAFF PHOTO — assess this:' });
      parts.push({ inline_data: { mime_type: staffImg.mimeType, data: staffImg.base64 } });
    }

    const { response: geminiRes, errorMsg } = await callGemini(parts, 400);
    if (!geminiRes) return NextResponse.json({ error: errorMsg || 'AI unavailable.' }, { status: 502 });
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error(`quality check HTTP ${geminiRes.status}:`, errText.substring(0, 300));
      if (geminiRes.status === 400) return NextResponse.json({ error: 'Photo could not be processed — try a smaller or clearer photo.' }, { status: 502 });
      return NextResponse.json({ error: `AI error (${geminiRes.status}). Please try again.` }, { status: 502 });
    }

    const gdata = await geminiRes.json();
    const raw = (gdata.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    if (!raw) return NextResponse.json({ error: 'AI returned an empty response. Please try again.' }, { status: 502 });

    const parsed = parseJSON(raw);
    if (!parsed) {
      const vm = raw.match(/"verdict"\s*:\s*"(pass|fail|uncertain)"/i);
      const em = raw.match(/"explanation"\s*:\s*"([^"]+)"/);
      const cm = raw.match(/"confidence"\s*:\s*([\d.]+)/);
      const sm = raw.match(/"similarity"\s*:\s*(\d+)/);
      if (vm) return NextResponse.json({ verdict: vm[1].toLowerCase(), confidence: cm ? parseFloat(cm[1]) : null, similarity: sm ? parseInt(sm[1]) : null, explanation: em?.[1] || '', breakdown: [] });
      return NextResponse.json({ error: 'Could not read the AI response. Please try again.' }, { status: 502 });
    }

    return NextResponse.json({
      verdict:     ['pass','fail','uncertain'].includes(parsed.verdict) ? parsed.verdict : 'uncertain',
      confidence:  typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : null,
      similarity:  typeof parsed.similarity === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.similarity))) : null,
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
      breakdown:   (Array.isArray(parsed.breakdown) ? parsed.breakdown : []).filter((b: any) => b && typeof b.label === 'string' && typeof b.ok === 'boolean').slice(0, 5),
    });

  } catch (err: any) {
    console.error('check-photo unhandled error:', err?.message || err);
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}
