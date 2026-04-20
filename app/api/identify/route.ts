import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';

const PROMPT = `あなたは日本のごみ分別の専門家です。写真に写っているものを識別してください。

## 識別のポイント
- 素材（プラスチック・金属・ガラス・紙・布など）を見る
- 形・色・サイズを観察する
- ラベルや文字があれば読む
- 部分的に写っていても推測する
- 日常的なごみを積極的に識別する

## 回答形式
品名のみを10文字以内で答えてください。例：
ペットボトル・空き缶・ビン・牛乳パック・新聞紙・段ボール・雑誌・生ごみ・食品トレイ・プラ容器・乾電池・蛍光灯・電球・スプレー缶・ライター・傘・包丁・鍋・フライパン・家電・衣類・靴・ペットボトルのキャップ・割り箸・紙コップ・プラスチックバッグ・ラップ・発泡スチロール・ガラス

## 重要
- 多少不鮮明でも積極的に識別する
- 「不明」は本当に何も判断できない場合のみ使う
- 品名だけ答える（説明不要）`;

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
