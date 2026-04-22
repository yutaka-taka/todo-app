import { NextRequest } from 'next/server';

export const maxDuration = 30;

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

// gemini-2.5-flash のみ動作確認済み（他モデルはこのプロジェクトで quota=0）
const GEMINI_MODEL = 'gemini-2.5-flash';

async function tryGemini(image: string, apiKey: string): Promise<{ result: string | null; log: string }> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: 'image/jpeg', data: image } },
          ],
        }],
        generationConfig: {
          maxOutputTokens: 30,
          temperature: 0,
          thinkingConfig: { thinkingBudget: 0 }, // 思考モードOFF（高速化）
        },
      }),
    });

    const body = await res.text();
    if (!res.ok) {
      console.error(`[identify] Gemini error ${res.status}:`, body.slice(0, 400));
      return { result: null, log: `Gemini HTTP ${res.status}: ${body.slice(0, 100)}` };
    }

    const data = JSON.parse(body);
    const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    if (!text || text === '不明') {
      console.log('[identify] Gemini returned empty/不明');
      return { result: null, log: 'Gemini: 識別不可' };
    }
    const result = text.split(/[\n。、\s]/)[0].trim();
    console.log('[identify] Gemini result:', result);
    return { result, log: `Gemini: ${result}` };
  } catch (e) {
    console.error('[identify] Gemini exception:', e);
    return { result: null, log: `Gemini exception: ${e}` };
  }
}

// Google Cloud Vision フォールバック
const LABEL_MAP: [string, string][] = [
  ['plastic bottle', 'ペットボトル'], ['pet bottle', 'ペットボトル'], ['water bottle', 'ペットボトル'],
  ['glass bottle', 'びん'], ['beer bottle', 'びん'], ['wine bottle', 'びん'],
  ['aluminum can', '空き缶'], ['aluminium can', '空き缶'], ['tin can', '空き缶'], ['beverage can', '空き缶'],
  ['milk carton', '紙パック'], ['juice carton', '紙パック'], ['carton', '紙パック'],
  ['cardboard box', '段ボール'], ['corrugated box', '段ボール'], ['cardboard', '段ボール'],
  ['newspaper', '新聞紙'], ['magazine', '雑誌'], ['book', '雑誌'],
  ['styrofoam', '発泡スチロール'], ['polystyrene', '発泡スチロール'], ['foam', '発泡スチロール'],
  ['plastic container', 'プラ容器'], ['food container', 'プラ容器'], ['plastic bag', 'プラ容器'],
  ['plastic tray', 'プラ容器'], ['plastic wrap', 'プラ容器'], ['packaging', 'プラ容器'],
  ['dry cell battery', '乾電池'], ['alkaline battery', '乾電池'], ['battery', '乾電池'],
  ['fluorescent lamp', '蛍光灯'], ['fluorescent light', '蛍光灯'], ['light bulb', '電球'], ['led bulb', '電球'],
  ['aerosol can', 'スプレー缶'], ['spray can', 'スプレー缶'], ['aerosol', 'スプレー缶'],
  ['cigarette lighter', 'ライター'], ['lighter', 'ライター'],
  ['mobile phone', '携帯電話'], ['smartphone', 'スマートフォン'], ['cell phone', '携帯電話'],
  ['laptop computer', 'パソコン'], ['laptop', 'パソコン'], ['desktop computer', 'パソコン'],
  ['television', 'テレビ'], ['flat screen', 'テレビ'],
  ['washing machine', '洗濯機'], ['refrigerator', '冷蔵庫'], ['fridge', '冷蔵庫'],
  ['microwave oven', '電子レンジ'], ['microwave', '電子レンジ'],
  ['vacuum cleaner', '掃除機'], ['hair dryer', 'ドライヤー'], ['electric iron', 'アイロン'],
  ['air conditioner', 'エアコン'], ['electric fan', '扇風機'],
  ['game console', 'ゲーム機'], ['remote control', 'リモコン'],
  ['bicycle', '自転車'], ['bike', '自転車'], ['umbrella', '傘'],
  ['sofa', 'ソファ'], ['couch', 'ソファ'], ['chair', 'いす'], ['table', 'テーブル'],
  ['bed', 'ベッド'], ['mattress', 'マットレス'], ['bookshelf', '本棚'],
  ['clothing', '衣類'], ['jacket', '衣類'], ['shirt', '衣類'], ['coat', '衣類'],
  ['shoes', '靴'], ['footwear', '靴'], ['sneakers', '靴'],
  ['handbag', 'かばん'], ['backpack', 'かばん'], ['bag', 'かばん'],
  ['blanket', '毛布'], ['pillow', '布団類'], ['futon', '布団'],
  ['ceramic', '陶磁器'], ['porcelain', '陶磁器'],
  ['frying pan', 'フライパン'], ['pot', '鍋'], ['saucepan', '鍋'], ['cookware', '鍋'],
  ['plate', '皿'], ['dish', '皿'], ['bowl', '食器'], ['cup', 'コップ'],
  ['tire', 'タイヤ'], ['tyre', 'タイヤ'], ['rubber', 'ゴム'],
  ['bottle', 'びん'], ['can', '空き缶'], ['jar', 'びん'],
  ['electronic device', '小型家電'], ['electronics', '小型家電'], ['gadget', '小型家電'],
  ['plastic', 'プラ容器'], ['glass', 'びん'], ['metal', '空き缶'],
  ['paper', '紙'], ['food', '生ごみ'], ['vegetable', '生ごみ'], ['fruit', '生ごみ'],
  ['computer', 'パソコン'],
];

