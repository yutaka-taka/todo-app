import { NextRequest } from 'next/server';
import { parse } from 'node-html-parser';
import Anthropic from '@anthropic-ai/sdk';
import { initDb, getDb } from '@/lib/db';

interface ParsedItem {
  name: string;
  category: string;
  summary: string;
  details: string;
  disposalMethod: string;
  keywords: string[];
}

interface RegionPdf {
  regionName: string;
  pdfUrl: string;
  pdfTitle: string;
  calendarGroup: number;
}

async function extractFromPdf(pdfUrl: string): Promise<{ items: ParsedItem[]; pdfs: RegionPdf[] }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { items: [], pdfs: [] };

  const res = await fetch(pdfUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`PDF取得失敗: ${res.status}`);

  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        },
        {
          type: 'text',
          text: `このPDFはごみの分別・出し方に関する長野市の資料です。
以下のJSON形式で全てのごみ品目を抽出してください。JSONのみ返してください。

{"items": [
  {
    "name": "品目名（例：ペットボトル）",
    "category": "分別区分（例：資源ごみ）",
    "summary": "一行概要",
    "details": "詳細な出し方・注意事項",
    "disposalMethod": "出し方",
    "keywords": ["関連キーワード1", "関連キーワード2"]
  }
]}

PDFに記載されている全品目を含めてください。品目が見当たらない場合は {"items":[]} を返してください。`,
        },
      ],
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { items: [], pdfs: [] };

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return { items: parsed.items ?? [], pdfs: [] };
  } catch {
    return { items: [], pdfs: [] };
  }
}

async function extractFromHtml(url: string, html: string): Promise<{ items: ParsedItem[]; pdfs: RegionPdf[] }> {
  const root = parse(html);
  const items: ParsedItem[] = [];
  const pdfs: RegionPdf[] = [];

  // Extract region-specific PDF links
  const baseUrl = new URL(url);
  const links = root.querySelectorAll('a[href]');
  for (const link of links) {
    const href = link.getAttribute('href') ?? '';
    const text = link.text.trim();
    if (!href) continue;

    const isPdf = href.toLowerCase().includes('.pdf') || text.includes('PDF');
    if (!isPdf) continue;

    // Try to extract region name from link text
    // e.g. "ごみ年間収集予定表(浅川)（PDF：312KB）"
    const regionMatch = text.match(/[（(]([^）)（(（PpDdFf：:\d]+?)[）)]/);
    if (regionMatch && regionMatch[1].trim() && !regionMatch[1].includes('PDF') && !regionMatch[1].match(/^\d/)) {
      const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
      // Extract calendar group from link or surrounding text
      const groupMatch = (link.parentNode?.text ?? '').match(/第?(\d+)(?:区|グループ|番)/);
      pdfs.push({
        regionName: regionMatch[1].trim(),
        pdfUrl: fullUrl,
        pdfTitle: text.replace(/\s+/g, ' ').trim(),
        calendarGroup: groupMatch ? parseInt(groupMatch[1]) : 0,
      });
    } else if (text.includes('年間収集予定表') || text.includes('収集カレンダー')) {
      // Generic schedule PDF
      const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
      pdfs.push({
        regionName: text.replace(/[（(）)\s]/g, '').replace(/PDF.*$/, '').trim() || '全域',
        pdfUrl: fullUrl,
        pdfTitle: text.trim(),
        calendarGroup: 0,
      });
    }
  }

  // Parse HTML tables for garbage items
  const rows = root.querySelectorAll('table tr');
  for (const row of rows) {
    const cells = row.querySelectorAll('td, th');
    if (cells.length < 2) continue;
    const name = cells[0].text.trim().replace(/\s+/g, ' ');
    const category = cells[1].text.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 50 || category.length > 100) continue;
    if (name.match(/品目|種類|ごみの名前|名称/)) continue;
    const summary = cells[2]?.text.trim().replace(/\s+/g, ' ') ?? '';
    items.push({
      name, category,
      summary: summary.slice(0, 150),
      details: summary,
      disposalMethod: summary.slice(0, 80),
      keywords: [name],
    });
  }

  // Fallback: definition lists
  if (items.length === 0) {
    root.querySelectorAll('dt').forEach(dt => {
      const dd = dt.nextElementSibling;
      if (dd?.tagName === 'DD') {
        const name = dt.text.trim();
        const summary = dd.text.trim().replace(/\s+/g, ' ');
        if (name && name.length < 50 && summary) {
          items.push({ name, category: '', summary: summary.slice(0, 150), details: summary, disposalMethod: '', keywords: [name] });
        }
      }
    });
  }

  return { items, pdfs };
}

export async function POST(req: NextRequest) {
  const { url } = await req.json();
  if (!url) return Response.json({ error: 'URLが指定されていません' }, { status: 400 });

  try {
    await initDb();

    const headRes = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(() => null);
    const contentType = headRes?.headers.get('content-type') ?? '';
    const isPdf = url.toLowerCase().endsWith('.pdf') || contentType.includes('application/pdf');

    let items: ParsedItem[] = [];
    let pdfs: RegionPdf[] = [];

    if (isPdf) {
      const result = await extractFromPdf(url);
      items = result.items;
      pdfs = result.pdfs;
    } else {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 0 } });
      if (!res.ok) return Response.json({ error: `ページ取得失敗 (${res.status})` }, { status: 502 });
      const html = await res.text();
      const result = await extractFromHtml(url, html);
      items = result.items;
      pdfs = result.pdfs;
    }

    // Store in DB
    const sql = getDb();
    let insertedItems = 0;
    for (const item of items.slice(0, 200)) {
      if (!item.name) continue;
      await sql`
        INSERT INTO garbage_items (name, category, summary, details, disposal_method, keywords, source_url, updated_at)
        VALUES (${item.name}, ${item.category}, ${item.summary}, ${item.details}, ${item.disposalMethod}, ${item.keywords}, ${url}, NOW())
        ON CONFLICT DO NOTHING
      `;
      insertedItems++;
    }

    let insertedPdfs = 0;
    for (const pdf of pdfs) {
      if (!pdf.regionName || !pdf.pdfUrl) continue;
      await sql`
        INSERT INTO region_pdfs (region_name, pdf_url, pdf_title, calendar_group, source_url)
        VALUES (${pdf.regionName}, ${pdf.pdfUrl}, ${pdf.pdfTitle}, ${pdf.calendarGroup}, ${url})
        ON CONFLICT (region_name, pdf_url) DO UPDATE
          SET pdf_title = EXCLUDED.pdf_title, source_url = EXCLUDED.source_url
      `;
      insertedPdfs++;
    }

    return Response.json({
      items: items.slice(0, 200),
      pdfs,
      insertedItems,
      insertedPdfs,
      count: items.length,
      source: url,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return Response.json({ error: `取得エラー: ${msg}` }, { status: 500 });
  }
}
