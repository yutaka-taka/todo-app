import { NextRequest } from 'next/server';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { getDb, initDb } from '@/lib/db';
import type { CollectionType } from '@/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

// pdfjs-dist が Node.js 環境で DOMMatrix を要求するためポリフィル
if (typeof globalThis.DOMMatrix === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).DOMMatrix = class DOMMatrix {
    a=1;b=0;c=0;d=1;e=0;f=0;
    m11=1;m12=0;m13=0;m14=0;m21=0;m22=1;m23=0;m24=0;
    m31=0;m32=0;m33=1;m34=0;m41=0;m42=0;m43=0;m44=1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inverse(){return new (globalThis as any).DOMMatrix();}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    multiply(){return new (globalThis as any).DOMMatrix();}
  };
}

interface TextItem {
  str: string;
  x: number;
  y: number;
}

// 略称 → CollectionType[] のマッピング（長野市PDFフォーマット）
// "可 / プ" のようなスラッシュ区切りの複合型も含む
const ABBREV_MAP: [string, CollectionType[]][] = [
  ['可 / プ', ['burnable', 'plastic']],
  ['可 / 枝', ['burnable', 'branches']],
  ['缶 / ペ', ['cans', 'pet']],
  ['ビ / 電', ['bottlesBatteries']],
  ['紙 / ペ', ['paper', 'pet']],
  ['可 / 不', ['burnable', 'nonBurnable']],
  ['不 / 枝', ['nonBurnable', 'branches']],
  ['可 / 缶', ['burnable', 'cans']],
  ['不', ['nonBurnable']],
  ['可', ['burnable']],
  ['プ', ['plastic']],
  ['缶', ['cans']],
  ['ペ', ['pet']],
  ['ビ', ['bottlesBatteries']],
  ['枝', ['branches']],
];

function parseTypeAbbrev(str: string): CollectionType[] | null {
  for (const [pat, types] of ABBREV_MAP) {
    if (str === pat) return types;
  }
  return null;
}

// 年間グリッド形式のパース（長野市PDFフォーマット）:
// ヘッダ行に "YYYY年M月" が12ヶ月分並び、
// 各行に日付数字・曜日・収集区分略称が各月列に並ぶ形式
function parseAnnualGrid(
  rows: Map<number, TextItem[]>
): Map<string, Set<CollectionType>> {
  const result = new Map<string, Set<CollectionType>>();
  const sortedY = Array.from(rows.keys()).sort((a, b) => b - a);

  // ヘッダ行: "YYYY年M月" が3つ以上並ぶ行を探す
  const yearMonthRe = /^(\d{4})年(\d{1,2})月$/;
  let headerY: number | null = null;
  const monthCols: { x: number; year: number; month: number }[] = [];

  for (const y of sortedY) {
    const items = rows.get(y)!.sort((a, b) => a.x - b.x);
    const matches = items.filter(i => yearMonthRe.test(i.str));
    if (matches.length >= 3) {
      headerY = y;
      for (const item of matches) {
        const m = item.str.match(yearMonthRe)!;
        monthCols.push({ x: item.x, year: parseInt(m[1]), month: parseInt(m[2]) });
      }
      break;
    }
  }

  if (headerY === null || monthCols.length === 0) return result;

  // 列間隔の半分を許容誤差として計算
  const colSpacing = monthCols.length >= 2
    ? (monthCols[monthCols.length - 1].x - monthCols[0].x) / (monthCols.length - 1)
    : 95;
  const tolerance = Math.floor(colSpacing / 2);

  // 各データ行を処理
  for (const y of sortedY) {
    if (y >= headerY) continue;
    const items = rows.get(y)!.sort((a, b) => a.x - b.x);

    // 各アイテムを最近の月列に割り当て
    const colItems = new Map<number, TextItem[]>();
    for (const col of monthCols) colItems.set(col.x, []);

    for (const item of items) {
      let nearest = monthCols[0];
      let minDiff = Math.abs(item.x - nearest.x);
      for (const col of monthCols) {
        const diff = Math.abs(item.x - col.x);
        if (diff < minDiff) { minDiff = diff; nearest = col; }
      }
      if (minDiff <= tolerance) colItems.get(nearest.x)!.push(item);
    }

    // 各月列のアイテムから日付と収集区分を抽出
    for (const col of monthCols) {
      const cellItems = colItems.get(col.x)!;
      if (cellItems.length === 0) continue;

      let day: number | null = null;
      const types: CollectionType[] = [];

      for (const item of cellItems) {
        // 純粋な整数 1〜31 は日付
        const n = parseInt(item.str);
        if (!isNaN(n) && n >= 1 && n <= 31 && item.str === String(n)) {
          day = n;
          continue;
        }
        // 曜日は無視
        if (/^[日月火水木金土]$/.test(item.str)) continue;
        // 収集区分略称
        const ts = parseTypeAbbrev(item.str);
        if (ts) types.push(...ts);
      }

      if (day === null || types.length === 0) continue;
      const key = `${col.year}-${col.month}-${day}`;
      if (!result.has(key)) result.set(key, new Set());
      for (const t of types) result.get(key)!.add(t);
    }
  }

  return result;
}

