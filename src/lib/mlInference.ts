/**
 * LightGBM ONNX 推論モジュール
 * ml/models/model.onnx + ml/models/meta.json が必要
 * Phase 3 実装: npm install onnxruntime-node@1.18.0 が前提
 */
import path from 'path'
import fs from 'fs'

const MODEL_DIR  = path.join(process.cwd(), 'ml', 'models')
const MODEL_PATH = path.join(MODEL_DIR, 'model.onnx')
const META_PATH  = path.join(MODEL_DIR, 'meta.json')

export interface MLMeta {
  feature_cols: string[]
  best_iteration: number
  test_auc: number
  hit1_rate: number
  hit2_rate: number
  trained_at: string
  onnx_failed?: string
}

export interface MLFeatureVector {
  grade_rank: number
  surface_bin: number
  distance: number
  distance_bin: number
  month: number
  day_of_year: number
  total_races: number
  total_places: number
  place_rate: number
  g1_races: number
  g1_places: number
  g2_places: number
  g3_places: number
  dist_rate: number
  venue_rate: number
  surface_rate: number
  course_dist_rate: number
  form0: number
  form1: number
  form2: number
  form3: number
  form4: number
  form_avg: number
  form_recent3_avg: number
  days_since_last: number
  last_race_pop: number
  jockey_rank: number
  trainer_rank: number
  horse_weight: number
  weight_change: number
  weight_vs_avg: number
  popularity: number
  odds: number
  odds_log: number
  odds_rank: number
  rapid_increase: number
  [key: string]: number
}

let _session: unknown = null
let _meta: MLMeta | null = null

export function isMLModelAvailable(): boolean {
  return fs.existsSync(MODEL_PATH) && fs.existsSync(META_PATH)
}

export function getMLMeta(): MLMeta | null {
  if (_meta) return _meta
  if (!fs.existsSync(META_PATH)) return null
  try {
    _meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'))
    return _meta
  } catch { return null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtModule = any

async function tryImportOrt(): Promise<OrtModule | null> {
  try {
    // Dynamic import — onnxruntime-node may not be installed yet
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('onnxruntime-node')
  } catch {
    return null
  }
}

export async function loadMLModel(): Promise<{ session: unknown; meta: MLMeta } | null> {
  if (!isMLModelAvailable()) return null
  if (_session && _meta) return { session: _session, meta: _meta }

  try {
    const ort = await tryImportOrt()
    if (!ort) { console.warn('[mlInference] onnxruntime-node が未インストールです'); return null }
    _meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'))
    _session = await ort.InferenceSession.create(MODEL_PATH)
    return { session: _session, meta: _meta! }
  } catch (err) {
    console.warn('[mlInference] ONNX モデルの読み込みに失敗:', (err as Error).message)
    return null
  }
}

export async function predictML(features: MLFeatureVector[]): Promise<number[] | null> {
  const loaded = await loadMLModel()
  if (!loaded) return null

  try {
    const ort = await tryImportOrt()
    if (!ort) return null
    const { session, meta } = loaded
    const cols = meta.feature_cols
    const flat = new Float32Array(features.length * cols.length)
    for (let i = 0; i < features.length; i++) {
      for (let j = 0; j < cols.length; j++) {
        flat[i * cols.length + j] = features[i][cols[j]] ?? 0
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tensor = new ort.Tensor('float32', flat, [features.length, cols.length])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await (session as any).run({ input: tensor })

    // LightGBM ONNX: output_probability shape は [N, 2]
    const probKey = Object.keys(results).find((k: string) => k.includes('probability') || k.includes('prob')) ?? Object.keys(results)[0]
    const probTensor = results[probKey]
    const data = probTensor.data as Float32Array
    const dim = data.length / features.length
    const probs: number[] = []
    for (let i = 0; i < features.length; i++) {
      probs.push(dim === 2 ? data[i * 2 + 1] : data[i])
    }
    return probs
  } catch (err) {
    console.warn('[mlInference] 推論エラー:', (err as Error).message)
    return null
  }
}
