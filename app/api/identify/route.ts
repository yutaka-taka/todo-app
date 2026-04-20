import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  const { image } = await req.json();
  if (!image) {
    return Response.json({ result: '不明' }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ result: '不明', error: 'API key not configured' });
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: image },
            },
            {
              type: 'text',
              text: 'この画像に写っているごみ・廃棄物の種類を日本語で答えてください。ごみの名前だけを1〜10文字で答えてください。例：ペットボトル、空き缶、新聞紙、段ボール、生ごみ、電池、蛍光灯、スプレー缶、など。識別できない場合は「不明」とだけ答えてください。',
            },
          ],
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '不明';
    return Response.json({ result: text });
  } catch {
    return Response.json({ result: '不明' });
  }
}
