import type { HorseStat } from '@prisma/client'

export interface LocalWeights {
  recentFormMult: number
  distanceMult: number
  venueMult: number
  surfaceMult: number
  g1Mult: number
  ageMult: number
  jockeyMult: number
  raceAffinityMult: number
  trackCondMult: number
}

export const DEFAULT_WEIGHTS: LocalWeights = {
  recentFormMult: 0.73, // v273最適化: 前哨戦・フォーム改善後の最適値
  distanceMult: 1.28,   // 距離適性は最強因子
  venueMult: 1.15,      // コース適性は第2因子
  surfaceMult: 1.05,
  g1Mult: 0.80,         // G1実績（近G1未連対のペナルティ緩和後に下げ）
  ageMult: 0.50,        // 年齢因子を適度に強化
  jockeyMult: 1.10,     // 騎手効果を若干強化
  raceAffinityMult: 1.0,
  trackCondMult: 1.0,
}

interface EntryInput {
  horseNumber: number
  horseName: string
  age?: number | null
  jockey?: string | null
  horseWeight?: number | null
  weightChange?: number | null
}

interface RaceContext {
  name?: string
  grade: string
  distance: number
  venue: string
  surface: string
  trackCondition?: string
}

export interface ScoredHorse {
  rank: number
  horseNumber: number | null
  horseName: string
  placeRate: number
  factors: {
    recentForm: string
    distanceSuitability: string
    courseRecord: string
    jockeyStats: string
    reason: string
    _bonuses?: {
      recentForm: number
      distance: number
      venue: number
      surface: number
      g1: number
      age: number
      jockey: number
      raceAffinity: number
      trackCond: number
      prep: number
    }
  }
}

type StatRecord = Record<string, { races: number; places: number }>

// 騎手ランク定義（JRA主要騎手のG1勝利数・連対実績に基づく）
const JOCKEY_RANKS: Record<string, number> = {
  // S+級: 圧倒的な実績（+14）
  'C.ルメール': 14, 'ルメール': 14,
  // S級: トップ騎手（+10）
  '武豊': 10, '川田将雅': 10, '横山武史': 10,
  // A+級: 主要騎手（+7）
  '坂井瑠星': 7, '岩田望来': 7, '松山弘平': 7,
  '戸崎圭太': 7, '池添謙一': 7, '北村友一': 7,
  'M.デムーロ': 7, 'デムーロ': 7,
  // A級: 実力騎手（+4）
  '浜中俊': 4, '田辺裕信': 4, '丸山元気': 4,
  '幸英明': 4, '藤岡佑介': 4, '西村淳也': 4,
  '鮫島克駿': 4, '永野猛蔵': 4, '三浦皇成': 4,
  '福永祐一': 7, '岩田康誠': 4, '蛯名正義': 4,
  '内田博幸': 4, '柴田善臣': 4,
}

const RANK_CAPS = [65, 52, 38, 28, 22, 18, 15]

