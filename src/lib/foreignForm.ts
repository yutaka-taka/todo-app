/**
 * 海外/地方を含む全戦績の point-in-time 事前評価。
 *
 * 目的: JRA戦績が無い/薄い「0戦海外馬」(カランダガン=海外G1勝ち多数/ロマンチックウォリアー等)を
 * 可予測化する。本アプリの特徴量は JRA中心の RaceResult から作るため、海外G1馬でも totalRaces=0 で
 * 「データなし」既定値(≈平均)に潰れ、top5/伏兵で射程外になる。netkeiba result から取得した全戦績
 * (scripts/fetch_foreign_form.js → ml/foreign_form.json)を読み、対象レース日「より前」の重賞実績から
 * 連対確率の事前値(%)を与える。リーク防止のため beforeDate より前のレースのみ使用する。
 */
import fs from 'fs'
import path from 'path'

interface ForeignRace { date: string; grade: string; pos: number | null; field: number | null; overseas: boolean; venue: string; name: string }
interface ForeignEntry { id: string | null; races: ForeignRace[]; scrapedAt: string }

const FOREIGN_PATH = path.join(process.cwd(), 'ml', 'foreign_form.json')
// この戦数以下の JRA 実績しか無い馬にのみ海外formを適用（実績豊富な馬は本来の特徴量を尊重）。
// 既定0=「JRA完全未経験(真の0戦海外馬)」のみ。1以上にすると遠征凡走組まで拾い集計が悪化（検証済）。
export const FOREIGN_MAX_JRA = Number(process.env.FOREIGN_MAX_JRA ?? 0)
const RECENCY_DAYS = Number(process.env.FOREIGN_RECENCY_DAYS ?? 730) // 直近2年の重賞のみ評価

let _store: Record<string, ForeignEntry> | null = null
let _loaded = false

function load(): Record<string, ForeignEntry> | null {
  if (_loaded) return _store
  _loaded = true
  try {
    if (fs.existsSync(FOREIGN_PATH)) _store = JSON.parse(fs.readFileSync(FOREIGN_PATH, 'utf8'))
  } catch { _store = null }
  return _store
}

export function isForeignFormAvailable(): boolean {
  return !!load()
}

// 重賞1走の「連対確率事前値(%)」。グレード×着順で評価（海外G1≒JRA G1 とみなす）。
function gradedScore(grade: string, pos: number | null): number {
  const p = pos ?? 18
  if (grade === 'G1') return p === 1 ? 40 : p <= 2 ? 34 : p <= 3 ? 27 : p <= 5 ? 20 : 12
  if (grade === 'G2') return p === 1 ? 30 : p <= 2 ? 25 : p <= 3 ? 20 : p <= 5 ? 14 : 9
  if (grade === 'G3') return p === 1 ? 24 : p <= 2 ? 20 : p <= 3 ? 16 : 10
  return 0
}

/**
 * 馬名と対象レース日から「海外form由来の連対確率事前値(%)」を返す。
 * beforeDate より前の重賞実績のみ使用（リークなし）。重賞実績が無ければ null。
 */
export function getForeignRating(horseName: string, beforeDate: Date): number | null {
  const store = load()
  if (!store) return null
  const e = store[horseName]
  if (!e || !e.races?.length) return null
  const before = beforeDate.getTime()
  let best = 0
  let gradedCount = 0
  for (const r of e.races) {
    const t = new Date(r.date).getTime()
    if (isNaN(t) || t >= before) continue // 対象レース以降は使わない
    if (r.grade === '通常') continue
    const days = (before - t) / 86400000
    if (days > RECENCY_DAYS) continue
    gradedCount++
    const recency = days <= 200 ? 1.0 : days <= 400 ? 0.85 : 0.7
    best = Math.max(best, gradedScore(r.grade, r.pos) * recency)
  }
  if (gradedCount === 0) return null
  // 複数の重賞好走があれば少し上積み（一発でない裏付け）
  const depthBonus = Math.min(4, (gradedCount - 1) * 1.5)
  // FOREIGN_SCALE: 海外重賞実績の「JRAへの翻訳率」を割り引く係数（遠征組の凡走で過大評価を防ぐ）。
  // 既定0.55＝G1勝ち→約22%(断然1位でなく有力候補帯)。1.0は過大評価でHit@5悪化（検証済）。0で無効化。
  const scale = Number(process.env.FOREIGN_SCALE ?? 0.55)
  return Math.min(45, (best + depthBonus) * scale)
}

/**
 * mlRateMap（馬名→ML連対確率%）を海外formで上書き補正（破壊的）。
 * JRA戦績が FOREIGN_MAX_JRA 戦以下の馬に限り、海外form事前値が現状ML値より高ければ採用。
 * @param totalRacesByName 馬名→JRA戦数（薄実績判定用）
 */
export function applyForeignForm(
  mlRateMap: Map<string, number>,
  totalRacesByName: Map<string, number>,
  race: { date?: Date },
): void {
  const store = load()
  if (!store || !race.date) return
  mlRateMap.forEach((rate, name) => {
    const jra = totalRacesByName.get(name) ?? 0
    if (jra > FOREIGN_MAX_JRA) return
    const fr = getForeignRating(name, race.date as Date)
    if (fr != null && fr > rate) mlRateMap.set(name, fr)
  })
}
