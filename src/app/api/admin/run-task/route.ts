import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'
import type { TaskKey, TaskStatus } from './types'

export const dynamic = 'force-dynamic'

export type { TaskKey, TaskStatus }

// モジュールレベルで保持（サーバー再起動でリセット）
const taskState = new Map<TaskKey, TaskStatus>()

const ROOT = process.cwd()
const NODE = process.execPath

function getToday() {
  return new Date().toISOString().split('T')[0]
}

function buildConfig(task: TaskKey): { cmd: string; args: string[] } | null {
  const today = getToday()
  switch (task) {
    case 'weekly_update':
      return { cmd: NODE, args: [path.join(ROOT, 'scripts', 'weekly_update.js')] }
    case 'weekly_prefetch':
      return { cmd: NODE, args: [path.join(ROOT, 'scripts', 'weekly_prefetch.js')] }
    case 'ml_dataset':
      return {
        cmd: 'python',
        args: [
          path.join(ROOT, 'ml', 'build_dataset.py'),
          '--from=2021-01-01',
          `--to=${today}`,
          `--out=${path.join(ROOT, 'ml', 'dataset.parquet')}`,
        ],
      }
    case 'ml_retrain':
      return {
        cmd: 'python',
        args: [
          path.join(ROOT, 'ml', 'train.py'),
          `--dataset=${path.join(ROOT, 'ml', 'dataset.parquet')}`,
          `--out-dir=${path.join(ROOT, 'ml', 'models')}`,
        ],
      }
    default:
      return null
  }
}

// GET: 全タスクの現在状態を返す
export async function GET() {
  const result: Record<string, TaskStatus> = {}
  taskState.forEach((status, task) => {
    result[task] = { ...status }
  })
  return NextResponse.json(result)
}

// POST { task }: タスクを起動（多重起動防止）
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const task = body.task as TaskKey | undefined

  if (!task) return NextResponse.json({ error: 'task is required' }, { status: 400 })

  const config = buildConfig(task)
  if (!config) return NextResponse.json({ error: `Unknown task: ${task}` }, { status: 400 })

  const current = taskState.get(task)
  if (current?.running) {
    return NextResponse.json({ status: 'already_running', pid: current.pid, startedAt: current.startedAt })
  }

  const state: TaskStatus = { running: true, startedAt: new Date().toISOString(), lastLines: [] }
  taskState.set(task, state)

  try {
    const proc = spawn(config.cmd, config.args, {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    state.pid = proc.pid

    const pushLine = (line: string) => {
      if (!line.trim()) return
      state.lastLines.push(line)
      if (state.lastLines.length > 200) state.lastLines.shift()
    }

    proc.stdout?.on('data', (chunk: Buffer) => chunk.toString().split('\n').forEach(pushLine))
    proc.stderr?.on('data', (chunk: Buffer) => chunk.toString().split('\n').forEach(pushLine))

    proc.on('close', (code) => {
      state.running = false
      state.finishedAt = new Date().toISOString()
      state.exitCode = code
    })

    proc.on('error', (err) => {
      state.running = false
      state.finishedAt = new Date().toISOString()
      state.exitCode = -1
      state.lastLines.push(`[ERROR] ${err.message}`)
    })

    return NextResponse.json({ status: 'started', pid: proc.pid, startedAt: state.startedAt })
  } catch (err) {
    state.running = false
    state.exitCode = -1
    state.lastLines.push(`[ERROR] ${err instanceof Error ? err.message : String(err)}`)
    return NextResponse.json({ status: 'error', error: String(err) }, { status: 500 })
  }
}
