import { NextRequest } from 'next/server';
import { getDb, initDb } from '@/lib/db';

// GET: 地区キーで年間予定・カレンダー情報を取得
export async function GET(req: NextRequest) {
  const regionKey = req.nextUrl.searchParams.get('region') ?? '';
  try {
    await initDb();
    const sql = getDb();

    const schedules = await sql`
      SELECT region_key, calendar_group, pdf_url, pdf_title, schedule_info, updated_at
      FROM region_schedules
      WHERE region_key ILIKE ${'%' + regionKey + '%'}
      ORDER BY region_key LIMIT 20
    `;

    const calendars = regionKey ? await sql`
      SELECT region_key, year, month, calendar_data
      FROM region_calendars
      WHERE region_key ILIKE ${'%' + regionKey + '%'}
      ORDER BY year, month
    ` : [];

    return Response.json({ schedules, calendars });
  } catch (e) {
    return Response.json({ schedules: [], calendars: [], error: String(e) });
  }
}

// POST: 地区の年間予定情報をDB保存
export async function POST(req: NextRequest) {
  const { regionKey, calendarGroup, pdfUrl, pdfTitle, scheduleInfo } = await req.json();
  if (!regionKey) return Response.json({ error: '地区キーが必要です' }, { status: 400 });

  try {
    await initDb();
    const sql = getDb();
    await sql`
      INSERT INTO region_schedules (region_key, calendar_group, pdf_url, pdf_title, schedule_info, updated_at)
      VALUES (
        ${regionKey},
        ${calendarGroup ?? 0},
        ${pdfUrl ?? ''},
        ${pdfTitle ?? ''},
        ${JSON.stringify(scheduleInfo ?? {})},
        NOW()
      )
      ON CONFLICT (region_key) DO UPDATE
        SET calendar_group = EXCLUDED.calendar_group,
            pdf_url = EXCLUDED.pdf_url,
            pdf_title = EXCLUDED.pdf_title,
            schedule_info = EXCLUDED.schedule_info,
            updated_at = NOW()
    `;
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
