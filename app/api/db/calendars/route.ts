import { NextRequest } from 'next/server';
import { initDb, getDb } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const regionKey = searchParams.get('region') || '浅川';
  const year = parseInt(searchParams.get('year') || String(new Date().getFullYear()));

  try {
    await initDb();
    const sql = getDb();

    // 当該年度（4月〜翌3月）を対象に取得
    const rows = await sql`
      SELECT year, month, calendar_data
      FROM region_calendars
      WHERE region_key = ${regionKey}
        AND (
          (year = ${year} AND month >= 1)
          OR (year = ${year + 1} AND month <= 3)
        )
      ORDER BY year, month
    `;

    const calendars = rows.map(row => ({
      year: row.year as number,
      month: row.month as number,
      entries: ((row.calendar_data as { entries: unknown[] }).entries ?? []),
    }));

    return Response.json({ calendars });
  } catch (e) {
    return Response.json({ error: String(e), calendars: [] }, { status: 500 });
  }
}