async function parsePdf(
  pdfUrl: string,
  debug: string[]
): Promise<Map<string, Set<CollectionType>>> {
  debug.push(`PDF取得中: ${pdfUrl}`);
  const res = await fetch(pdfUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) throw new Error(`PDF取得失敗: ${res.status}`);

  const buf = await res.arrayBuffer();
  debug.push(`PDFサイズ: ${Math.round(buf.byteLength / 1024)} KB`);

  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  GlobalWorkerOptions.workerSrc = pathToFileURL(
    resolve(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs')
  ).toString();

  const pdf = await getDocument({
    data: new Uint8Array(buf),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  debug.push(`PDF総ページ数: ${pdf.numPages}`);

  // 全ページのテキストアイテムを収集
  const allItems: TextItem[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items as Array<{ str: string; transform: number[] }>) {
      if (!item.str?.trim()) continue;
      allItems.push({ str: item.str.trim(), x: item.transform[4], y: item.transform[5] });
    }
  }

  debug.push(`抽出テキストアイテム数: ${allItems.length}`);

  // Y 近傍（4pt丸め）でアイテムを行にグループ化
  const rows = new Map<number, TextItem[]>();
  for (const item of allItems) {
    const ry = Math.round(item.y / 4) * 4;
    if (!rows.has(ry)) rows.set(ry, []);
    rows.get(ry)!.push(item);
  }

  // 年間グリッド形式（"YYYY年M月" ヘッダ + 日付行）
  const result = parseAnnualGrid(rows);
  if (result.size > 0) {
    debug.push(`年間グリッド形式でパース成功: ${result.size}日分`);
    return result;
  }

  debug.push('パース失敗：認識できる形式ではありませんでした');
  return new Map();
}

export async function POST(req: NextRequest) {
  const { url, regionKey = '浅川', calendarGroup = 14 } = await req.json();
  if (!url) return Response.json({ error: 'URLが必要です' }, { status: 400 });

  const debug: string[] = [];
  try {
    const dateTypeMap = await parsePdf(url, debug);
    await initDb();

    if (dateTypeMap.size === 0) {
      return Response.json({ error: 'カレンダーデータを取得できませんでした', debug }, { status: 422 });
    }

    // date → types[] の形に変換
    const dayMap = new Map<string, CollectionType[]>();
    dateTypeMap.forEach((typeSet, key) => {
      dayMap.set(key, Array.from(typeSet));
    });

    // 月ごとにグループ化して region_calendars に保存
    const byYearMonth = new Map<string, { year: number; month: number; entries: { date: number; types: CollectionType[] }[] }>();
    dayMap.forEach((types, key) => {
      const [year, month, day] = key.split('-').map(Number);
      const ym = `${year}-${month}`;
      if (!byYearMonth.has(ym)) byYearMonth.set(ym, { year, month, entries: [] });
      byYearMonth.get(ym)!.entries.push({ date: day, types });
    });

    const sql = getDb();
    let savedMonths = 0;
    for (const ym of Array.from(byYearMonth.keys())) {
      const { year, month, entries } = byYearMonth.get(ym)!;
      entries.sort((a, b) => a.date - b.date);
      await sql`
        INSERT INTO region_calendars (region_key, calendar_group, year, month, calendar_data, updated_at)
        VALUES (
          ${regionKey},
          ${calendarGroup},
          ${year},
          ${month},
          ${JSON.stringify({ entries })}::jsonb,
          NOW()
        )
        ON CONFLICT (region_key, year, month) DO UPDATE SET
          calendar_data = EXCLUDED.calendar_data,
          updated_at = NOW()
      `;
      savedMonths++;
    }

    debug.push(`DBに ${savedMonths} ヶ月分を保存しました`);
    return Response.json({ savedMonths, totalDays: dayMap.size, debug });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debug.push(`エラー: ${msg}`);
    return Response.json({ error: msg, debug }, { status: 500 });
  }
}
