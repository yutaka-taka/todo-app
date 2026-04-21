import { NextRequest } from 'next/server';

// Google Cloud Vision の英語ラベル → 日本語ごみ品名 マッピング
const VISION_LABEL_MAP: [string, string][] = [
  // 容器・ボトル
  ['plastic bottle', 'ペットボトル'],
  ['bottle', 'びん'],
  ['glass bottle', 'びん'],
  ['aluminum can', '空き缶'],
  ['tin can', '空き缶'],
  ['beverage can', '空き缶'],
  ['can', '空き缶'],
  ['jar', 'びん'],
  ['plastic container', 'プラ容器'],
  ['food container', 'プラ容器'],
  ['container', 'プラ容器'],
  ['plastic bag', 'プラスチックバッグ'],
  ['shopping bag', 'プラスチックバッグ'],
  ['packaging', 'プラ容器'],
  ['styrofoam', '発泡スチロール'],
  ['foam', '発泡スチロール'],
  ['cup', 'コップ'],
  ['mug', 'マグカップ'],
  ['wine glass', 'グラス'],
  // 紙類
  ['newspaper', '新聞紙'],
  ['magazine', '雑誌'],
  ['book', '雑誌'],
  ['cardboard', '段ボール'],
  ['carton', '紙パック'],
  ['milk carton', '紙パック'],
  ['paper bag', '紙袋'],
  ['paper', '紙'],
  ['envelope', '封筒'],
  // 生ごみ
  ['food', '生ごみ'],
  ['vegetable', '生ごみ'],
  ['fruit', '生ごみ'],
  ['meat', '生ごみ'],
  ['bread', '生ごみ'],
  // 台所用品
  ['pot', '鍋'],
  ['pan', 'フライパン'],
  ['frying pan', 'フライパン'],
  ['cookware', '鍋'],
  ['plate', '皿'],
  ['bowl', '食器'],
  ['chopsticks', '割り箸'],
  ['knife', '包丁'],
  // 家電
  ['mobile phone', '携帯電話'],
  ['smartphone', 'スマートフォン'],
  ['telephone', '電話機'],
  ['laptop', 'パソコン'],
  ['computer', 'パソコン'],
  ['monitor', 'パソコンモニター'],
  ['television', 'テレビ'],
  ['remote control', 'リモコン'],
  ['camera', 'カメラ'],
  ['tablet computer', 'タブレット'],
  ['headphones', 'ヘッドホン'],
  // 電池・照明
  ['battery', '乾電池'],
  ['fluorescent lamp', '蛍光灯'],
  ['light bulb', '電球'],
  ['fluorescent light', '蛍光灯'],
  // 危険物
  ['spray', 'スプレー缶'],
  ['aerosol', 'スプレー缶'],
  ['lighter', 'ライター'],
  // 衣類
  ['clothing', '衣類'],
  ['jacket', '衣類'],
  ['shirt', '衣類'],
  ['shoes', '靴'],
  ['footwear', '靴'],
  ['bag', 'かばん'],
  ['handbag', 'かばん'],
  // 大型ごみ
  ['umbrella', '傘'],
  ['bicycle', '自転車'],
  ['furniture', '家具'],
  ['chair', 'いす'],
  ['table', 'テーブル'],
  ['bed', 'ベッド'],
  // その他
  ['rubber', 'ゴム'],
  ['tire', 'タイヤ'],
  ['wood', '木材'],
  ['ceramic', '陶磁器'],
];

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
              { type: 'OBJECT_LOCALIZATION', maxResults: 5 },
              { type: 'LABEL_DETECTION', maxResults: 15 },
            ],
          }],
        }),
      }
    );

    if (!res.ok) return Response.json({ result: '不明' });

    const data = await res.json();
    const objects: string[] = (data.responses?.[0]?.localizedObjectAnnotations ?? [])
      .map((o: { name: string }) => o.name.toLowerCase());
    const labels: string[] = (data.responses?.[0]?.labelAnnotations ?? [])
      .map((l: { description: string }) => l.description.toLowerCase());

    // 物体認識（より具体的）→ ラベルの順で照合
    for (const candidate of [...objects, ...labels]) {
      for (const [key, ja] of VISION_LABEL_MAP) {
        if (candidate === key || candidate.includes(key) || key.includes(candidate)) {
          return Response.json({ result: ja });
        }
      }
    }

    // マッピングなし：上位ラベルをそのまま返す（DB検索の部分一致に期待）
    return Response.json({ result: labels[0] ?? '不明' });
  } catch {
    return Response.json({ result: '不明' });
  }
}
