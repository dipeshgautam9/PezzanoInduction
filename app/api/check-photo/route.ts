import { NextRequest, NextResponse } from '@vercel/serverless';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini API client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

async function fetchImageAsBase64(url: string): Promise<{ inlineData: { data: string; mimeType: string } } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Determine MIME type dynamically from header or fallback to jpeg
    const mimeType = response.headers.get('content-type') || 'image/jpeg';
    
    return {
      inlineData: {
        data: buffer.toString('base64'),
        mimeType: mimeType.split(';')[0] // Ensure clean mimeType format
      }
    };
  } catch (err) {
    console.error(`Failed to fetch image from ${url}:`, err);
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { photoUrls, prompt } = body;

    if (!photoUrls || !Array.isArray(photoUrls) || photoUrls.length === 0) {
      return NextResponse.json({ error: 'No photo URLs provided' }, { status: 400 });
    }

    // 1. Limit max images per single prompt to avoid hitting Gemini payload limits (Max ~5-10 recommended)
    const MAX_IMAGES = 10;
    const urlsToProcess = photoUrls.slice(0, MAX_IMAGES);

    // 2. Fetch images concurrently and filter out failed fetches
    const imageParts = (
      await Promise.all(urlsToProcess.map((url: string) => fetchImageAsBase64(url)))
    ).filter((item): item is NonNullable<typeof item> => item !== null);

    if (imageParts.length === 0) {
      return NextResponse.json({ error: 'Failed to process any provided images' }, { status: 400 });
    }

    // 3. Request Gemini Model
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    
    const userPrompt = prompt || 'Analyze these product photos for quality and compliance.';
    
    const result = await model.generateContent([
      userPrompt,
      ...imageParts
    ]);

    const text = result.response.text();

    return NextResponse.json({ success: true, result: text });
  } catch (error: any) {
    console.error('API /check-photo Error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
