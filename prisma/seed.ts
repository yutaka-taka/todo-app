import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const initialRules = `
【JRA G1予想 初期アルゴリズム】

■ 基本スコアリング原則
1. 直近6走の成績（2着以内の回数 / 6走）を基本連対率とする
2. G1実績: G1で2着以内経験あり → +20pt
3. G1未勝利: G1初出走 → -10pt（格上げ挑戦リスク）

■ 距離適性評価
- 今回距離の±200m以内で2着以内経験あり → +15pt
- 距離短縮時: 前走より300m以上短縮 → +5pt（スピード活かせる）
- 距離延長時: 前走より300m以上延長 → -10pt（スタミナ未知）

■ コース適性
- 同競馬場での2着以内経験あり → +10pt
- 芝/ダート問題なく対応できる馬 → +5pt

■ 騎手評価
- G1騎乗経験豊富(10回以上) → +10pt
- 前走同騎手でコンビ継続 → +5pt
- 乗り替わり(前走と異なる騎手) → -5pt

■ 人気と実力の相関
- 1番人気: 平均連対率 約65%
- 2番人気: 平均連対率 約50%
- 3番人気: 平均連対率 約40%
- 4-6番人気: 平均連対率 約30%
- 7番人気以下: 平均連対率 約15%（穴馬）

■ 馬場状態適性
- 重・不良馬場: 過去の道悪実績を重視
- 良馬場: 通常評価

■ 除外・割引要素
- 連続好走疲れ（3走連続2着以内後）: -5pt
- 休み明け（前走から90日以上）: -5pt
- 斤量増（前走より2kg以上増量）: -5pt

※このルールは自己学習により継続的に改善されます。
`

