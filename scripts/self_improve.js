'use strict'
// 自己改善スクリプト: 過去G1レース「予想→結果照合→アルゴリズム改善」を自律実行
const { PrismaClient } = require('@prisma/client')
const Anthropic = require('@anthropic-ai/sdk')
// Load env manually (avoid dotenv dependency)
const fs = require('fs'), path = require('path')
function loadEnv(file) {
  try {
    fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([^=#\s][^=]*)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    })
  } catch {}
}
loadEnv('.env'); loadEnv('.env.local')

const prisma = new PrismaClient()
const client = new (Anthropic.default || Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY })

function extractJSON(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (m) return m[1].trim()
  const s = text.indexOf('{'), e = text.lastIndexOf('}')
  if (s !== -1 && e > s) return text.slice(s, e + 1)
  return text
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// 騎手ランク定義
const JOCKEY_RANKS = {
  'C.ルメール': 14, 'ルメール': 14,
  '武豊': 10, '川田将雅': 10, '横山武史': 10,
  '坂井瑠星': 7, '岩田望来': 7, '松山弘平': 7,
  '戸崎圭太': 7, '池添謙一': 7, '北村友一': 7,
  'M.デムーロ': 7, 'デムーロ': 7,
  '浜中俊': 4, '田辺裕信': 4, '丸山元気': 4,
  '幸英明': 4, '藤岡佑介': 4, '西村淳也': 4,
  '鮫島克駿': 4, '三浦皇成': 4,
  '福永祐一': 7, '岩田康誠': 4, '蛯名正義': 4,
  '内田博幸': 4, '柴田善臣': 4,
}

// Laplace平滑化した連対率スコア（適性・騎手評価強化版）
function scoreHorse(entry, race, stat) {
  if (!stat || stat.totalRaces === 0) return 32
  const base = (stat.totalPlaces + 2) / (stat.totalRaces + 8) * 100
  const effectiveBase = Math.min(base, 60)
  let bonus = 0

  // G1評価
  if (race.grade === 'G1') {
    if (stat.g1Races === 0) {
      const rate = stat.totalPlaces / stat.totalRaces
      bonus += rate >= 0.45 ? -3 : rate >= 0.30 ? -5 : -8
    } else {
      const r = stat.g1Places / stat.g1Races
      if (r >= 0.4) bonus += 18
      else if (r >= 0.2) bonus += 8
      else if (stat.g1Races >= 3) bonus -= 8
      else bonus -= 3
    }
  }

  // 距離適性（実データがあれば）×1.25重み
  const distData = stat.distanceData || {}
  const dk = String(race.distance)
  if (distData[dk] && distData[dk].races > 0) {
    const sf = Math.min(distData[dk].races, 5) / 5
    const r = distData[dk].places / distData[dk].races
    if (r >= 0.5) bonus += Math.round(15 * sf * 1.25)
    else if (r >= 0.3) bonus += Math.round(7 * sf * 1.25)
    else bonus -= Math.round(5 * sf * 1.25)
  }

  // コース適性×1.15重み
  const venueData = stat.venueData || {}
  if (venueData[race.venue] && venueData[race.venue].races > 0) {
    const sf = Math.min(venueData[race.venue].races, 5) / 5
    const r = venueData[race.venue].places / venueData[race.venue].races
    if (r >= 0.4) bonus += Math.round(10 * sf * 1.15)
    else if (r >= 0.2) bonus += Math.round(3 * sf * 1.15)
    else bonus -= Math.round(3 * sf)
  }

  // 馬場適性×1.05重み
  const surfData = stat.surfaceData || {}
  if (surfData[race.surface] && surfData[race.surface].races > 0) {
    const sf = Math.min(surfData[race.surface].races, 8) / 8
    const r = surfData[race.surface].places / surfData[race.surface].races
    if (r >= 0.5) bonus += Math.round(8 * sf * 1.05)
    else if (r < 0.2) bonus -= Math.round(8 * sf)
  }

  // 騎手評価
  if (entry.jockey) {
    bonus += JOCKEY_RANKS[entry.jockey] ?? 0
  }

  // 直近フォーム
  if (stat.recentForm) {
    const pos = stat.recentForm.split('-').map(Number).filter(n => !isNaN(n) && n > 0)
    if (pos.length > 0) {
      const ws = [0.40, 0.25, 0.18, 0.12, 0.05]
      let s = 0, t = 0
      for (let i = 0; i < Math.min(pos.length, 5); i++) { s += pos[i] * ws[i]; t += ws[i] }
      const avg = s / t
      if (avg <= 1.4) bonus += 24
      else if (avg <= 1.8) bonus += 20
      else if (avg <= 2.2) bonus += 15
      else if (avg <= 3.0) bonus += 8
      else if (avg <= 4.5) bonus += 1
      else if (avg > 7) bonus -= 10
      else bonus -= 4
      if (pos.length >= 2 && pos[0] <= 2 && pos[1] <= 2) bonus += 5
      if (pos[0] === 1) bonus += 3
    }
  }

  // 72上限はソート後にランクキャップで適用するため下限のみ
  return Math.round(Math.max(20, effectiveBase + bonus) * 10) / 10
}

// Rank-based caps + differentiation (mirrors scorer.ts)
const RANK_CAPS = [65, 52, 38, 28, 22]
function applyRankCaps(scored) {
  for (let i = 0; i < scored.length; i++) {
    const cap = RANK_CAPS[i] ?? 20
    scored[i].placeRate = Math.min(scored[i].placeRate, cap)
  }
  if (scored.length >= 2 && scored[0].placeRate - scored[1].placeRate < 5) {
    scored[1].placeRate = Math.max(scored[1].placeRate - 7, (RANK_CAPS[1] ?? 52) - 12)
  }
  if (scored.length >= 3 && scored[1].placeRate - scored[2].placeRate < 5) {
    scored[2].placeRate = Math.max(scored[2].placeRate - 12, (RANK_CAPS[2] ?? 38) - 14)
  }
  if (scored.length >= 2 && scored[0].placeRate - scored[1].placeRate < 1) {
    scored[0].placeRate = Math.max(scored[0].placeRate - 5, scored[1].placeRate + 2)
  }
  return scored
}

async function callClaude(prompt, systemPrompt, maxTokens = 2000) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  })
  return msg.content[0].type === 'text' ? msg.content[0].text.trim() : ''
}

