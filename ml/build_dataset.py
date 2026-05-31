"""
RaceResult から LightGBM 訓練データセット (Parquet) を生成。【point-in-time / リーク除去版】

旧版は各レース結果に「その馬の現在の全期間集計 HorseStat」を結合していたため、
対象レース自体＋未来レースの成績が特徴量に混入していた（AUC 0.99 の正体）。
本版は各 (馬, レース) の特徴量を、その馬の対象レース日より前の deduped レースのみから
時系列に算出する。サービス側 src/lib/mlFeatures.ts と同一の特徴量定義・既定値を用いる
ことで train/serve parity を保証する。

  python ml/build_dataset.py --from=2021-01-01 --to=2026-12-31 --out=ml/dataset.parquet
"""
import argparse
import math
import os
import psycopg2
import pandas as pd
import numpy as np

DB_URL = os.environ.get('DATABASE_URL', 'postgresql://postgres:post@localhost:5432/keiba')

# === src/lib/mlFeatures.ts と完全一致させること（train/serve parity） ===
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
    '手塚貴久': 7, '中内田充正': 8, '高野友和': 7,
    '安田翔伍': 6, '奥村武': 5,
}
VENUE_WIN_RATE = {
    '東京': 0.119, '中山': 0.108, '阪神': 0.115, '京都': 0.114,
    '中京': 0.111, '新潟': 0.108, '札幌': 0.110, '函館': 0.109,
    '小倉': 0.110, '福島': 0.109,
}
GRADE_RANK = {'G1': 4, 'G2': 3, 'G3': 2, '通常': 1}
DEDUP_DAYS = 4

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


def distance_bin(d):
    if d <= 1400: return 0
    if d <= 1700: return 1
    if d <= 2100: return 2
    return 3


def fetch(conn, start, end):
    sql = """
    SELECT r.id AS race_id, r.name, r.date, r.venue, r.grade, r.surface, r.distance,
           rr."finishPosition" AS pos, rr."horseName" AS horse,
           rr.jockey, rr.trainer, rr.popularity, rr.odds,
           rr."horseWeight" AS hw, rr."weightChange" AS wc, rr."rapidIncrease" AS r3f
    FROM "RaceResult" rr JOIN "Race" r ON r.id = rr."raceId"
    WHERE r.date BETWEEN %s AND %s AND rr."finishPosition" IS NOT NULL
    ORDER BY rr."horseName", r.date
    """
    cur = conn.cursor()
    cur.execute(sql, (start, end))
    cols = [c[0] for c in cur.description]
    return pd.DataFrame(cur.fetchall(), columns=cols)


def json_rate(d, key):
    v = d.get(key)
    if v and v[0] > 0:
        return v[1] / v[0]
    return None