const PREP_RACES: Record<string, string[]> = {
  '日本ダービー':           ['皐月賞', 'NHKマイルカップ', '青葉賞'],
  '菊花賞':               ['神戸新聞杯', 'セントライト記念', '皐月賞'],
  'オークス':              ['桜花賞', 'フローラステークス'],
  '優駿牝馬（オークス）':    ['桜花賞', 'フローラステークス'],
  '天皇賞（春）':           ['阪神大賞典', '日経賞', 'AJCC', '有馬記念'],
  '宝塚記念':              ['大阪杯', '天皇賞（春）'],
  '天皇賞（秋）':           ['毎日王冠', 'オールカマー', '札幌記念'],
  '有馬記念':              ['ジャパンカップ', '天皇賞（秋）', '宝塚記念'],
  'ジャパンカップ':          ['天皇賞（秋）', '宝塚記念'],
  '安田記念':              ['ヴィクトリアマイル', 'NHKマイルカップ'],
  'ヴィクトリアマイル':       ['阪神牝馬ステークス', '中山牝馬ステークス', '桜花賞'],
  'エリザベス女王杯':        ['府中牝馬ステークス', '秋華賞', 'オークス'],
  '秋華賞':               ['オークス', 'ローズステークス', '紫苑ステークス'],
  'スプリンターズステークス':  ['キーンランドカップ', 'セントウルステークス', '高松宮記念'],
  '高松宮記念':             ['シルクロードステークス', 'オーシャンステークス'],
  'マイルチャンピオンシップ':  ['スワンステークス', '富士ステークス', '安田記念'],
  'フェブラリーステークス':    ['東海ステークス', '根岸ステークス', 'チャンピオンズカップ'],
  'チャンピオンズカップ':     ['JBCクラシック', 'みやこステークス', 'シリウスステークス'],
  'NHKマイルカップ':        ['アーリントンカップ', 'ニュージーランドトロフィー', '桜花賞'],
  '桜花賞':               ['チューリップ賞', 'フィリーズレビュー'],
  '皐月賞':               ['弥生賞ディープインパクト記念', 'スプリングステークス', '共同通信杯', '弥生賞'],
  '大阪杯':               ['金鯱賞', '中山記念', '京都記念'],
}

export function localScoreHorses(
  entries: EntryInput[],
  race: RaceContext,
  stats: HorseStat[],
  weights: LocalWeights = DEFAULT_WEIGHTS
): ScoredHorse[] {
  const statMap = new Map(stats.map((s) => [s.horseName, s]))

  const scored = entries.map((entry) => {
    const stat = statMap.get(entry.horseName) ?? null
    return buildScore(entry, race, stat, weights)
  })

  scored.sort((a, b) => b.placeRate - a.placeRate)

  const top7 = scored.slice(0, 7)

  for (let i = 0; i < top7.length; i++) {
    const cap = RANK_CAPS[i] ?? 15
    top7[i].placeRate = Math.min(top7[i].placeRate, cap)
  }

  if (top7.length >= 2 && top7[0].placeRate - top7[1].placeRate < 5) {
    top7[1].placeRate = Math.max(top7[1].placeRate - 7, (RANK_CAPS[1] ?? 52) - 12)
  }
  if (top7.length >= 3 && top7[1].placeRate - top7[2].placeRate < 5) {
    top7[2].placeRate = Math.max(top7[2].placeRate - 12, (RANK_CAPS[2] ?? 38) - 14)
  }
  if (top7.length >= 2 && top7[0].placeRate - top7[1].placeRate < 1) {
    top7[0].placeRate = Math.max(top7[0].placeRate - 5, top7[1].placeRate + 2)
  }

  return top7.map((s, i) => ({
    ...s,
    rank: i + 1,
    placeRate: Math.round(s.placeRate * 10) / 10,
  }))
}

function smoothedRate(places: number, races: number): number {
  return (places + 2) / (races + 8)
}

function parseRecentForm(form: string): number[] {
  return form.split('-').map(Number).filter((n) => !isNaN(n) && n > 0)
}

