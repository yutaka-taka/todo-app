import { neon } from '@neondatabase/serverless';

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return neon(url);
}

export async function initDb() {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS garbage_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      details TEXT DEFAULT '',
      keywords TEXT[] DEFAULT '{}',
      source_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // 旧列を削除（既存テーブル対応）
  await sql`ALTER TABLE garbage_items DROP COLUMN IF EXISTS summary`;
  await sql`ALTER TABLE garbage_items DROP COLUMN IF EXISTS disposal_method`;
  // 新列を追加（既存テーブル対応）
  await sql`ALTER TABLE garbage_items ADD COLUMN IF NOT EXISTS details TEXT DEFAULT ''`;
  await sql`ALTER TABLE garbage_items ADD COLUMN IF NOT EXISTS keywords TEXT[] DEFAULT '{}'`;
  // name のユニーク制約（ON CONFLICT(name) に必要）
  await sql`
    DELETE FROM garbage_items a USING garbage_items b
    WHERE a.id < b.id AND a.name = b.name
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS garbage_items_name_unique ON garbage_items(name)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS region_pdfs (
      id SERIAL PRIMARY KEY,
      region_name TEXT NOT NULL,
      pdf_url TEXT NOT NULL,
      pdf_title TEXT DEFAULT '',
      calendar_group INTEGER DEFAULT 0,
      source_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Unique index on region_pdfs to prevent duplicates
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS region_pdfs_region_url
    ON region_pdfs(region_name, pdf_url)
  `;
  // 地区ごとのごみ収集カレンダー（JSONで月ごとのデータを保存）
  await sql`
    CREATE TABLE IF NOT EXISTS region_calendars (
      id SERIAL PRIMARY KEY,
      region_key TEXT NOT NULL,       -- 地区キー（例: 浅川）
      calendar_group INTEGER DEFAULT 0,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      calendar_data JSONB NOT NULL,   -- {entries: [{date, types}]}
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(region_key, year, month)
    )
  `;
  // 地区ごとの年間収集予定表情報
  await sql`
    CREATE TABLE IF NOT EXISTS region_schedules (
      id SERIAL PRIMARY KEY,
      region_key TEXT NOT NULL UNIQUE, -- 地区キー（例: 浅川）
      calendar_group INTEGER DEFAULT 0,
      pdf_url TEXT DEFAULT '',
      pdf_title TEXT DEFAULT '',
      schedule_info JSONB DEFAULT '{}', -- 収集日情報（曜日など）
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}
