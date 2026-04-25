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
- 距離短縮時: 前走より300m以上短縮 → +5pt
- 距離延長時: 前走より300m以上延長 → -10pt

■ コース適性
- 同競馬場での2着以内経験あり → +10pt

■ 騎手評価
- G1騎乗経験豊富(10回以上) → +10pt
- 前走同騎手でコンビ継続 → +5pt
- 乗り替わり → -5pt

■ 人気と実力の相関
- 1番人気: 平均連対率 約65%
- 2番人気: 平均連対率 約50%
- 3番人気: 平均連対率 約40%
- 4-6番人気: 平均連対率 約30%
- 7番人気以下: 平均連対率 約15%

■ 除外・割引要素
- 休み明け（90日以上）: -5pt
- 斤量増（2kg以上）: -5pt

※このルールは自己学習により継続的に改善されます。
`

// 2018年以降の重賞レーススケジュール
const raceSchedule = [
  // ===== 2018年 =====
  { name: 'フェブラリーステークス2018', date: new Date('2018-02-18'), venue: '東京', grade: 'G1', surface: 'ダート', distance: 1600 },
  { name: '高松宮記念2018', date: new Date('2018-03-25'), venue: '中京', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '大阪杯2018', date: new Date('2018-04-01'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '桜花賞2018', date: new Date('2018-04-08'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '皐月賞2018', date: new Date('2018-04-15'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '天皇賞（春）2018', date: new Date('2018-04-29'), venue: '京都', grade: 'G1', surface: '芝', distance: 3200 },
  { name: 'NHKマイルカップ2018', date: new Date('2018-05-06'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ヴィクトリアマイル2018', date: new Date('2018-05-13'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'オークス2018', date: new Date('2018-05-20'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '日本ダービー2018', date: new Date('2018-05-27'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '安田記念2018', date: new Date('2018-06-03'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '宝塚記念2018', date: new Date('2018-06-24'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'スプリンターズステークス2018', date: new Date('2018-09-30'), venue: '中山', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '秋華賞2018', date: new Date('2018-10-14'), venue: '京都', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '菊花賞2018', date: new Date('2018-10-21'), venue: '京都', grade: 'G1', surface: '芝', distance: 3000 },
  { name: '天皇賞（秋）2018', date: new Date('2018-10-28'), venue: '東京', grade: 'G1', surface: '芝', distance: 2000 },
  { name: 'エリザベス女王杯2018', date: new Date('2018-11-11'), venue: '京都', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'マイルチャンピオンシップ2018', date: new Date('2018-11-18'), venue: '京都', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ジャパンカップ2018', date: new Date('2018-11-25'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: 'チャンピオンズカップ2018', date: new Date('2018-12-02'), venue: '中京', grade: 'G1', surface: 'ダート', distance: 1800 },
  { name: '阪神ジュベナイルフィリーズ2018', date: new Date('2018-12-09'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '朝日杯フューチュリティステークス2018', date: new Date('2018-12-16'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '有馬記念2018', date: new Date('2018-12-23'), venue: '中山', grade: 'G1', surface: '芝', distance: 2500 },
  { name: 'ホープフルステークス2018', date: new Date('2018-12-28'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  // 2018 主要G2
  { name: '京都記念2018', date: new Date('2018-02-11'), venue: '京都', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '中山記念2018', date: new Date('2018-03-04'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '金鯱賞2018', date: new Date('2018-03-11'), venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'スプリングステークス2018', date: new Date('2018-03-18'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '弥生賞2018', date: new Date('2018-03-04'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: '目黒記念2018', date: new Date('2018-05-27'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'オールカマー2018', date: new Date('2018-09-23'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '毎日王冠2018', date: new Date('2018-10-07'), venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '京都大賞典2018', date: new Date('2018-10-07'), venue: '京都', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'セントライト記念2018', date: new Date('2018-09-17'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '神戸新聞杯2018', date: new Date('2018-09-23'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'アルゼンチン共和国杯2018', date: new Date('2018-11-04'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  // 2018 主要G3
  { name: 'フローラステークス2018', date: new Date('2018-04-22'), venue: '東京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: '青葉賞2018', date: new Date('2018-04-28'), venue: '東京', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'エプソムカップ2018', date: new Date('2018-06-10'), venue: '東京', grade: 'G3', surface: '芝', distance: 1800 },
  { name: '中山金杯2018', date: new Date('2018-01-06'), venue: '中山', grade: 'G3', surface: '芝', distance: 2000 },
  { name: '京都金杯2018', date: new Date('2018-01-06'), venue: '京都', grade: 'G3', surface: '芝', distance: 1600 },

  // ===== 2019年 =====
  { name: 'フェブラリーステークス2019', date: new Date('2019-02-17'), venue: '東京', grade: 'G1', surface: 'ダート', distance: 1600 },
  { name: '高松宮記念2019', date: new Date('2019-03-24'), venue: '中京', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '大阪杯2019', date: new Date('2019-03-31'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '桜花賞2019', date: new Date('2019-04-07'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '皐月賞2019', date: new Date('2019-04-14'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '天皇賞（春）2019', date: new Date('2019-04-28'), venue: '京都', grade: 'G1', surface: '芝', distance: 3200 },
  { name: 'NHKマイルカップ2019', date: new Date('2019-05-05'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ヴィクトリアマイル2019', date: new Date('2019-05-12'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'オークス2019', date: new Date('2019-05-19'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '日本ダービー2019', date: new Date('2019-05-26'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '安田記念2019', date: new Date('2019-06-02'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '宝塚記念2019', date: new Date('2019-06-23'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'スプリンターズステークス2019', date: new Date('2019-09-29'), venue: '中山', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '秋華賞2019', date: new Date('2019-10-13'), venue: '京都', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '菊花賞2019', date: new Date('2019-10-20'), venue: '京都', grade: 'G1', surface: '芝', distance: 3000 },
  { name: '天皇賞（秋）2019', date: new Date('2019-10-27'), venue: '東京', grade: 'G1', surface: '芝', distance: 2000 },
  { name: 'エリザベス女王杯2019', date: new Date('2019-11-10'), venue: '京都', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'マイルチャンピオンシップ2019', date: new Date('2019-11-17'), venue: '京都', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ジャパンカップ2019', date: new Date('2019-11-24'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: 'チャンピオンズカップ2019', date: new Date('2019-12-01'), venue: '中京', grade: 'G1', surface: 'ダート', distance: 1800 },
  { name: '阪神ジュベナイルフィリーズ2019', date: new Date('2019-12-08'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '朝日杯フューチュリティステークス2019', date: new Date('2019-12-15'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '有馬記念2019', date: new Date('2019-12-22'), venue: '中山', grade: 'G1', surface: '芝', distance: 2500 },
  { name: 'ホープフルステークス2019', date: new Date('2019-12-28'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  // 2019 主要G2/G3
  { name: '京都記念2019', date: new Date('2019-02-10'), venue: '京都', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '中山記念2019', date: new Date('2019-03-03'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '金鯱賞2019', date: new Date('2019-03-10'), venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'スプリングステークス2019', date: new Date('2019-03-17'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '弥生賞2019', date: new Date('2019-03-03'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'オールカマー2019', date: new Date('2019-09-22'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '毎日王冠2019', date: new Date('2019-10-06'), venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '京都大賞典2019', date: new Date('2019-10-06'), venue: '京都', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'セントライト記念2019', date: new Date('2019-09-16'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '神戸新聞杯2019', date: new Date('2019-09-22'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '目黒記念2019', date: new Date('2019-05-26'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'アルゼンチン共和国杯2019', date: new Date('2019-11-03'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'エプソムカップ2019', date: new Date('2019-06-09'), venue: '東京', grade: 'G3', surface: '芝', distance: 1800 },

  // ===== 2020年 =====
  { name: 'フェブラリーステークス2020', date: new Date('2020-02-23'), venue: '東京', grade: 'G1', surface: 'ダート', distance: 1600 },
  { name: '高松宮記念2020', date: new Date('2020-03-29'), venue: '中京', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '大阪杯2020', date: new Date('2020-04-05'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '桜花賞2020', date: new Date('2020-04-12'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '皐月賞2020', date: new Date('2020-04-19'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '天皇賞（春）2020', date: new Date('2020-04-26'), venue: '京都', grade: 'G1', surface: '芝', distance: 3200 },
  { name: 'NHKマイルカップ2020', date: new Date('2020-05-10'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ヴィクトリアマイル2020', date: new Date('2020-05-17'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'オークス2020', date: new Date('2020-05-24'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '日本ダービー2020', date: new Date('2020-05-31'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '安田記念2020', date: new Date('2020-06-07'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '宝塚記念2020', date: new Date('2020-06-28'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'スプリンターズステークス2020', date: new Date('2020-10-04'), venue: '中山', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '秋華賞2020', date: new Date('2020-10-18'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '菊花賞2020', date: new Date('2020-10-25'), venue: '阪神', grade: 'G1', surface: '芝', distance: 3000 },
  { name: '天皇賞（秋）2020', date: new Date('2020-11-01'), venue: '東京', grade: 'G1', surface: '芝', distance: 2000 },
  { name: 'エリザベス女王杯2020', date: new Date('2020-11-15'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'マイルチャンピオンシップ2020', date: new Date('2020-11-22'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ジャパンカップ2020', date: new Date('2020-11-29'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: 'チャンピオンズカップ2020', date: new Date('2020-12-06'), venue: '中京', grade: 'G1', surface: 'ダート', distance: 1800 },
  { name: '阪神ジュベナイルフィリーズ2020', date: new Date('2020-12-13'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '朝日杯フューチュリティステークス2020', date: new Date('2020-12-20'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '有馬記念2020', date: new Date('2020-12-27'), venue: '中山', grade: 'G1', surface: '芝', distance: 2500 },
  { name: 'ホープフルステークス2020', date: new Date('2020-12-28'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  // 2020 主要G2/G3
  { name: '京都記念2020', date: new Date('2020-02-09'), venue: '京都', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '中山記念2020', date: new Date('2020-03-01'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '金鯱賞2020', date: new Date('2020-03-08'), venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'スプリングステークス2020', date: new Date('2020-03-22'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '弥生賞ディープインパクト記念2020', date: new Date('2020-03-01'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'オールカマー2020', date: new Date('2020-09-27'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '毎日王冠2020', date: new Date('2020-10-11'), venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '京都大賞典2020', date: new Date('2020-10-11'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'セントライト記念2020', date: new Date('2020-09-21'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '神戸新聞杯2020', date: new Date('2020-09-27'), venue: '中京', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '目黒記念2020', date: new Date('2020-05-31'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'アルゼンチン共和国杯2020', date: new Date('2020-11-08'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'エプソムカップ2020', date: new Date('2020-06-14'), venue: '東京', grade: 'G3', surface: '芝', distance: 1800 },

  // ===== 2021年 =====
  { name: 'フェブラリーステークス2021', date: new Date('2021-02-21'), venue: '東京', grade: 'G1', surface: 'ダート', distance: 1600 },
  { name: '高松宮記念2021', date: new Date('2021-03-28'), venue: '中京', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '大阪杯2021', date: new Date('2021-04-04'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '桜花賞2021', date: new Date('2021-04-11'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '皐月賞2021', date: new Date('2021-04-18'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '天皇賞（春）2021', date: new Date('2021-04-25'), venue: '阪神', grade: 'G1', surface: '芝', distance: 3200 },
  { name: 'NHKマイルカップ2021', date: new Date('2021-05-09'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ヴィクトリアマイル2021', date: new Date('2021-05-16'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'オークス2021', date: new Date('2021-05-23'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '日本ダービー2021', date: new Date('2021-05-30'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '安田記念2021', date: new Date('2021-06-06'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '宝塚記念2021', date: new Date('2021-06-27'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'スプリンターズステークス2021', date: new Date('2021-10-03'), venue: '中山', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '秋華賞2021', date: new Date('2021-10-17'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '菊花賞2021', date: new Date('2021-10-24'), venue: '阪神', grade: 'G1', surface: '芝', distance: 3000 },
  { name: '天皇賞（秋）2021', date: new Date('2021-10-31'), venue: '東京', grade: 'G1', surface: '芝', distance: 2000 },
  { name: 'エリザベス女王杯2021', date: new Date('2021-11-14'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'マイルチャンピオンシップ2021', date: new Date('2021-11-21'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ジャパンカップ2021', date: new Date('2021-11-28'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: 'チャンピオンズカップ2021', date: new Date('2021-12-05'), venue: '中京', grade: 'G1', surface: 'ダート', distance: 1800 },
  { name: '阪神ジュベナイルフィリーズ2021', date: new Date('2021-12-12'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '朝日杯フューチュリティステークス2021', date: new Date('2021-12-19'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '有馬記念2021', date: new Date('2021-12-26'), venue: '中山', grade: 'G1', surface: '芝', distance: 2500 },
  { name: 'ホープフルステークス2021', date: new Date('2021-12-28'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  // 2021 主要G2/G3
  { name: '京都記念2021', date: new Date('2021-02-14'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '中山記念2021', date: new Date('2021-02-28'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '金鯱賞2021', date: new Date('2021-03-07'), venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'スプリングステークス2021', date: new Date('2021-03-21'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '弥生賞ディープインパクト記念2021', date: new Date('2021-02-28'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'オールカマー2021', date: new Date('2021-09-26'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '毎日王冠2021', date: new Date('2021-10-10'), venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '京都大賞典2021', date: new Date('2021-10-10'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'セントライト記念2021', date: new Date('2021-09-20'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '神戸新聞杯2021', date: new Date('2021-09-26'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '目黒記念2021', date: new Date('2021-05-30'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'アルゼンチン共和国杯2021', date: new Date('2021-11-07'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'エプソムカップ2021', date: new Date('2021-06-13'), venue: '東京', grade: 'G3', surface: '芝', distance: 1800 },
  { name: 'チューリップ賞2021', date: new Date('2021-03-06'), venue: '阪神', grade: 'G2', surface: '芝', distance: 1600 },

  // ===== 2022年 =====
  { name: 'フェブラリーステークス2022', date: new Date('2022-02-20'), venue: '東京', grade: 'G1', surface: 'ダート', distance: 1600 },
  { name: '高松宮記念2022', date: new Date('2022-03-27'), venue: '中京', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '大阪杯2022', date: new Date('2022-04-03'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '桜花賞2022', date: new Date('2022-04-10'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '皐月賞2022', date: new Date('2022-04-17'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '天皇賞（春）2022', date: new Date('2022-05-01'), venue: '阪神', grade: 'G1', surface: '芝', distance: 3200 },
  { name: 'NHKマイルカップ2022', date: new Date('2022-05-08'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ヴィクトリアマイル2022', date: new Date('2022-05-15'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'オークス2022', date: new Date('2022-05-22'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '日本ダービー2022', date: new Date('2022-05-29'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '安田記念2022', date: new Date('2022-06-05'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '宝塚記念2022', date: new Date('2022-06-26'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'スプリンターズステークス2022', date: new Date('2022-10-02'), venue: '中山', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '秋華賞2022', date: new Date('2022-10-16'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '菊花賞2022', date: new Date('2022-10-23'), venue: '阪神', grade: 'G1', surface: '芝', distance: 3000 },
  { name: '天皇賞（秋）2022', date: new Date('2022-10-30'), venue: '東京', grade: 'G1', surface: '芝', distance: 2000 },
  { name: 'エリザベス女王杯2022', date: new Date('2022-11-13'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'マイルチャンピオンシップ2022', date: new Date('2022-11-20'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ジャパンカップ2022', date: new Date('2022-11-27'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: 'チャンピオンズカップ2022', date: new Date('2022-12-04'), venue: '中京', grade: 'G1', surface: 'ダート', distance: 1800 },
  { name: '阪神ジュベナイルフィリーズ2022', date: new Date('2022-12-11'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '朝日杯フューチュリティステークス2022', date: new Date('2022-12-18'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '有馬記念2022', date: new Date('2022-12-25'), venue: '中山', grade: 'G1', surface: '芝', distance: 2500 },
  { name: 'ホープフルステークス2022', date: new Date('2022-12-28'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  // 2022 主要G2/G3
  { name: '京都記念2022', date: new Date('2022-02-13'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '中山記念2022', date: new Date('2022-02-27'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '金鯱賞2022', date: new Date('2022-03-06'), venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'スプリングステークス2022', date: new Date('2022-03-20'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '弥生賞ディープインパクト記念2022', date: new Date('2022-03-06'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'オールカマー2022', date: new Date('2022-09-25'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '毎日王冠2022', date: new Date('2022-10-09'), venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '京都大賞典2022', date: new Date('2022-10-09'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'セントライト記念2022', date: new Date('2022-09-19'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '神戸新聞杯2022', date: new Date('2022-09-25'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '目黒記念2022', date: new Date('2022-05-29'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'アルゼンチン共和国杯2022', date: new Date('2022-11-06'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'エプソムカップ2022', date: new Date('2022-06-12'), venue: '東京', grade: 'G3', surface: '芝', distance: 1800 },
  { name: 'チューリップ賞2022', date: new Date('2022-03-05'), venue: '阪神', grade: 'G2', surface: '芝', distance: 1600 },
  { name: 'フローラステークス2022', date: new Date('2022-04-17'), venue: '東京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: '青葉賞2022', date: new Date('2022-04-30'), venue: '東京', grade: 'G2', surface: '芝', distance: 2400 },

  // ===== 2023年 =====
  { name: 'フェブラリーステークス2023', date: new Date('2023-02-19'), venue: '東京', grade: 'G1', surface: 'ダート', distance: 1600 },
  { name: '高松宮記念2023', date: new Date('2023-03-26'), venue: '中京', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '大阪杯2023', date: new Date('2023-04-02'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '桜花賞2023', date: new Date('2023-04-09'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '皐月賞2023', date: new Date('2023-04-16'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '天皇賞（春）2023', date: new Date('2023-04-30'), venue: '京都', grade: 'G1', surface: '芝', distance: 3200 },
  { name: 'NHKマイルカップ2023', date: new Date('2023-05-07'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ヴィクトリアマイル2023', date: new Date('2023-05-14'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'オークス2023', date: new Date('2023-05-21'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '日本ダービー2023', date: new Date('2023-05-28'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '安田記念2023', date: new Date('2023-06-04'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '宝塚記念2023', date: new Date('2023-06-25'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'スプリンターズステークス2023', date: new Date('2023-10-01'), venue: '中山', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '秋華賞2023', date: new Date('2023-10-15'), venue: '京都', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '菊花賞2023', date: new Date('2023-10-22'), venue: '京都', grade: 'G1', surface: '芝', distance: 3000 },
  { name: '天皇賞（秋）2023', date: new Date('2023-10-29'), venue: '東京', grade: 'G1', surface: '芝', distance: 2000 },
  { name: 'エリザベス女王杯2023', date: new Date('2023-11-12'), venue: '京都', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'マイルチャンピオンシップ2023', date: new Date('2023-11-19'), venue: '京都', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ジャパンカップ2023', date: new Date('2023-11-26'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: 'チャンピオンズカップ2023', date: new Date('2023-12-03'), venue: '中京', grade: 'G1', surface: 'ダート', distance: 1800 },
  { name: '阪神ジュベナイルフィリーズ2023', date: new Date('2023-12-10'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '朝日杯フューチュリティステークス2023', date: new Date('2023-12-17'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '有馬記念2023', date: new Date('2023-12-24'), venue: '中山', grade: 'G1', surface: '芝', distance: 2500 },
  { name: 'ホープフルステークス2023', date: new Date('2023-12-28'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  // 2023 主要G2/G3
  { name: '京都記念2023', date: new Date('2023-02-12'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '中山記念2023', date: new Date('2023-02-26'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '金鯱賞2023', date: new Date('2023-03-12'), venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'スプリングステークス2023', date: new Date('2023-03-19'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '弥生賞ディープインパクト記念2023', date: new Date('2023-03-05'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'オールカマー2023', date: new Date('2023-09-24'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '毎日王冠2023', date: new Date('2023-10-08'), venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '京都大賞典2023', date: new Date('2023-10-08'), venue: '京都', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'セントライト記念2023', date: new Date('2023-09-18'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '神戸新聞杯2023', date: new Date('2023-09-24'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '目黒記念2023', date: new Date('2023-05-28'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'アルゼンチン共和国杯2023', date: new Date('2023-11-05'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'エプソムカップ2023', date: new Date('2023-06-11'), venue: '東京', grade: 'G3', surface: '芝', distance: 1800 },
  { name: 'チューリップ賞2023', date: new Date('2023-03-04'), venue: '阪神', grade: 'G2', surface: '芝', distance: 1600 },
  { name: 'フローラステークス2023', date: new Date('2023-04-16'), venue: '東京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: '青葉賞2023', date: new Date('2023-04-29'), venue: '東京', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '鳴尾記念2023', date: new Date('2023-06-03'), venue: '阪神', grade: 'G3', surface: '芝', distance: 2000 },
  { name: '中山金杯2023', date: new Date('2023-01-05'), venue: '中山', grade: 'G3', surface: '芝', distance: 2000 },
  { name: '京都金杯2023', date: new Date('2023-01-08'), venue: '中京', grade: 'G3', surface: '芝', distance: 1600 },

  // ===== 2024年 =====
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
  // 2024 主要G2/G3
  { name: '京都記念2024', date: new Date('2024-02-11'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '中山記念2024', date: new Date('2024-03-03'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '金鯱賞2024', date: new Date('2024-03-10'), venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'スプリングステークス2024', date: new Date('2024-03-17'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '弥生賞ディープインパクト記念2024', date: new Date('2024-03-03'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'オールカマー2024', date: new Date('2024-09-22'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '毎日王冠2024', date: new Date('2024-10-06'), venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '京都大賞典2024', date: new Date('2024-10-06'), venue: '京都', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'セントライト記念2024', date: new Date('2024-09-16'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '神戸新聞杯2024', date: new Date('2024-09-22'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '目黒記念2024', date: new Date('2024-05-26'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'アルゼンチン共和国杯2024', date: new Date('2024-11-03'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'エプソムカップ2024', date: new Date('2024-06-09'), venue: '東京', grade: 'G3', surface: '芝', distance: 1800 },
  { name: 'チューリップ賞2024', date: new Date('2024-03-02'), venue: '阪神', grade: 'G2', surface: '芝', distance: 1600 },
  { name: 'フローラステークス2024', date: new Date('2024-04-21'), venue: '東京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: '青葉賞2024', date: new Date('2024-04-27'), venue: '東京', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '鳴尾記念2024', date: new Date('2024-06-01'), venue: '阪神', grade: 'G3', surface: '芝', distance: 2000 },
  { name: '中山金杯2024', date: new Date('2024-01-06'), venue: '中山', grade: 'G3', surface: '芝', distance: 2000 },
  { name: '京都金杯2024', date: new Date('2024-01-06'), venue: '京都', grade: 'G3', surface: '芝', distance: 1600 },
  { name: 'ダービー卿チャレンジトロフィー2024', date: new Date('2024-04-06'), venue: '中山', grade: 'G3', surface: '芝', distance: 1600 },
  { name: '新潟記念2024', date: new Date('2024-09-01'), venue: '新潟', grade: 'G3', surface: '芝', distance: 2000 },
  { name: '小倉記念2024', date: new Date('2024-08-04'), venue: '小倉', grade: 'G3', surface: '芝', distance: 2000 },
  { name: '関屋記念2024', date: new Date('2024-08-11'), venue: '新潟', grade: 'G3', surface: '芝', distance: 1600 },

  // ===== 2025年 =====
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
  // 2025 主要G2/G3
  { name: '京都記念2025', date: new Date('2025-02-09'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '中山記念2025', date: new Date('2025-03-02'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '金鯱賞2025', date: new Date('2025-03-09'), venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'スプリングステークス2025', date: new Date('2025-03-16'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '弥生賞ディープインパクト記念2025', date: new Date('2025-03-02'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'オールカマー2025', date: new Date('2025-09-21'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '毎日王冠2025', date: new Date('2025-10-05'), venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '京都大賞典2025', date: new Date('2025-10-05'), venue: '京都', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'セントライト記念2025', date: new Date('2025-09-14'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '神戸新聞杯2025', date: new Date('2025-09-21'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '目黒記念2025', date: new Date('2025-05-25'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'アルゼンチン共和国杯2025', date: new Date('2025-11-02'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'エプソムカップ2025', date: new Date('2025-06-08'), venue: '東京', grade: 'G3', surface: '芝', distance: 1800 },
  { name: 'チューリップ賞2025', date: new Date('2025-03-01'), venue: '阪神', grade: 'G2', surface: '芝', distance: 1600 },
  { name: 'フローラステークス2025', date: new Date('2025-04-20'), venue: '東京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: '青葉賞2025', date: new Date('2025-04-26'), venue: '東京', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '鳴尾記念2025', date: new Date('2025-05-31'), venue: '阪神', grade: 'G3', surface: '芝', distance: 2000 },
  { name: '中山金杯2025', date: new Date('2025-01-05'), venue: '中山', grade: 'G3', surface: '芝', distance: 2000 },
  { name: '京都金杯2025', date: new Date('2025-01-05'), venue: '京都', grade: 'G3', surface: '芝', distance: 1600 },
  { name: 'ダービー卿チャレンジトロフィー2025', date: new Date('2025-04-05'), venue: '中山', grade: 'G3', surface: '芝', distance: 1600 },
  { name: '新潟記念2025', date: new Date('2025-08-31'), venue: '新潟', grade: 'G3', surface: '芝', distance: 2000 },
  { name: '小倉記念2025', date: new Date('2025-08-03'), venue: '小倉', grade: 'G3', surface: '芝', distance: 2000 },
  { name: '関屋記念2025', date: new Date('2025-08-10'), venue: '新潟', grade: 'G3', surface: '芝', distance: 1600 },

  // ===== 2026年 G2（予想対象・日程は推定） =====
  { name: '中山金杯2026', date: new Date('2026-01-04'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: '京都金杯2026', date: new Date('2026-01-04'), venue: '京都', grade: 'G2', surface: '芝', distance: 1600 },
  { name: '京都記念2026', date: new Date('2026-02-08'), venue: '京都', grade: 'G2', surface: '芝', distance: 2200 },
  { name: 'チューリップ賞2026', date: new Date('2026-03-01'), venue: '阪神', grade: 'G2', surface: '芝', distance: 1600 },
  { name: '弥生賞ディープインパクト記念2026', date: new Date('2026-03-01'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: '中山記念2026', date: new Date('2026-03-01'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '金鯱賞2026', date: new Date('2026-03-08'), venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'スプリングステークス2026', date: new Date('2026-03-15'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '青葉賞2026', date: new Date('2026-04-25'), venue: '東京', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'フローラステークス2026', date: new Date('2026-04-26'), venue: '東京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'マイラーズカップ2026', date: new Date('2026-04-26'), venue: '京都', grade: 'G2', surface: '芝', distance: 1600 },
  { name: '目黒記念2026', date: new Date('2026-05-24'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: '鳴尾記念2026', date: new Date('2026-05-31'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'セントライト記念2026', date: new Date('2026-09-20'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '神戸新聞杯2026', date: new Date('2026-09-20'), venue: '中京', grade: 'G2', surface: '芝', distance: 2200 },
  { name: 'オールカマー2026', date: new Date('2026-09-27'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '毎日王冠2026', date: new Date('2026-10-04'), venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '京都大賞典2026', date: new Date('2026-10-04'), venue: '京都', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '府中牝馬ステークス2026', date: new Date('2026-10-11'), venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  { name: 'アルゼンチン共和国杯2026', date: new Date('2026-11-01'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'チャレンジカップ2026', date: new Date('2026-11-29'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2000 },

  // ===== 2026年 G1（予想対象） =====
  { name: 'フェブラリーステークス2026', date: new Date('2026-02-22'), venue: '東京', grade: 'G1', surface: 'ダート', distance: 1600 },
  { name: '高松宮記念2026', date: new Date('2026-03-29'), venue: '中京', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '大阪杯2026', date: new Date('2026-04-05'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '桜花賞2026', date: new Date('2026-04-12'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '皐月賞2026', date: new Date('2026-04-19'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '天皇賞（春）2026', date: new Date('2026-05-03'), venue: '京都', grade: 'G1', surface: '芝', distance: 3200 },
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
  const existingConfig = await prisma.algorithmConfig.findFirst({ where: { version: 1 } })
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

  const total = await prisma.race.count()
  console.log(`${created}件を新規追加（合計: ${total}件）`)
  console.log('シード完了!')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
