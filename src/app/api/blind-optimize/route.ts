import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'

const execAsync = promisify(exec)

export const maxDuration = 600  // 最大10分（実測30-60秒）

export async function POST() {
  const startTime = Date.now()
  const scriptPath = path.join(process.cwd(), 'scripts', 'full_blind_optimize.js')

  try {
    const { stdout, stderr } = await execAsync(`node "${scriptPath}" --save`, {
      cwd: process.cwd(),
      timeout: 590000,
      maxBuffer: 50 * 1024 * 1024,  // 50MB
      env: { ...process.env },
    })

    const elapsed = Math.round((Date.now() - startTime) / 1000)
    const out = (stdout || '') + (stderr ? `\n${stderr}` : '')

    // 結果サマリ抽出
    const accMatch = out.match(/精度:\s*([\d.]+)%\s*→\s*([\d.]+)%/)
                  || out.match(/ベスト:[\s\S]*?精度[:：]\s*([\d.]+)%[^→]*→\s*([\d.]+)%/)
    const beforeAcc = accMatch ? parseFloat(accMatch[1]) : null
    const afterAcc = accMatch ? parseFloat(accMatch[2]) : null

    const versionMatch = out.match(/AlgorithmConfig\s*v(\d+)\s*保存完了/)
    const version = versionMatch ? parseInt(versionMatch[1]) : null

    const labelMatch = out.match(/ベスト:\s*([^\s\n]+)/)
    const bestLabel = labelMatch ? labelMatch[1] : null

    // 順位別的中率
    const rankRows: { rank: number; hits: number; total: number; pct: number; predAvg: number }[] = []
    const rankRe = /(\d)位:\s*(\d+)\/(\d+)\s*\((\d+)%\)\s*予測平均([\d.]+)%/g
    let rm: RegExpExecArray | null
    while ((rm = rankRe.exec(out)) !== null) {
      rankRows.push({ rank: parseInt(rm[1]), hits: parseInt(rm[2]), total: parseInt(rm[3]), pct: parseInt(rm[4]), predAvg: parseFloat(rm[5]) })
    }
    // 重複排除（最終出力分のみ採用）
    const uniqueRanks = new Map<number, typeof rankRows[0]>()
    rankRows.forEach((r) => uniqueRanks.set(r.rank, r))
    const finalRanks: typeof rankRows = []
    uniqueRanks.forEach((v) => finalRanks.push(v))
    finalRanks.sort((a, b) => a.rank - b.rank)

    // 年別精度
    const yearRows: { year: number; pct: number; full: number; half: number; miss: number }[] = []
    const yearRe = /(\d{4}):\s*(\d+)%\s*\((\d+)\/(\d+)\/(\d+)\)/g
    let ym: RegExpExecArray | null
    while ((ym = yearRe.exec(out)) !== null) {
      yearRows.push({ year: parseInt(ym[1]), pct: parseInt(ym[2]), full: parseInt(ym[3]), half: parseInt(ym[4]), miss: parseInt(ym[5]) })
    }
    const uniqueYears = new Map<number, typeof yearRows[0]>()
    yearRows.forEach((y) => uniqueYears.set(y.year, y))
    const finalYears: typeof yearRows = []
    uniqueYears.forEach((v) => finalYears.push(v))
    finalYears.sort((a, b) => a.year - b.year)

    return NextResponse.json({
      success: true,
      elapsed,
      version,
      bestLabel,
      beforeAccuracy: beforeAcc,
      afterAccuracy: afterAcc,
      ranks: finalRanks,
      years: finalYears,
      log: out.split('\n').slice(-80).join('\n'),
    })
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return NextResponse.json({
      success: false,
      error: err.message || '最適化に失敗しました',
      log: (err.stdout || '') + '\n' + (err.stderr || ''),
    }, { status: 500 })
  }
}
