"""
RaceResult から LightGBM 訓練データセット (Parquet) を生成。

実行:
    python ml/build_dataset.py --from=2021-01-01 --to=2026-05-13 --out=ml/dataset.parquet
"""
import argparse
import os
import json
import psycopg2
import pandas as pd
import numpy as np
from datetime import datetime

DB_URL = os.environ.get('DATABASE_URL', 'postgresql://postgres:post@localhost:5432/keiba')

JOCKEY_RANKS = {
    'C.ルメール': 14, 'ルメール': 14,
    '武豊': 10, '川田将雅': 10, '横山武史': 10,
    '坂井瑠星': 7, '岩田望来': 7, '松山弘平': 7,
    '戸崎圭太': 7, '池添謙一': 7, '北村友一': 7,
    'M.デムーロ': 7, 'デムーロ': 7,
    '福永祐一': 7, '藤岡佑介': 5, '浜中俊': 5,
}

TRAINER_RANKS = {
    '矢作芳人': 10, '国枝栄': 9, '池江泰寿': 9, '藤沢和雄': 8,
    '友道康夫': 8, '須貝尚介': 7, '音無秀孝': 7, '堀宣行': 8,
    '手塚貴久': 7, '中内田充正': 8, '高野友和': 7, '斉藤崇史': 6,
    '安田翔伍': 6, '奥村武': 5, '清水久詞': 5,
}

VENUE_WIN_RATE = {
    '東京': 0.119, '中山': 0.108, '阪神': 0.115, '京都': 0.114,
    '中京': 0.111, '新潟': 0.108, '札幌': 0.110, '函館': 0.109,
    '小倉': 0.110, '福島': 0.109,
}

GRADE_RANK = {'G1': 4, 'G2': 3, 'G3': 2, '通常': 1}


def fetch_results(conn, start, end):
    sql = """
    SELECT
      r.id AS race_id, r.name AS race_name, r.date, r.venue, r.grade, r.surface, r.distance,
      r."trackCondition" AS track_cond, r.weather, r."className" AS class_name,
      rr.id AS result_id, rr."finishPosition" AS finish_position,
      rr."horseName" AS horse_name, rr."horseNumber" AS horse_number,
      rr.age, rr.sex, rr.jockey, rr.trainer,
      rr.popularity, rr.odds,
      rr."horseWeight" AS horse_weight, rr."weightChange" AS weight_change,
      rr."rapidIncrease" AS rapid_increase,
      hs."totalRaces", hs."totalPlaces",
      hs."g1Races", hs."g1Places", hs."g2Races", hs."g2Places", hs."g3Races", hs."g3Places",
      hs."distanceData", hs."venueData", hs."surfaceData", hs."courseDistData",
      hs."intervalData", hs."recentForm", hs."recentGrades", hs."recentPops",
      hs."lastRaceDate", hs."lastRacePopularity", hs."avgHorseWeight"
    FROM "RaceResult" rr
    JOIN "Race" r ON r.id = rr."raceId"
    LEFT JOIN "HorseStat" hs ON hs."horseName" = rr."horseName"
    WHERE r.date BETWEEN %s AND %s
      AND rr."finishPosition" IS NOT NULL
    ORDER BY r.date, r.id
    """
    cur = conn.cursor()
    cur.execute(sql, (start, end))
    cols = [c[0] for c in cur.description]
    return pd.DataFrame(cur.fetchall(), columns=cols)


def get_json_rate(json_val, key):
    try:
        d = json.loads(json_val) if isinstance(json_val, str) else (json_val or {})
        v = d.get(str(key))
        if v and v.get('races', 0) > 0:
            return v['places'] / v['races']
    except Exception:
        pass
    return None


def parse_form_list(s, n=5):
    if not s:
        return [None] * n
    parts = s.split('-')[:n]
    result = []
    for p in parts:
        try:
            result.append(int(p))
        except Exception:
            result.append(None)
    while len(result) < n:
        result.append(None)
    return result


