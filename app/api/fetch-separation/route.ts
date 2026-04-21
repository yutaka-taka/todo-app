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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractItemLinks(html: string, baseUrl: string): { name: string; href: string }[] {
  const root = parse(html);
  const base = new URL(baseUrl);
  const results: { name: string; href: string }[] = [];

  // リンク付きの品目名を取得（a タグのテキスト）
  for (const a of root.querySelectorAll('a[href]')) {
    const name = a.text.trim().replace(/\s+/g, ' ');
    const href = a.getAttribute('href') ?? '';
    if (!name || name.length > 80 || !href) continue;
    // かな一覧ページのナビゲーションリンク等を除外
    if (KANA_LIST.includes(name) || name.match(/トップ|ホーム|メニュー|検索|一覧|ページ|先頭|前へ|次へ/)) continue;
    const fullUrl = href.startsWith('http') ? href : new URL(href, base).toString();
    // 同一ドメインのみ
    if (!fullUrl.includes(base.hostname)) continue;
    results.push({ name, href: fullUrl });
  }
  return results;
}

function extractCategory(html: string): string {
  const root = parse(html);

  // パターン1: <dt>分別種別</dt><dd>xxx</dd>
  for (const dt of root.querySelectorAll('dt')) {
    if (dt.text.trim().includes('分別種別') || dt.text.trim().includes('分別区分')) {
      const dd = dt.nextElementSibling;
      if (dd) {
        const text = dd.text.trim().replace(/\s+/g, ' ');
        if (text) return text;
      }
    }
  }

  // パターン2: テーブルで「分別種別」ヘッダーの隣セル
  for (const tr of root.querySelectorAll('tr')) {
    const cells = tr.querySelectorAll('td, th');
    for (let i = 0; i < cells.length - 1; i++) {
      const header = cells[i].text.trim();
      if (header.includes('分別種別') || header.includes('分別区分')) {
        const value = cells[i + 1].text.trim().replace(/\s+/g, ' ');
        if (value) return value;
      }
    }
  }

  // パターン3: 「分別種別」を含む要素の次の兄弟または子
  for (const el of root.querySelectorAll('*')) {
    const text = el.text.trim();
    if (text === '分別種別' || text === '分別区分') {
      const next = el.nextElementSibling;
      if (next) {
        const value = next.text.trim().replace(/\s+/g, ' ');
        if (value) return value;
      }
    }
  }

  // パターン4: ページ内の分別種類キーワードを探す
  const categoryKeywords = ['燃えるごみ', '燃えないごみ', '粗大ごみ', '有害ごみ', '拠点回収',
    '資源ごみ', '不燃ごみ', '可燃ごみ'];
  const bodyText = root.text;
  for (const kw of categoryKeywords) {
    if (bodyText.includes(kw)) return kw;
  }

  return '';
}

function findKanaUrlPattern(html: string, baseUrl: string): string | null {
  const root = parse(html);
  const base = new URL(baseUrl);
  const links = root.querySelectorAll('a[href]');

  for (const link of links) {
    const text = link.text.trim();
    const href = link.getAttribute('href') ?? '';
    if (!href || !KANA_LIST.includes(text)) continue;
    const fullUrl = href.startsWith('http') ? href : new URL(href, base).toString();
    const encodedKana = encodeURIComponent(text);
    const pattern = fullUrl.includes(encodedKana)
      ? fullUrl.replace(encodedKana, '{kana}')
      : fullUrl.includes(text)
        ? fullUrl.replace(text, '{kana}')
        : null;
    if (pattern) return pattern;
  }
  return null;
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
    const baseHtml = await fetchHtml(url);
    if (!baseHtml) return Response.json({ error: 'ベースページ取得失敗' }, { status: 502 });

    let urlTemplate = findKanaUrlPattern(baseHtml, url);
    if (!urlTemplate) {
      const cleanBase = url.split('?')[0];
      urlTemplate = `${cleanBase}?row={kana}`;
    }

    for (const kana of KANA_LIST) {
      try {
        // 一覧ページに1秒wait
        await new Promise(r => setTimeout(r, 1000));

        const kanaUrl = urlTemplate.replace('{kana}', encodeURIComponent(kana));
        if (kanaUrl === url) continue;

        const listHtml = await fetchHtml(kanaUrl);
        if (!listHtml) { errors.push(`${kana}: 取得失敗`); continue; }

        const itemLinks = extractItemLinks(listHtml, kanaUrl);
        if (itemLinks.length === 0) continue;

        fetchedKana.push(kana);
        totalItems += itemLinks.length;

        for (const { name, href } of itemLinks) {
          try {
            // 詳細ページに50ms wait
            await new Promise(r => setTimeout(r, 50));

            const detailHtml = await fetchHtml(href);
            const category = detailHtml ? extractCategory(detailHtml) : '';

            // name + category のみ UPSERT（details/keywords は触らない）
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
      errors: errors.slice(0, 20),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return Response.json({ error: `エラー: ${msg}` }, { status: 500 });
  }
}
