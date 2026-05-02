import { NextRequest } from 'next/server';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { getDb, initDb } from '@/lib/db';
import type { CollectionType } from '@/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

// 行テキスト → CollectionType のマッピング（CSV の型名列と一致させる）
const TYPE_MAP: [string, CollectionType][] = [
  ['可燃ごみ',     'burnable'],
  ['不燃ごみ',     'nonBurnable'],
  ['資源プラスチック', 'plastic'],
  ['紙',          'paper'],
  ['缶',          'cans'],       // 「缶、スプレー缶…」も含む
  ['ペットボトル', 'pet'],
  ['ビン',        'bottlesBatteries'],
  ['乾電池',      'bottlesBatteries'],
  ['剪定枝葉等',  'branches'],
];

function detectType(text: string): CollectionType | null {
  for (const [key, type] of TYPE_MAP) {
    if (text.includes(key)) return type;
  }
  return null;
}

// YYYY/M/D 形式の日付文字列かどうか判定
function parseDateStr(s: string): { year: number; month: number; day: number } | null {
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  return { year: parseInt(m[1]), month: parseInt(m[2]), day: parseInt(m[3]) };
}

interface TextItem {
  str: string;
  x: number;
  y: number;
}

// CSVライク形式のパース：
// ヘッダ行に YYYY/M/D 形式の日付が並び、
// 各型行に ○ マークが対応する日付列に置かれる形式
function parseCsvLike(
  rows: Map<number, TextItem[]>
): Map<string, Set<CollectionType>> {
  const result = new Map<string, Set<CollectionType>>();

  // Y 降順（上から下）に並べる
  const sortedY = Array.from(rows.keys()).sort((a, b) => b - a);

  // ヘッダ行：YYYY/M/D が3つ以上連続する行を探す
  let headerY: number | null = null;
  const dateByX = new Map<number, { year: number; month: number; day: number }>();

  for (const y of sortedY) {
    const items = rows.get(y)!.sort((a, b) => a.x - b.x);
    const dates = items.filter(i => parseDateStr(i.str));
    if (dates.length >= 3) {
      headerY = y;
      for (const item of dates) {
        const d = parseDateStr(item.str)!;
        dateByX.set(Math.round(item.x), d);
      }
      break;
    }
  }

  if (headerY === null || dateByX.size === 0) return result;

  // 日付 X 位置の一覧（ソート済み）
  const dateXs = Array.from(dateByX.keys()).sort((a, b) => a - b);

  // 型行：ヘッダより下の行で型名と ○ を含む行
  for (const y of sortedY) {
    if (y >= headerY) continue;
    const items = rows.get(y)!.sort((a, b) => a.x - b.x);
    const rowText = items.map(i => i.str).join(' ');

    const collType = detectType(rowText);
    if (!collType) continue;

    // ○ マークを探してその X 位置を最近の日付列に対応させる
    for (const item of items) {
      if (item.str !== '○') continue;
      const ix = Math.round(item.x);
      // 最も近い日付 X を探す
      let nearest = dateXs[0];
      let minDiff = Math.abs(ix - nearest);
      for (const dx of dateXs) {
        const diff = Math.abs(ix - dx);
        if (diff < minDiff) { minDiff = diff; nearest = dx; }
      }
      if (minDiff > 20) continue; // 許容誤差 20pt 超は無視

      const d = dateByX.get(nearest)!;
      const key = `${d.year}-${d.month}-${d.day}`;
      if (!result.has(key)) result.set(key, new Set());
      result.get(key)!.add(collType);
    }
  }

  return result;
}

// 月次カレンダー形式のパース：
// 月名（4月 〜 3月）が見出しになっており、1〜31の数字が列ヘッダ、
// 型行に ○ が並ぶ形式
function parseMonthlyGrid(
  rows: Map<number, TextItem[]>,
  fiscalYear: number
): Map<string, Set<CollectionType>> {
  const result = new Map<string, Set<CollectionType>>();
  const sortedY = Array.from(rows.keys()).sort((a, b) => b - a);

  let currentMonth = 0;
  let currentYear = fiscalYear;
  // 数字列 X → 日 の対応（月が変わるたびにリセット）
  let dayByX = new Map<number, number>();

  for (const y of sortedY) {
    const items = rows.get(y)!.sort((a, b) => a.x - b.x);
    const rowText = items.map(i => i.str).join(' ');

    // 月見出し検出（「4月」「5月」...「3月」）
    const monthMatch = rowText.match(/\b([1-9]|1[0-2])月\b/);
    if (monthMatch) {
      const m = parseInt(monthMatch[1]);
      currentMonth = m;
      // 4月〜12月はfiscalYear、1月〜3月はfiscalYear+1
      currentYear = m >= 4 ? fiscalYear : fiscalYear + 1;
      dayByX = new Map();
      // 同一行の数字（1〜31）を日列ヘッダとして収集
      for (const item of items) {
        const n = parseInt(item.str);
        if (!isNaN(n) && n >= 1 && n <= 31) {
          dayByX.set(Math.round(item.x), n);
        }
      }
      continue;
    }

    if (currentMonth === 0) continue;

    // 日列ヘッダ行（1〜31の数字が多い行）
    const nums = items.filter(i => { const n = parseInt(i.str); return !isNaN(n) && n >= 1 && n <= 31; });
    if (nums.length >= 7 && dayByX.size === 0) {
      for (const item of nums) dayByX.set(Math.round(item.x), parseInt(item.str));
      continue;
    }

    // 型行
    const collType = detectType(rowText);
    if (!collType || dayByX.size === 0) continue;

    const dayXs = Array.from(dayByX.keys()).sort((a, b) => a - b);
    for (const item of items) {
      if (item.str !== '○') continue;
      const ix = Math.round(item.x);
      let nearest = dayXs[0];
      let minDiff = Math.abs(ix - nearest);
      for (const dx of dayXs) {
        const diff = Math.abs(ix - dx);
        if (diff < minDiff) { minDiff = diff; nearest = dx; }
      }
      if (minDiff > 20) continue;
      const day = dayByX.get(nearest)!;
      const key = `${currentYear}-${currentMonth}-${day}`;
      if (!result.has(key)) result.set(key, new Set());
      result.get(key)!.add(collType);
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

  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
  GlobalWorkerOptions.workerSrc = pathToFileURL(
    resolve(process.cwd(), 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs')
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

  // アプローチ1: CSV ライク形式（ヘッダに YYYY/M/D）
  const result1 = parseCsvLike(rows);
  if (result1.size > 0) {
    debug.push(`CSVライク形式でパース成功: ${result1.size}日分`);
    return result1;
  }

  // アプローチ2: 月次グリッド形式（月名 + 1〜31 の数字列）
  // 年度開始年を現在年から推測
  const fiscalYear = new Date().getFullYear();
  const result2 = parseMonthlyGrid(rows, fiscalYear);
  if (result2.size > 0) {
    debug.push(`月次グリッド形式でパース成功: ${result2.size}日分`);
    return result2;
  }

  debug.push('パース失敗：認識できる形式ではありませんでした');
  return new Map();
}

export async function POST(req: NextRequest) {
  const { url, regionKey = '浅川', calendarGroup = 14 } = await req.json();
  if (!url) return Response.json({ error: 'URLが必要です' }, { status: 400 });

  const debug: string[] = [];
  try {
    await initDb();
    const dateTypeMap = await parsePdf(url, debug);

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
