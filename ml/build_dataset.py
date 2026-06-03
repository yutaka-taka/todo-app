"""
RaceResult から LightGBM 訓練データセット (Parquet) を生成。
【point-in-time / リーク除去 + オッズ非依存(数日前予想)版】

設計原則: **すべての特徴量は「予想時点(数日前・オッズ/馬体重/上がり3F 未確定)」で
計算可能でなければならない**。当日情報(odds/popularity/horse_weight/weight_change/
当日上がり3F)は serve 時に欠損し train/serve skew を生むため特徴量から除外し、
過去走から算出する実力系の代理指標(スピード指数・脚質・過去上がり3F・過去人気)に
置き換える。各 (馬,レース) の特徴量は対象レース日より前の deduped レースのみから算出。

サービス側 src/lib/mlFeatures.ts / scripts/reanalyze.js と同一定義・既定値で parity を保証。
スピード指数の正規化は reanalyze.js が出力する ml/speed_norms.json を共用する。

  python ml/build_dataset.py --from=2021-01-01 --to=2026-12-31 --out=ml/dataset.parquet
"""
import argparse
import json
import os
import re
import psycopg2
import pandas as pd

DB_URL = os.environ.get('DATABASE_URL', 'postgresql://postgres:post@localhost:5432/keiba')
NORMS_PATH = os.path.join(os.path.dirname(__file__), 'speed_norms.json')

# === src/lib/mlFeatures.ts / reanalyze.js と完全一致させること（train/serve parity） ===
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
# 過去走が無い場合のフォールバック（reanalyze.js と一致）
DEF_SPEED, DEF_POSRATIO, DEF_FRONT, DEF_R3F, DEF_POP = 0.0, 0.5, 0.0, 35.0, 9

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

# ローテ（ステップレース）特徴: USE_ROTATION=1 の train.py で有効化する opt-in 列。
# dataset には常に出力し、train 側で採否を切り替える（PEDIGREE_COLS と同じ方式）。
# 2026東京優駿でバステール(前走皐月賞3着・前々走弥生賞勝ち=重賞好走)を取りこぼした分析より。
ROTATION_COLS = ['prev_grade_rank', 'graded_place_rate', 'best_graded_finish', 'last_graded_gap']


def distance_bin(d):
    if d <= 1400: return 0
    if d <= 1700: return 1
    if d <= 2100: return 2
    return 3


def parse_time_sec(t):
    if not t:
        return None
    m = re.match(r'^(?:(\d+):)?(\d+(?:\.\d+)?)$', str(t))
    if not m:
        return None
    total = (int(m.group(1)) if m.group(1) else 0) * 60 + float(m.group(2))
    return total if 0 < total < 1200 else None


def first_corner(cp):
    if not cp:
        return None
    head = str(cp).split('-')[0]
    try:
        n = int(head)
        return n if n > 0 else None
    except ValueError:
        return None


def speed_z(norms, venue, surface, distance, sec):
    if sec is None:
        return None
    g = norms.get(f'{venue}-{surface}-{distance}')
    if not g or g['n'] < 20:
        return None
    z = (g['mean'] - sec) / max(g['std'], 0.1)
    return max(-5.0, min(5.0, z))


def fetch(conn, start, end):
    sql = """
    SELECT r.id AS race_id, r.name, r.date, r.venue, r.grade, r.surface, r.distance,
           rr."finishPosition" AS pos, rr."horseName" AS horse,
           rr.jockey, rr.trainer, rr.popularity, rr."horseWeight" AS hw,
           rr.time AS time, rr."cornerPositions" AS corner, rr."rapidIncrease" AS r3f
    FROM "RaceResult" rr JOIN "Race" r ON r.id = rr."raceId"
    WHERE r.date BETWEEN %s AND %s AND rr."finishPosition" IS NOT NULL
    ORDER BY rr."horseName", r.date
    """
    cur = conn.cursor()
    cur.execute(sql, (start, end))
    cols = [c[0] for c in cur.description]
    return pd.DataFrame(cur.fetchall(), columns=cols)


