'use strict'
/**
 * 半的中ケース分析: 見落とした馬が何位にランクされているか調べる
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs'), path = require('path')
function loadEnv(f) { try { fs.readFileSync(path.join(__dirname,'..', f), 'utf8').split('\n').forEach(l => { const m = l.match(/^([^=#\s][^=]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'').trim() }) } catch {} }
loadEnv('.env'); loadEnv('.env.local')
const prisma = new PrismaClient()

const W = { recentFormMult:0.76, distanceMult:1.33, venueMult:1.15, surfaceMult:1.05, g1Mult:0.85, ageMult:0.40, jockeyMult:1.0 }
const JR = { 'C.ルメール':14,'ルメール':14,'武豊':10,'川田将雅':10,'横山武史':10,'坂井瑠星':7,'岩田望来':7,'松山弘平':7,'戸崎圭太':7,'池添謙一':7,'北村友一':7,'M.デムーロ':7,'デムーロ':7,'浜中俊':4,'田辺裕信':4,'丸山元気':4,'幸英明':4,'藤岡佑介':4,'西村淳也':4,'鮫島克駿':4,'永野猛蔵':4,'三浦皇成':4,'福永祐一':7,'岩田康誠':4,'蛯名正義':4,'内田博幸':4,'柴田善臣':4 }

function sm(p,r){ return (p+2)/(r+8)*100 }

function score(e, race, stat) {
  const w = W
  if (!stat || stat.totalRaces === 0) {
    let p = 0; const age = e.age ? Number(e.age) : 0
    if (age===3) p+=3; else if (age===4||age===5) p+=2; else if (age>=7) p-=3
    return Math.max(22, Math.min(38, 30+p))
  }
  const base = Math.min(sm(stat.totalPlaces, stat.totalRaces), 60)
  const dd = stat.distanceData||{}, dk = String(race.distance)
  let dB = 0
  if (dd[dk] && dd[dk].races > 0) {
    const sf = Math.min(dd[dk].races,5)/5, r = dd[dk].places/dd[dk].races
    dB = r>=0.5 ? Math.round(15*sf) : r>=0.3 ? Math.round(7*sf) : -Math.round(5*sf)
  }
  const vd = stat.venueData||{}; let vB = 0
  if (vd[race.venue] && vd[race.venue].races > 0) {
    const sf=Math.min(vd[race.venue].races,5)/5, r=vd[race.venue].places/vd[race.venue].races
    vB = r>=0.4?Math.round(10*sf):r>=0.2?Math.round(3*sf):-Math.round(3*sf)
  }
  const sd = stat.surfaceData||{}; let sB = 0
  if (sd[race.surface] && sd[race.surface].races > 0) {
    const sf=Math.min(sd[race.surface].races,8)/8, r=sd[race.surface].places/sd[race.surface].races
    sB = r>=0.5?Math.round(8*sf):r<0.2?-Math.round(8*sf):0
  }
  let g1B = 0
  if (stat.g1Races === 0) {
    const r = stat.totalRaces > 0 ? stat.totalPlaces/stat.totalRaces : 0
    g1B = r>=0.45?-3:r>=0.30?-5:-8
  } else {
    const r = stat.g1Places/stat.g1Races
    if (r>=0.4) g1B=18; else if(r>=0.2) g1B=8; else if(stat.g1Races>=3) g1B=-8; else g1B=-3
  }
  let fB = 0
  if (stat.recentForm) {
    const pos = stat.recentForm.split('-').map(Number).filter(n=>!isNaN(n)&&n>0)
    if (pos.length > 0) {
      const ws=[0.40,0.25,0.18,0.12,0.05]; let s=0,t=0
      for (let i=0;i<Math.min(pos.length,5);i++){s+=pos[i]*ws[i];t+=ws[i]}
      const avg=s/t
      if(avg<=1.4)fB=24; else if(avg<=1.8)fB=20; else if(avg<=2.2)fB=15; else if(avg<=3.0)fB=8; else if(avg<=4.5)fB=1; else if(avg>7)fB=-10; else fB=-4
      if(pos.length>=2&&pos[0]<=2&&pos[1]<=2)fB+=5
      if(pos[0]===1)fB+=3
    }
  }
  const age=e.age?Number(e.age):0; let aB=0
  if(age===3)aB=3; else if(age===4||age===5)aB=2; else if(age>=7)aB=-4
  const jB = e.jockey ? (JR[e.jockey]??0) : 0
  let pot=0
  if(stat.totalRaces<=6&&stat.g1Places>0) pot=(stat.g1Places/stat.g1Races)>=0.5?10:7
  else if(stat.totalRaces<=4&&stat.totalPlaces>=2) pot=5
  let tB=0
  if(stat.recentForm){
    const pos=stat.recentForm.split('-').map(Number).filter(n=>!isNaN(n)&&n>0)
    if(pos.length>=4){const ra=(pos[0]+pos[1])/2,oa=(pos[2]+pos[3])/2; if(ra<oa-1.5)tB=6; else if(ra<oa-0.5)tB=3; else if(ra>oa+2)tB=-5}
  }
  const total = Math.round(g1B*w.g1Mult)+Math.round(dB*w.distanceMult)+Math.round(vB*w.venueMult)+Math.round(sB*w.surfaceMult)+Math.round(fB*w.recentFormMult)+Math.round(aB*w.ageMult)+Math.round(jB*w.jockeyMult)+pot+tB
  return Math.max(20, base + total)
}

async function main() {
  const allRaces = await prisma.race.findMany({
    include: { entries:{orderBy:{horseNumber:'asc'}}, results:{orderBy:{finishPosition:'asc'}} },
    orderBy: { date: 'asc' },
  })
  const statsMap = new Map(), finishesMap = new Map()
  const dist = {}
  let halfTotal = 0

  for (const race of allRaces) {
    if (race.grade === 'G1') {
      const actual = race.results.filter(r=>r.finishPosition<=2).map(r=>r.horseName)
      if (actual.length >= 2) {
        const entryNames = new Set(race.entries.map(e=>e.horseName))
        const additional = race.results.filter(r=>!entryNames.has(r.horseName)).map(r=>({horseNumber:r.horseNumber,horseName:r.horseName,age:null,jockey:null}))
        const allEntries = [...race.entries, ...additional]
        const scored = allEntries.map(e=>({ name:e.horseName, s:score(e,race,statsMap.get(e.horseName)||null) })).sort((a,b)=>b.s-a.s)
        const top6 = scored.slice(0,6).map(h=>h.name)
        const hits = actual.filter(a=>top6.includes(a)).length
        if (hits === 1) {
          halfTotal++
          const missed = actual.find(a=>!top6.includes(a))
          if (missed) {
            const rank = scored.findIndex(h=>h.name===missed) + 1
            const r = rank <= 18 ? rank : 99
            dist[r] = (dist[r]||0) + 1
          }
        }
      }
    }
    for (const result of race.results) {
      if (!result.horseName?.trim()) continue
      if (!statsMap.has(result.horseName)) statsMap.set(result.horseName, {totalRaces:0,totalPlaces:0,g1Races:0,g1Places:0,distanceData:{},venueData:{},surfaceData:{},recentForm:null})
      const s = statsMap.get(result.horseName)
      const placed = result.finishPosition<=2
      s.totalRaces++; if(placed)s.totalPlaces++
      if(race.grade==='G1'){s.g1Races++;if(placed)s.g1Places++}
      const dk=String(race.distance); if(!s.distanceData[dk])s.distanceData[dk]={races:0,places:0}; s.distanceData[dk].races++;if(placed)s.distanceData[dk].places++
      if(!s.venueData[race.venue])s.venueData[race.venue]={races:0,places:0}; s.venueData[race.venue].races++;if(placed)s.venueData[race.venue].places++
      if(!s.surfaceData[race.surface])s.surfaceData[race.surface]={races:0,places:0}; s.surfaceData[race.surface].races++;if(placed)s.surfaceData[race.surface].places++
      if(!finishesMap.has(result.horseName))finishesMap.set(result.horseName,[])
      finishesMap.get(result.horseName).push({date:race.date.getTime(),position:result.finishPosition})
      const f=finishesMap.get(result.horseName); f.sort((a,b)=>b.date-a.date); s.recentForm=f.slice(0,7).map(x=>x.position).join('-')
    }
  }

  console.log('半的中ケースの見落とし馬ランク分布 (total=' + halfTotal + '件):')
  const sorted = Object.entries(dist).sort((a,b)=>Number(a[0])-Number(b[0]))
  let cum = 0
  for (const [rank, cnt] of sorted) {
    cum += cnt
    const bar = '#'.repeat(cnt)
    console.log('  rank' + String(rank).padStart(2) + ': ' + String(cnt).padStart(2) + '件 (累積' + String(Math.round(cum/halfTotal*100)).padStart(3) + '%) ' + bar)
  }
  await prisma.$disconnect()
}
main().catch(e=>{console.error(e);process.exit(1)})
