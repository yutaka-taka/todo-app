"""新オッズ非依存モデルの honest 評価（test split, グレード別 Hit@5）。"""
import json, os
import numpy as np
import pandas as pd
import lightgbm as lgb

HERE = os.path.dirname(__file__)
df = pd.read_parquet(os.path.join(HERE, 'dataset.parquet'))
meta = json.load(open(os.path.join(HERE, 'models', 'meta.json'), encoding='utf-8'))
cols = meta['feature_cols']
booster = lgb.Booster(model_file=os.path.join(HERE, 'models', 'model.txt'))

df = df.sort_values('date').reset_index(drop=True)
n = len(df)
test = df.iloc[int(n * 0.80):].copy()
for c in cols:
    test[c] = test[c].fillna(0)
test['pred'] = booster.predict(test[cols])


def hit(sub, top_n=5):
    races = hit1 = hit2 = 0
    for _, g in sub.groupby('race_id'):
        if g['y'].sum() < 2:
            continue
        races += 1
        h = g.nlargest(top_n, 'pred')['y'].sum()
        hit1 += 1 if h >= 1 else 0
        hit2 += 1 if h >= 2 else 0
    if races == 0:
        return (0, 0, 0)
    return (races, hit1 / races, hit2 / races)


print(f"test rows={len(test)}  AUC(meta)={meta['test_auc']:.4f}  feats={len(cols)}")
for label, sub in [
    ('全レース', test),
    ('重賞(G1/G2/G3)', test[test['grade_rank'] >= 2]),
    ('G1のみ', test[test['grade_rank'] == 4]),
]:
    r, h1, h2 = hit(sub)
    print(f"  {label:16s} races={r:5d}  Hit@5(1)={h1*100:5.1f}%  Hit@5(2)={h2*100:5.1f}%")
