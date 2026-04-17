'use client'

import { useState, useRef, useEffect } from 'react'

type Task = {
  id: string
  text: string
  completed: boolean
  createdAt: number
}

const STORAGE_KEY = 'todo-tasks'

function loadTasks(): Task[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveTasks(tasks: Task[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
}

export default function TodoApp() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [input, setInput] = useState('')
  const [filter, setFilter] = useState<'all' | 'active' | 'done'>('all')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setTasks(loadTasks())
  }, [])

  function addTask() {
    const text = input.trim()
    if (!text) return
    const next: Task[] = [
      {
        id: crypto.randomUUID(),
        text,
        completed: false,
        createdAt: Date.now(),
      },
      ...tasks,
    ]
    setTasks(next)
    saveTasks(next)
    setInput('')
    inputRef.current?.focus()
  }

  function toggleTask(id: string) {
    const next = tasks.map((t) =>
      t.id === id ? { ...t, completed: !t.completed } : t
    )
    setTasks(next)
    saveTasks(next)
  }

  function deleteTask(id: string) {
    const next = tasks.filter((t) => t.id !== id)
    setTasks(next)
    saveTasks(next)
  }

  const filtered = tasks.filter((t) => {
    if (filter === 'active') return !t.completed
    if (filter === 'done') return t.completed
    return true
  })

  const activeCount = tasks.filter((t) => !t.completed).length
  const doneCount = tasks.filter((t) => t.completed).length

  return (
    <div className="min-h-screen flex items-start justify-center pt-16 pb-16 px-4">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-stone-800">
            やること
          </h1>
          <p className="mt-1 text-sm text-stone-400">
            {activeCount > 0
              ? `残り ${activeCount} 件`
              : tasks.length === 0
              ? 'タスクを追加しましょう'
              : 'すべて完了！'}
          </p>
        </div>

        {/* Input */}
        <div className="flex gap-2 mb-6">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTask()}
            placeholder="新しいタスクを入力..."
            className="flex-1 px-4 py-3 rounded-xl bg-white border border-stone-200 text-stone-800 placeholder-stone-300 text-sm outline-none focus:border-stone-400 focus:ring-2 focus:ring-stone-100 transition-all"
          />
          <button
            onClick={addTask}
            disabled={!input.trim()}
            className="px-5 py-3 rounded-xl bg-stone-800 text-white text-sm font-medium hover:bg-stone-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
          >
            追加
          </button>
        </div>

        {/* Filter tabs */}
        {tasks.length > 0 && (
          <div className="flex gap-1 mb-4 p-1 bg-stone-100 rounded-xl w-fit">
            {(
              [
                { key: 'all', label: `すべて (${tasks.length})` },
                { key: 'active', label: `未完了 (${activeCount})` },
                { key: 'done', label: `完了 (${doneCount})` },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  filter === key
                    ? 'bg-white text-stone-800 shadow-sm'
                    : 'text-stone-400 hover:text-stone-600'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Task list */}
        <ul className="space-y-2">
          {filtered.length === 0 && (
            <li className="text-center py-12 text-stone-300 text-sm">
              {filter === 'done' ? '完了済みのタスクはありません' : filter === 'active' ? '未完了のタスクはありません' : 'タスクがありません'}
            </li>
          )}
          {filtered.map((task) => (
            <li
              key={task.id}
              className="task-item flex items-center gap-3 px-4 py-3.5 bg-white rounded-xl border border-stone-100 group hover:border-stone-200 transition-all"
            >
              {/* Checkbox */}
              <button
                onClick={() => toggleTask(task.id)}
                aria-label={task.completed ? '未完了に戻す' : '完了にする'}
                className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                  task.completed
                    ? 'bg-emerald-400 border-emerald-400'
                    : 'border-stone-200 hover:border-stone-400'
                }`}
              >
                {task.completed && (
                  <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 10 8">
                    <path
                      d="M1 4l3 3 5-6"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>

              {/* Text */}
              <span
                className={`flex-1 text-sm leading-relaxed transition-all ${
                  task.completed
                    ? 'line-through text-stone-300'
                    : 'text-stone-700'
                }`}
              >
                {task.text}
              </span>

              {/* Delete */}
              <button
                onClick={() => deleteTask(task.id)}
                aria-label="削除"
                className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-lg text-stone-200 hover:text-red-400 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 14 14">
                  <path
                    d="M1 1l12 12M13 1L1 13"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>

        {/* Clear done */}
        {doneCount > 0 && (
          <div className="mt-4 text-right">
            <button
              onClick={() => {
                const next = tasks.filter((t) => !t.completed)
                setTasks(next)
                saveTasks(next)
              }}
              className="text-xs text-stone-300 hover:text-red-400 transition-colors"
            >
              完了済みを削除 ({doneCount})
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