// 2024-2026年の重賞レーススケジュール
const raceSchedule = [
  // === 2024年 主要G1（自己学習用） ===
  { name: 'フェブラリーステークス2024', date: new Date('2024-02-18'), venue: '東京', grade: 'G1', surface: 'ダート', distance: 1600 },
  { name: '高松宮記念2024', date: new Date('2024-03-24'), venue: '中京', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '大阪杯2024', date: new Date('2024-03-31'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '桜花賞2024', date: new Date('2024-04-07'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '皐月賞2024', date: new Date('2024-04-14'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '天皇賞（春）2024', date: new Date('2024-04-28'), venue: '京都', grade: 'G1', surface: '芝', distance: 3200 },
  { name: 'NHKマイルカップ2024', date: new Date('2024-05-12'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ヴィクトリアマイル2024', date: new Date('2024-05-12'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'オークス2024', date: new Date('2024-05-19'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '日本ダービー2024', date: new Date('2024-05-26'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '安田記念2024', date: new Date('2024-06-02'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '宝塚記念2024', date: new Date('2024-06-23'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'スプリンターズステークス2024', date: new Date('2024-09-29'), venue: '中山', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '秋華賞2024', date: new Date('2024-10-13'), venue: '京都', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '菊花賞2024', date: new Date('2024-10-20'), venue: '京都', grade: 'G1', surface: '芝', distance: 3000 },
  { name: '天皇賞（秋）2024', date: new Date('2024-10-27'), venue: '東京', grade: 'G1', surface: '芝', distance: 2000 },
  { name: 'エリザベス女王杯2024', date: new Date('2024-11-10'), venue: '京都', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'マイルチャンピオンシップ2024', date: new Date('2024-11-17'), venue: '京都', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ジャパンカップ2024', date: new Date('2024-11-24'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: 'チャンピオンズカップ2024', date: new Date('2024-12-01'), venue: '中京', grade: 'G1', surface: 'ダート', distance: 1800 },
  { name: '阪神ジュベナイルフィリーズ2024', date: new Date('2024-12-08'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '朝日杯フューチュリティステークス2024', date: new Date('2024-12-15'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '有馬記念2024', date: new Date('2024-12-22'), venue: '中山', grade: 'G1', surface: '芝', distance: 2500 },
  { name: 'ホープフルステークス2024', date: new Date('2024-12-28'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },

  // 2024年 主要G2（自己学習用）
  { name: '京都記念2024', date: new Date('2024-02-11'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '中山記念2024', date: new Date('2024-03-03'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '毎日杯2024', date: new Date('2024-03-23'), venue: '阪神', grade: 'G3', surface: '芝', distance: 1800 },
  { name: 'スプリングステークス2024', date: new Date('2024-03-17'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '産経大阪杯2024', date: new Date('2024-03-31'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: 'フローラステークス2024', date: new Date('2024-04-21'), venue: '東京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: '青葉賞2024', date: new Date('2024-04-27'), venue: '東京', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '目黒記念2024', date: new Date('2024-05-26'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: '鳴尾記念2024', date: new Date('2024-05-25'), venue: '中京', grade: 'G3', surface: '芝', distance: 2000 },
  { name: 'エプソムカップ2024', date: new Date('2024-06-09'), venue: '東京', grade: 'G3', surface: '芝', distance: 1800 },

  // === 2025年 G1（自己学習用 - Claude学習データ内） ===
  { name: 'フェブラリーステークス2025', date: new Date('2025-02-23'), venue: '東京', grade: 'G1', surface: 'ダート', distance: 1600 },
  { name: '高松宮記念2025', date: new Date('2025-03-23'), venue: '中京', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '大阪杯2025', date: new Date('2025-04-06'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '桜花賞2025', date: new Date('2025-04-13'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '皐月賞2025', date: new Date('2025-04-20'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '天皇賞（春）2025', date: new Date('2025-04-27'), venue: '京都', grade: 'G1', surface: '芝', distance: 3200 },
  { name: 'NHKマイルカップ2025', date: new Date('2025-05-11'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ヴィクトリアマイル2025', date: new Date('2025-05-18'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'オークス2025', date: new Date('2025-05-25'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '日本ダービー2025', date: new Date('2025-06-01'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '安田記念2025', date: new Date('2025-06-08'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '宝塚記念2025', date: new Date('2025-06-22'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'スプリンターズステークス2025', date: new Date('2025-09-28'), venue: '中山', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '秋華賞2025', date: new Date('2025-10-12'), venue: '京都', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '菊花賞2025', date: new Date('2025-10-19'), venue: '京都', grade: 'G1', surface: '芝', distance: 3000 },
  { name: '天皇賞（秋）2025', date: new Date('2025-10-26'), venue: '東京', grade: 'G1', surface: '芝', distance: 2000 },
  { name: 'エリザベス女王杯2025', date: new Date('2025-11-09'), venue: '京都', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'マイルチャンピオンシップ2025', date: new Date('2025-11-16'), venue: '京都', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ジャパンカップ2025', date: new Date('2025-11-23'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: 'チャンピオンズカップ2025', date: new Date('2025-11-30'), venue: '中京', grade: 'G1', surface: 'ダート', distance: 1800 },
  { name: '阪神ジュベナイルフィリーズ2025', date: new Date('2025-12-07'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '朝日杯フューチュリティステークス2025', date: new Date('2025-12-14'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '有馬記念2025', date: new Date('2025-12-28'), venue: '中山', grade: 'G1', surface: '芝', distance: 2500 },
  { name: 'ホープフルステークス2025', date: new Date('2025-12-28'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },

  // 2025年 主要G2/G3
  { name: '京都記念2025', date: new Date('2025-02-09'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '中山記念2025', date: new Date('2025-03-02'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '金鯱賞2025', date: new Date('2025-03-09'), venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'スプリングステークス2025', date: new Date('2025-03-16'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '弥生賞2025', date: new Date('2025-03-02'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'フローラステークス2025', date: new Date('2025-04-20'), venue: '東京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: '青葉賞2025', date: new Date('2025-04-26'), venue: '東京', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '目黒記念2025', date: new Date('2025-05-25'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'エプソムカップ2025', date: new Date('2025-06-08'), venue: '東京', grade: 'G3', surface: '芝', distance: 1800 },
  { name: 'オールカマー2025', date: new Date('2025-09-21'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '毎日王冠2025', date: new Date('2025-10-05'), venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  { name: 'セントライト記念2025', date: new Date('2025-09-14'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '神戸新聞杯2025', date: new Date('2025-09-21'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '京都大賞典2025', date: new Date('2025-10-05'), venue: '京都', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'アルゼンチン共和国杯2025', date: new Date('2025-11-02'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'エリカ賞2025', date: new Date('2025-11-16'), venue: '阪神', grade: 'G3', surface: '芝', distance: 2000 },

  // === 2026年 G1（予想対象） ===
  { name: 'フェブラリーステークス2026', date: new Date('2026-02-22'), venue: '東京', grade: 'G1', surface: 'ダート', distance: 1600 },
  { name: '高松宮記念2026', date: new Date('2026-03-29'), venue: '中京', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '大阪杯2026', date: new Date('2026-04-05'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '桜花賞2026', date: new Date('2026-04-12'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '皐月賞2026', date: new Date('2026-04-19'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '天皇賞（春）2026', date: new Date('2026-04-26'), venue: '京都', grade: 'G1', surface: '芝', distance: 3200 },
  { name: 'NHKマイルカップ2026', date: new Date('2026-05-10'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ヴィクトリアマイル2026', date: new Date('2026-05-17'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'オークス2026', date: new Date('2026-05-24'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '日本ダービー2026', date: new Date('2026-05-31'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '安田記念2026', date: new Date('2026-06-07'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '宝塚記念2026', date: new Date('2026-06-28'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'スプリンターズステークス2026', date: new Date('2026-09-27'), venue: '中山', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '秋華賞2026', date: new Date('2026-10-18'), venue: '京都', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '菊花賞2026', date: new Date('2026-10-25'), venue: '京都', grade: 'G1', surface: '芝', distance: 3000 },
  { name: '天皇賞（秋）2026', date: new Date('2026-11-01'), venue: '東京', grade: 'G1', surface: '芝', distance: 2000 },
  { name: 'エリザベス女王杯2026', date: new Date('2026-11-08'), venue: '京都', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'マイルチャンピオンシップ2026', date: new Date('2026-11-22'), venue: '京都', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ジャパンカップ2026', date: new Date('2026-11-29'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: 'チャンピオンズカップ2026', date: new Date('2026-12-06'), venue: '中京', grade: 'G1', surface: 'ダート', distance: 1800 },
  { name: '阪神ジュベナイルフィリーズ2026', date: new Date('2026-12-13'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '朝日杯フューチュリティステークス2026', date: new Date('2026-12-20'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '有馬記念2026', date: new Date('2026-12-27'), venue: '中山', grade: 'G1', surface: '芝', distance: 2500 },
  { name: 'ホープフルステークス2026', date: new Date('2026-12-28'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
]

async function main() {
  console.log('シードデータを投入中...')

  // 初期アルゴリズム設定
  const existingConfig = await prisma.algorithmConfig.findFirst({
    where: { version: 1 }
  })

  if (!existingConfig) {
    await prisma.algorithmConfig.create({
      data: {
        version: 1,
        isActive: true,
        rules: initialRules,
        insights: '初期設定。自己学習ボタンを押すと知見が蓄積されます。',
        analyzedCount: 0,
      }
    })
    console.log('初期アルゴリズム設定を作成しました')
  }

  // レーススケジュール投入
  let created = 0
  for (const race of raceSchedule) {
    const existing = await prisma.race.findUnique({
      where: { name_date: { name: race.name, date: race.date } }
    })
    if (!existing) {
      await prisma.race.create({ data: race })
      created++
    }
  }
  console.log(`${created}件のレースを追加しました（既存: ${raceSchedule.length - created}件）`)

  console.log('シード完了!')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
