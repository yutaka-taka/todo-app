import { NextRequest } from 'next/server';

// OCR テキスト（日本語）→ ごみ品名 マッピング（最優先）
const JAPANESE_TEXT_MAP: [string, string][] = [
  ['乾電池', '乾電池'],
  ['蛍光灯', '蛍光灯'],
  ['スプレー缶', 'スプレー缶'],
  ['カセットボンベ', 'カセットボンベ'],
  ['ペットボトル', 'ペットボトル'],
  ['段ボール', '段ボール'],
  ['ダンボール', '段ボール'],
  ['新聞紙', '新聞紙'],
  ['紙パック', '紙パック'],
  ['発泡スチロール', '発泡スチロール'],
  ['陶磁器', '陶磁器'],
  ['スマートフォン', 'スマートフォン'],
  ['携帯電話', '携帯電話'],
  ['電子レンジ', '電子レンジ'],
  ['洗濯機', '洗濯機'],
  ['冷蔵庫', '冷蔵庫'],
  ['掃除機', '掃除機'],
  ['ドライヤー', 'ドライヤー'],
  ['アイロン', 'アイロン'],
  ['パソコン', 'パソコン'],
  ['テレビ', 'テレビ'],
  ['自転車', '自転車'],
  ['タイヤ', 'タイヤ'],
  ['布団', '布団'],
  ['毛布', '毛布'],
  ['ライター', 'ライター'],
  ['スプレー', 'スプレー缶'],
  ['電池', '乾電池'],
  ['蛍光', '蛍光灯'],
  ['新聞', '新聞紙'],
  ['雑誌', '雑誌'],
  ['衣類', '衣類'],
  ['傘', '傘'],
  ['小型家電', '小型家電'],
  ['プラスチック', 'プラ容器'],
  ['アルミ', '空き缶'],
  ['ガラスびん', 'びん'],
  ['ガラス瓶', 'びん'],
];

