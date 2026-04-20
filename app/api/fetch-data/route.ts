import { NextRequest } from 'next/server';
import { parse } from 'node-html-parser';

interface ParsedItem {
  name: string;
  category: string;
  summary: string;
}

export async function POST(req: NextRequest) {
  const { url } = await req.json();
  if (!url) return Response.json({ error: 'URLが指定されていません' }, { status: 400 });

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GomiApp/1.0)' },
      next: { revalidate: 0 },
    });

    if (!res.ok) {
      return Response.json({ error: `ページの取得に失敗しました (${res.status})` }, { status: 502 });
    }

    const html = await res.text();
    const root = parse(html);
    const items: ParsedItem[] = [];

    // Try parsing table rows
    const rows = root.querySelectorAll('table tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const name = cells[0].text.trim().replace(/\s+/g, ' ');
        const category = cells[1].text.trim().replace(/\s+/g, ' ');
        if (name && category && name.length < 50 && !name.includes('ごみの種類') && !name.includes('品目')) {
          const summary = cells[2]?.text.trim().replace(/\s+/g, ' ') ?? '';
          items.push({ name, category, summary: summary.slice(0, 100) });
        }
      }
    }

    // Fallback: try definition lists
    if (items.length === 0) {
      const dts = root.querySelectorAll('dt');
      for (const dt of dts) {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD') {
          const name = dt.text.trim().replace(/\s+/g, ' ');
          const summary = dd.text.trim().replace(/\s+/g, ' ');
          if (name && summary && name.length < 50) {
            items.push({ name, category: '', summary: summary.slice(0, 100) });
          }
        }
      }
    }

    // Fallback: extract headings with following paragraphs
    if (items.length === 0) {
      const headings = root.querySelectorAll('h2, h3, h4');
      for (const h of headings) {
        const text = h.text.trim();
        if (text && text.length < 30 && (
          text.includes('ごみ') || text.includes('資源') || text.includes('缶') ||
          text.includes('びん') || text.includes('ペット') || text.includes('紙') ||
          text.includes('布') || text.includes('粗大') || text.includes('有害')
        )) {
          const next = h.nextElementSibling;
          const summary = next ? next.text.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
          items.push({ name: text, category: '', summary });
        }
      }
    }

    return Response.json({
      items: items.slice(0, 100),
      count: items.length,
      source: url,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return Response.json({ error: `取得エラー: ${msg}` }, { status: 500 });
  }
}
