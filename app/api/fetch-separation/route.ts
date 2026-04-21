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

interface ParsedItem {
  name: string;
  category: string;
  summary: string;
  details: string;
  disposalMethod: string;
  keywords: string[];
}

function extractItemsFromHtml(html: string): ParsedItem[] {
  const root = parse(html);
  const items: ParsedItem[] = [];

  // table rows
  const rows = root.querySelectorAll('table tr');
  for (const row of rows) {
    const cells = row.querySelectorAll('td, th');
    if (cells.length < 2) continue;
    const name = cells[0].text.trim().replace(/\s+/g, ' ');
    const category = cells[1].text.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 60 || name.match(/品目|名前|名称|ごみの種類/)) continue;
    const summary = cells[2]?.text.trim().replace(/\s+/g, ' ') ?? '';
    items.push({
      name,
      category,
      summary: summary.slice(0, 150),
      details: summary,
      disposalMethod: summary.slice(0, 80),
      keywords: [name],
    });
  }

  // dl/dt/dd pairs
  if (items.length === 0) {
    root.querySelectorAll('dt').forEach(dt => {
      const dd = dt.nextElementSibling;
      if (dd?.tagName === 'DD') {
        const name = dt.text.trim().replace(/\s+/g, ' ');
        const summary = dd.text.trim().replace(/\s+/g, ' ');
        if (name && name.length < 60 && summary) {
          items.push({ name, category: '', summary: summary.slice(0, 150), details: summary, disposalMethod: '', keywords: [name] });
        }
      }
    });
  }

  // li elements that look like item entries
  if (items.length === 0) {
    root.querySelectorAll('li').forEach(li => {
      const text = li.text.trim().replace(/\s+/g, ' ');
      if (text && text.length < 80) {
        items.push({ name: text, category: '', summary: '', details: '', disposalMethod: '', keywords: [text] });
      }
    });
  }

  return items;
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
  const allItems: ParsedItem[] = [];
  const errors: string[] = [];
  const fetchedKana: string[] = [];

  try {
    const baseRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      cache: 'no-store',
    });
    if (!baseRes.ok) {
      return Response.json({ error: `ページ取得失敗 (${baseRes.status})` }, { status: 502 });
    }
    const baseHtml = await baseRes.text();

    // Extract items from the base page
    allItems.push(...extractItemsFromHtml(baseHtml));

    // Discover kana URL pattern from links; fall back to common patterns
    let urlTemplate = findKanaUrlPattern(baseHtml, url);
    if (!urlTemplate) {
      const cleanBase = url.split('?')[0];
      urlTemplate = `${cleanBase}?row={kana}`;
    }

    for (const kana of KANA_LIST) {
      try {
        const kanaUrl = urlTemplate.replace('{kana}', encodeURIComponent(kana));
        if (kanaUrl === url) continue;

        await new Promise(r => setTimeout(r, 1000));
        const res = await fetch(kanaUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          cache: 'no-store',
        });
        if (!res.ok) { errors.push(`${kana}: HTTP ${res.status}`); continue; }

        const html = await res.text();
        const items = extractItemsFromHtml(html);
        allItems.push(...items);
        fetchedKana.push(kana);
      } catch (e) {
        errors.push(`${kana}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Deduplicate by name
    const uniqueItems = allItems.filter(
      (item, idx, arr) => arr.findIndex(i => i.name === item.name) === idx
    );

    let insertedCount = 0;
    for (const item of uniqueItems.slice(0, 5000)) {
      if (!item.name?.trim()) continue;
      await sql`
        INSERT INTO garbage_items (name, category, summary, details, disposal_method, keywords, source_url, updated_at)
        VALUES (
          ${item.name.trim()},
          ${(item.category ?? '').trim()},
          ${(item.summary ?? '').trim()},
          ${(item.details ?? '').trim()},
          ${(item.disposalMethod ?? '').trim()},
          ${item.keywords ?? []},
          ${url},
          NOW()
        )
        ON CONFLICT DO NOTHING
      `;
      insertedCount++;
    }

    return Response.json({
      totalItems: uniqueItems.length,
      insertedCount,
      fetchedKana,
      errors: errors.slice(0, 20),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return Response.json({ error: `エラー: ${msg}` }, { status: 500 });
  }
}
