import type { Draft, FormSchema, Thread } from './shared.ts'

export type RunStatus = 'ready' | 'checking' | 'waiting' | 'needs_login' | 'submitting' | 'success' | 'failed' | 'unknown' | 'missed'
export interface CheckinPlan {
  id: string
  owner: string
  thread: Thread
  schema: FormSchema
  time: string
  recipient: string
  enabled: boolean
  demo: boolean
  privacyHash: string
  createdAt: number
  updatedAt: number
}
export interface DailyCheckin {
  planId: string
  date: string
  schema: FormSchema
  draft: Draft
  source: 'yesterday' | 'empty' | 'edited'
  sourceDate: string
  status: RunStatus
  message: string
  revision: number
  privacyAgreed: boolean
  submittedAt?: number
  finishedAt?: number
  nextCheckAt?: number
}
export const runLabels: Record<RunStatus, string> = {
  ready: '待签到',
  checking: '正在核对',
  waiting: '等待开放',
  needs_login: '等待扫码续期',
  submitting: '正在提交',
  success: '已完成',
  failed: '签到失败',
  unknown: '结果待核实',
  missed: '已错过当天',
}