// 英語ラベル → 日本語ごみ品名（具体的・多語フレーズを先に配置）
const VISION_LABEL_MAP: [string, string][] = [
  // === 容器・ボトル（具体→汎用の順） ===
  ['plastic bottle', 'ペットボトル'],
  ['pet bottle', 'ペットボトル'],
  ['water bottle', 'ペットボトル'],
  ['glass bottle', 'びん'],
  ['aluminum can', '空き缶'],
  ['aluminium can', '空き缶'],
  ['tin can', '空き缶'],
  ['beverage can', '空き缶'],
  ['beer can', '空き缶'],
  ['beer bottle', 'びん'],
  ['wine bottle', 'びん'],
  ['milk carton', '紙パック'],
  ['juice carton', '紙パック'],
  ['food container', 'プラ容器'],
  ['plastic container', 'プラ容器'],
  ['plastic tray', 'プラ容器'],
  ['food tray', 'プラ容器'],
  ['plastic wrap', 'プラ容器'],
  ['plastic bag', 'プラ容器'],
  ['shopping bag', 'プラ容器'],
  ['styrofoam box', '発泡スチロール'],
  ['foam box', '発泡スチロール'],
  ['styrofoam', '発泡スチロール'],
  ['polystyrene', '発泡スチロール'],
  ['bottle', 'びん'],
  ['jar', 'びん'],
  ['carton', '紙パック'],
  ['packaging', 'プラ容器'],
  ['foam', '発泡スチロール'],
  ['cup', 'コップ'],
  ['mug', 'マグカップ'],
  ['wine glass', 'グラス'],
  // === 紙類 ===
  ['cardboard box', '段ボール'],
  ['corrugated box', '段ボール'],
  ['cardboard', '段ボール'],
  ['newspaper', '新聞紙'],
  ['magazine', '雑誌'],
  ['book', '雑誌'],
  ['paper bag', '紙袋'],
  ['envelope', '封筒'],
  ['paper', '紙'],
  // === 生ごみ ===
  ['food waste', '生ごみ'],
  ['kitchen waste', '生ごみ'],
  ['vegetable', '生ごみ'],
  ['fruit', '生ごみ'],
  ['meat', '生ごみ'],
  ['bread', '生ごみ'],
  ['food', '生ごみ'],
  // === 台所用品 ===
  ['frying pan', 'フライパン'],
  ['cooking pan', 'フライパン'],
  ['pot', '鍋'],
  ['saucepan', '鍋'],
  ['cookware', '鍋'],
  ['plate', '皿'],
  ['dish', '皿'],
  ['bowl', '食器'],
  ['chopsticks', '割り箸'],
  ['knife', '包丁'],
  ['kettle', 'やかん'],
  ['electric kettle', '電気ケトル'],
  ['thermos', '魔法瓶'],
  ['pan', 'フライパン'],
  // === 家電（大型） ===
  ['washing machine', '洗濯機'],
  ['refrigerator', '冷蔵庫'],
  ['fridge', '冷蔵庫'],
  ['microwave oven', '電子レンジ'],
  ['microwave', '電子レンジ'],
  ['vacuum cleaner', '掃除機'],
  ['air conditioner', 'エアコン'],
  ['electric fan', '扇風機'],
  ['fan heater', 'ファンヒーター'],
  ['space heater', '暖房器具'],
  ['television', 'テレビ'],
  ['tv', 'テレビ'],
  ['flat screen', 'テレビ'],
  // === 家電（小型） ===
  ['mobile phone', '携帯電話'],
  ['smartphone', 'スマートフォン'],
  ['cell phone', '携帯電話'],
  ['laptop computer', 'パソコン'],
  ['laptop', 'パソコン'],
  ['desktop computer', 'パソコン'],
  ['personal computer', 'パソコン'],
  ['computer monitor', 'パソコンモニター'],
  ['tablet computer', 'タブレット'],
  ['digital camera', 'デジタルカメラ'],
  ['game console', 'ゲーム機'],
  ['video game console', 'ゲーム機'],
  ['hair dryer', 'ドライヤー'],
  ['electric iron', 'アイロン'],
  ['electric toothbrush', '電動歯ブラシ'],
  ['toaster oven', 'オーブントースター'],
  ['toaster', 'トースター'],
  ['coffee maker', 'コーヒーメーカー'],
  ['printer', 'プリンター'],
  ['remote control', 'リモコン'],
  ['camera', 'カメラ'],
  ['headphones', 'ヘッドホン'],
  ['earphone', 'イヤホン'],
  ['clock', '時計'],
  ['alarm clock', '時計'],
  ['telephone', '電話機'],
  ['calculator', '電卓'],
  ['computer', 'パソコン'],
  ['monitor', 'パソコンモニター'],
  // === 電池・照明 ===
  ['dry cell battery', '乾電池'],
  ['alkaline battery', '乾電池'],
  ['battery pack', '乾電池'],
  ['fluorescent lamp', '蛍光灯'],
  ['fluorescent light', '蛍光灯'],
  ['fluorescent tube', '蛍光灯'],
  ['light bulb', '電球'],
  ['led bulb', '電球'],
  ['battery', '乾電池'],
  // === 危険物 ===
  ['aerosol can', 'スプレー缶'],
  ['spray can', 'スプレー缶'],
  ['spray bottle', 'スプレー缶'],
  ['fire lighter', 'ライター'],
  ['cigarette lighter', 'ライター'],
  ['spray', 'スプレー缶'],
  ['aerosol', 'スプレー缶'],
  ['lighter', 'ライター'],
  // === 衣類・布類 ===
  ['winter clothing', '衣類'],
  ['clothing', '衣類'],
  ['jacket', '衣類'],
  ['coat', '衣類'],
  ['shirt', '衣類'],
  ['trousers', '衣類'],
  ['jeans', '衣類'],
  ['dress', '衣類'],
  ['shoes', '靴'],
  ['boots', '靴'],
  ['sneakers', '靴'],
  ['footwear', '靴'],
  ['handbag', 'かばん'],
  ['backpack', 'かばん'],
  ['suitcase', 'かばん'],
  ['bag', 'かばん'],
  ['pillow', '布団類'],
  ['blanket', '毛布'],
  ['futon', '布団'],
  ['duvet', '布団'],
  // === 大型ごみ ===
  ['folding umbrella', '傘'],
  ['umbrella', '傘'],
  ['bicycle', '自転車'],
  ['bike', '自転車'],
  ['sofa', 'ソファ'],
  ['couch', 'ソファ'],
  ['furniture', '家具'],
  ['bookshelf', '本棚'],
  ['bookcase', '本棚'],
  ['chair', 'いす'],
  ['table', 'テーブル'],
  ['desk', 'デスク'],
  ['bed', 'ベッド'],
  ['mattress', 'マットレス'],
  ['carpet', 'カーペット'],
  ['rug', 'カーペット'],
  // === 陶磁器・ガラス ===
  ['ceramic', '陶磁器'],
  ['porcelain', '陶磁器'],
  ['glass', 'びん'],
  // === その他 ===
  ['rubber', 'ゴム'],
  ['tire', 'タイヤ'],
  ['tyre', 'タイヤ'],
  ['wood', '木材'],
];

