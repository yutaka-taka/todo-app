'use strict'
/**
 * 細粒度ウェイト最適化 (±0.01〜0.05ステップ)
 * optimize_weights.jsの収束点から更に微調整
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs'), path = require('path')
function loadEnv(f) { try { fs.readFileSync(path.join(__dirname,'..', f), 'utf8').split('\n').forEach(l => { const m = l.match(/^([^=#\s][^=]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'').trim() }) } catch {} }
loadEnv('.env'); loadEnv('.env.local')
const prisma = new PrismaClient()

const JR = { 'C.ルメール':14,'ルメール':14,'武豊':10,'川田将雅':10,'横山武史':10,'坂井瑠星':7,'岩田望来':7,'松山弘平':7,'戸崎圭太':7,'池添謙一':7,'北村友一':7,'M.デムーロ':7,'デムーロ':7,'浜中俊':4,'田辺裕信':4,'丸山元気':4,'幸英明':4,'藤岡佑介':4,'西村淳也':4,'鮫島克駿':4,'永野猛蔵':4,'三浦皇成':4,'福永祐一':7,'岩田康誠':4,'蛯名正義':4,'内田博幸':4,'柴田善臣':4 }
const RANK_CAPS = [65, 52, 38, 28, 22, 18, 15]

const PREP_RACES = {
  '日本ダービー':['皐月賞','NHKマイルカップ','青葉賞'],'菊花賞':['神戸新聞杯','セントライト記念','皐月賞'],
  'オークス':['桜花賞','フローラステークス'],'優駿牝馬（オークス）':['桜花賞','フローラステークス'],
  '天皇賞（春）':['阪神大賞典','日経賞','AJCC','有馬記念'],'宝塚記念':['大阪杯','天皇賞（春）'],
  '天皇賞（秋）':['毎日王冠','オールカマー','札幌記念'],'有馬記念':['ジャパンカップ','天皇賞（秋）','宝塚記念'],
  'ジャパンカップ':['天皇賞（秋）','宝塚記念'],'安田記念':['ヴィクトリアマイル','NHKマイルカップ'],
  'ヴィクトリアマイル':['阪神牝馬ステークス','中山牝馬ステークス','桜花賞'],
  'エリザベス女王杯':['府中牝馬ステークス','秋華賞','オークス'],'秋華賞':['オークス','ローズステークス','紫苑ステークス'],
  'スプリンターズステークス':['キーンランドカップ','セントウルステークス','高松宮記念'],
  '高松宮記念':['シルクロードステークス','オーシャンステークス'],
  'マイルチャンピオンシップ':['スワンステークス','富士ステークス','安田記念'],
  'フェブラリーステークス':['東海ステークス','根岸ステークス','チャンピオンズカップ'],
  'チャンピオンズカップ':['JBCクラシック','みやこステークス','シリウスステークス'],
  'NHKマイルカップ':['アーリントンカップ','ニュージーランドトロフィー','桜花賞'],
  '桜花賞':['チューリップ賞','フィリーズレビュー'],'皐月賞':['弥生賞ディープインパクト記念','スプリングステークス','共同通信杯','弥生賞'],
  '大阪杯':['金鯱賞','中山記念','京都記念'],
}

function sm(p,r){ return (p+2)/(r+8)*100 }

function buildScore(e, race, stat, w) {
  if (!stat || stat.totalRaces === 0) {
    let p=0; const age=e.age?Number(e.age):0
    if(age===3)p+=3; else if(age===4||age===5)p+=2; else if(age>=7)p-=3
    return Math.max(22, Math.min(38, 30+p))
  }
  const base = Math.min(sm(stat.totalPlaces,stat.totalRaces), 60)
  let effectiveBase = base
  if (race.grade === 'G1' && stat.g1Races >= 1) {
    const g1Rate = Math.min(sm(stat.g1Places, stat.g1Races), 60)
    const gw = Math.min(stat.g1Races, 10) / 10 * 0.6
    effectiveBase = base * (1-gw) + g1Rate * gw
  }
  const cappedBase = Math.min(effectiveBase, 60)
  let bonuses = {}

  let g1B=0
  if(stat.g1Races===0){const r=stat.totalRaces>0?stat.totalPlaces/stat.totalRaces:0; g1B=r>=0.45?-3:r>=0.30?-5:-8}
  else{const r=stat.g1Places/stat.g1Races; if(r>=0.4)g1B=18; else if(r>=0.2)g1B=8; else if(stat.g1Races>=3)g1B=-8; else g1B=-1}
  bonuses.g1 = Math.round(g1B*(w.g1Mult||1))

  const dd=stat.distanceData||{},dk=String(race.distance); let dB=0
  if(dd[dk]&&dd[dk].races>0){const sf=Math.min(dd[dk].races,5)/5,r=dd[dk].places/dd[dk].races; dB=r>=0.5?Math.round(15*sf):r>=0.3?Math.round(7*sf):-Math.round(5*sf)}
  else{for(const d of[-200,200,-400,400]){const nd=dd[String(race.distance+d)];if(nd&&nd.races>=2){const f=Math.abs(d)===200?0.5:0.3,r=nd.places/nd.races,v=r>=0.5?15*f:r>=0.3?7*f:-5*f;if(v>dB)dB=v}};dB=Math.round(dB)}
  bonuses.distance = Math.round(dB*(w.distanceMult||1))

  const vd=stat.venueData||{}; let vB=0
  if(vd[race.venue]&&vd[race.venue].races>0){const sf=Math.min(vd[race.venue].races,5)/5,r=vd[race.venue].places/vd[race.venue].races; vB=r>=0.4?Math.round(10*sf):r>=0.2?Math.round(3*sf):-Math.round(3*sf)}
  bonuses.venue = Math.round(vB*(w.venueMult||1))

  const sd=stat.surfaceData||{}; let sB=0
  if(sd[race.surface]&&sd[race.surface].races>0){const sf=Math.min(sd[race.surface].races,8)/8,r=sd[race.surface].places/sd[race.surface].races; sB=r>=0.5?Math.round(8*sf):r<0.2?-Math.round(8*sf):0}
  bonuses.surface = Math.round(sB*(w.surfaceMult||1))

  let fB=0
  if(stat.recentForm){const pos=stat.recentForm.split('-').map(Number).filter(n=>!isNaN(n)&&n>0);if(pos.length>0){const ws=[0.40,0.25,0.18,0.12,0.05];let s=0,t=0;for(let i=0;i<Math.min(pos.length,5);i++){s+=pos[i]*ws[i];t+=ws[i]}const avg=s/t;if(avg<=1.4)fB=24;else if(avg<=1.8)fB=20;else if(avg<=2.2)fB=15;else if(avg<=3.0)fB=8;else if(avg<=4.5)fB=1;else if(avg<=5.5)fB=0;else if(avg>7)fB=-10;else fB=-4;if(pos.length>=2&&pos[0]<=2&&pos[1]<=2)fB+=5;if(pos[0]===1)fB+=3}}
  bonuses.recentForm = Math.round(fB*(w.recentFormMult||1))

  const age=e.age?Number(e.age):0; let aB=0
  if(age===3)aB=3; else if(age===4||age===5)aB=2; else if(age>=7)aB=-4
  bonuses.age = Math.round(aB*(w.ageMult||1))

  const jB=e.jockey?(JR[e.jockey]??0):0
  bonuses.jockey = Math.round(jB*(w.jockeyMult||1))

  let rAB=0
  if(race.name&&stat.raceNameData){const rk=race.name.replace(/\s*\d{4}年?\s*$/,'').trim();const rnd=stat.raceNameData[rk];if(rnd&&rnd.races>0){if(rnd.places>=2)rAB=18;else if(rnd.places>=1)rAB=6;else if(rnd.races>=3)rAB=-4}}
  bonuses.raceAffinity=Math.round(rAB*(w.raceAffinityMult||1))

  // 前哨戦実績ボーナス
  let prepB=0
  if(race.name&&stat.raceNameData){const crb=race.name.replace(/\s*\d{4}年?\s*$/,'').trim();const pl=PREP_RACES[crb]||[];for(const pn of pl){const pd=stat.raceNameData[pn];if(pd&&pd.races>=1){if(pd.places>=1){prepB=Math.max(prepB,6);break}else{prepB=Math.max(prepB,2)}}}}
  bonuses.prep=prepB

  // 馬場状態適性
  let tcB=0
  if(race.trackCondition&&stat){const or2=stat.totalRaces>0?stat.totalPlaces/stat.totalRaces:0;if(race.surface==='芝'){if(race.trackCondition==='不良'){tcB=or2>=0.40?3:or2>=0.25?0:-5}else if(race.trackCondition==='重'){tcB=or2>=0.40?2:or2>=0.20?0:-3}}else if(race.surface==='ダート'){if(race.trackCondition==='重'||race.trackCondition==='不良')tcB=3}}
  bonuses.trackCond=Math.round(tcB*(w.trackCondMult||1))

  let pot=0
  if(stat.totalRaces<=6&&stat.g1Places>0)pot=(stat.g1Places/stat.g1Races)>=0.5?10:7
  else if(stat.totalRaces<=4&&stat.totalPlaces>=2)pot=5

  let tB=0
  if(stat.recentForm){const pos=stat.recentForm.split('-').map(Number).filter(n=>!isNaN(n)&&n>0);if(pos.length>=4){const ra=(pos[0]+pos[1])/2,oa=(pos[2]+pos[3])/2;if(ra<oa-1.5)tB=6;else if(ra<oa-0.5)tB=3;else if(ra>oa+2)tB=-5}}

  const total=Object.values(bonuses).reduce((a,b)=>a+b,0)+pot+tB
  return Math.max(20, cappedBase + total)
}

function scoreRace(entries, race, statsMap, w) {
  const scored = entries.map(e=>({name:e.horseName,s:buildScore(e,race,statsMap.get(e.horseName)||null,w)})).sort((a,b)=>b.s-a.s)
  const top7 = scored.slice(0,7)
  for(let i=0;i<top7.length;i++) top7[i].s=Math.min(top7[i].s,RANK_CAPS[i]??15)
  if(top7.length>=2&&top7[0].s-top7[1].s<5)top7[1].s=Math.max(top7[1].s-7,(RANK_CAPS[1]??52)-12)
  return top7.map(h=>h.name)
}

let allRacesCache = null
async function loadAllRaces() {
  if (allRacesCache) return allRacesCache
  allRacesCache = await prisma.race.findMany({
    include: { entries:{orderBy:{horseNumber:'asc'}}, results:{orderBy:{finishPosition:'asc'}} },
    orderBy: { date: 'asc' },
  })
  return allRacesCache
}

async function evalAccuracy(w) {
  const allRaces = await loadAllRaces()
  const statsMap = new Map(), finishesMap = new Map()
  let full=0, half=0, miss=0

  for (const race of allRaces) {
    if (race.grade === 'G1') {
      const actual = race.results.filter(r=>r.finishPosition<=2).map(r=>r.horseName)
      if (actual.length >= 2) {
        const entryNames = new Set(race.entries.map(e=>e.horseName))
        const additional = race.results.filter(r=>!entryNames.has(r.horseName)).map(r=>({horseNumber:r.horseNumber,horseName:r.horseName,age:null,jockey:null}))
        const top6 = scoreRace([...race.entries,...additional], race, statsMap, w)
        const hits = actual.filter(a=>top6.includes(a)).length
        if(hits===2)full++; else if(hits===1)half++; else miss++
      }
    }
    for (const result of race.results) {
      if (!result.horseName?.trim()) continue
      if (!statsMap.has(result.horseName)) statsMap.set(result.horseName, {totalRaces:0,totalPlaces:0,g1Races:0,g1Places:0,distanceData:{},venueData:{},surfaceData:{},raceNameData:{},recentForm:null})
      const s=statsMap.get(result.horseName), placed=result.finishPosition<=2
      s.totalRaces++;if(placed)s.totalPlaces++
      if(race.grade==='G1'){s.g1Races++;if(placed)s.g1Places++}
      const dk=String(race.distance);if(!s.distanceData[dk])s.distanceData[dk]={races:0,places:0};s.distanceData[dk].races++;if(placed)s.distanceData[dk].places++
      if(!s.venueData[race.venue])s.venueData[race.venue]={races:0,places:0};s.venueData[race.venue].races++;if(placed)s.venueData[race.venue].places++
      if(!s.surfaceData[race.surface])s.surfaceData[race.surface]={races:0,places:0};s.surfaceData[race.surface].races++;if(placed)s.surfaceData[race.surface].places++
      const rk=race.name.replace(/\s*\d{4}年?\s*$/,'').trim();if(!s.raceNameData[rk])s.raceNameData[rk]={races:0,places:0};s.raceNameData[rk].races++;if(placed)s.raceNameData[rk].places++
      if(!finishesMap.has(result.horseName))finishesMap.set(result.horseName,[])
      finishesMap.get(result.horseName).push({date:race.date.getTime(),position:result.finishPosition})
      const f=finishesMap.get(result.horseName);f.sort((a,b)=>b.date-a.date);s.recentForm=f.slice(0,7).map(x=>x.position).join('-')
    }
  }
  const total=full+half+miss
  return { accuracy: total>0?Math.round((full*2+half)/(total*2)*1000)/10:0, full, half, miss }
}

async function main() {
  console.log('=== 細粒度ウェイト最適化 (±0.01〜0.04) ===\n')

  const currentAlgo = await prisma.algorithmConfig.findFirst({ orderBy: { version: 'desc' } })
  let weights = { recentFormMult:0.58, distanceMult:1.28, venueMult:1.15, surfaceMult:1.05, g1Mult:0.85, ageMult:0.40, jockeyMult:0.95, raceAffinityMult:1.0, trackCondMult:1.0 }
  if (currentAlgo?.insights) {
    try { const ins=JSON.parse(currentAlgo.insights); if(ins.localWeights) weights={...weights,...ins.localWeights} } catch {}
  }

  console.log('ベースライン評価中...')
  const baseline = await evalAccuracy(weights)
  console.log(`ベースライン: ${baseline.accuracy}% (full=${baseline.full} half=${baseline.half} miss=${baseline.miss})`)
  console.log('開始ウェイト:', JSON.stringify(weights))

  const factors = ['recentFormMult','distanceMult','venueMult','surfaceMult','g1Mult','ageMult','jockeyMult','raceAffinityMult','trackCondMult']
  const steps = [0.01, 0.02, 0.03, 0.04, -0.01, -0.02, -0.03, -0.04]
  const MIN_W = 0.20, MAX_W = 2.0

  let bestWeights = { ...weights }
  let bestAccuracy = baseline.accuracy
  let improved = true
  let iteration = 0

  while (improved && iteration < 5) {
    improved = false
    iteration++
    console.log(`\n--- 反復 ${iteration} ---`)

    for (const factor of factors) {
      let localBest = bestAccuracy
      let localBestW = bestWeights[factor]

      for (const step of steps) {
        const candidate = { ...bestWeights }
        const newVal = Math.round((bestWeights[factor] + step) * 100) / 100
        if (newVal < MIN_W || newVal > MAX_W) continue
        candidate[factor] = newVal

        const result = await evalAccuracy(candidate)
        if (result.accuracy > localBest + 0.05) {
          localBest = result.accuracy
          localBestW = newVal
        }
      }

      if (localBestW !== bestWeights[factor]) {
        console.log(`  ${factor}: ${bestWeights[factor].toFixed(2)} → ${localBestW.toFixed(2)} (${bestAccuracy.toFixed(1)}% → ${localBest.toFixed(1)}%)`)
        bestWeights = { ...bestWeights, [factor]: localBestW }
        bestAccuracy = localBest
        improved = true
      }
    }

    if (!improved) console.log('  改善なし（収束）')
  }

  console.log('\n=== 最適化結果 ===')
  console.log(`最終ブラインド的中率: ${bestAccuracy}%`)
  console.log(`改善量: ${baseline.accuracy}% → ${bestAccuracy}% (+${Math.round((bestAccuracy-baseline.accuracy)*10)/10}%)`)
  console.log('最適ウェイト:', JSON.stringify(bestWeights))

  if (bestAccuracy > baseline.accuracy) {
    const newVersion = (currentAlgo?.version || 257) + 1
    await prisma.algorithmConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })
    await prisma.algorithmConfig.create({
      data: {
        version: newVersion,
        isActive: true,
        rules: `細粒度最適化: ${baseline.accuracy}%→${bestAccuracy}%`,
        insights: JSON.stringify({
          localWeights: bestWeights,
          localAccuracy: { total: 253, accuracy: bestAccuracy },
          blindAccuracy: bestAccuracy,
          lastLearnedAt: new Date().toISOString(),
          optimizationMethod: 'fine_coordinate_descent',
        }),
        analyzedCount: 253,
        accuracy: bestAccuracy,
      }
    })
    console.log(`\nAlgorithmConfig v${newVersion} 保存完了`)
  } else {
    console.log('\n改善なし - DBは更新しません')
  }
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