def add_feature_columns(df):
    df = df.copy()
    df['date'] = pd.to_datetime(df['date'], utc=True)

    # (A) レース基本
    df['month'] = df['date'].dt.month
    df['day_of_year'] = df['date'].dt.dayofyear
    df['grade_rank'] = df['grade'].map(GRADE_RANK).fillna(1)
    df['surface_bin'] = (df['surface'] == '芝').astype(int)
    df['distance_bin'] = pd.cut(df['distance'], bins=[0, 1400, 1700, 2100, 9999], labels=[0, 1, 2, 3]).astype(float)

    # (B) 累積実績
    df['total_races'] = df['totalRaces'].fillna(0)
    df['total_places'] = df['totalPlaces'].fillna(0)
    df['place_rate'] = df['total_places'] / df['total_races'].clip(lower=1)
    df['g1_places'] = df['g1Places'].fillna(0)
    df['g2_places'] = df['g2Places'].fillna(0)
    df['g3_places'] = df['g3Places'].fillna(0)
    df['g1_races'] = df['g1Races'].fillna(0)
    df['g2_races'] = df['g2Races'].fillna(0)
    df['g3_races'] = df['g3Races'].fillna(0)

    df['dist_rate'] = df.apply(lambda r: get_json_rate(r['distanceData'], r['distance']), axis=1)
    df['venue_rate'] = df.apply(lambda r: get_json_rate(r['venueData'], r['venue']), axis=1)
    df['surface_rate'] = df.apply(lambda r: get_json_rate(r['surfaceData'], r['surface']), axis=1)
    cd_key = df.apply(lambda r: f"{r['venue']}-{r['surface']}-{r['distance']}", axis=1)
    df['course_dist_rate'] = df.apply(lambda r: get_json_rate(r['courseDistData'], f"{r['venue']}-{r['surface']}-{r['distance']}"), axis=1)

    df['dist_rate'] = df['dist_rate'].fillna(df['place_rate'])
    df['venue_rate'] = df['venue_rate'].fillna(df['venue'].map(VENUE_WIN_RATE)).fillna(0.111)
    df['surface_rate'] = df['surface_rate'].fillna(df['place_rate'])
    df['course_dist_rate'] = df['course_dist_rate'].fillna(df['dist_rate'])

    # (C) 最近形
    forms = df['recentForm'].apply(lambda s: parse_form_list(s, 5)).apply(pd.Series)
    forms.columns = ['form0', 'form1', 'form2', 'form3', 'form4']
    df = pd.concat([df, forms], axis=1)
    df['form_avg'] = forms.mean(axis=1, skipna=True)
    df['form_recent3_avg'] = forms[['form0', 'form1', 'form2']].mean(axis=1, skipna=True)

    last_rd = pd.to_datetime(df['lastRaceDate'], utc=True, errors='coerce')
    df['days_since_last'] = (df['date'] - last_rd).dt.days.clip(upper=365)
    df['last_race_pop'] = df['lastRacePopularity'].fillna(9)

    # (D) 騎手・調教師
    df['jockey_rank'] = df['jockey'].apply(lambda x: JOCKEY_RANKS.get(x, 3) if pd.notna(x) else 3)
    df['trainer_rank'] = df['trainer'].apply(lambda x: TRAINER_RANKS.get(x, 3) if pd.notna(x) else 3)

    # (E) 馬体重
    df['horse_weight'] = df['horse_weight'].fillna(df['avgHorseWeight']).fillna(490)
    df['weight_change'] = df['weight_change'].fillna(0)
    df['weight_vs_avg'] = df['horse_weight'] - df['avgHorseWeight'].fillna(df['horse_weight'])

    # (F) 市場
    df['popularity'] = df['popularity'].fillna(9)
    df['odds'] = df['odds'].fillna(15.0)
    df['odds_log'] = np.log1p(df['odds'])
    df['rapid_increase'] = df['rapid_increase'].fillna(35.0)

    # レース内オッズランク
    df['odds_rank'] = df.groupby('race_id')['odds'].rank(method='min')

    # (I) ラベル
    df['y'] = (df['finish_position'] <= 2).astype(int)

    return df


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--from', dest='start', required=True)
    parser.add_argument('--to', dest='end', required=True)
    parser.add_argument('--out', default='ml/dataset.parquet')
    args = parser.parse_args()

    print(f'DB接続: {DB_URL[:40]}...')
    conn = psycopg2.connect(DB_URL)
    print(f'データ取得: {args.start} → {args.end}')
    df = fetch_results(conn, args.start, args.end)
    conn.close()
    print(f'取得行数: {len(df)}')

    df = add_feature_columns(df)

    available = [c for c in FEATURE_COLS if c in df.columns]
    missing = [c for c in FEATURE_COLS if c not in df.columns]
    if missing:
        print(f'警告: 欠損特徴量列: {missing}')

    out_df = df[available + ['y', 'race_id', 'date', 'horse_name']].copy()
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    out_df.to_parquet(args.out, index=False)
    print(f'保存: {args.out} ({len(out_df)} 行 / {len(available)} 特徴量)')
    print(f'連対馬割合: {out_df["y"].mean():.3f}')


if __name__ == '__main__':
    main()
