import { NextRequest } from 'next/server';
import { parse } from 'node-html-parser';
import { initDb, getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 300;

const KANA_LIST = [
  'あ','い','う','え','お',
  'か','き','く','け','こ',
  'さ','し','す','せ','そ',
  'た','ち','つ','て','と',
  'な','に','ぬ','ね','の',
  'は','ひ','ふ','へ','ほ',
  'ま','み','む','め','も',
  'や','ゆ','よ',
  'ら','り','る','れ','ろ',
  'わ',
];

const UA = 'Mozilla/5.0 (compatible; NaganoCityGomiBot/1.0)';

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ベースページから かな→URL のマップを構築
function buildKanaUrlMap(html: string, baseUrl: string): Map<string, string> {
  const root = parse(html);
  const base = new URL(baseUrl);
  const map = new Map<string, string>();
  for (const a of root.querySelectorAll('a[href]')) {
    const text = a.text.trim();
    if (!KANA_LIST.includes(text)) continue;
    const href = a.getAttribute('href') ?? '';
    if (!href) continue;
    const fullUrl = href.startsWith('http') ? href : new URL(href, base).toString();
    map.set(text, fullUrl);
  }
  return map;
}

// 一覧ページから品目名＋リンクを取得（/gomi/contents/gomikensaku/ を含むリンクのみ）
function extractItemLinks(html: string, baseUrl: string): { name: string; href: string }[] {
  const root = parse(html);
  const base = new URL(baseUrl);
  const results: { name: string; href: string }[] = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (!href.includes('/gomi/contents/gomikensaku/')) continue;
    const name = a.text.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 100) continue;
    const fullUrl = href.startsWith('http') ? href : new URL(href, base).toString();
    results.push({ name, href: fullUrl });
  }
  return results;
}

// 詳細ページから分別種別を取得
// 実際のHTML構造: <h2>分別種別</h2><p><a href="...">不燃ごみ</a></p>
function extractCategory(html: string): string {
  const root = parse(html);

  // パターン1（長野市の実際の構造）: h2[text=分別種別] の次の兄弟要素のテキスト
  for (const h2 of root.querySelectorAll('h2')) {
    if (h2.text.trim().includes('分別種別')) {
      const next = h2.nextElementSibling;
      if (next) {
        const text = next.text.trim().replace(/\s+/g, '');
        if (text) return text;
      }
    }
  }

  // パターン2: dt/dd
  for (const dt of root.querySelectorAll('dt')) {
    if (dt.text.trim().includes('分別種別') || dt.text.trim().includes('分別区分')) {
      const dd = dt.nextElementSibling;
      if (dd) {
        const text = dd.text.trim().replace(/\s+/g, ' ');
        if (text) return text;
      }
    }
  }

  // パターン3: テーブル
  for (const tr of root.querySelectorAll('tr')) {
    const cells = tr.querySelectorAll('td, th');
    for (let i = 0; i < cells.length - 1; i++) {
      if (cells[i].text.trim().includes('分別種別')) {
        const text = cells[i + 1].text.trim().replace(/\s+/g, ' ');
        if (text) return text;
      }
    }
  }

  return '';
}

export async function POST(req: NextRequest) {
  const { url } = await req.json();
  if (!url) return Response.json({ error: 'URLが指定されていません' }, { status: 400 });

  await initDb();
  const sql = getDb();
  const errors: string[] = [];
  const fetchedKana: string[] = [];
  let insertedCount = 0;
  let totalItems = 0;

  try {
    // ベースページ取得・かなURLマップ構築
    const baseHtml = await fetchHtml(url);
    if (!baseHtml) return Response.json({ error: 'ベースページ取得失敗' }, { status: 502 });

    const kanaUrlMap = buildKanaUrlMap(baseHtml, url);
    if (kanaUrlMap.size === 0) {
      return Response.json({ error: 'かなボタンのリンクが見つかりませんでした' }, { status: 502 });
    }

    for (const kana of KANA_LIST) {
      const kanaUrl = kanaUrlMap.get(kana);
      if (!kanaUrl) { errors.push(`${kana}: URLマップなし`); continue; }

      try {
        // 一覧ページに 500ms wait（サーバー負荷軽減）
        await new Promise(r => setTimeout(r, 500));

        const listHtml = await fetchHtml(kanaUrl);
        if (!listHtml) { errors.push(`${kana}: 一覧ページ取得失敗`); continue; }

        const itemLinks = extractItemLinks(listHtml, kanaUrl);
        if (itemLinks.length === 0) continue;

        fetchedKana.push(kana);
        totalItems += itemLinks.length;

        for (const { name, href } of itemLinks) {
          try {
            // 詳細ページは wait なし（HTTP往復時間 約200-300ms が自然なpacing）
            const detailHtml = await fetchHtml(href);
            const category = detailHtml ? extractCategory(detailHtml) : '';

            await sql`
              INSERT INTO garbage_items (name, category, source_url, updated_at)
              VALUES (${name}, ${category}, ${url}, NOW())
              ON CONFLICT (name) DO UPDATE SET
                category = EXCLUDED.category,
                updated_at = NOW()
            `;
            insertedCount++;
          } catch (e) {
            errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        errors.push(`${kana}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return Response.json({
      totalItems,
      insertedCount,
      fetchedKana,
      errors: errors.slice(0, 30),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return Response.json({ error: `エラー: ${msg}` }, { status: 500 });
  }
}