def dup_score(row):
    return (4 if row['popularity'] is not None else 0) + (2 if row['hw'] is not None else 0) + (1 if (row['pos'] or 99) < 99 else 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from', dest='start', required=True)
    ap.add_argument('--to', dest='end', required=True)
    ap.add_argument('--out', default='ml/dataset.parquet')
    args = ap.parse_args()

    print(f'DB接続 / データ取得: {args.start} → {args.end}')
    conn = psycopg2.connect(DB_URL)
    df = fetch(conn, args.start, args.end)
    conn.close()
    print(f'取得行数: {len(df)}')

    # odds_rank はレース(コピー)内で計算（各コピーはフィールド完備のため一貫）
    df['_odds_for_rank'] = df['odds'].fillna(15.0)
    df['odds_rank'] = df.groupby('race_id')['_odds_for_rank'].rank(method='min')

    df['date'] = pd.to_datetime(df['date'])
    # NaN(欠損)を None に正規化（pandas 経由で DB null が NaN になり "is not None" 判定を
    # すり抜けるのを防ぐ。サービス側の既定値ロジックと一致させるため必須）。
    for col in ['pos', 'popularity', 'odds', 'hw', 'wc', 'r3f']:
        df[col] = df[col].astype('object').where(df[col].notna(), None)
    recs = df.to_dict('records')

    out_rows = []
    cur_horse = None
    # 馬ごとの prior 集計（point-in-time）
    def reset():
        return dict(n=0, places=0, g1n=0, g1p=0, g2n=0, g2p=0, g3n=0, g3p=0,
                    dist={}, venue={}, surf={}, cd={}, wsum=0.0, wcnt=0,
                    finishes=[], last_date=None, last_pop=None, prev_r3f=None,
                    pending=None)  # pending = 直前 emit 待ち行（dedup 用）
    acc = reset()

    def add_prior(acc, race):
        """deduped 1 レースを prior 集計へ加算（emit 後に呼ぶ）"""
        placed = (race['pos'] or 99) <= 2
        acc['n'] += 1
        if placed: acc['places'] += 1
        g = race['grade']
        if g == 'G1':
            acc['g1n'] += 1; acc['g1p'] += 1 if placed else 0
        elif g == 'G2':
            acc['g2n'] += 1; acc['g2p'] += 1 if placed else 0
        elif g == 'G3':
            acc['g3n'] += 1; acc['g3p'] += 1 if placed else 0
        for key, dd in ((str(race['distance']), 'dist'), (race['venue'], 'venue'),
                        (race['surface'], 'surf'), (f"{race['venue']}-{race['surface']}-{race['distance']}", 'cd')):
            m = acc[dd]; e = m.get(key)
            if e is None: m[key] = [1, 1 if placed else 0]
            else: e[0] += 1; e[1] += 1 if placed else 0
        if race['hw'] is not None and race['hw'] > 0:
            acc['wsum'] += race['hw']; acc['wcnt'] += 1
        acc['finishes'].append(race['pos'] or 99)
        acc['last_date'] = race['date']
        acc['last_pop'] = race['popularity']
        acc['prev_r3f'] = race['r3f']

    def merge_pending(a, b):
        """同一レース重複（4日以内）を統合し、情報量の多い行を採用"""
        keep = b if dup_score(b) > dup_score(a) else a
        other = a if keep is b else b
        keep = dict(keep)
        if (keep['pos'] or 99) >= 99 and (other['pos'] or 99) < 99:
            keep['pos'] = other['pos']
        for k in ('popularity', 'hw', 'wc', 'r3f', 'odds'):
            if keep[k] is None: keep[k] = other[k]
        if (GRADE_RANK.get(other['grade'], 1)) > (GRADE_RANK.get(keep['grade'], 1)):
            keep['grade'] = other['grade']
        return keep

    def emit(acc, race):
        n = acc['n']
        place_rate = (acc['places'] / n) if n > 0 else 0.111
        # form: prior finishes newest-first, pad 0 to 5（mlFeatures.ts parseForm 準拠）
        fr = list(reversed(acc['finishes']))[:5]
        form = [fr[i] if i < len(fr) else 0 for i in range(5)]
        form_avg = sum(form) / 5.0
        form_r3 = (form[0] + form[1] + form[2]) / 3.0
        if acc['last_date'] is not None:
            days = (race['date'] - acc['last_date']).days
            days_since = min(max(days, 0), 365)
        else:
            days_since = 180
        avg_hw = (acc['wsum'] / acc['wcnt']) if acc['wcnt'] > 0 else None
        hw = race['hw'] if race['hw'] is not None else (avg_hw if avg_hw is not None else 490)
        avg_hw2 = avg_hw if avg_hw is not None else hw
        d = race['distance']
        feat = {
            'grade_rank': GRADE_RANK.get(race['grade'], 1),
            'surface_bin': 1 if race['surface'] == '芝' else 0,
            'distance': d,
            'distance_bin': distance_bin(d),
            'month': race['date'].month,
            'day_of_year': race['date'].dayofyear,
            'total_races': n,
            'total_places': acc['places'],
            'place_rate': place_rate,
            'g1_races': acc['g1n'], 'g1_places': acc['g1p'],
            'g2_places': acc['g2p'], 'g3_places': acc['g3p'],
            'dist_rate': (json_rate(acc['dist'], str(d)) if json_rate(acc['dist'], str(d)) is not None else place_rate),
            'venue_rate': (json_rate(acc['venue'], race['venue']) if json_rate(acc['venue'], race['venue']) is not None else VENUE_WIN_RATE.get(race['venue'], 0.111)),
            'surface_rate': (json_rate(acc['surf'], race['surface']) if json_rate(acc['surf'], race['surface']) is not None else place_rate),
            'course_dist_rate': (json_rate(acc['cd'], f"{race['venue']}-{race['surface']}-{d}") if json_rate(acc['cd'], f"{race['venue']}-{race['surface']}-{d}") is not None else place_rate),
            'form0': form[0], 'form1': form[1], 'form2': form[2], 'form3': form[3], 'form4': form[4],
            'form_avg': form_avg, 'form_recent3_avg': form_r3,
            'days_since_last': days_since,
            'last_race_pop': acc['last_pop'] if acc['last_pop'] is not None else 9,
            'jockey_rank': JOCKEY_RANKS.get(race['jockey'], 3) if race['jockey'] else 3,
            'trainer_rank': TRAINER_RANKS.get(race['trainer'], 3) if race['trainer'] else 3,
            'horse_weight': hw,
            'weight_change': race['wc'] if race['wc'] is not None else 0,
            'weight_vs_avg': hw - avg_hw2,
            'popularity': race['popularity'] if race['popularity'] is not None else 9,
            'odds': race['odds'] if race['odds'] is not None else 15.0,
            'odds_log': math.log1p(race['odds'] if race['odds'] is not None else 15.0),
            'odds_rank': race['odds_rank'],
            'rapid_increase': acc['prev_r3f'] if acc['prev_r3f'] is not None else 35.0,
            'y': 1 if (race['pos'] or 99) <= 2 else 0,
            'race_id': race['race_id'],
            'date': race['date'],
            'horse_name': race['horse'],
        }
        out_rows.append(feat)

    def flush(acc):
        """pending 行を emit → prior へ加算"""
        if acc['pending'] is not None:
            emit(acc, acc['pending'])
            add_prior(acc, acc['pending'])
            acc['pending'] = None

    for race in recs:
        h = race['horse']
        if h != cur_horse:
            flush(acc)
            acc = reset()
            cur_horse = h
        p = acc['pending']
        if p is not None and (race['date'] - p['date']).days <= DEDUP_DAYS:
            acc['pending'] = merge_pending(p, race)  # 同一レース重複 → 統合（emit せず保留）
        else:
            flush(acc)            # 前の確定レースを emit + prior 反映
            acc['pending'] = dict(race)
    flush(acc)

    out = pd.DataFrame(out_rows)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    out.to_parquet(args.out, index=False)
    print(f'保存: {args.out} ({len(out)} 行 / {len(FEATURE_COLS)} 特徴量)')
    print(f'連対馬割合: {out["y"].mean():.3f}')
    print(f'デビュー戦(prior 0戦)割合: {(out["total_races"]==0).mean():.3f}')


if __name__ == '__main__':
    main()
