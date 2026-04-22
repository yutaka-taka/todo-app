import { NextRequest } from 'next/server';

const PROMPT = `この写真に写っているものを、ごみとして分別するための品名を日本語で1つだけ答えてください。

以下の候補から最も近いものを選んでください：
ペットボトル、空き缶、びん、段ボール、新聞紙、雑誌、紙パック、発泡スチロール、プラ容器、
生ごみ、乾電池、蛍光灯、電球、スプレー缶、ライター、カセットボンベ、
テレビ、冷蔵庫、洗濯機、エアコン、パソコン、スマートフォン、携帯電話、電子レンジ、掃除機、
ドライヤー、アイロン、電気ケトル、リモコン、充電器、ゲーム機、
自転車、傘、家具、いす、テーブル、ベッド、ソファ、本棚、
衣類、靴、かばん、布団、毛布、
陶磁器、皿、コップ、鍋、フライパン、包丁、
ゴム、タイヤ、電池

候補にない場合は最も近い日本語のごみ名称を短く答えてください。
ごみ品名のみを返してください。説明・理由は不要です。識別できない場合のみ「不明」と返してください。`;

async function tryGemini(image: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: PROMPT },
              { inline_data: { mime_type: 'image/jpeg', data: image } },
            ],
          }],
          generationConfig: { maxOutputTokens: 30, temperature: 0 },
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    if (!text || text === '不明') return null;
    // 改行・余分な句読点を除去して最初の品名のみ返す
    return text.split(/[\n。、]/)[0].trim();
  } catch {
    return null;
  }
}

// Google Cloud Vision API フォールバック
const LABEL_MAP: [string, string][] = [
  ['plastic bottle', 'ペットボトル'], ['pet bottle', 'ペットボトル'], ['water bottle', 'ペットボトル'],
  ['glass bottle', 'びん'], ['beer bottle', 'びん'], ['wine bottle', 'びん'],
  ['aluminum can', '空き缶'], ['aluminium can', '空き缶'], ['tin can', '空き缶'], ['beverage can', '空き缶'],
  ['milk carton', '紙パック'], ['juice carton', '紙パック'],
  ['cardboard box', '段ボール'], ['corrugated box', '段ボール'], ['cardboard', '段ボール'],
  ['newspaper', '新聞紙'], ['magazine', '雑誌'], ['book', '雑誌'],
  ['styrofoam', '発泡スチロール'], ['polystyrene', '発泡スチロール'],
  ['plastic container', 'プラ容器'], ['food container', 'プラ容器'], ['plastic bag', 'プラ容器'], ['plastic tray', 'プラ容器'],
  ['dry cell battery', '乾電池'], ['alkaline battery', '乾電池'], ['battery', '乾電池'],
  ['fluorescent lamp', '蛍光灯'], ['fluorescent light', '蛍光灯'], ['light bulb', '電球'],
  ['aerosol can', 'スプレー缶'], ['spray can', 'スプレー缶'], ['aerosol', 'スプレー缶'],
  ['cigarette lighter', 'ライター'], ['lighter', 'ライター'],
  ['mobile phone', '携帯電話'], ['smartphone', 'スマートフォン'], ['cell phone', '携帯電話'],
  ['laptop', 'パソコン'], ['computer', 'パソコン'], ['television', 'テレビ'],
  ['washing machine', '洗濯機'], ['refrigerator', '冷蔵庫'], ['microwave', '電子レンジ'],
  ['vacuum cleaner', '掃除機'], ['hair dryer', 'ドライヤー'], ['electric iron', 'アイロン'],
  ['bicycle', '自転車'], ['umbrella', '傘'],
  ['sofa', 'ソファ'], ['chair', 'いす'], ['table', 'テーブル'], ['bed', 'ベッド'],
  ['clothing', '衣類'], ['shoes', '靴'], ['bag', 'かばん'], ['blanket', '毛布'],
  ['ceramic', '陶磁器'], ['frying pan', 'フライパン'], ['pot', '鍋'],
  ['tire', 'タイヤ'], ['bottle', 'びん'], ['can', '空き缶'],
  ['electronic device', '小型家電'], ['electronics', '小型家電'],
  ['plastic', 'プラ容器'], ['glass', 'びん'], ['metal', '空き缶'],
  ['paper', '紙'], ['food', '生ごみ'], ['carton', '紙パック'],
];

async function tryVision(image: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: image },
            features: [
              { type: 'OBJECT_LOCALIZATION', maxResults: 10 },
              { type: 'LABEL_DETECTION', maxResults: 20 },
              { type: 'TEXT_DETECTION', maxResults: 1 },
            ],
          }],
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const ann = data.responses?.[0] ?? {};

    // OCR テキスト（日本語）優先
    const fullText: string = ann.textAnnotations?.[0]?.description ?? '';
    const jpKeywords: [string, string][] = [
      ['乾電池', '乾電池'], ['電池', '乾電池'], ['蛍光灯', '蛍光灯'], ['ライター', 'ライター'],
      ['スプレー缶', 'スプレー缶'], ['スプレー', 'スプレー缶'], ['ペットボトル', 'ペットボトル'],
      ['段ボール', '段ボール'], ['新聞紙', '新聞紙'], ['雑誌', '雑誌'],
      ['紙パック', '紙パック'], ['発泡スチロール', '発泡スチロール'],
    ];
    for (const [kw, ja] of jpKeywords) {
      if (fullText.includes(kw)) return ja;
    }

    // 物体・ラベル照合（信頼度フィルタなし）
    const objects: string[] = (ann.localizedObjectAnnotations ?? []).map((o: { name: string }) => o.name.toLowerCase());
    const labels: string[] = (ann.labelAnnotations ?? []).map((l: { description: string }) => l.description.toLowerCase());

    for (const candidate of [...objects, ...labels]) {
      for (const [key, ja] of LABEL_MAP) {
        if (candidate === key || candidate.includes(key)) return ja;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const { image } = await req.json();
  if (!image) return Response.json({ result: '不明' }, { status: 400 });

  // Gemini API キー（専用 or Vision キーを兼用）
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_VISION_API_KEY;
  const visionKey = process.env.GOOGLE_VISION_API_KEY;

  if (!geminiKey && !visionKey) {
    return Response.json({ result: '不明', error: 'APIキーが未設定です' });
  }

  // 1. Gemini Vision（高精度・日本語直接応答）
  if (geminiKey) {
    const geminiResult = await tryGemini(image, geminiKey);
    if (geminiResult) return Response.json({ result: geminiResult });
  }

  // 2. Google Cloud Vision（フォールバック）
  if (visionKey) {
    const visionResult = await tryVision(image, visionKey);
    if (visionResult) return Response.json({ result: visionResult });
  }

  return Response.json({ result: '不明' });
}
