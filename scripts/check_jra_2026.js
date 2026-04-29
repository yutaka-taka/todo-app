'use strict'
const fs = require('fs')

async function main() {
  const res = await fetch('https://www.jra.go.jp/datafile/seiseki/replay/2026/jyusyo.html', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  const buf = await res.arrayBuffer()
  const html = new TextDecoder('shift_jis').decode(buf)

  // <td class="race"><span class="grade_icon gX">GX</span>RACE_NAME</td>
  // race name に <a href="..."> がある場合もある
  const racePattern = /<td[^>]*class="race"[^>]*>\s*<span[^>]*class="grade_icon\s+g(\d)"[^>]*>[^<]*<\/span>\s*(?:<a[^>]*>)?([^<]+)/g
  const races = []
  let m
  while ((m = racePattern.exec(html)) !== null) {
    const grade = 'G' + m[1]
    const name = m[2].trim()
    if (name) races.push({ grade, name })
  }

  console.log('JRA 2026 重賞:', races.length, '件')
  // 重複排除
  const uniq = []
  const seen = new Set()
  for (const r of races) {
    if (!seen.has(r.name)) { seen.add(r.name); uniq.push(r) }
  }
  console.log('ユニーク:', uniq.length, '件')

  // 辞書ロード
  const routeContent = fs.readFileSync('src/app/api/fetch-schedule/route.ts', 'utf8')
  const dictNames = new Set()
  for (const m of routeContent.matchAll(/^\s*'([^']+)':\s*\{\s*venue/gm)) dictNames.add(m[1])
  console.log('現在の辞書:', dictNames.size, '件')

  // ファジー比較ヘルパ（route側のvariants生成と同等）
  const norm = s => s
    .replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '')
    .replace(/カップ$|C$/g, '').replace(/ステークス$|S$/g, '')
    .replace(/フィリーズ$|F$/g, '').replace(/トロフィー$|T$/g, '')
    .replace(/ハンデキャップ$|ハンデ$/g, '')
    .replace(/ディープインパクト記念/g, '')
    .replace(/東京スポーツ杯|東スポ杯/g, '東スポ')
    .replace(/AJCC|アメリカJCC|アメリカジョッキークラブカップ|アメリカジョッキークラブC/g, 'AJCC')
    .replace(/[\s　]/g, '')
  const dictNorm = new Map()
  for (const d of dictNames) dictNorm.set(norm(d), d)

  // G1/G2 のみで欠落チェック
  const g12 = uniq.filter(r => r.grade === 'G1' || r.grade === 'G2')
  console.log('\n■ G1/G2 一覧（JRA）:', g12.length)
  for (const r of g12) console.log(' ', r.grade, r.name)

  const missing = []
  const matched = []
  for (const r of g12) {
    if (dictNames.has(r.name)) continue
    const nr = norm(r.name)
    if (dictNorm.has(nr)) {
      matched.push({ jra: r.name, dict: dictNorm.get(nr) })
      continue
    }
    missing.push(r)
  }
  console.log('\n■ 辞書にあるが表記異なる:', matched.length)
  for (const x of matched) console.log(`  ${x.jra} (JRA) ↔ ${x.dict} (辞書)`)
  console.log('\n■ 辞書欠落 G1/G2:', missing.length, '件')
  for (const r of missing) console.log(' ', r.grade, r.name)
}
main().catch(e => console.error(e))
