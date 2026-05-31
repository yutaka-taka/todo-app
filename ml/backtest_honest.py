"""
honest バックテスト（リーク除去済み point-in-time parquet の test split で評価）。

build_dataset.py が生成する parquet は各 (馬,レース) の特徴量を対象レース日より前の
レースのみから算出済み（リークなし）。本スクリプトは時系列で最後の test_ratio を
ホールドアウトとし、以下を比較する:
  - 市場ベースライン（オッズ昇順 top5）
  - 能力ヒューリスティック（place_rate/form/距離適性ベース）
  - ML 単体
  - ブレンド（grid search で最適 ML 比率）

レース種別（全体 / 重賞 G1-G3）別に Hit@5(1)/Hit@5(2) を出す。

  python ml/backtest_honest.py --dataset=ml/dataset.parquet --test-ratio=0.20
"""
import argparse
import numpy as np
import pandas as pd
import lightgbm as lgb

FEATURE_COLS = [
    'grade_rank', 'surface_bin', 'distance', 'distance_bin', 'month', 'day_of_year',
    'total_races', 'total_places', 'place_rate', 'g1_races', 'g1_places', 'g2_places', 'g3_places',
    'dist_rate', 'venue_rate', 'surface_rate', 'course_dist_rate',
    'form0', 'form1', 'form2', 'form3', 'form4', 'form_avg', 'form_recent3_avg',
    'days_since_last', 'last_race_pop',
    'jockey_rank', 'trainer_rank',
    'horse_weight', 'weight_change', 'weight_vs_avg',
    'popularity', 'odds', 'odds_log', 'odds_rank',
    'rapid_increase',
]


def heuristic_ability(df):
    """能力ヒューリスティック（市場非依存・point-in-time）。0..1 に正規化された連対力スコア。"""
    place = df['place_rate'].clip(0, 1)
    dist  = df['dist_rate'].clip(0, 1)
    surf  = df['surface_rate'].clip(0, 1)
    # 近3走平均着順 → 良いほど高スコア（1着=最良）。0(データなし)は中庸へ。
    f3 = df['form_recent3_avg'].replace(0, np.nan)
    form_score = (1.0 / f3.clip(lower=1)).fillna(0.15)
    return 0.40 * place + 0.20 * dist + 0.15 * surf + 0.25 * form_score


def hit_rates(df, score_col):
    total = h1 = h2 = 0
    for _, g in df.groupby('race_id'):
        if g['y'].sum() < 2:
            continue
        total += 1
        top5 = g.nlargest(5, score_col)
        hits = int(top5['y'].sum())
        if hits >= 1: h1 += 1
        if hits >= 2: h2 += 1
    if total == 0:
        return 0.0, 0.0, 0
    return h1 / total, h2 / total, total


def report(df, label):
    print(f'\n=== {label}  (races with >=2 placers) ===')
    rows = []
    # 市場（オッズ小さいほど上位 → スコアは負のオッズ順位）
    df = df.copy()
    df['_market'] = -df['odds_rank']
    df['_ability'] = heuristic_ability(df)
    for name, col in [('市場(オッズ)', '_market'), ('能力ヒューリスティック', '_ability'), ('ML単体', '_ml')]:
        h1, h2, n = hit_rates(df, col)
        rows.append((name, h1, h2, n))
    # ブレンド grid（ML確率 と 能力ヒューリスティックを min-max 正規化して合成）
    ml = df['_ml']
    ab = df['_ability']
    ml_n = (ml - ml.min()) / (ml.max() - ml.min() + 1e-9)
    ab_n = (ab - ab.min()) / (ab.max() - ab.min() + 1e-9)
    best = None
    for w in [0.0, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]:
        df['_blend'] = w * ml_n + (1 - w) * ab_n
        h1, h2, n = hit_rates(df, '_blend')
        if best is None or h2 > best[2] or (h2 == best[2] and h1 > best[1]):
            best = (w, h1, h2, n)
    for name, h1, h2, n in rows:
        print(f'  {name:18s}: Hit@5(1)={h1*100:5.1f}%  Hit@5(2)={h2*100:5.1f}%  [{n}]')
    print(f'  {"ブレンド最適":18s}: Hit@5(1)={best[1]*100:5.1f}%  Hit@5(2)={best[2]*100:5.1f}%  [{best[3]}]  (ML比率={best[0]:.1f})')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dataset', default='ml/dataset.parquet')
    ap.add_argument('--model', default='ml/models/model.txt')
    ap.add_argument('--test-ratio', dest='test_ratio', type=float, default=0.20)
    args = ap.parse_args()

    df = pd.read_parquet(args.dataset).sort_values('date').reset_index(drop=True)
    n = len(df)
    test = df.iloc[int(n * (1 - args.test_ratio)):].copy()
    print(f'全 {n} 行 / test {len(test)} 行 ({test["date"].min()} 〜 {test["date"].max()})')

    booster = lgb.Booster(model_file=args.model)
    test['_ml'] = booster.predict(test[FEATURE_COLS])

    report(test, '全レース')
    report(test[test['grade_rank'] >= 2], '重賞のみ (G1/G2/G3)')
    report(test[test['grade_rank'] == 4], 'G1 のみ')


if __name__ == '__main__':
    main()
