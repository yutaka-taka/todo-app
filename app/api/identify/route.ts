import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';

const PROMPT = `あなたは日本のごみ分別の専門家です。画像に写っているものを詳しく観察し、それが何であるか特定してください。

## 手順
1. 画像に写っているものを詳細に観察する（色・形・素材・ラベルなど）
2. 最も可能性の高いごみの品名を特定する
3. 品名を日本語で答える

## 回答ルール
- 品名のみを答える（説明・理由は不要）
- 10文字以内の日本語で答える
- できるだけ具体的な品名にする

## 回答例
ペットボトル / アルミ缶 / スチール缶 / ガラスびん / 新聞紙 / 段ボール / 雑誌 / 生ごみ / 食品トレイ / 電池 / 蛍光灯 / 電球 / スプレー缶 / 傘 / 包丁 / 鍋 / 衣類 / 電子機器 / 自転車 / 家具 / など

## 識別できない場合のみ
画像が不鮮明・ごみが写っていない・判断できない場合は「不明」とだけ答えてください。`;

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
      model: 'claude-sonnet-4-6',
      max_tokens: 30,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: image },
            },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    });

    const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : '不明';
    // 余分な説明文が含まれた場合、最初の単語（品名）だけ取り出す
    const text = raw.split(/[\n。、,，]/)[0].trim().slice(0, 15) || '不明';
    return Response.json({ result: text });
  } catch {
    return Response.json({ result: '不明' });
  }
}