def fetch_ped_map(conn):
    cur = conn.cursor()
    cur.execute('SELECT "horseName", sire, "sireOfDam" FROM "HorseStat" WHERE sire IS NOT NULL')
    return {row[0]: (row[1], row[2]) for row in cur.fetchall()}


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

    if not os.path.exists(NORMS_PATH):
        raise SystemExit(f'speed_norms.json が見つかりません: {NORMS_PATH}\n先に `node scripts/reanalyze.js` を実行してください。')
    with open(NORMS_PATH, encoding='utf-8') as f:
        norms = json.load(f)
    print(f'speed_norms: {len(norms)} 群')

    print(f'DB接続 / データ取得: {args.start} → {args.end}')
    conn = psycopg2.connect(DB_URL)
    df = fetch(conn, args.start, args.end)
    ped_map = fetch_ped_map(conn)
    conn.close()
    print(f'取得行数: {len(df)} / 血統保有馬: {len(ped_map)}')

    df['date'] = pd.to_datetime(df['date'])
    # フィールドサイズ（コピー内の出走頭数）= posRatio 用
    df['_fieldsize'] = df.groupby('race_id')['race_id'].transform('count')
    # 当該行のスピード指数 / 1角通過位置比率を事前計算（reanalyze.js と同一式）
    df['_sec'] = df['time'].map(parse_time_sec)
    df['_speedz'] = [speed_z(norms, v, s, d, sec) for v, s, d, sec in
                     zip(df['venue'], df['surface'], df['distance'], df['_sec'])]
    df['_fc'] = df['corner'].map(first_corner)
    df['_posratio'] = [
        max(0.0, min(1.0, fc / fs)) if (fc is not None and fs and fs > 0) else None
        for fc, fs in zip(df['_fc'], df['_fieldsize'])
    ]

    # NaN(欠損)を None に正規化（pandas 経由で DB null が NaN になり判定をすり抜けるのを防ぐ）
    for col in ['pos', 'popularity', 'hw', 'r3f', '_speedz', '_posratio']:
        df[col] = df[col].astype('object').where(df[col].notna(), None)
    recs = df.to_dict('records')

    # --- 血統適性 as-of-date（リーク防止: 各レースは「その時点まで」の産駒成績のみから算出） ---
    from collections import defaultdict
    for r in recs:
        sb = ped_map.get(r['horse'])
        r['_sire'] = sb[0] if sb else None
        r['_bms'] = sb[1] if sb else None
        r['_dbin'] = distance_bin(r['distance'])
    rid_rows = defaultdict(list)
    for i, r in enumerate(recs):
        rid_rows[r['race_id']].append(i)
    rid_order = sorted(rid_rows.keys(), key=lambda rid: recs[rid_rows[rid][0]]['date'])
    sd_, ss_, bd_ = {}, {}, {}

    def _arate(store, key):
        e = store.get(key)
        return (e[1] / e[0]) if (e and e[0] >= 10) else None

    for rid in rid_order:
        rows = rid_rows[rid]
        for i in rows:  # 先に当該レース「前まで」の集計でレートを確定（レース内リーク防止）
            r = recs[i]
            r['_sdr'] = _arate(sd_, (r['_sire'], r['_dbin'])) if r['_sire'] else None
            r['_ssr'] = _arate(ss_, (r['_sire'], r['surface'])) if r['_sire'] else None
            r['_bdr'] = _arate(bd_, (r['_bms'], r['_dbin'])) if r['_bms'] else None
        for i in rows:  # 次にこのレース結果を集計へ加算
            r = recs[i]
            placed = 1 if (r['pos'] or 99) <= 2 else 0
            if r['_sire']:
                for key, store in (((r['_sire'], r['_dbin']), sd_), ((r['_sire'], r['surface']), ss_)):
                    e = store.setdefault(key, [0, 0]); e[0] += 1; e[1] += placed
            if r['_bms']:
                e = bd_.setdefault((r['_bms'], r['_dbin']), [0, 0]); e[0] += 1; e[1] += placed

    out_rows = []
    cur_horse = None

    def reset():
        return dict(n=0, places=0, g1n=0, g1p=0, g2n=0, g2p=0, g3n=0, g3p=0,
                    dist={}, venue={}, surf={}, cd={}, wsum=0.0, wcnt=0,
                    finishes=[], prs=[], last_date=None, last_pop=None, pending=None)
    acc = reset()

    def add_prior(acc, race):
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
        # 実力系の prior レコード（時系列順）。grade/pos はローテ特徴に使用。
        acc['prs'].append(dict(speedz=race['_speedz'], posratio=race['_posratio'],
                               r3f=race['r3f'], pop=race['popularity'],
                               grade=race['grade'], pos=(race['pos'] or 99)))
        acc['last_date'] = race['date']
        acc['last_pop'] = race['popularity']

    def merge_pending(a, b):
        keep = b if dup_score(b) > dup_score(a) else a
        other = a if keep is b else b
        keep = dict(keep)
        if (keep['pos'] or 99) >= 99 and (other['pos'] or 99) < 99:
            keep['pos'] = other['pos']
        for k in ('popularity', 'hw', 'r3f', '_speedz', '_posratio', '_sdr', '_ssr', '_bdr'):
            if keep[k] is None: keep[k] = other[k]
        if (GRADE_RANK.get(other['grade'], 1)) > (GRADE_RANK.get(keep['grade'], 1)):
            keep['grade'] = other['grade']
        return keep

    def agg_speed_style_pop(prs):
        """reanalyze.js と同一ロジックで prior レコード列から実力系を集計"""
        speeds = [p['speedz'] for p in prs if p['speedz'] is not None]
        posr = [p['posratio'] for p in prs if p['posratio'] is not None]
        r3fs = [p['r3f'] for p in prs if p['r3f'] is not None]
        last3 = prs[-3:]
        l3speed = [p['speedz'] for p in last3 if p['speedz'] is not None]
        l3r3f = [p['r3f'] for p in last3 if p['r3f'] is not None]
        last5 = prs[-5:]
        l5pop = [DEF_POP if p['pop'] is None else p['pop'] for p in last5]
        return {
            'best_speed': max(speeds) if speeds else DEF_SPEED,
            'avg_speed3': (sum(l3speed) / len(l3speed)) if l3speed else DEF_SPEED,
            'last_speed': speeds[-1] if speeds else DEF_SPEED,
            'avg_pos_ratio': (sum(posr) / len(posr)) if posr else DEF_POSRATIO,
            'front_rate': (sum(1 for r in posr if r <= 0.3) / len(posr)) if posr else DEF_FRONT,
            'best_r3f': min(r3fs) if r3fs else DEF_R3F,
            'avg_r3f3': (sum(l3r3f) / len(l3r3f)) if l3r3f else DEF_R3F,
            'avg_recent_pop': (sum(l5pop) / len(l5pop)) if l5pop else DEF_POP,
            'best_recent_pop': min(l5pop) if l5pop else DEF_POP,
        }

    def agg_rotation(acc):
        """ローテ（ステップレース）特徴。serving 側(mlFeatures.ts)が HorseStat から計算できる
        情報＝『直近5走窓(grade/着順/人気)＋全期間グレード集計』のみで算出し parity を保証する。
        当日情報を使わず数日前に計算可能（リークなし）。"""
        # 直近5走（最新が先頭）= recentForm/recentGrades/recentPops と同じ並び
        recent5 = list(reversed(acc['prs']))[:5]
        if not recent5:
            return {'prev_grade_rank': 1, 'graded_place_rate': 0.0,
                    'best_graded_finish': 18, 'last_graded_gap': 0}
        prev_grade_rank = GRADE_RANK.get(recent5[0]['grade'], 1)
        # 全期間グレード(G1/G2/G3)連対率（HorseStat の g*Races/g*Places と一致）
        gn = acc['g1n'] + acc['g2n'] + acc['g3n']
        gp = acc['g1p'] + acc['g2p'] + acc['g3p']
        graded_place_rate = (gp / gn) if gn > 0 else 0.0
        # 直近5走内の重賞での最高着順 / 最新重賞の「人気-着順」健闘度
        graded5 = [p for p in recent5 if GRADE_RANK.get(p['grade'], 1) >= 2]
        best_graded_finish = min((p['pos'] for p in graded5), default=18)
        last_graded = graded5[0] if graded5 else None  # recent5 は最新が先頭
        if last_graded and last_graded['pop']:
            gap = last_graded['pop'] - (last_graded['pos'] or 99)
        else:
            gap = 0
        return {
            'prev_grade_rank': prev_grade_rank,
            'graded_place_rate': graded_place_rate,
            'best_graded_finish': best_graded_finish,
            'last_graded_gap': max(-17, min(17, gap)),
        }

    def emit(acc, race):
        n = acc['n']
        place_rate = (acc['places'] / n) if n > 0 else 0.111
        fr = list(reversed(acc['finishes']))[:5]
        form = [fr[i] if i < len(fr) else 0 for i in range(5)]
        form_avg = sum(form) / 5.0
        form_r3 = (form[0] + form[1] + form[2]) / 3.0
        if acc['last_date'] is not None:
            days = (race['date'] - acc['last_date']).days
            days_since = min(max(days, 0), 365)
        else:
            days_since = 180
        avg_hw = (acc['wsum'] / acc['wcnt']) if acc['wcnt'] > 0 else 490.0
        d = race['distance']
        ss = agg_speed_style_pop(acc['prs'])
        rot = agg_rotation(acc)
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
            'horse_weight': avg_hw,
            **ss,
            **rot,
            'sire_dist_rate': race['_sdr'] if race.get('_sdr') is not None else place_rate,
            'sire_surf_rate': race['_ssr'] if race.get('_ssr') is not None else place_rate,
            'bms_dist_rate':  race['_bdr'] if race.get('_bdr') is not None else place_rate,
            'y': 1 if (race['pos'] or 99) <= 2 else 0,
            'race_id': race['race_id'],
            'date': race['date'],
            'horse_name': race['horse'],
        }
        out_rows.append(feat)

    def flush(acc):
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
            acc['pending'] = merge_pending(p, race)
        else:
            flush(acc)
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
