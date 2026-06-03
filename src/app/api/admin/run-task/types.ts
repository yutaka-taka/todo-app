export type TaskKey = 'weekly_update' | 'weekly_prefetch' | 'ml_dataset' | 'ml_retrain'

export interface TaskStatus {
  running: boolean
  pid?: number
  startedAt?: string
  finishedAt?: string
  exitCode?: number | null
  lastLines: string[]
}
