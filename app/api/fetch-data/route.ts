import { NextRequest } from 'next/server';
import { parse } from 'node-html-parser';
import Anthropic from '@anthropic-ai/sdk';
import { initDb, getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 300;

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

async function extractFromPdf(
  pdfUrl: string
): Promise<{ items: ParsedItem[]; pdfs: RegionPdf[]; debug: string[] }> {
  const debug: string[] = [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    debug.push('ANTHROPIC_API_KEY が設定されていません');
    return { items: [], pdfs: [], debug };
  }

  debug.push(`PDFを取得中: ${pdfUrl}`);
  let pdfRes: Response;
  try {
    pdfRes = await fetch(pdfUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/pdf,*/*',
      },
    });
  } catch (e) {
    debug.push(`PDFフェッチ例外: ${e}`);
    return { items: [], pdfs: [], debug };
  }

  debug.push(`HTTPステータス: ${pdfRes.status} ${pdfRes.statusText}`);
  debug.push(`Content-Type: ${pdfRes.headers.get('content-type') ?? 'unknown'}`);

  if (!pdfRes.ok) {
    debug.push(`PDFの取得に失敗しました`);
    return { items: [], pdfs: [], debug };
  }

  const contentType = pdfRes.headers.get('content-type') ?? '';
  // PDFではなくHTMLが返ってきた場合（リダイレクトやエラーページ）
  if (contentType.includes('text/html')) {
    debug.push('PDFではなくHTMLが返却されました。URLを確認してください。');
    return { items: [], pdfs: [], debug };
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await pdfRes.arrayBuffer();
    debug.push(`PDFサイズ: ${Math.round(buffer.byteLength / 1024)} KB`);
  } catch (e) {
    debug.push(`ArrayBuffer変換失敗: ${e}`);
    return { items: [], pdfs: [], debug };
  }

  if (buffer.byteLength > 20 * 1024 * 1024) {
    debug.push('PDFが20MBを超えるため処理をスキップします');
    return { items: [], pdfs: [], debug };
  }

  if (buffer.byteLength > 5 * 1024 * 1024) {
    debug.push(`警告: PDFが大きいです(${Math.round(buffer.byteLength / 1024 / 1024 * 10) / 10}MB)。処理に時間がかかる場合があります。`);
  }

  const base64 = Buffer.from(buffer).toString('base64');
  debug.push('Claude APIにPDFを送信中...');

  try {
    const client = new Anthropic({ apiKey, timeout: 240_000 });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          } as any,
          {
            type: 'text',
            text: `このPDFはごみの分別・出し方に関する長野市の公式資料です。

PDF内に記載されている**全ての**ごみ品目を抽出して、以下のJSON形式で返してください。
必ずJSON形式のみで返答し、前置きや説明文は不要です。

{
  "items": [
    {
      "name": "品目名（具体的に。例：ペットボトル、アルミ缶、新聞紙）",
      "category": "分別区分（例：資源ごみ、燃えるごみ、燃えないごみ、有害ごみ、粗大ごみ）",
      "summary": "分別方法の一行概要",
      "details": "詳細な出し方・注意事項（複数行OK）",
      "disposalMethod": "具体的な出し方",
      "keywords": ["関連キーワード", "別名", "通称"]
    }
  ]
}

品目が見つからない場合は {"items": []} を返してください。`,
          },
        ],
      }],
    });

    const rawText = response.content[0].type === 'text' ? response.content[0].text : '';
    debug.push(`Claude応答長: ${rawText.length} 文字`);
    debug.push(`応答先頭: ${rawText.slice(0, 100)}`);

    // JSON抽出（コードブロック対応）
    const cleaned = rawText
      .replace(/^```json\s*/m, '')
      .replace(/^```\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      debug.push('JSONが見つかりませんでした');
      return { items: [], pdfs: [], debug };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const items: ParsedItem[] = (parsed.items ?? []).filter((i: ParsedItem) => i.name?.trim());
    debug.push(`抽出品目数: ${items.length}`);
    return { items, pdfs: [], debug };
  } catch (e) {
    debug.push(`Claude API エラー: ${e instanceof Error ? e.message : String(e)}`);
    return { items: [], pdfs: [], debug };
  }
}

async function extractFromHtml(
  url: string,
  html: string
): Promise<{ items: ParsedItem[]; pdfs: RegionPdf[] }> {
  const root = parse(html);
  const items: ParsedItem[] = [];
  const pdfs: RegionPdf[] = [];

  const baseUrl = new URL(url);
  const links = root.querySelectorAll('a[href]');
  for (const link of links) {
    const href = link.getAttribute('href') ?? '';
    const text = link.text.trim();
    if (!href) continue;

    const isPdf = href.toLowerCase().includes('.pdf') || text.includes('PDF');
    if (!isPdf) continue;

    const regionMatch = text.match(/[（(]([^）)（(PpDdFf：:\d]+?)[）)]/);
    if (
      regionMatch &&
      regionMatch[1].trim() &&
      !regionMatch[1].includes('PDF') &&
      !regionMatch[1].match(/^\d/)
    ) {
      const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
      const groupMatch = (link.parentNode?.text ?? '').match(/第?(\d+)(?:区|グループ|番)/);
      pdfs.push({
        regionName: regionMatch[1].trim(),
        pdfUrl: fullUrl,
        pdfTitle: text.replace(/\s+/g, ' ').trim(),
        calendarGroup: groupMatch ? parseInt(groupMatch[1]) : 0,
      });
    } else if (text.includes('年間収集予定表') || text.includes('収集カレンダー')) {
      const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
      pdfs.push({
        regionName: text.replace(/[（(）)\s]/g, '').replace(/PDF.*$/, '').trim() || '全域',
        pdfUrl: fullUrl,
        pdfTitle: text.trim(),
        calendarGroup: 0,
      });
    }
  }

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

  const debugLog: string[] = [];

  try {
    await initDb();

    const isPdf = url.toLowerCase().includes('.pdf');
    debugLog.push(`URL: ${url}`);
    debugLog.push(`PDF判定: ${isPdf}`);

    let items: ParsedItem[] = [];
    let pdfs: RegionPdf[] = [];

    if (isPdf) {
      const result = await extractFromPdf(url);
      items = result.items;
      pdfs = result.pdfs;
      debugLog.push(...result.debug);
    } else {
      debugLog.push('HTMLページとして処理');
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        cache: 'no-store',
      });
      debugLog.push(`HTTPステータス: ${res.status}`);
      if (!res.ok) return Response.json({ error: `ページ取得失敗 (${res.status})`, debug: debugLog }, { status: 502 });
      const html = await res.text();
      const result = await extractFromHtml(url, html);
      items = result.items;
      pdfs = result.pdfs;
      debugLog.push(`抽出品目: ${items.length}件、地区PDF: ${pdfs.length}件`);
    }

    const sql = getDb();
    let insertedItems = 0;
    for (const item of items.slice(0, 300)) {
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

    debugLog.push(`DB保存: ごみ品目 ${insertedItems}件、地区PDF ${insertedPdfs}件`);

    return Response.json({
      items: items.slice(0, 300),
      pdfs,
      insertedItems,
      insertedPdfs,
      count: items.length,
      source: url,
      debug: debugLog,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    debugLog.push(`致命的エラー: ${msg}`);
    return Response.json({ error: `取得エラー: ${msg}`, debug: debugLog }, { status: 500 });
  }
}
