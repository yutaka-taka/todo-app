"""
グレード誤ラベル修正（in-place / 非破壊）。

fetch_jra_full_calendar.js はグレードを RaceData02（クラス欄）からしか取らず、
レース名の (G1)/(G2)/(G3) を無視するため、多数のステークスが grade='通常' で
登録されている。本スクリプトはレース名からグレードを判定し、grade を UPDATE する。

  dry-run:  python scripts/fix_grades.py
  apply:    python scripts/fix_grades.py --apply

障害(J.G1 等)は対象外（平地グレードのみ）。
"""
import argparse
import os
import re
import sys
import psycopg2

sys.stdout.reconfigure(encoding='utf-8')
DB_URL = os.environ.get('DATABASE_URL', 'postgresql://postgres:post@localhost:5432/keiba')

# 障害レースの除外パターン（J.G1 / JG2 / (JGI) / 障害 など）
JUMP_RE = re.compile(r'\(?\s*J\s*[.\-]?\s*G\s*[I1Ⅰ2Ⅱ3Ⅲ]', re.IGNORECASE)

# 平地グレード判定: 名前中の (G1)/(GI)/(GⅠ) などを拾う
GRADE_PATTERNS = [
    ('G1', re.compile(r'\(\s*G\s*(?:1|I|Ⅰ)\s*\)', re.IGNORECASE)),
    ('G2', re.compile(r'\(\s*G\s*(?:2|II|Ⅱ)\s*\)', re.IGNORECASE)),
    ('G3', re.compile(r'\(\s*G\s*(?:3|III|Ⅲ)\s*\)', re.IGNORECASE)),
]


def grade_from_name(name: str):
    if not name:
        return None
    if JUMP_RE.search(name) or '障害' in name:
        return None  # 障害は平地グレードに含めない
    for g, pat in GRADE_PATTERNS:
        if pat.search(name):
            return g
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='実際にUPDATEを実行')
    args = ap.parse_args()

    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    cur.execute('SELECT id, name, grade FROM "Race"')
    rows = cur.fetchall()

    changes = []  # (id, old, new)
    for rid, name, grade in rows:
        g = grade_from_name(name)
        if g and g != grade:
            changes.append((rid, grade, g, name))

    from collections import Counter
    by = Counter((c[1], c[2]) for c in changes)
    print(f'総レース: {len(rows)} / 変更対象: {len(changes)}')
    for (old, new), n in sorted(by.items()):
        print(f'  {old} -> {new}: {n}')
    print('--- sample (最大20件) ---')
    for c in changes[:20]:
        print(f'  [{c[1]}->{c[2]}] {c[3]}')

    if args.apply and changes:
        for rid, _old, new, _name in changes:
            cur.execute('UPDATE "Race" SET grade=%s, "updatedAt"=now() WHERE id=%s', (new, rid))
        conn.commit()
        print(f'\n✓ {len(changes)} 件を更新しました。')
    elif changes:
        print('\n(dry-run: --apply で実行)')
    conn.close()


if __name__ == '__main__':
    main()
