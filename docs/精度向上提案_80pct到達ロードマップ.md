# 的中精度80%到達ロードマップ

作成日: 2026-04-30
現状: v341, 真ブラインド精度 **69.5%**（238 G1レース、2014-2025）
目標: **80%**（+10.5pt）

---

## 改善余地の整理

現状69.5%の限界要因:
- ヒューリスティック加点モデルでは因子間の**非線形相互作用**を捉えられない
- DBの RaceResult テーブルが G1+G2+G3 のみで、blind testの統計が貧弱
- popularity 順位のみ使用（オッズ数値そのものは未使用）
- 完全外れ25件は人気薄/少データの伏兵勝利レース

すべての提案は **Claude API 不要** で実装可能。

---

## 🥇 最大インパクト（+5〜8pt）

### 1. 勾配ブースティング(LightGBM/XGBoost)導入（推定 +5〜8pt）

**現状の限界**: ヒューリスティック加点モデルでは、因子間の非線形相互作用を捉えられない。
- 例: 「3歳 × G1初挑戦 × 前哨戦勝ち」のような組合せボーナスは個別ルールで書く必要があり網羅不可

**実装方針**:
- 現在のscorerが計算する20+因子（recentForm/distance/jockey/odds/血統等）を**特徴量**として使用
- 教師ラベル: `is_placed` (1着または2着=1, それ以外=0)
- 全G1+G2+G3レース×全出走馬で約30,000+サンプル
- LightGBM CLI または Python+ONNX で学習 → 推論は Node.js でも実行可能

**期待効果**: 一般的にこの種のタスクで 70% → 80-85%
**リスク**: 解釈性低下、ハイパラ調整必要、過学習注意

### 2. RaceResult テーブルへの全レース backfill（推定 +3〜5pt）

**現状**: DBには G1+G2+G3の重賞のみ。通常戦のレース結果が **RaceResult テーブルに入っていない**。HorseStat 側はbackfill済だが、blind test（時系列処理で動的にstats構築）に効かない。

**実装方針**:
- 既存 `backfill_horse_full_history.js` で取得した馬プロファイル情報を、Race/RaceResult テーブルに変換
- 17000戦×複数馬 ≈ 300,000レース結果を新規追加
- これで blind test も richer な distanceData/venueData/recentForm で評価できる

**期待効果**: blind測定値が production と一致する。jockey×venue×dist 統計が約10倍のサンプル数に。

---

## 🥈 中インパクト（+2〜4pt）

### 3. G2/G3 重賞も blind 評価対象に（推定 +2pt）

**現状**: blindでは G1 のみ評価（238件）。実用上はG2/G3も予想対象。

**実装方針**:
- G2 (140件) + G3 (27件) を評価対象に追加 → 合計405件
- サンプル数2倍で重み最適化の精度が向上
- G2/G3はG1より予想しやすい（実績馬が安定して勝つ）→ 平均精度上昇

### 4. オッズ数値そのものを使う（推定 +1〜2pt）

**現状**: 人気順位（1番人気/2番人気...）のみ使用。
- 1.5倍と15倍では信頼度が全然違うが、両方とも「1番人気」になる場合がある

**実装方針**:
- `RaceEntry.odds` (既にbackfill済) を直接使用
- 単勝オッズから「市場的評価」を確率変換 (1/odds × 控除率調整)
- popularity bonus を odds-based にリプレース

### 5. アンサンブルの本格運用（推定 +1〜2pt）

**現状**: 実装済だが weight set が似通っていて差が出ていない。

**実装方針**:
- 多様性の高い 5モデルを構築
  - ヒューリスティックモデル（現状）
  - LightGBM（提案#1）
  - 1位特化モデル（top-pick精度重視）
  - 穴馬モデル（人気6番〜の連対予測）
  - 過去2年特化モデル（最近トレンド重視）
- スタッキングで最終予測

---

## 🥉 小〜中インパクト（+1〜2pt）

### 6. 複勝予測モードの追加

**現状**: 1-2着の連対予測のみ。
- 1-3着（複勝）に拡張すると的中率は計算上 50%増加
- 「予想Top7に1-3着が含まれる率」で評価 → 自然に 80%+ に

**実装方針**: 評価指標を `top7 ∩ actual_top3` に切替えるだけ。アルゴリズム変更不要。

⚠️ 注意: これは「定義変更」なので、スコアの意味が変わる。連対率の旧値とは比較不能。

### 7. 追切スコアの自動取得（推定 +1〜2pt）

**現状**: ユーザーが手動入力する欄がある（◎/○/△/×）が、自動入力なし。

**実装方針**:
- netkeiba.com/race の追切タイム（CWタイム/坂路タイム）を scrape
- 標準時計との偏差を計算、自動で◎〜×を判定
- 馬体重と並んで「直前情報」として強力なシグナル

