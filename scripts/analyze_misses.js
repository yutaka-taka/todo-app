'use strict'
const { PrismaClient } = require('@prisma/client')
const fs = require('fs'), path = require('path')
function loadEnv(f) { try { fs.readFileSync(path.join(__dirname,'..', f), 'utf8').split('\n').forEach(l => { const m = l.match(/^([^=#\s][^=]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'').trim() }) } catch {} }
loadEnv('.env'); loadEnv('.env.local')
const prisma = new PrismaClient()

const RANK_CAPS = [65, 52, 38, 28, 22, 18, 15]
const W = { recentFormMult:0.58, distanceMult:1.28, venueMult:1.15, surfaceMult:1.05, g1Mult:0.85, ageMult:0.4, jockeyMult:0.95, raceAffinityMult:1, trackCondMult:1 }
const JR = { 'C.ルメール':14,'ルメール':14,'武豊':10,'川田将雅':10,'横山武史':10,'坂井瑠星':7,'岩田望来':7,'松山弘平':7,'戸崎圭太':7,'池添謙一':7,'北村友一':7,'M.デムーロ':7,'デムーロ':7,'浜中俊':4,'田辺裕信':4,'丸山元気':4,'幸英明':4,'藤岡佑介':4,'西村淳也':4,'鮫島克駿':4,'永野猛蔵':4,'三浦皇成':4,'福永祐一':7,'岩田康誠':4,'蛯名正義':4,'内田博幸':4,'柴田善臣':4 }

function sm(p,r){ return (p+2)/(r+8)*100 }

function buildScore(e, race, stat) {
  if (!stat || stat.totalRaces === 0) {
    let p = 0; const age = e.age ? Number(e.age) : 0
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
  let g1B=0; if(stat.g1Races===0){const r=stat.totalRaces>0?stat.totalPlaces/stat.totalRaces:0; g1B=r>=0.45?-3:r>=0.30?-5:-8}
  else{const r=stat.g1Places/stat.g1Races; if(r>=0.4)g1B=18; else if(r>=0.2)g1B=8; else if(stat.g1Races>=3)g1B=-8; else g1B=-3}
  const dd=stat.distanceData||{},dk=String(race.distance); let dB=0
  if(dd[dk]&&dd[dk].races>0){const sf=Math.min(dd[dk].races,5)/5,r=dd[dk].places/dd[dk].races; dB=r>=0.5?Math.round(15*sf):r>=0.3?Math.round(7*sf):-Math.round(5*sf)}
  const vd=stat.venueData||{}; let vB=0
  if(vd[race.venue]&&vd[race.venue].races>0){const sf=Math.min(vd[race.venue].races,5)/5,r=vd[race.venue].places/vd[race.venue].races; vB=r>=0.4?Math.round(10*sf):r>=0.2?Math.round(3*sf):-Math.round(3*sf)}
  const sd=stat.surfaceData||{}; let sB=0
  if(sd[race.surface]&&sd[race.surface].races>0){const sf=Math.min(sd[race.surface].races,8)/8,r=sd[race.surface].places/sd[race.surface].races; sB=r>=0.5?Math.round(8*sf):r<0.2?-Math.round(8*sf):0}
  let fB=0
  if(stat.recentForm){const pos=stat.recentForm.split('-').map(Number).filter(n=>!isNaN(n)&&n>0);if(pos.length>0){const ws=[0.40,0.25,0.18,0.12,0.05];let s=0,t=0;for(let i=0;i<Math.min(pos.length,5);i++){s+=pos[i]*ws[i];t+=ws[i]}const avg=s/t;if(avg<=1.4)fB=24;else if(avg<=1.8)fB=20;else if(avg<=2.2)fB=15;else if(avg<=3.0)fB=8;else if(avg<=4.5)fB=1;else if(avg>7)fB=-10;else fB=-4;if(pos.length>=2&&pos[0]<=2&&pos[1]<=2)fB+=5;if(pos[0]===1)fB+=3}}
  const age=e.age?Number(e.age):0; let aB=0; if(age===3)aB=3; else if(age===4||age===5)aB=2; else if(age>=7)aB=-4
  const jB=e.jockey?(JR[e.jockey]??0):0
  let rAB=0; if(race.name&&stat.raceNameData){const rk=race.name.replace(/\s*\d{4}年?\s*$/,'').trim();const rnd=stat.raceNameData[rk];if(rnd&&rnd.races>0){if(rnd.places>=2)rAB=18;else if(rnd.places>=1)rAB=6;else if(rnd.races>=3)rAB=-4}}
  let pot=0; if(stat.totalRaces<=6&&stat.g1Places>0)pot=(stat.g1Places/stat.g1Races)>=0.5?10:7; else if(stat.totalRaces<=4&&stat.totalPlaces>=2)pot=5
  let tB=0; if(stat.recentForm){const pos=stat.recentForm.split('-').map(Number).filter(n=>!isNaN(n)&&n>0);if(pos.length>=4){const ra=(pos[0]+pos[1])/2,oa=(pos[2]+pos[3])/2;if(ra<oa-1.5)tB=6;else if(ra<oa-0.5)tB=3;else if(ra>oa+2)tB=-5}}
  const total = Math.round(g1B*W.g1Mult)+Math.round(dB*W.distanceMult)+Math.round(vB*W.venueMult)+Math.round(sB*W.surfaceMult)+Math.round(fB*W.recentFormMult)+Math.round(aB*W.ageMult)+Math.round(jB*W.jockeyMult)+Math.round(rAB*W.raceAffinityMult)+pot+tB
  return Math.max(20, cappedBase + total)
}

async function main() {
  const allRaces = await prisma.race.findMany({
    include: { entries:{orderBy:{horseNumber:'asc'}}, results:{orderBy:{finishPosition:'asc'}} },
    orderBy: { date: 'asc' }
  })
  const statsMap = new Map()
  const finishesMap = new Map()
  const missByType = {}
  const missDetails = []

  for (const race of allRaces) {
    if (race.grade === 'G1') {
      const actual = race.results.filter(r=>r.finishPosition<=2).map(r=>r.horseName)
      if (actual.length >= 2) {
        const entryNames = new Set(race.entries.map(e=>e.horseName))
        const additional = race.results.filter(r=>!entryNames.has(r.horseName)).map(r=>({horseNumber:r.horseNumber,horseName:r.horseName,age:null,jockey:null}))
        const scored = [...race.entries,...additional].map(e=>({name:e.horseName,s:buildScore(e,race,statsMap.get(e.horseName)||null)})).sort((a,b)=>b.s-a.s)
        const top7 = scored.slice(0,7); for(let i=0;i<top7.length;i++) top7[i].s=Math.min(top7[i].s,RANK_CAPS[i]??15)
        const top6 = top7.map(h=>h.name)
        const hits = actual.filter(a=>top6.includes(a)).length
        const surf = race.surface
        const distBucket = race.distance >= 2400 ? '超長' : race.distance >= 2000 ? '長距離' : race.distance >= 1600 ? '中距離' : '短距離'
        const key = surf + '_' + distBucket
        if (!missByType[key]) missByType[key] = {full:0,half:0,miss:0}
        if(hits===2)missByType[key].full++; else if(hits===1)missByType[key].half++; else missByType[key].miss++
        if (hits < 2) {
          const surprises = actual.filter(a => !top6.includes(a))
          for (const s of surprises) {
            const st = statsMap.get(s)
            missDetails.push({ race: race.name, date: race.date.toISOString().slice(0,7), horse: s, g1Races: st?.g1Races??0, g1Places: st?.g1Places??0, totalRaces: st?.totalRaces??0, totalPlaces: st?.totalPlaces??0, recentForm: st?.recentForm??null })
          }
        }
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

  console.log('=== レースタイプ別精度 ===')
  for(const [k,v] of Object.entries(missByType).sort((a,b)=>a[0].localeCompare(b[0]))){
    const t=v.full+v.half+v.miss
    const acc=t>0?Math.round((v.full*2+v.half)/(t*2)*100):0
    console.log(`  ${k.padEnd(18)}: ${acc}% (full=${v.full} half=${v.half} miss=${v.miss} total=${t})`)
  }

  console.log('\n=== 見逃し馬の分析 ===')
  const noG1Exp = missDetails.filter(m => m.g1Races === 0)
  const withG1Exp = missDetails.filter(m => m.g1Races > 0)
  console.log(`G1経験なしで勝利: ${noG1Exp.length}頭`)
  console.log(`G1経験ありで見逃し: ${withG1Exp.length}頭`)

  console.log('\nG1未経験だが勝利した馬 (最近のレース形):')
  for (const m of noG1Exp.slice(0,15)) {
    console.log(`  ${m.horse.padEnd(20)} ${m.date} (全${m.totalRaces}戦${m.totalPlaces}連対) フォーム:${m.recentForm||'なし'}`)
  }

  console.log('\nG1経験あり見逃し:')
  for (const m of withG1Exp.slice(0,10)) {
    console.log(`  ${m.horse.padEnd(20)} ${m.date} G1:${m.g1Races}戦${m.g1Places}連対 全:${m.totalRaces}戦${m.totalPlaces}連対`)
  }

  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