function buildScore(
  entry: EntryInput,
  race: RaceContext,
  stat: HorseStat | null,
  weights: LocalWeights
): ScoredHorse {
  if (!stat || stat.totalRaces === 0) {
    let partialBonus = 0
    const notes: string[] = []
    if (entry.age != null) {
      if (entry.age === 3)                         { partialBonus += 3; notes.push('3歳') }
      else if (entry.age === 4 || entry.age === 5) { partialBonus += 2; notes.push(`${entry.age}歳`) }
      else if (entry.age >= 7)                     { partialBonus -= 3; notes.push(`${entry.age}歳晩年`) }
    }
    if (entry.weightChange != null) {
      if (Math.abs(entry.weightChange) <= 3)  partialBonus += 2
      else if (Math.abs(entry.weightChange) > 10) partialBonus -= 5
    }
    return {
      rank: 0,
      horseNumber: entry.horseNumber,
      horseName: entry.horseName,
      placeRate: Math.max(22, Math.min(38, 30 + partialBonus)),
      factors: {
        recentForm: 'データなし',
        distanceSuitability: '距離実績未収集',
        courseRecord: 'コース実績未収集',
        jockeyStats: entry.jockey ?? '未定',
        reason: `DBに成績データなし${notes.length ? `（${notes.join('/')}）` : ''}。自己学習を続けると精度が向上します。`,
      },
    }
  }

  const distData = stat.distanceData as StatRecord
  const venueData = stat.venueData as StatRecord
  const surfData = stat.surfaceData as StatRecord

  const baseSmoothed = smoothedRate(stat.totalPlaces, stat.totalRaces)

  let effectiveBase = baseSmoothed * 100
  if (race.grade === 'G1' && stat.g1Races >= 1) {
    const g1Smoothed = smoothedRate(stat.g1Places, stat.g1Races)
    const g1Weight = Math.min(stat.g1Races, 10) / 10 * 0.6  // max 0.6、1レースから適用
    effectiveBase = baseSmoothed * (1 - g1Weight) * 100 + g1Smoothed * g1Weight * 100
  }

  let recentFormBonus = 0
  let recentFormText = `通算${stat.totalRaces}戦${stat.totalPlaces}連対`

  if (stat.recentForm) {
    const positions = parseRecentForm(stat.recentForm)
    if (positions.length > 0) {
      recentFormText = `直近: ${stat.recentForm}`
      const ws = [0.40, 0.25, 0.18, 0.12, 0.05]
      let wSum = 0, wTotal = 0
      for (let i = 0; i < Math.min(positions.length, 5); i++) {
        const w = ws[i] ?? 0.05
        wSum += positions[i] * w
        wTotal += w
      }
      const avgPos = wSum / wTotal

      if (avgPos <= 1.4)      recentFormBonus = 24
      else if (avgPos <= 1.8) recentFormBonus = 20
      else if (avgPos <= 2.2) recentFormBonus = 15
      else if (avgPos <= 3.0) recentFormBonus = 8
      else if (avgPos <= 4.5) recentFormBonus = 1
      else if (avgPos <= 5.5) recentFormBonus = 0   // 5着前後は中立（ペナルティなし）
      else if (avgPos > 7.0)  recentFormBonus = -10
      else                    recentFormBonus = -4

      if (positions.length >= 2 && positions[0] <= 2 && positions[1] <= 2) recentFormBonus += 5
      if (positions[0] === 1) recentFormBonus += 3  // 直近1着追加ボーナス
    }
  }

  let distanceBonus = 0
  const dk = String(race.distance)
  const dStat = distData[dk]
  let distanceSuitability = `${race.distance}mの実績なし`

  if (dStat && dStat.races > 0) {
    const sf = Math.min(dStat.races, 5) / 5
    const r = dStat.places / dStat.races
    if (r >= 0.5) {
      distanceBonus = Math.round(15 * sf)
      distanceSuitability = `◎ ${race.distance}mで${dStat.races}戦${dStat.places}連対（得意距離）`
    } else if (r >= 0.3) {
      distanceBonus = Math.round(7 * sf)
      distanceSuitability = `○ ${race.distance}mで${dStat.races}戦${dStat.places}連対`
    } else {
      distanceBonus = -Math.round(5 * sf)
      distanceSuitability = `△ ${race.distance}mの成績が低調`
    }
  } else {
    const nearby = [
      { d: race.distance - 200, factor: 0.5 },
      { d: race.distance + 200, factor: 0.5 },
      { d: race.distance - 400, factor: 0.3 },
      { d: race.distance + 400, factor: 0.3 },
    ]
    let bestNearby = 0
    for (const { d, factor } of nearby) {
      const nd = distData[String(d)]
      if (nd && nd.races >= 2) {
        const r = nd.places / nd.races
        const val = r >= 0.5 ? 15 * factor : r >= 0.3 ? 7 * factor : -5 * factor
        if (val > bestNearby) bestNearby = val
      }
    }
    if (bestNearby > 0) {
      distanceBonus = Math.round(bestNearby)
      distanceSuitability = `${race.distance}m近隣距離での実績あり（参考）`
    }
  }

  let venueBonus = 0
  const vStat = venueData[race.venue]
  let courseRecord = `${race.venue}実績なし`
  if (vStat && vStat.races > 0) {
    const sf = Math.min(vStat.races, 5) / 5
    const r = vStat.places / vStat.races
    if (r >= 0.4) {
      venueBonus = Math.round(10 * sf)
      courseRecord = `◎ ${race.venue}で${vStat.races}戦${vStat.places}連対（得意コース）`
    } else if (r >= 0.2) {
      venueBonus = Math.round(3 * sf)
      courseRecord = `${race.venue}で${vStat.races}戦${vStat.places}連対`
    } else if (vStat.races >= 3) {
      venueBonus = -Math.round(4 * sf)
      courseRecord = `△ ${race.venue}での成績が低調`
    } else {
      courseRecord = `${race.venue}で${vStat.races}戦${vStat.places}連対`
    }
  }

  let surfaceBonus = 0
  const sStat = surfData[race.surface]
  if (sStat && sStat.races > 0) {
    const sf = Math.min(sStat.races, 8) / 8
    const r = sStat.places / sStat.races
    if (r >= 0.5)      surfaceBonus = Math.round(8 * sf)
    else if (r >= 0.3) surfaceBonus = Math.round(3 * sf)
    else if (r < 0.2)  surfaceBonus = -Math.round(8 * sf)
  }

  let g1Bonus = 0
  let g1Note = ''
  if (race.grade === 'G1') {
    if (stat.g1Races === 0) {
      // 全体連対率が高ければ初G1でもペナルティ軽減
      const overallRate = stat.totalRaces > 0 ? stat.totalPlaces / stat.totalRaces : 0
      g1Bonus = overallRate >= 0.45 ? -3 : overallRate >= 0.30 ? -5 : -8
      g1Note = overallRate >= 0.30 ? `G1初挑戦(連対率${Math.round(overallRate*100)}%)` : 'G1初挑戦'
    } else {
      const g1Rate = stat.g1Places / stat.g1Races
      if (g1Rate >= 0.4) {
        g1Bonus = 18
        g1Note = `G1で${stat.g1Races}戦${stat.g1Places}連対(高実績)`
      } else if (g1Rate >= 0.2) {
        g1Bonus = 8
        g1Note = `G1で${stat.g1Races}戦${stat.g1Places}連対`
      } else if (stat.g1Races >= 3) {
        g1Bonus = -8
        g1Note = `G1で${stat.g1Races}戦連対なし(苦手)`
      } else {
        g1Bonus = -1  // 1-2回のG1経験で未連対: 経験値あり、軽微なペナルティのみ
        g1Note = `G1で${stat.g1Races}戦連対なし`
      }

      // Same-distance or same-venue G1 credit
      let sameDistCredit = 0
      for (const [dk2, dv2] of Object.entries(distData)) {
        const d2 = parseInt(dk2, 10)
        if (isNaN(d2) || d2 === race.distance) continue
        if (Math.abs(d2 - race.distance) <= 100 && dv2.places > 0) {
          sameDistCredit = Math.max(sameDistCredit, 6)
        }
      }
      if (vStat && vStat.places > 0 && stat.g1Places > 0) {
        sameDistCredit = Math.max(sameDistCredit, 5)
      }
      const credit = Math.min(sameDistCredit, 8)
      g1Bonus += credit
      if (credit > 0) g1Note += '+近距離G1'
    }
  }

  let ageBonus = 0
  let ageNote = ''
  if (entry.age != null) {
    if (entry.age === 3)                         { ageBonus = 3;  ageNote = '3歳(ポテンシャル)' }
    else if (entry.age === 4 || entry.age === 5) { ageBonus = 2;  ageNote = `${entry.age}歳(充実期)` }
    else if (entry.age >= 7)                     { ageBonus = -4; ageNote = `${entry.age}歳(晩年期)` }
  }

  let weightNote = ''
  let weightBonus = 0
  if (entry.weightChange != null) {
    const wc = entry.weightChange
    const sign = wc > 0 ? '+' : ''
    if (Math.abs(wc) <= 3)       { weightBonus = 3;  weightNote = `体重安定(${sign}${wc}kg)` }
    else if (Math.abs(wc) > 10)  { weightBonus = -8; weightNote = `体重大幅変動(${sign}${wc}kg)` }
    else if (Math.abs(wc) > 6)   { weightBonus = -4; weightNote = `体重変動(${sign}${wc}kg)` }
    else                          { weightBonus = -2; weightNote = `体重小変動(${sign}${wc}kg)` }
  }

  // 騎手評価
  let jockeyBonus = 0
  let jockeyNote = ''
  if (entry.jockey) {
    const jRank = JOCKEY_RANKS[entry.jockey] ?? 0
    jockeyBonus = jRank
    if (jRank >= 14) jockeyNote = `${entry.jockey}(最上位騎手)`
    else if (jRank >= 10) jockeyNote = `${entry.jockey}(S級騎手)`
    else if (jRank >= 7) jockeyNote = `${entry.jockey}(A+級騎手)`
    else if (jRank >= 4) jockeyNote = `${entry.jockey}(A級騎手)`
    else jockeyNote = entry.jockey
  }

  // 少数レース高ポテンシャル補正（出走数≤6でG1連対 → 有望馬）
  let potentialBonus = 0
  if (stat.totalRaces <= 6 && stat.g1Places > 0) {
    const g1Rate = stat.g1Places / stat.g1Races
    potentialBonus = g1Rate >= 0.5 ? 10 : 7
  } else if (stat.totalRaces <= 4 && stat.totalPlaces >= 2) {
    potentialBonus = 5
  }

  // 直近フォームのトレンド補正（改善中ならボーナス）
  let trendBonus = 0
  if (stat.recentForm) {
    const tPos = stat.recentForm.split('-').map(Number).filter((n) => !isNaN(n) && n > 0)
    if (tPos.length >= 4) {
      const recentAvg = (tPos[0] + tPos[1]) / 2
      const olderAvg = (tPos[2] + tPos[3]) / 2
      if (recentAvg < olderAvg - 1.5) trendBonus = 6
      else if (recentAvg < olderAvg - 0.5) trendBonus = 3
      else if (recentAvg > olderAvg + 2) trendBonus = -5
    }
  }

  // 同一レース相性ボーナス（宝塚記念を複数回制覇した馬など）
  let raceAffinityBonus = 0
  if (race.name && stat.raceNameData) {
    const raceKey = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const rnData = (stat.raceNameData as StatRecord)[raceKey]
    if (rnData && rnData.races > 0) {
        if (rnData.places >= 2)       raceAffinityBonus = 18  // 2回以上連対: 強力な適性
      else if (rnData.places >= 1)  raceAffinityBonus = 6   // 1回連対: 小ボーナス
      else if (rnData.races >= 3)   raceAffinityBonus = -4  // 3回以上出走・未連対: 弱ペナルティ
    }
  }

  // 前哨戦実績ボーナス
  let prepBonus = 0
  if (race.name && stat.raceNameData) {
    const currentRaceBase = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const prepList = PREP_RACES[currentRaceBase] ?? []
    for (const prepName of prepList) {
      const pd = (stat.raceNameData as StatRecord)[prepName]
      if (pd && pd.races >= 1) {
        if (pd.places >= 1) { prepBonus = Math.max(prepBonus, 6); break }
        else                { prepBonus = Math.max(prepBonus, 2) }
      }
    }
  }

  // 馬場状態補正（芝の重/不良でペナルティ、ダートなら恩恵）
  let trackCondBonus = 0
  if (race.trackCondition && race.trackCondition !== '良') {
    if (race.surface === '芝') {
      if (race.trackCondition === '不良') {
        const overallRate = stat ? stat.totalPlaces / stat.totalRaces : 0
        trackCondBonus = overallRate >= 0.40 ? 3 : overallRate >= 0.25 ? 0 : -5
      } else if (race.trackCondition === '重') {
        const overallRate = stat ? stat.totalPlaces / stat.totalRaces : 0
        trackCondBonus = overallRate >= 0.40 ? 2 : overallRate >= 0.20 ? 0 : -3
      } else if (race.trackCondition === '稍重') {
        trackCondBonus = 0  // 稍重はほぼ変わらず
      }
    } else if (race.surface === 'ダート') {
      if (race.trackCondition === '重' || race.trackCondition === '不良') trackCondBonus = 3
      else if (race.trackCondition === '稍重') trackCondBonus = 1
    }
  }

  // Apply weight multipliers to each factor
  const wRecentForm    = Math.round(recentFormBonus   * weights.recentFormMult)
  const wDistance      = Math.round(distanceBonus     * weights.distanceMult)
  const wVenue         = Math.round(venueBonus         * weights.venueMult)
  const wSurface       = Math.round(surfaceBonus       * weights.surfaceMult)
  const wG1            = Math.round(g1Bonus            * weights.g1Mult)
  const wAge           = Math.round(ageBonus           * weights.ageMult)
  const wJockey        = Math.round(jockeyBonus        * (weights.jockeyMult ?? 1.0))
  const wRaceAffinity  = Math.round(raceAffinityBonus  * (weights.raceAffinityMult ?? 1.0))
  const wTrackCond     = Math.round(trackCondBonus     * (weights.trackCondMult ?? 1.0))

  const totalBonus = wRecentForm + wDistance + wVenue + wSurface + wG1 + wAge + wJockey + wRaceAffinity + wTrackCond + prepBonus + weightBonus + potentialBonus + trendBonus

  // Cap effective base at 60% before bonuses (72上限はソート後にランクキャップで適用)
  const cappedBase = Math.min(effectiveBase, 60)
  const finalRate = Math.max(20, cappedBase + totalBonus)

  const reason = [
    `ベース連対率${(baseSmoothed * 100).toFixed(0)}%(${stat.totalRaces}戦)`,
    g1Note,
    ageNote,
    jockeyNote,
    weightNote,
  ].filter(Boolean).join('、')

  return {
    rank: 0,
    horseNumber: entry.horseNumber,
    horseName: entry.horseName,
    placeRate: Math.round(finalRate * 10) / 10,
    factors: {
      recentForm: recentFormText,
      distanceSuitability,
      courseRecord,
      jockeyStats: jockeyNote || entry.jockey || '未定',
      reason,
      _bonuses: {
        recentForm: wRecentForm,
        distance: wDistance,
        venue: wVenue,
        surface: wSurface,
        g1: wG1,
        age: wAge,
        jockey: wJockey,
        raceAffinity: wRaceAffinity,
        trackCond: wTrackCond,
        prep: prepBonus,
      },
    },
  }
}

// predict/route.tsのためのエントリー補完ユーティリティ
export function mergeEntriesWithResults(
  entries: { horseNumber: number; horseName: string; age?: number | null; jockey?: string | null }[],
  results: { horseNumber: number; horseName: string }[]
) {
  const entryNames = new Set(entries.map((e) => e.horseName))
  const additional = results
    .filter((r) => !entryNames.has(r.horseName))
    .map((r) => ({ horseNumber: r.horseNumber, horseName: r.horseName, age: null, jockey: null }))
  return [...entries, ...additional]
}
