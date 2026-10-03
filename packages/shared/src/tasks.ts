/** 后台任务（关系图生成、LibreOffice 转换等）的状态模型。 */

export type TaskState = 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

export interface TaskProgress {
  taskId: string
  kind: 'graph-generate' | 'convert' | 'agent-prompt' | 'import'
  label: string
  state: TaskState
  /** 0..1，未知时为 null */
  ratio: number | null
  detail: string
  done: number
  total: number
  startedAt: number
  finishedAt: number | null
  error: string | null
}

export function createTaskProgress(partial: Partial<TaskProgress> & { taskId: string; kind: TaskProgress['kind']; label: string }): TaskProgress {
  return {
    state: 'pending',
    ratio: null,
    detail: '',
    done: 0,
    total: 0,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    ...partial
  }
}
