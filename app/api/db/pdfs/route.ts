import { NextRequest } from 'next/server';
import { getDb, initDb } from '@/lib/db';

export async function GET(req: NextRequest) {
  const region = req.nextUrl.searchParams.get('region') ?? '';
  try {
    await initDb();
    const sql = getDb();
    if (region) {
      const rows = await sql`
        SELECT id, region_name, pdf_url, pdf_title, calendar_group
        FROM region_pdfs
        WHERE region_name ILIKE ${'%' + region + '%'}
        ORDER BY id DESC LIMIT 5
      `;
      return Response.json({ pdfs: rows });
    }
    const rows = await sql`
      SELECT id, region_name, pdf_url, pdf_title, calendar_group
      FROM region_pdfs ORDER BY region_name LIMIT 200
    `;
    return Response.json({ pdfs: rows });
  } catch (e) {
    return Response.json({ pdfs: [], error: String(e) });
  }
}

export async function POST(req: NextRequest) {
  const { pdfs, sourceUrl } = await req.json();
  if (!pdfs?.length) return Response.json({ inserted: 0 });

  try {
    await initDb();
    const sql = getDb();
    let inserted = 0;
    for (const pdf of pdfs) {
      if (!pdf.regionName || !pdf.pdfUrl) continue;
      await sql`
        INSERT INTO region_pdfs (region_name, pdf_url, pdf_title, calendar_group, source_url)
        VALUES (
          ${pdf.regionName.trim()},
          ${pdf.pdfUrl.trim()},
          ${(pdf.pdfTitle ?? '').trim()},
          ${pdf.calendarGroup ?? 0},
          ${sourceUrl ?? ''}
        )
        ON CONFLICT (region_name, pdf_url) DO UPDATE
          SET pdf_title = EXCLUDED.pdf_title,
              source_url = EXCLUDED.source_url
      `;
      inserted++;
    }
    return Response.json({ inserted });
  } catch (e) {
    return Response.json({ inserted: 0, error: String(e) }, { status: 500 });
  }
}
