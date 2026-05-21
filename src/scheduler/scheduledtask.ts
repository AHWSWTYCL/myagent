export type ScheduledTaskType = 'once' | 'cron'
export type ScheduledTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface ScheduledTask {
  id: string
  type: ScheduledTaskType
  prompt: string

  // once: absolute fire time
  run_at?: string

  // cron: expression + next computed fire time
  cron?: string
  next_run_at?: string

  status: ScheduledTaskStatus
  run_count: number
  last_run_at?: string
  result?: string

  // once only: delete the file after successful completion (default: true)
  auto_delete: boolean

  created_at: string
  updated_at: string
}
