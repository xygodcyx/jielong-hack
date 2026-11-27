import type { CheckinPlan, DailyCheckin, RunStatus } from '../automation-shared.ts'
import type { Session } from './store.ts'
import { AppError } from './api.ts'
import { db } from './store.ts'

db.exec(`CREATE TABLE IF NOT EXISTS automation_accounts (owner TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS checkin_plans (id TEXT PRIMARY KEY, owner TEXT NOT NULL, thread_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(owner,thread_id));
  CREATE TABLE IF NOT EXISTS daily_checkins (plan_id TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(plan_id,date));`)

export function automationAccount(owner: string): Session | null {
  const row = db.prepare('SELECT data FROM automation_accounts WHERE owner=?').get(owner) as { data: string } | null
  return row
    ? JSON.parse(row.data)
    : null
}
export function saveAutomationAccount(owner: string, session: Session, force = false) {
  const old = automationAccount(owner)
  // 普通待办保存不能用请求开始时的旧快照覆盖其他设备刚扫码的凭证。
  if (!force && old)
    return
  const { login: _, ...safe } = session
  db.prepare('INSERT OR REPLACE INTO automation_accounts VALUES (?,?)').run(owner, JSON.stringify(safe))
}
export function invalidateAutomationAccount(owner: string, token?: string) {
  const account = automationAccount(owner)
  if (account && account.token === token)
    saveAutomationAccount(owner, { ...account, expire: 0 }, true)
}
export function plans(owner?: string): CheckinPlan[] {
  const rows = owner
    ? db.prepare('SELECT data FROM checkin_plans WHERE owner=? ORDER BY rowid DESC').all(owner)
    : db.prepare('SELECT data FROM checkin_plans ORDER BY rowid').all()
  return (rows as { data: string }[]).map(row => JSON.parse(row.data))
}
export function getPlan(id: string, owner?: string): CheckinPlan {
  const row = db.prepare('SELECT owner,data FROM checkin_plans WHERE id=?').get(id) as { data: string, owner: string } | null
  if (!row || (owner && owner !== row.owner))
    throw new AppError('自动签到计划不存在。', 404)
  return JSON.parse(row.data)
}
export function savePlan(plan: CheckinPlan) {
  db.prepare('INSERT INTO checkin_plans VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
    .run(plan.id, plan.owner, plan.thread.id, JSON.stringify(plan))
}
export function dailyCheckin(planId: string, date: string): DailyCheckin | null {
  const row = db.prepare('SELECT data FROM daily_checkins WHERE plan_id=? AND date=?').get(planId, date) as { data: string } | null
  return row
    ? JSON.parse(row.data)
    : null
}
export function insertDailyCheckin(run: DailyCheckin) {
  db.prepare('INSERT OR IGNORE INTO daily_checkins VALUES (?,?,?,?,?)').run(run.planId, run.date, JSON.stringify(run), run.status, run.revision)
  return dailyCheckin(run.planId, run.date)!
}
export function updateDailyCheckin(run: DailyCheckin, expectedRevision = run.revision) {
  const updated = { ...run, revision: expectedRevision + 1 }
  const result = db.prepare('UPDATE daily_checkins SET data=?,status=?,revision=? WHERE plan_id=? AND date=? AND revision=?')
    .run(JSON.stringify(updated), updated.status, updated.revision, run.planId, run.date, expectedRevision)
  if (!result.changes)
    throw new AppError('这份待签到内容已被更新，请刷新后再编辑。', 409)
  return updated
}
export function recentCheckins(planId: string) {
  return (db.prepare('SELECT data FROM daily_checkins WHERE plan_id=? ORDER BY date DESC LIMIT 14').all(planId) as { data: string }[]).map(row => JSON.parse(row.data) as DailyCheckin)
}
export const editableStatuses: RunStatus[] = [
  'ready',
  'waiting',
  'needs_login',
  'failed',
]
export function editableRun(run: DailyCheckin) {
  return editableStatuses.includes(run.status) && !run.submittedAt
}
export function recoverInterruptedCheckins(now = Date.now()) {
  const rows = db.prepare('SELECT data FROM daily_checkins WHERE status IN (\'checking\',\'submitting\')').all() as { data: string }[]
  for (const row of rows) {
    const run: DailyCheckin = JSON.parse(row.data)
    run.status = run.submittedAt ? 'unknown' : 'ready'
    run.message = run.submittedAt ? '提交过程中服务重启，结果待核实；请查看官网记录。' : '核对过程中服务重启，待下次检查。'
    if (run.submittedAt)
      run.finishedAt = now
    updateDailyCheckin(run)
  }
}