async function main() {
  console.log('=== 自己改善サイクル開始 ===\n')
  const today = new Date()
  const knowledgeCutoff = new Date('2025-08-01')

  // ====== Phase 1: G1レース着順取得（小バッチで安定取得）======
  console.log('Phase 1: 過去G1レース着順データをClaudeから取得')
  const targetRaces = await prisma.race.findMany({
    where: { date: { lt: knowledgeCutoff }, grade: 'G1', results: { none: {} } },
    orderBy: { date: 'asc' },
    take: 60,
  })
  console.log(`  対象: ${targetRaces.length}件\n`)

  const resultMap = new Map() // raceId → { race, results }
  const BATCH = 5

  for (let i = 0; i < targetRaces.length; i += BATCH) {
    const batch = targetRaces.slice(i, i + BATCH)
    const raceList = batch.map(r => `${r.name}（${r.date.toISOString().slice(0, 10)}）`).join('\n')

    const prompt = `以下のJRA G1レースの着順上位5頭を教えてください（知っているレースのみ）。

${raceList}

JSON形式のみ: {"races":[{"raceName":"有馬記念2024","results":[{"finishPosition":1,"horseName":"ドウデュース"},{"finishPosition":2,"horseName":"シャフリヤール"},{"finishPosition":3,"horseName":"ダノンデサイル"},{"finishPosition":4,"horseName":"アーバンシック"},{"finishPosition":5,"horseName":"ジャスティンパレス"}]}]}`

    try {
      const text = await callClaude(prompt, 'JRA競馬専門家。確実な過去G1結果のみJSON形式で。', 2500)
      const parsed = JSON.parse(extractJSON(text))
      if (Array.isArray(parsed.races)) {
        for (const rd of parsed.races) {
          if (!Array.isArray(rd.results) || rd.results.length < 2) continue
          const matched = batch.find(r =>
            r.name === rd.raceName ||
            r.name.includes(rd.raceName.replace(/\d{4}/, '').trim()) ||
            rd.raceName.includes(r.name.replace(/\d{4}$/, '').trim())
          )
          if (matched) {
            resultMap.set(matched.id, { race: matched, results: rd.results })
            console.log(`  ✓ ${matched.name}: ${rd.results.slice(0, 2).map(r => r.horseName).join('/')}`)
          }
        }
      }
    } catch (e) {
      console.log(`  バッチ${Math.floor(i / BATCH) + 1}失敗: ${String(e).slice(0, 60)}`)
    }
    await sleep(800)
  }

  console.log(`\n  着順取得: ${resultMap.size}レース`)

  // ====== Phase 2: 出走馬リスト取得 ======
  console.log('\nPhase 2: 出走馬データ取得')
  const entryMap = new Map() // raceId → entries[]
  const raceIds = Array.from(resultMap.keys())
  const EBATCH = 4

  for (let i = 0; i < raceIds.length; i += EBATCH) {
    const ids = raceIds.slice(i, i + EBATCH)
    const races = ids.map(id => resultMap.get(id).race)
    const raceList = races.map(r => `${r.name}（${r.date.toISOString().slice(0, 10)}、${r.venue}、${r.surface}${r.distance}m）`).join('\n')

    const prompt = `以下のJRA G1レースの出走全馬（馬番、馬名、騎手、年齢）を教えてください。

${raceList}

JSON形式のみ: {"races":[{"raceName":"有馬記念2024","entries":[{"horseNumber":1,"horseName":"ドウデュース","jockey":"武豊","age":5},{"horseNumber":2,"horseName":"シャフリヤール","jockey":"川田将雅","age":6}]}]}

各レースの全出走馬（15〜18頭）を含めてください。`

    try {
      const text = await callClaude(prompt, 'JRA競馬専門家。過去G1出走全馬をJSON形式で。', 4096)
      const parsed = JSON.parse(extractJSON(text))
      if (Array.isArray(parsed.races)) {
        for (const ed of parsed.races) {
          if (!Array.isArray(ed.entries) || ed.entries.length < 5) continue
          const matched = races.find(r =>
            r.name === ed.raceName ||
            r.name.includes(ed.raceName.replace(/\d{4}/, '').trim())
          )
          if (matched) {
            entryMap.set(matched.id, ed.entries)
            console.log(`  ✓ ${matched.name}: ${ed.entries.length}頭`)
          }
        }
      }
    } catch (e) {
      console.log(`  エントリーバッチ${Math.floor(i / EBATCH) + 1}失敗: ${String(e).slice(0, 60)}`)
    }
    await sleep(800)
  }

  // ====== Phase 3: DBに保存 ======
  console.log('\nPhase 3: DB保存')
  let seeded = 0
  for (const [raceId, data] of resultMap) {
    const { race, results } = data
    const entries = entryMap.get(raceId) || []

    let entrySaved = 0
    for (const e of entries) {
      if (!e.horseName || !e.horseNumber) continue
      try {
        await prisma.raceEntry.create({
          data: { raceId, horseNumber: Number(e.horseNumber), horseName: String(e.horseName).trim(), jockey: e.jockey || null, age: e.age || null }
        })
        entrySaved++
      } catch {}
    }

    let resultSaved = 0
    for (const res of results.slice(0, 5)) {
      if (!res.horseName) continue
      const hn = entries.find(e => e.horseName === res.horseName)?.horseNumber ?? (90 + res.finishPosition)
      try {
        await prisma.raceResult.create({
          data: { raceId, finishPosition: Number(res.finishPosition), horseNumber: Number(hn), horseName: String(res.horseName).trim() }
        })
        resultSaved++
      } catch {}
    }

    if (resultSaved >= 2) {
      seeded++
      console.log(`  ✓ ${race.name}: 出走${entrySaved}頭, 結果${resultSaved}件`)
    }
  }
  console.log(`\n  DB保存: ${seeded}レース`)

  // ====== Phase 4: HorseStatをRaceResultから更新（distanceData・recentForm付き）======
  console.log('\nPhase 4: HorseStat更新')
  const allResultRaces = await prisma.race.findMany({
    where: { results: { some: {} } },
    include: { results: { orderBy: { finishPosition: 'asc' } } },
    orderBy: { date: 'asc' },
  })

  const statsMap = new Map()
  const finishesMap = new Map()

  for (const race of allResultRaces) {
    for (const res of race.results) {
      if (!res.horseName?.trim()) continue
      const placed = res.finishPosition <= 2
      if (!statsMap.has(res.horseName)) {
        statsMap.set(res.horseName, {
          totalRaces: 0, totalPlaces: 0, g1Races: 0, g1Places: 0,
          distanceData: {}, venueData: {}, surfaceData: {}, lastRaceDate: race.date
        })
      }
      const s = statsMap.get(res.horseName)
      s.totalRaces++
      if (placed) s.totalPlaces++
      if (race.grade === 'G1') { s.g1Races++; if (placed) s.g1Places++ }
      const dk = String(race.distance)
      if (!s.distanceData[dk]) s.distanceData[dk] = { races: 0, places: 0 }
      s.distanceData[dk].races++; if (placed) s.distanceData[dk].places++
      if (!s.venueData[race.venue]) s.venueData[race.venue] = { races: 0, places: 0 }
      s.venueData[race.venue].races++; if (placed) s.venueData[race.venue].places++
      if (!s.surfaceData[race.surface]) s.surfaceData[race.surface] = { races: 0, places: 0 }
      s.surfaceData[race.surface].races++; if (placed) s.surfaceData[race.surface].places++
      if (race.date > s.lastRaceDate) s.lastRaceDate = race.date
      if (!finishesMap.has(res.horseName)) finishesMap.set(res.horseName, [])
      finishesMap.get(res.horseName).push({ date: race.date.getTime(), position: res.finishPosition })
    }
  }

  finishesMap.forEach((finishes, horseName) => {
    const s = statsMap.get(horseName)
    if (!s) return
    finishes.sort((a, b) => b.date - a.date)
    s.recentForm = finishes.slice(0, 5).map(f => f.position).join('-')
  })

  function mergeData(ex, inc) {
    const m = { ...ex }
    for (const [k, v] of Object.entries(inc)) {
      m[k] = m[k] ? { races: m[k].races + v.races, places: m[k].places + v.places } : { ...v }
    }
    return m
  }

  let horseUpdated = 0
  for (const [horseName, hs] of statsMap) {
    try {
      const existing = await prisma.horseStat.findUnique({ where: { horseName } })
      if (existing) {
        const newParts = hs.recentForm ? hs.recentForm.split('-') : []
        const oldParts = existing.recentForm ? existing.recentForm.split('-') : []
        const mergedForm = [...newParts, ...oldParts].filter(Boolean).slice(0, 7).join('-')
        await prisma.horseStat.update({
          where: { horseName },
          data: {
            distanceData: mergeData(existing.distanceData, hs.distanceData),
            venueData: mergeData(existing.venueData, hs.venueData),
            surfaceData: mergeData(existing.surfaceData, hs.surfaceData),
            recentForm: mergedForm || null,
            lastRaceDate: hs.lastRaceDate > (existing.lastRaceDate || new Date(0)) ? hs.lastRaceDate : existing.lastRaceDate,
          }
        })
      } else {
        await prisma.horseStat.create({
          data: {
            horseName, totalRaces: hs.totalRaces, totalPlaces: hs.totalPlaces,
            g1Races: hs.g1Races, g1Places: hs.g1Places,
            distanceData: hs.distanceData, venueData: hs.venueData, surfaceData: hs.surfaceData,
            lastRaceDate: hs.lastRaceDate, recentForm: hs.recentForm || null,
          }
        })
      }
      horseUpdated++
    } catch {}
  }
  console.log(`  HorseStat更新: ${horseUpdated}頭（recentForm/distanceData付き）`)

  // ====== Phase 5: 予想生成 ======
  console.log('\nPhase 5: 予想生成')
  const racesToPredict = await prisma.race.findMany({
    where: {
      date: { lt: today },
      results: { some: { finishPosition: { lte: 2 } } },
      predictions: { none: {} },
    },
    include: {
      entries: { orderBy: { horseNumber: 'asc' } },
      results: { orderBy: { finishPosition: 'asc' } },
    },
    orderBy: { date: 'asc' },
  })

  let predictedCount = 0
  const predLog = []

  for (const race of racesToPredict) {
    const rawEntries = race.entries.length > 0
      ? race.entries
      : race.results.map(r => ({ horseNumber: r.horseNumber, horseName: r.horseName, age: r.age, jockey: r.jockey, horseWeight: null }))
    if (rawEntries.length === 0) continue

    const horseNames = rawEntries.map(e => e.horseName)
    const stats = await prisma.horseStat.findMany({ where: { horseName: { in: horseNames } } })
    const statMap = new Map(stats.map(s => [s.horseName, s]))

    const scored = applyRankCaps(
      rawEntries
        .map(e => ({ ...e, placeRate: scoreHorse(e, race, statMap.get(e.horseName) || null) }))
        .sort((a, b) => b.placeRate - a.placeRate)
        .slice(0, 5)
    ).map((h, i) => ({ ...h, rank: i + 1 }))

    if (scored.length === 0) continue

    await prisma.prediction.createMany({
      data: scored.map(p => ({
        raceId: race.id,
        horseNumber: p.horseNumber,
        horseName: p.horseName,
        placeRate: p.placeRate,
        rank: p.rank,
        factors: { jockeyStats: p.jockey || '不明' },
      }))
    })

    const actualTop2 = race.results.filter(r => r.finishPosition <= 2).map(r => r.horseName)
    const top5 = scored.map(p => p.horseName)
    const hits = actualTop2.filter(n => top5.includes(n)).length
    const label = hits === 2 ? '完全' : hits === 1 ? '半的中' : '外れ'
    predLog.push(`[${label}] ${race.name}: 予想[${top5.slice(0, 3).join('/')}] 実際[${actualTop2.join('/')}]`)
    predictedCount++
  }

  console.log(`  予想生成: ${predictedCount}レース`)
  predLog.forEach(l => console.log(`  ${l}`))

  // ====== Phase 6: 精度統計 ======
  console.log('\nPhase 6: 精度統計')
  const racesWithBoth = await prisma.race.findMany({
    where: { predictions: { some: {} }, results: { some: {} } },
    include: {
      predictions: { orderBy: { rank: 'asc' } },
      results: { orderBy: { finishPosition: 'asc' } },
    },
    orderBy: { date: 'asc' },
  })

  let completeHits = 0, halfHits = 0, misses = 0
  const rankHits = { 1: { a: 0, h: 0 }, 2: { a: 0, h: 0 }, 3: { a: 0, h: 0 }, 4: { a: 0, h: 0 }, 5: { a: 0, h: 0 } }
  const missExamples = []

  for (const r of racesWithBoth) {
    const top5 = r.predictions.slice(0, 5).map(p => p.horseName)
    const actualTop2 = r.results.filter(res => res.finishPosition <= 2).map(res => res.horseName)
    if (actualTop2.length < 2) continue
    const hits = actualTop2.filter(a => top5.includes(a)).length
    if (hits === 2) completeHits++
    else if (hits === 1) halfHits++
    else misses++
    for (const pred of r.predictions.slice(0, 5)) {
      if (rankHits[pred.rank]) { rankHits[pred.rank].a++; if (actualTop2.includes(pred.horseName)) rankHits[pred.rank].h++ }
    }
    if (hits < 2) {
      const surprises = actualTop2.filter(a => !top5.includes(a))
      const topStr = r.predictions.slice(0, 3).map(p => `${p.rank}位${p.horseName}(${p.placeRate}%)`).join('/')
      missExamples.push(`${r.name}: 予想[${topStr}]→実際[${actualTop2.join('/')}] 外:[${surprises.join('/')}]`)
    }
  }

  const total = racesWithBoth.length
  const accuracy = total > 0 ? Math.round((completeHits * 2 + halfHits) / (total * 2) * 1000) / 10 : 0

  console.log(`  照合レース数: ${total}`)
  console.log(`  通算的中率: ${accuracy}%`)
  console.log(`  完全的中(2/2): ${completeHits}件 / 半的中(1/2): ${halfHits}件 / 外れ(0/2): ${misses}件`)
  console.log(`\n  予想順位別的中率:`)
  for (const [rank, v] of Object.entries(rankHits)) {
    if (v.a > 0) console.log(`    ${rank}位: ${v.h}/${v.a}回 (${Math.round(v.h / v.a * 100)}%)`)
  }
  if (missExamples.length > 0) {
    console.log(`\n  外れパターン:`)
    missExamples.slice(0, 8).forEach(m => console.log(`    ${m}`))
  }

  // ====== Phase 7: Claude分析 → AlgorithmConfig更新 ======
  if (total >= 5) {
    console.log('\nPhase 7: Claude分析 → アルゴリズム改善')

    const rankLines = Object.entries(rankHits)
      .filter(([, v]) => v.a > 0)
      .map(([rank, v]) => `予想${rank}位: ${v.h}/${v.a}回(${Math.round(v.h / v.a * 100)}%)`)
      .join('\n')

    const currentConfig = await prisma.algorithmConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    })

    const prompt = `JRA競馬予想AIの自己改善システムです。${total}レースの予想を分析してください。

通算的中率: ${accuracy}%
完全的中: ${completeHits}件 / 半的中: ${halfHits}件 / 外れ: ${misses}件

予想順位別的中率:
${rankLines}

代表的な外れパターン:
${missExamples.slice(0, 8).join('\n')}

現在のルール:
${(currentConfig?.rules || '未設定').slice(0, 600)}

以下のJSON形式のみ: {"analysis":"根本原因（4〜6文）","improvements":["改善1","改善2","改善3","改善4"],"updatedRules":"改善後ルール（600文字以内）","estimatedAccuracy":65.0}`

    try {
      const text = await callClaude(prompt, 'JRA競馬予想自己改善AI。累積データを分析してアルゴリズムを改善します。JSON形式のみ。', 2000)
      const json = JSON.parse(extractJSON(text))

      console.log('\n  【分析結果】')
      console.log(`  ${json.analysis}`)
      console.log('\n  【改善点】')
      if (Array.isArray(json.improvements)) json.improvements.forEach(i => console.log(`    - ${i}`))

      if (json.updatedRules && currentConfig) {
        await prisma.algorithmConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })
        const newVersion = (currentConfig.version || 0) + 1
        await prisma.algorithmConfig.create({
          data: {
            version: newVersion, isActive: true,
            rules: json.updatedRules,
            insights: JSON.stringify(json.improvements || []),
            analyzedCount: (currentConfig.analyzedCount || 0) + predictedCount,
            accuracy: json.estimatedAccuracy || accuracy,
          }
        })
        console.log(`\n  → AlgorithmConfig v${newVersion}に更新（推定精度: ${json.estimatedAccuracy}%）`)
        console.log('\n  【更新されたルール（冒頭）】')
        console.log(`  ${json.updatedRules.slice(0, 300)}...`)
      }
    } catch (e) {
      console.log(`  Claude分析失敗: ${e}`)
    }
  } else {
    console.log(`\nPhase 7スキップ: データ不足(${total}件 < 5件)`)
  }

  console.log('\n=== 自己改善サイクル完了 ===')
  await prisma.$disconnect()
}

main().catch(async e => {
  console.error('スクリプトエラー:', e)
  await prisma.$disconnect()
  process.exit(1)
})
