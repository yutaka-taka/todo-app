/**
 * 選定前 ML 確率(mlRateMap)に対するヒューリスティック補正レイヤ。
 *
 * 目的（2026 東京優駿の取りこぼし分析より）:
 *  - 距離未経験の「逃げ/先行」馬がスピード指数だけで過大評価される問題
 *    （例: リアライズシリウス 2400m実績なし・完全な逃げ → 予想2位だが7着）。
 *  - 少経験馬(1〜2戦)の確率が薄いサンプルで極端に振れる問題
 *    （例: パントルナイーフ 1戦のみ → 圏外だが2着）。
 *
 * いずれも「どの5頭を選ぶか」に効かせたいので、scorer.ts の選定が参照する
 * mlRateMap（馬名→ML連対確率%）そのものを選定前に補正する。
 * 再訓練不要・ONNX非依存・STAMINA_ADJUST=0 で無効化可能。
 */
import type { HorseStat } from '@prisma/client'

const SHRINK_K = Number(process.env.SHRINK_K ?? 2)          // 縮約の強さ（小=弱い縮約）。n戦の馬は n/(n+K) だけ自前評価を残す
// フォーム考慮の縮約緩和（0=無効＝旧挙動）。少経験でも直近フォームが強い馬は縮約を弱める。
// G1診断で「≤3戦の好フォーム馬(form[1-1]/[1-5-1]等)を過小評価し連対を取りこぼす」問題への対策。
const SHRINK_FORM_RELIEF = Number(process.env.SHRINK_FORM_RELIEF ?? 0.6)
const STAMINA_MAX_CUT = 0.35 // スタミナ減点の上限（35%）
const STEPUP_FULL_M = 800    // この延長幅(m)で base=1（最大減点）に達する

// 直近フォーム品質 0..1（高いほど強い）。recentForm は最新が先頭。直近3走を recency 加重。
// 勝ち・連対が多いほど高く、大敗(>=8着)が多いほど低い。データ無し(=デビュー)は 0（縮約は維持）。
function formQuality(recentForm: string | null | undefined): number {
  if (!recentForm) return 0
  const pos = recentForm.split('-').map(Number).filter((n) => !isNaN(n) && n > 0)
  if (pos.length === 0) return 0
  const w = [1.0, 0.6, 0.3]
  let num = 0, den = 0
  for (let i = 0; i < Math.min(3, pos.length); i++) {
    const p = pos[i]
    const f = p === 1 ? 1.0 : p === 2 ? 0.7 : p === 3 ? 0.4 : p <= 5 ? 0.15 : p >= 8 ? -0.3 : 0
    num += w[i] * f; den += w[i]
  }
  return clamp01(den > 0 ? num / den : 0)
}

interface DistRow { races?: number; places?: number }

function parseDistData(v: unknown): Record<string, DistRow> {
  try {
    const d = typeof v === 'string' ? JSON.parse(v) : v
    return (d && typeof d === 'object') ? (d as Record<string, DistRow>) : {}
  } catch {
    return {}
  }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/**
 * 距離延長×脚質スタミナ減点率（0〜STAMINA_MAX_CUT）を返す。
 * - 当該距離の経験が1走以上あれば 0（実績で裏付け済み）。
 * - 経験が無ければ「実績最長距離からの延長幅」× 脚質 で減点。
 *   逃げ・先行(frontRate高/posRatio小)ほど大きく、追込(posRatio大)ほど小さい。
 */
function staminaCut(s: HorseStat, distance: number): number {
  const dd = parseDistData(s.distanceData)
  const expAtDist = dd[String(distance)]?.races ?? 0
  if (expAtDist >= 1) return 0

  let provenMax = 0
  for (const [k, row] of Object.entries(dd)) {
    if ((row?.races ?? 0) >= 1) provenMax = Math.max(provenMax, Number(k) || 0)
  }
  // 実績距離が不明（distanceData空）の場合は中程度の延長(400m)とみなす
  const ext = provenMax > 0 ? distance - provenMax : 400
  if (ext <= 0) return 0

  const base = Math.min(ext, STEPUP_FULL_M) / STEPUP_FULL_M // 0..1
  // 先行度: frontRate を優先、無ければ posRatio(0=前,1=後)から (1-posRatio)
  const frontRaw = s.frontRate != null
    ? s.frontRate
    : (s.avgPosRatio != null ? 1 - s.avgPosRatio : 0.3)
  const frontMult = 0.4 + 0.8 * clamp01(frontRaw) // 追込≈0.4 / 完全逃げ≈1.2
  return Math.min(STAMINA_MAX_CUT, 0.25 * base * frontMult)
}

/**
 * mlRateMap を選定前に補正して返す（元のMapは変更しない）。
 * @param mlRateMap 馬名→ML連対確率(%)
 * @param stats     出走馬の HorseStat 配列
 * @param race      距離（スタミナ判定に使用）
 */
export function adjustMlRatesForStamina(
  mlRateMap: Map<string, number>,
  stats: HorseStat[],
  race: { distance: number },
): Map<string, number> {
  const statByName = new Map(stats.map((s) => [s.horseName, s]))
  // フィールド平均（Map は forEach で集計。for...of / スプレッドは downlevelIteration エラー）
  let sum = 0, cnt = 0
  mlRateMap.forEach((v) => { sum += v; cnt++ })
  const mean = cnt ? sum / cnt : 11

  const out = new Map<string, number>()
  mlRateMap.forEach((rate, name) => {
    const s = statByName.get(name)
    if (!s) {
      // データ欠損馬は平均寄りへ強めに縮約（過大/過小いずれも是正）
      out.set(name, 0.4 * rate + 0.6 * mean)
      return
    }
    // 1) 少経験馬の縮約: n戦 → n/(n+K) だけ自前評価を残し、残りは平均へ。
    //    ただし直近フォームが強い少経験馬は縮約を弱める（effK を下げる）＝好フォームの素質馬を救済。
    const n = Math.max(0, s.totalRaces ?? 0)
    const effK = SHRINK_K * (1 - SHRINK_FORM_RELIEF * formQuality(s.recentForm))
    let r = (n / (n + effK)) * rate + (effK / (n + effK)) * mean
    // 2) 距離延長×脚質スタミナ減点
    r = r * (1 - staminaCut(s, race.distance))
    out.set(name, r)
  })
  return out
}
