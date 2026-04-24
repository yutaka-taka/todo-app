import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import { prisma } from '@/lib/db'

const execAsync = promisify(exec)

const PSQL_PATH = 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe'

interface TableStat {
  relname: string
  total_size: string
  total_bytes: bigint
  n_live_tup: bigint
  n_dead_tup: bigint
  last_vacuum: Date | null
  last_analyze: Date | null
}

interface DbSize {
  size: string
  bytes: bigint
}

export async function GET() {
  try {
    const [tables, dbSizeResult] = await Promise.all([
      prisma.$queryRawUnsafe<TableStat[]>(`
        SELECT
          relname,
          pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
          pg_total_relation_size(relid) AS total_bytes,
          n_live_tup,
          n_dead_tup,
          last_vacuum,
          last_analyze
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
      `),
      prisma.$queryRawUnsafe<DbSize[]>(`
        SELECT
          pg_size_pretty(pg_database_size(current_database())) AS size,
          pg_database_size(current_database()) AS bytes
      `),
    ])

    const totalDeadTuples = tables.reduce((sum: number, t: TableStat) => sum + Number(t.n_dead_tup), 0)
    const lastVacuum = tables
      .map((t: TableStat) => t.last_vacuum)
      .filter((v): v is Date => v !== null)
      .sort((a: Date, b: Date) => new Date(b).getTime() - new Date(a).getTime())[0]

    return NextResponse.json({
      dbSize: dbSizeResult[0]?.size ?? '不明',
      dbBytes: Number(dbSizeResult[0]?.bytes ?? 0),
      totalDeadTuples,
      lastVacuum: lastVacuum ? new Date(lastVacuum).toLocaleString('ja-JP') : 'なし',
      tables: tables.map((t: TableStat) => ({
        name: t.relname,
        size: t.total_size,
        liveTuples: Number(t.n_live_tup),
        deadTuples: Number(t.n_dead_tup),
        lastVacuum: t.last_vacuum ? new Date(t.last_vacuum).toLocaleString('ja-JP') : null,
        lastAnalyze: t.last_analyze ? new Date(t.last_analyze).toLocaleString('ja-JP') : null,
      })),
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function POST() {
  const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:post@localhost:5432/keiba'
  const match = dbUrl.match(/postgresql:\/\/([^:]+):([^@]+)@([^:/]+):?(\d*)\/(.+)/)
  if (!match) {
    return NextResponse.json({ error: 'DB接続文字列の解析に失敗しました' }, { status: 500 })
  }
  const [, user, password, host, port, dbname] = match

  const startTime = Date.now()

  try {
    // VACUUM ANALYZE: 不要タプルの削除とクエリプランナー統計の更新
    const cmd = `"${PSQL_PATH}" -c "VACUUM ANALYZE;" -d ${dbname} -U ${user} -h ${host} -p ${port || 5432}`
    await execAsync(cmd, {
      env: { ...process.env, PGPASSWORD: password },
      timeout: 120000,
    })

    // VACUUM後の統計を取得
    const [tables, dbSizeResult] = await Promise.all([
      prisma.$queryRawUnsafe<TableStat[]>(`
        SELECT
          relname,
          pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
          n_live_tup,
          n_dead_tup,
          last_vacuum,
          last_analyze
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
      `),
      prisma.$queryRawUnsafe<DbSize[]>(`
        SELECT
          pg_size_pretty(pg_database_size(current_database())) AS size,
          pg_database_size(current_database()) AS bytes
      `),
    ])

    const elapsed = Date.now() - startTime
    const totalDeadTuples = tables.reduce((sum: number, t: TableStat) => sum + Number(t.n_dead_tup), 0)

    return NextResponse.json({
      success: true,
      elapsed,
      dbSize: dbSizeResult[0]?.size ?? '不明',
      totalDeadTuples,
      tables: tables.map((t: TableStat) => ({
        name: t.relname,
        size: t.total_size,
        liveTuples: Number(t.n_live_tup),
        deadTuples: Number(t.n_dead_tup),
        lastVacuum: t.last_vacuum ? new Date(t.last_vacuum).toLocaleString('ja-JP') : null,
        lastAnalyze: t.last_analyze ? new Date(t.last_analyze).toLocaleString('ja-JP') : null,
      })),
    })
  } catch (e) {
    return NextResponse.json({ error: `最適化に失敗しました: ${String(e)}` }, { status: 500 })
  }
}