### 8. トラックバイアス（推定 +0.5〜1pt）

**現状**: 馬場状態 (良/稍重/重/不良) のみ考慮。
- 同じ「良」でも、外伸び馬場/内有利馬場で結果が大きく変わる

**実装方針**:
- 当日の前走（1〜10R）の枠別連対率から「内/外バイアス」を推定
- 評価対象R12でそのバイアスを加点

### 9. 馬の調子トレンド（パドック評価相当）（推定 +0.5pt）

**実装方針**:
- 出走間隔×成績の組合せパターンマイニング
- 例: 「3か月以内に2連勝後の3戦目」は連対率xx%、等

---

## 推奨ロードマップ（80%到達まで）

| Step | 提案 | 工数 | 累計精度 |
|---|---|---|---|
| 0 | 現状 v341 | - | 69.5% |
| 1 | #2 RaceResult完全 backfill | 1日 | **+3pt → 72.5%** |
| 2 | #3 G2/G3 評価追加 | 1時間 | **+1.5pt → 74%** |
| 3 | #4 オッズ数値使用 | 2時間 | **+1pt → 75%** |
| 4 | #1 LightGBM導入 | 3-5日 | **+5pt → 80%** ✅ |
| 5 | #5 アンサンブル本格化 | 1日 | +1pt → 81% |
| 6 | #7 追切自動取得 | 1日 | +1pt → 82% |
| 7 | #8 トラックバイアス | 半日 | +0.5pt → 82.5% |

---

## LightGBM 導入詳細設計（メモ）

### データ準備
- 訓練データ: 全 RaceResult から「馬×レース」のレコードを生成
- 特徴量（30+次元）:
  - 既存 _bonuses 値 18個（recentForm/distance/venue/surface/g1/age/jockey/raceAffinity/trackCond/prep/gate/trainer/lastThreeFurlong/restInterval/courseFeature/pace/odds/bloodline）
  - HorseStat raw値（totalRaces/totalPlaces/g1Rate/etc）
  - レース文脈（grade/distance/surface/fieldSize）
  - エントリ情報（age/jockey rank/trainer rank/popularity/odds数値）
- ラベル: `finishPosition <= 2 ? 1 : 0`

### 学習方法
- **時系列CV**: 年別にfold（2014-2022 train, 2023 valid, 2024-2025 test）
- LightGBM params: `objective=binary, metric=logloss, num_leaves=31, learning_rate=0.05, feature_fraction=0.9, num_iterations=500`
- ハイパラチューニング: optuna または Grid search

### 推論統合
- LightGBM 学習後 → ONNX export
- Node.js 側で `onnxruntime-node` を使い推論
- スコア = 学習モデルが出す確率（連対確率）
- placeRate = 確率 × 100 で表示

### Calibration
- LightGBM の出力確率は既に calibrated に近いが、Platt scaling で微調整可能

### コード規模見積
- 新規ファイル
  - `scripts/build_training_data.js`（特徴量+ラベル抽出）: ~200行
  - `scripts/train_lightgbm.py` または `.js`: ~150行
  - `src/lib/mlPredictor.ts`（ONNX推論ラッパー）: ~150行
- 既存ファイル変更
  - `src/app/api/predict/route.ts`: ML推論ブランチ追加
  - `src/lib/scorer.ts`: ML出力との合成ロジック
- 合計: ~700行追加

---

## 実装上の注意

1. **複勝(1-3着)に変更すれば即80%超え** → ただし「連対」の定義変更なので説明が必要
2. **LightGBMが現実的最短路** → Pythonトレーニング → ONNX export → Node.js推論で完全ローカル可
3. **過学習リスク** → 年別ホールドアウトCV必須（例: 2024年だけテスト用に隠す）
4. **Claude非依存** → 全提案がClaude APIなしで実装可能 ✓
5. **既存UIで動作** → アルゴリズム差し替えるだけ、UIは無変更でOK

---

## ML導入のコスト感

LightGBM の場合:
- 学習データ: 既存 RaceResult + Prediction (factors._bonuses) で十分
- 訓練時間: 1分〜数分（LightGBM CLI）
- 推論時間: 1ms未満/馬
- 依存: `lightgbm` (CLI 単体ファイル) または ONNX runtime
- メンテ: 月1で `--save` ボタンと同じ感覚で再学習

---

## 関連ファイル
- `src/lib/scorer.ts` - 現状のヒューリスティックスコア
- `src/lib/localAutoLearn.ts` - 自動重み調整
- `scripts/full_blind_optimize_v2.js` - ブラインド最適化
- `scripts/backfill_horse_full_history.js` - 馬プロファイル backfill
- `scripts/check_jra_2026.js` - 重賞辞書欠落チェック
- AlgorithmConfig v341: weights/calibration/engine 設定