// フォールバック時に除外する汎用ラベル
const GENERIC_LABELS = new Set([
  'person', 'human', 'hand', 'finger', 'arm', 'face', 'skin', 'neck',
  'close-up', 'macro photography', 'still life', 'still life photography',
  'photography', 'snapshot', 'product', 'indoor', 'outdoor', 'room',
  'floor', 'wall', 'ceiling', 'light', 'darkness', 'shadow', 'material',
  'object', 'item', 'thing', 'surface', 'texture', 'color', 'background',
]);

function matchLabel(candidate: string, map: [string, string][]): string | null {
  for (const [key, ja] of map) {
    if (candidate === key) return ja;
    if (candidate.includes(key)) return ja;
    // key.includes(candidate): 4文字以上 かつ key内で単語として含まれる場合のみ
    if (candidate.length >= 4 && key.split(/\s+/).includes(candidate)) return ja;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const { image } = await req.json();
  if (!image) return Response.json({ result: '不明' }, { status: 400 });

  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) {
    return Response.json({ result: '不明', error: 'GOOGLE_VISION_API_KEY が未設定です' });
  }

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

    if (!res.ok) return Response.json({ result: '不明' });

    const data = await res.json();
    const annotations = data.responses?.[0] ?? {};

    // OCRテキスト（日本語）→ 最優先でマッチング
    const fullText: string = annotations.textAnnotations?.[0]?.description ?? '';
    for (const [keyword, ja] of JAPANESE_TEXT_MAP) {
      if (fullText.includes(keyword)) {
        return Response.json({ result: ja });
      }
    }

    // 物体認識（スコア 0.5 以上、高スコア優先）
    const objects: string[] = (annotations.localizedObjectAnnotations ?? [])
      .filter((o: { score: number }) => o.score >= 0.5)
      .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
      .map((o: { name: string }) => o.name.toLowerCase());

    for (const candidate of objects) {
      const match = matchLabel(candidate, VISION_LABEL_MAP);
      if (match) return Response.json({ result: match });
    }

    // ラベル検出（スコア 0.65 以上、高スコア優先）
    const labels: string[] = (annotations.labelAnnotations ?? [])
      .filter((l: { score: number }) => l.score >= 0.65)
      .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
      .map((l: { description: string }) => l.description.toLowerCase());

    for (const candidate of labels) {
      const match = matchLabel(candidate, VISION_LABEL_MAP);
      if (match) return Response.json({ result: match });
    }

    // フォールバック：汎用ラベルを除外して最上位のラベルを返す
    const meaningfulLabel = labels.find(l => !GENERIC_LABELS.has(l));
    return Response.json({ result: meaningfulLabel ?? '不明' });
  } catch {
    return Response.json({ result: '不明' });
  }
}
