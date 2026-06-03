"""
LightGBM 訓練。時系列CVで評価。最良モデルをONNX出力。

実行:
    python ml/train.py --dataset=ml/dataset.parquet --out-dir=ml/models
"""
import argparse
import os
import json
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score, log_loss

# オッズ非依存・数日前予想で計算可能な特徴量のみ（build_dataset.py / mlFeatures.ts と一致）
FEATURE_COLS = [
    'grade_rank', 'surface_bin', 'distance', 'distance_bin', 'month', 'day_of_year',
    'total_races', 'total_places', 'place_rate', 'g1_races', 'g1_places', 'g2_places', 'g3_places',
    'dist_rate', 'venue_rate', 'surface_rate', 'course_dist_rate',
    'form0', 'form1', 'form2', 'form3', 'form4', 'form_avg', 'form_recent3_avg',
    'days_since_last', 'last_race_pop',
    'jockey_rank', 'trainer_rank', 'horse_weight',
    'best_speed', 'avg_speed3', 'last_speed', 'avg_pos_ratio', 'front_rate',
    'best_r3f', 'avg_r3f3', 'avg_recent_pop', 'best_recent_pop',
]

# 血統適性。血統スクレイピングが十分に進んだら USE_PEDIGREE=1 で有効化する。
# （未取得が多い段階では定数化してノイズになるため既定では使わない）
PEDIGREE_COLS = ['sire_dist_rate', 'sire_surf_rate', 'bms_dist_rate']
if os.environ.get('USE_PEDIGREE'):
    FEATURE_COLS = FEATURE_COLS + PEDIGREE_COLS

# ローテ（ステップレース）特徴。既定ON（NO_ROTATION=1 で無効化）。
# build_dataset.py の ROTATION_COLS と一致させること（parity）。
# 重要: 旧版は USE_ROTATION=1 の opt-in だったため、月次自動再訓練(KeibaMLRetrain)が
# ローテ無しの38特徴モデルで本番(ml/models)を上書きし、検証済みのローテ改善
# (G1 Hit@5(2) +3.3pt / 768重賞walk-forward)を毎月サイレントに巻き戻していた。
# 既定ONにして再発防止する。serve側 mlFeatures.ts は常にローテ特徴を生成済み。
ROTATION_COLS = ['prev_grade_rank', 'graded_place_rate', 'best_graded_finish', 'last_graded_gap']
if not os.environ.get('NO_ROTATION'):
    FEATURE_COLS = FEATURE_COLS + ROTATION_COLS


def time_split(df, valid_ratio=0.15, test_ratio=0.20):
    """データが少ない場合も動作する割合ベースの時系列分割"""
    df = df.sort_values('date').reset_index(drop=True)
    n = len(df)
    test_start  = int(n * (1 - test_ratio))
    valid_start = int(n * (1 - test_ratio - valid_ratio))
    return (
        df.iloc[:valid_start],
        df.iloc[valid_start:test_start],
        df.iloc[test_start:],
    )


def eval_hit_rate(df, pred_col='pred', top_n=5):
    """5頭中連対馬カバー率を計算"""
    df = df.copy()
    races_total = 0
    hit1 = 0
    hit2 = 0
    for _, g in df.groupby('race_id'):
        if g['y'].sum() < 2:
            continue
        races_total += 1
        top5 = g.nlargest(top_n, pred_col)
        hits = top5['y'].sum()
        if hits >= 1:
            hit1 += 1
        if hits >= 2:
            hit2 += 1
    if races_total == 0:
        return 0.0, 0.0
    return hit1 / races_total, hit2 / races_total