const JP_KEYWORDS: [string, string][] = [
  ['乾電池', '乾電池'], ['電池', '乾電池'], ['蛍光灯', '蛍光灯'], ['ライター', 'ライター'],
  ['スプレー缶', 'スプレー缶'], ['スプレー', 'スプレー缶'], ['ペットボトル', 'ペットボトル'],
  ['段ボール', '段ボール'], ['新聞紙', '新聞紙'], ['雑誌', '雑誌'],
  ['紙パック', '紙パック'], ['発泡スチロール', '発泡スチロール'],
  ['プラスチック', 'プラ容器'], ['スマートフォン', 'スマートフォン'],
];

async function tryVision(image: string, apiKey: string): Promise<{ result: string | null; log: string }> {
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
              { type: 'WEB_DETECTION', maxResults: 5 },
            ],
          }],
        }),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      console.error('[identify] Vision error:', res.status, body.slice(0, 200));
      return { result: null, log: `Vision: HTTP ${res.status}` };
    }

    const data = await res.json();
    const ann = data.responses?.[0] ?? {};

    // OCR テキスト（日本語優先）
    const fullText: string = ann.textAnnotations?.[0]?.description ?? '';
    for (const [kw, ja] of JP_KEYWORDS) {
      if (fullText.includes(kw)) {
        console.log('[identify] Vision OCR match:', kw, '->', ja);
        return { result: ja, log: `Vision OCR: ${kw}` };
      }
    }

    // Web Detection（ウェブエンティティ）
    const webEntities: string[] = (ann.webDetection?.webEntities ?? [])
      .map((e: { description?: string }) => (e.description ?? '').toLowerCase())
      .filter(Boolean);
    const bestGuess: string = ann.webDetection?.bestGuessLabels?.[0]?.label?.toLowerCase() ?? '';
    if (bestGuess) webEntities.unshift(bestGuess);

    // Object + Labels
    const objects: string[] = (ann.localizedObjectAnnotations ?? [])
      .map((o: { name: string }) => o.name.toLowerCase());
    const labels: string[] = (ann.labelAnnotations ?? [])
      .map((l: { description: string }) => l.description.toLowerCase());

    const allCandidates = [...objects, ...webEntities, ...labels];
    console.log('[identify] Vision candidates:', allCandidates.slice(0, 8));

    for (const candidate of allCandidates) {
      for (const [key, ja] of LABEL_MAP) {
        if (candidate === key || candidate.includes(key)) {
          console.log('[identify] Vision match:', candidate, '->', ja);
          return { result: ja, log: `Vision: ${candidate} -> ${ja}` };
        }
      }
    }

    // フォールバック：最初の候補をそのまま返す（DBの部分一致に期待）
    const fallback = allCandidates.find(c =>
      c.length > 3 && !['person', 'human', 'hand', 'indoor', 'product', 'object', 'light'].includes(c)
    );
    if (fallback) {
      console.log('[identify] Vision fallback:', fallback);
      return { result: fallback, log: `Vision fallback: ${fallback}` };
    }

    return { result: null, log: 'Vision: no match' };
  } catch (e) {
    console.error('[identify] Vision exception:', e);
    return { result: null, log: `Vision exception: ${e}` };
  }
}

export async function POST(req: NextRequest) {
  const { image } = await req.json();
  if (!image) return Response.json({ result: '不明' }, { status: 400 });

  const geminiKey = process.env.GEMINI_API_KEY;
  const visionKey = process.env.GOOGLE_VISION_API_KEY;

  console.log('[identify] keys present - Gemini:', !!geminiKey, 'Vision:', !!visionKey);

  const logs: string[] = [];

  // 1. Gemini Vision
  if (geminiKey) {
    const { result, log } = await tryGemini(image, geminiKey);
    logs.push(log);
    if (result) return Response.json({ result, log });
  } else {
    logs.push('Gemini: キーなし');
  }

  // 2. Google Cloud Vision フォールバック
  if (visionKey) {
    const { result, log } = await tryVision(image, visionKey);
    logs.push(log);
    if (result) return Response.json({ result, log });
  } else {
    logs.push('Vision: キーなし');
  }

  console.error('[identify] 全て失敗:', logs);
  return Response.json({ result: '不明', logs });
}
