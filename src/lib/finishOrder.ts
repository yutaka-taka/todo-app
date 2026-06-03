/**
 * 着順確率モデル（Learning-to-Rank の生スコア → 連対(top2)確率）。
 *
 * 背景（Benter の香港モデル / annotated paper より）:
 *  - 素の Harville 式（独立性仮定）は「人気薄が2・3着に来る頻度」を系統的に過小評価する。
 *  - Benter は条件付き確率に指数 γ(≈0.81), δ(≈0.65) を掛けてこのバイアスを補正した。
 *  本アプリの取りこぼしは「低評価馬の2着」(ヴェルテンベルク12人気2着・ガイアフォース9人気2着)に
 *  集中しており、γ<1 の補正は連対確率の裾を持ち上げる＝この弱点に直接効く。
 *
 * lambdarank の生スコアはレース内の相対順位のみ意味を持つため、レース内 softmax で
 * 勝率 w_i（Σ=1）に変換し、Harville+γ で P(i が連対) を求める。
 */

/** レース内 softmax: ランカー生スコア列 → 勝率（合計1）。temperature で鋭さ調整。 */
export function rawScoresToWinProbs(scores: number[], temperature = 1): number[] {
  if (scores.length === 0) return []
  const m = Math.max(...scores)
  const ex = scores.map((s) => Math.exp((s - m) / Math.max(temperature, 1e-6)))
  const sum = ex.reduce((a, b) => a + b, 0) || 1
  return ex.map((e) => e / sum)
}

/**
 * 勝率 w_i から「連対(1〜2着)確率」を Harville + Benter γ補正で計算。
 *  P(i 連対) = w_i + Σ_{j≠i} w_j · s_i/(1 - s_j),  s = w^γ を正規化。
 *  γ=1 で素の Harville。γ<1 で人気薄の2着確率を持ち上げる（favorite-longshot bias 是正）。
 * 全頭の P(連対) の総和は理論上 2（=連対は2頭）に概ね一致する。
 */
export function top2Probs(winProbs: number[], gamma = 0.81): number[] {
  const n = winProbs.length
  if (n === 0) return []
  if (n <= 2) return winProbs.map(() => 1) // 2頭以下は全頭が連対
  const sig = winProbs.map((w) => Math.pow(Math.max(w, 1e-12), gamma))
  const sigSum = sig.reduce((a, b) => a + b, 0) || 1
  const s = sig.map((x) => x / sigSum)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    let second = 0
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const denom = 1 - s[j]
      if (denom > 1e-9) second += winProbs[j] * (s[i] / denom)
    }
    out.push(Math.max(0, Math.min(1, winProbs[i] + second)))
  }
  return out
}

/** ランカー生スコア列 → 連対確率(%)。serving 用のワンショット変換。 */
export function rankScoresToPlacePct(scores: number[], gamma = 0.81, temperature = 1): number[] {
  const win = rawScoresToWinProbs(scores, temperature)
  return top2Probs(win, gamma).map((p) => p * 100)
}