def train(args):
    df = pd.read_parquet(args.dataset)
    print(f'データ: {len(df)} 行')

    feature_cols = [c for c in FEATURE_COLS if c in df.columns]
    print(f'特徴量: {len(feature_cols)} 次元')

    train_df, valid_df, test_df = time_split(df)
    print(f'train={len(train_df)} / valid={len(valid_df)} / test={len(test_df)}')

    # 欠損値を 0 で補完（LightGBM は内部で扱えるが念のため）
    for col in feature_cols:
        train_df[col] = train_df[col].fillna(0)
        valid_df[col] = valid_df[col].fillna(0)
        test_df[col]  = test_df[col].fillna(0)

    from lightgbm import LGBMClassifier
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType as SklFloatTensorType

    clf = LGBMClassifier(
        objective='binary',
        metric=['auc', 'binary_logloss'],
        learning_rate=0.05,
        num_leaves=63,
        min_child_samples=100,
        colsample_bytree=0.85,
        subsample=0.85,
        subsample_freq=5,
        reg_alpha=0.1,
        reg_lambda=0.1,
        verbose=-1,
        random_state=42,
        n_estimators=2000,
    )
    clf.fit(
        train_df[feature_cols], train_df['y'],
        eval_set=[(train_df[feature_cols], train_df['y']), (valid_df[feature_cols], valid_df['y'])],
        eval_names=['train', 'valid'],
        callbacks=[lgb.early_stopping(100, verbose=False), lgb.log_evaluation(50)],
    )

    # テスト評価
    test_pred = clf.predict_proba(test_df[feature_cols])[:, 1]
    test_auc  = roc_auc_score(test_df['y'], test_pred)
    test_loss = log_loss(test_df['y'], test_pred)
    print(f'\nTEST AUC={test_auc:.4f}  LogLoss={test_loss:.4f}')

    test_df = test_df.copy()
    test_df['pred'] = test_pred
    hit1, hit2 = eval_hit_rate(test_df)
    print(f'5頭中1+ヒット: {hit1*100:.1f}%')
    print(f'5頭中2 ヒット: {hit2*100:.1f}%')

    # 特徴量重要度
    booster = clf.booster_
    imp = pd.DataFrame({'feature': feature_cols, 'importance': booster.feature_importance(importance_type='gain')})
    imp = imp.sort_values('importance', ascending=False)
    print('\n特徴量重要度 Top10:')
    print(imp.head(10).to_string(index=False))

    # モデル保存
    os.makedirs(args.out_dir, exist_ok=True)
    model_txt = os.path.join(args.out_dir, 'model.txt')
    booster.save_model(model_txt)
    print(f'\nモデル保存: {model_txt}')

    meta = {
        'feature_cols': feature_cols,
        'best_iteration': clf.best_iteration_,
        'test_auc': test_auc,
        'test_loss': test_loss,
        'hit1_rate': hit1,
        'hit2_rate': hit2,
        'trained_at': pd.Timestamp.now().isoformat(),
        'n_train': len(train_df),
        'n_test': len(test_df),
    }
    with open(os.path.join(args.out_dir, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # ONNX export
    try:
        from skl2onnx import convert_sklearn, update_registered_converter
        from skl2onnx.common.data_types import FloatTensorType as SklFloat
        from skl2onnx.common.shape_calculator import calculate_linear_classifier_output_shapes
        from onnxmltools.convert.lightgbm.operator_converters.LightGbm import convert_lightgbm

        update_registered_converter(
            LGBMClassifier, 'LightGbmLGBMClassifier',
            calculate_linear_classifier_output_shapes,
            convert_lightgbm,
            options={'nocl': [True, False], 'zipmap': [True, False]},
        )
        initial_type = [('input', SklFloat([None, len(feature_cols)]))]
        options = {id(clf): {'zipmap': False}}
        onnx_model = convert_sklearn(clf, initial_types=initial_type, options=options,
                                     target_opset={'': 15, 'ai.onnx.ml': 3})
        onnx_path = os.path.join(args.out_dir, 'model.onnx')
        with open(onnx_path, 'wb') as f:
            f.write(onnx_model.SerializeToString())
        print(f'ONNX保存: {onnx_path}')
    except Exception as e:
        print(f'ONNX変換失敗（model.txt のみ保存）: {e}')
        meta['onnx_failed'] = str(e)
        with open(os.path.join(args.out_dir, 'meta.json'), 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset', required=True)
    parser.add_argument('--out-dir', dest='out_dir', default='ml/models')
    train(parser.parse_args())
