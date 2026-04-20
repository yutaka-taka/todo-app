import { NextRequest } from 'next/server';
import { getDb, initDb } from '@/lib/db';

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get('q') ?? '';
  try {
    await initDb();
    const sql = getDb();
    if (!query.trim()) {
      return Response.json({ items: [] });
    }
    const q = `%${query.trim()}%`;
    const rows = await sql`
      SELECT id, name, category, summary, details, disposal_method, keywords
      FROM garbage_items
      WHERE name ILIKE ${q}
         OR category ILIKE ${q}
         OR summary ILIKE ${q}
         OR ${query.trim()} = ANY(keywords)
      ORDER BY
        CASE WHEN name ILIKE ${query.trim()} THEN 0
             WHEN name ILIKE ${'%' + query.trim() + '%'} THEN 1
             ELSE 2 END,
        name
      LIMIT 10
    `;
    return Response.json({ items: rows });
  } catch (e) {
    return Response.json({ items: [], error: String(e) });
  }
}

export async function POST(req: NextRequest) {
  const { items, sourceUrl } = await req.json();
  if (!items?.length) return Response.json({ inserted: 0 });

  try {
    await initDb();
    const sql = getDb();
    let inserted = 0;
    for (const item of items) {
      const name: string = (item.name ?? '').trim();
      if (!name) continue;
      await sql`
        INSERT INTO garbage_items (name, category, summary, details, disposal_method, keywords, source_url, updated_at)
        VALUES (
          ${name},
          ${(item.category ?? '').trim()},
          ${(item.summary ?? '').trim()},
          ${(item.details ?? '').trim()},
          ${(item.disposalMethod ?? item.disposal_method ?? '').trim()},
          ${item.keywords ?? []},
          ${sourceUrl ?? ''},
          NOW()
        )
        ON CONFLICT DO NOTHING
      `;
      inserted++;
    }
    return Response.json({ inserted });
  } catch (e) {
    return Response.json({ inserted: 0, error: String(e) }, { status: 500 });
  }
}
