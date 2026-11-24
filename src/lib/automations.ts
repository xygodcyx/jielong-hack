import type { CheckinPlan, DailyCheckin } from '../automation-shared.ts'
import type { Draft, FormSchema, JsonObject } from '../shared.ts'
import type { Session } from './store.ts'
import { createHash } from 'node:crypto'
import { blankValue } from '../shared.ts'
import { api, AppError } from './api.ts'
import { automationAccount, dailyCheckin, editableRun, getPlan, insertDailyCheckin, invalidateAutomationAccount, plans, recentCheckins, saveAutomationAccount, savePlan, updateDailyCheckin } from './automation-store.ts'
import { beijingDate, closingAt, offsetDate, scheduledAt, validTime } from './checkin-calendar.ts'
import { ownCheckin } from './checkin-records.ts'
import { demoSchema } from './demo.ts'
import { createPayload, loadSchema, validateDraft } from './forms.ts'
import { mailSettings, queueNotice, siteUrl, validEmail } from './mail.ts'
import { resolveFiles, validateMedia } from './media.ts'
import { addHistory, getMedia, saveMedia } from './store.ts'

const terminal = new Set([
  'success',
  'failed',
  'unknown',
  'missed',
])
function publicForm(schema: FormSchema & { base?: JsonObject }) {
  const { base: _, ...form } = schema
  return form
}
export function formHash(schema: FormSchema) {
  return createHash('sha256').update(JSON.stringify({
    fields: schema.fields,
    fixedValues: schema.values.filter(value => schema.fields.some(field => field.Id === value.FieldId && (field.IsDisabled || field.IsFixed))),
    requireNumber: schema.requireNumber,
    requireSignature: schema.requireSignature,
    needPrivacy: schema.needPrivacy,
    uploadConfig: schema.uploadConfig,
  })).digest('hex')
}
export const automationMediaOwner = (owner: string) => `automation:${owner}`
function optionalRecipient(value: unknown) {
  try {
    return validEmail(value)
  }
  catch {
    return ''
  }
}
export interface AutomationDependencies {
  now: () => number
  load: typeof loadSchema
  find: typeof ownCheckin
  files: typeof resolveFiles
  submit: (token: string, form: FormSchema, draft: Draft) => Promise<JsonObject>
}
const defaults: AutomationDependencies = {
  now: Date.now,
  load: loadSchema,
  find: ownCheckin,
  files: resolveFiles,
  submit: (token, form, draft) => api(form.endpoint, token, createPayload(form, draft)),
}

export class AutomationService {
  private busy = false
  private dependencies: AutomationDependencies
  constructor(dependencies: Partial<AutomationDependencies> = {}) {
    this.dependencies = {
      ...defaults,
      ...dependencies,
    }
  }

  private load(account: Session, id: string) {
    return account.demo
      ? Promise.resolve(demoSchema(id))
      : this.dependencies.load(account.token!, id)
  }

  private notice(plan: CheckinPlan, key: string, title: string, lines: string[]) {
    // 邮箱及 SMTP 均为可选；配置不完整时只保留站内状态。
    if (!plan.demo && plan.recipient && mailSettings().configured) {
      queueNotice(key, plan.owner, plan.recipient, {
        subject: `【接龙工作台】${title}`,
        title,
        lines,
        actionLabel: title.includes('登录')
          ? '扫码恢复登录'
          : '查看签到与待办',
        actionUrl: `${siteUrl()}/?automation=1`,
      }, this.dependencies.now())
    }
  }

  async registerLogin(owner: string, session: Session) {
    const old = automationAccount(owner)
    saveAutomationAccount(owner, session, true)
    if (old?.token !== session.token || old?.expire !== session.expire) {
      for (const plan of plans(owner).filter(p => p.enabled)) {
        this.notice(plan, `login:${owner}:${session.expire}:${plan.recipient}`, '微信登录已恢复', [
          '已保存此次扫码返回的登录凭证，循环签到继续运行。',
          `本次登录有效期至：${new Date(session.expire).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）。`,
          '若今天已到签到时间且尚未到 23:00，会核对今日记录后补交；不会补交往日记录。',
        ])
      }
    }
  }

  async create(owner: string, session: Session, threadId: string) {
    const existing = plans(owner).find(plan => plan.thread.id === threadId)
    if (existing)
      return existing
    if (plans(owner).length >= 50)
      throw new AppError('最多保存 50 个自动签到计划。')
    const form = await this.load(session, threadId)
    if (form.thread.type !== 5)
      throw new AppError('循环自动签到目前适用于周期打卡任务。', 422)
    saveAutomationAccount(owner, session)
    const now = this.dependencies.now()
    const plan: CheckinPlan = {
      id: crypto.randomUUID(),
      owner,
      thread: form.thread,
      schema: publicForm(form),
      time: '18:00',
      recipient: optionalRecipient(mailSettings().defaultRecipient),
      enabled: false,
      demo: !!session.demo,
      privacyHash: '',
      createdAt: now,
      updatedAt: now,
    }
    savePlan(plan)
    return plan
  }

  async ensureDaily(plan: CheckinPlan, date: string): Promise<DailyCheckin> {
    const existing = dailyCheckin(plan.id, date)
    if (existing)
      return existing
    const account = automationAccount(plan.owner)
    if (!account || (!account.demo && (!account.token || account.expire <= this.dependencies.now())))
      throw new AppError('登录已过期，请重新微信扫码后编辑待签到内容。', 401, 'AUTH_REQUIRED')
    const schema = publicForm(await this.load(account, plan.thread.id))
    const yesterday = offsetDate(date, -1)
    const record = account.demo
      ? null
      : await this.dependencies.find(account.token!, plan.thread.id, yesterday)
    const previous = dailyCheckin(plan.id, yesterday)
    const source: Draft | null = record
      ? {
          signature: String(record.Signature || schema.signature),
          number: String(record.Number || ''),
          values: record.RecordValues,
        }
      : previous?.status === 'success'
        ? previous.draft
        : null
    const values = schema.fields.map((field) => {
      const original = source?.values.find(value => value.FieldId === field.Id)
      return structuredClone(!field.IsDisabled && !field.IsFixed && original && (original.FieldType == null || original.FieldType === field.FieldType)
        ? original
        : schema.values.find(value => value.FieldId === field.Id) || blankValue(field))
    })
    // 只有服务器读取的本人昨日附件才成为这份新待办的附件白名单。
    schema.values = structuredClone(values)
    return insertDailyCheckin({
      planId: plan.id,
      date,
      schema,
      draft: { signature: source?.signature || schema.signature, number: source?.number || schema.number, values },
      source: source ? 'yesterday' : 'empty',
      sourceDate: source ? yesterday : '',
      status: 'ready',
      message: source
        ? `已复制 ${yesterday} 的本人签到内容。`
        : '昨天没有本人签到记录，请先填写内容。',
      revision: 1,
      privacyAgreed: plan.privacyHash === formHash(schema),
    })
  }

  async editableDaily(plan: CheckinPlan, requestedDate?: string) {
    const today = beijingDate(this.dependencies.now())
    let date = requestedDate || today
    if (!requestedDate && (this.dependencies.now() >= closingAt(today) || terminal.has(dailyCheckin(plan.id, today)?.status || '')))
      date = offsetDate(today, 1)
    if (![
      today,
      offsetDate(today, 1),
    ].includes(date)) {
      throw new AppError('只能编辑今天或明天的待签到内容。')
    }
    const run = await this.ensureDaily(plan, date)
    return { run, editable: editableRun(run) && this.dependencies.now() < closingAt(date) }
  }

  private retainFiles(owner: string, sessionId: string, run: DailyCheckin, draft: Draft) {
    const mediaOwner = automationMediaOwner(owner)
    for (const value of draft.values) {
      const field = run.schema.fields.find(field => field.Id === value.FieldId)!
      const originals = [
        ...(run.schema.values.find(v => v.FieldId === field.Id)?.Files || []),
        ...(run.draft.values.find(v => v.FieldId === field.Id)?.Files || []),
      ]
      for (const [index, file] of value.Files.entries()) {
        if (file.LocalId) {
          const media = getMedia(mediaOwner, String(file.LocalId)) || getMedia(sessionId, String(file.LocalId))
          if (!media)
            throw new AppError('待办附件已失效，请重新上传。')
          validateMedia(media, field, run.schema)
          if (getMedia(mediaOwner, String(file.LocalId))) {
            value.Files[index] = { ...file, LocalId: media.id, Url: `/api/automation-media/${media.id}` }
          }
          else {
            const id = crypto.randomUUID()
            const stable = { ...media, id, url: `/api/automation-media/${id}` }
            saveMedia(mediaOwner, id, stable)
            value.Files[index] = {
              LocalId: id,
              Url: stable.url,
              Name: media.name,
              FileName: media.name,
              MediaType: media.mediaType,
              Size: media.size,
            }
          }
        }
        else {
          const original = originals.find(original => !original.LocalId && original.RelativePath && original.RelativePath === file.RelativePath && original.TenantTypeId === file.TenantTypeId)
          if (!original)
            throw new AppError('附件不属于这份本人待办，请重新上传。')
          value.Files[index] = structuredClone(original)
        }
      }
    }
    return draft
  }

  async save(owner: string, session: Session, planId: string, date: string, body: JsonObject) {
    const plan = getPlan(planId, owner)
    const { run, editable } = await this.editableDaily(plan, date)
    if (!editable)
      throw new AppError('这份待办正在执行或已经处理，请编辑下一次签到。', 409)
    if (body.revision !== run.revision)
      throw new AppError('待办已被更新，请刷新后重试。', 409)
    const fresh = publicForm(await this.load(session, plan.thread.id))
    if (formHash(fresh) !== formHash(run.schema))
      throw new AppError('原任务的字段已变化，请刷新待办，核对新的表单后再保存。', 409, 'SCHEMA_CHANGED')
    if (fresh.needPrivacy && body.privacyAgreed !== true)
      throw new AppError('请先确认原任务的个人信息使用说明。')
    const time = validTime(body.time ?? plan.time)
    const draft = validateDraft({ ...run.schema, canSubmit: true }, body.draft)
    this.retainFiles(owner, session.id, run, draft)
    const enabled = body.enabled === undefined
      ? plan.enabled
      : body.enabled === true
    if (date === beijingDate(this.dependencies.now()) && this.dependencies.now() >= closingAt(date))
      throw new AppError('今天的补交时间已结束，请编辑明天的待办。', 409)
    const updated = updateDailyCheckin({
      ...run,
      draft,
      source: 'edited',
      status: 'ready',
      message: '已保存待签到内容。',
      privacyAgreed: !fresh.needPrivacy || body.privacyAgreed === true,
      nextCheckAt: 0,
    })
    savePlan({
      ...plan,
      time,
      recipient: optionalRecipient(body.recipient ?? plan.recipient),
      enabled,
      schema: fresh,
      thread: fresh.thread,
      privacyHash: formHash(fresh),
      updatedAt: this.dependencies.now(),
    })
    saveAutomationAccount(owner, session)
    return updated
  }

  async toggle(owner: string, id: string, enabled: boolean) {
    const plan = getPlan(id, owner)
    if (enabled) {
      const { run } = await this.editableDaily(plan)
      validateDraft({ ...run.schema, canSubmit: true }, run.draft)
      if (run.schema.needPrivacy && !run.privacyAgreed)
        throw new AppError('请先编辑待办并确认个人信息使用说明。')
    }
    savePlan({
      ...plan,
      enabled,
      updatedAt: this.dependencies.now(),
    })
    return getPlan(id, owner)
  }

  async refresh(owner: string, session: Session, id: string, date: string, revision: number) {
    const plan = getPlan(id, owner)
    const { run, editable } = await this.editableDaily(plan, date)
    if (!editable || revision !== run.revision)
      throw new AppError('待办已开始执行或已更新，请重新打开。', 409)
    const schema = publicForm(await this.load(session, plan.thread.id))
    const values = schema.fields.map((field) => {
      const value = run.draft.values.find(value => value.FieldId === field.Id)
      const oldField = run.schema.fields.find(old => old.Id === field.Id)
      return structuredClone(!field.IsDisabled && !field.IsFixed && oldField?.FieldType === field.FieldType && value
        ? value
        : schema.values.find(value => value.FieldId === field.Id) || blankValue(field))
    })
    schema.values = structuredClone(values)
    return updateDailyCheckin({
      ...run,
      schema,
      draft: { ...run.draft, values },
      status: 'ready',
      message: '表单结构已更新，请核对字段并保存。',
      privacyAgreed: !schema.needPrivacy || plan.privacyHash === formHash(schema),
      nextCheckAt: 0,
    })
  }

  list(owner: string) {
    const today = beijingDate(this.dependencies.now())
    return plans(owner).map(({ schema: _, owner: __, privacyHash: ___, ...plan }) => ({
      ...plan,
      today: dailyCheckin(plan.id, today),
      recent: recentCheckins(plan.id).map(({ draft: _, schema: __, ...run }) => run),
      loginExpired: !plan.demo && (automationAccount(owner)?.expire || 0) <= this.dependencies.now(),
      emailEnabled: !plan.demo && !!plan.recipient && mailSettings().configured,
    }))
  }

  private finish(plan: CheckinPlan, run: DailyCheckin, status: DailyCheckin['status'], message: string) {
    const done = updateDailyCheckin({
      ...run,
      status,
      message,
      finishedAt: this.dependencies.now(),
    })
    addHistory(automationMediaOwner(plan.owner), {
      threadId: plan.thread.id,
      title: plan.thread.title,
      signature: run.draft.signature,
      status,
      message,
      demo: plan.demo,
      date: run.date,
      automatic: true,
    })
    this.notice(plan, `result:${plan.id}:${run.date}`, status === 'success'
      ? '今日签到已完成'
      : '今日签到需要处理', [plan.thread.title, `签到日期：${run.date}（北京时间）`, message])
    return done
  }

  private needsLogin(plan: CheckinPlan, run?: DailyCheckin) {
    const account = automationAccount(plan.owner)
    if (run && run.status !== 'needs_login')
      updateDailyCheckin({ ...run, status: 'needs_login', message: '登录已失效，请在工作台重新微信扫码；23:00 前恢复可补交当天。' })
    this.notice(plan, `expired:${plan.owner}:${account?.token
      ? createHash('sha256').update(account.token).digest('hex').slice(0, 20)
      : 'missing'}:${plan.recipient}`, '微信登录已过期', [plan.thread.title, '循环签到正在等待重新登录。请打开工作台，使用原微信账号扫码。', '恢复登录后，仅在签到时间至当天 23:00 之间核对并补交今日记录；不会补交往日记录。'])
  }

  private async execute(plan: CheckinPlan, now: number) {
    const date = beijingDate(now)
    let run = dailyCheckin(plan.id, date)
    if (run && terminal.has(run.status))
      return
    if (now >= closingAt(date)) {
      if (run && !run.submittedAt)
        this.finish(plan, run, 'missed', '已超过当天 23:00，保留记录，不自动补交往日签到。')
      return
    }
    const account = automationAccount(plan.owner)
    if (!account || (!plan.demo && (!account.token || account.expire <= now))) {
      this.needsLogin(plan, run || undefined)
      return
    }
    try {
      run ||= await this.ensureDaily(plan, date)
      if (now < scheduledAt(date, plan.time) || (run.nextCheckAt || 0) > now)
        return
      if (!['ready', 'waiting', 'needs_login'].includes(run.status))
        return
      run = updateDailyCheckin({ ...run, status: 'checking', message: '正在核对今日记录与当前表单。' })
      const existing = plan.demo
        ? null
        : await this.dependencies.find(account.token!, plan.thread.id, date)
      if (existing) {
        this.finish(plan, run, 'success', '接龙管家已有本人今日记录，本次无需重复提交。')
        return
      }
      const form = publicForm(await this.load(account, plan.thread.id))
      if (form.thread.status === 'closed') {
        savePlan({
          ...getPlan(plan.id),
          enabled: false,
        })
        this.finish(plan, run, 'failed', '任务已结束，循环签到已停止。')
        return
      }
      if (formHash(form) !== formHash(run.schema))
        throw new AppError('原任务表单已变化，请在网站更新待办后继续。', 409, 'SCHEMA_CHANGED')
      if (!form.canSubmit) {
        updateDailyCheckin({
          ...run,
          status: 'waiting',
          message: form.unavailableReason,
          nextCheckAt: now + 300000,
        })
        return
      }
      if (form.needPrivacy && !run.privacyAgreed)
        throw new AppError('原任务需要确认个人信息使用说明，请编辑待办。')
      const outgoing = validateDraft({ ...form, values: run.schema.values }, structuredClone(run.draft))
      await this.dependencies.files(automationMediaOwner(plan.owner), account.token || '', { ...form, values: run.schema.values }, outgoing, plan.demo)
      // 附件处理期间可能暂停、跨日或超过补交时段；在真正提交之前再次检查。
      if (!getPlan(plan.id).enabled) {
        updateDailyCheckin({ ...run, status: 'ready', message: '循环签到已暂停。' })
        return
      }
      const current = this.dependencies.now()
      if (beijingDate(current) !== date || current >= closingAt(date)) {
        this.finish(plan, run, 'missed', '已超过当天补交时间，本次未提交。')
        return
      }
      const latest = plan.demo
        ? null
        : await this.dependencies.find(account.token!, plan.thread.id, date)
      if (latest) {
        this.finish(plan, run, 'success', '附件处理期间已完成今日签到，本次无需重复提交。')
        return
      }
      if (!getPlan(plan.id).enabled || beijingDate(this.dependencies.now()) !== date || this.dependencies.now() >= closingAt(date)) {
        updateDailyCheckin({ ...run, status: 'ready', message: '提交前已暂停或超过当天时段，本次未提交。' })
        return
      }
      // 先持久化“已发起”标记。服务中断或网络结果不明时，绝不盲目重发。
      run = updateDailyCheckin({
        ...run,
        draft: outgoing,
        submittedAt: current,
        status: 'submitting',
        message: '正在提交今日签到。',
      })
      const result = plan.demo
        ? { Description: '演示自动签到已完成，未发送真实表单或邮件。' }
        : await this.dependencies.submit(account.token!, form, outgoing)
      this.finish(plan, run, 'success', String(result.Description || '接龙管家已确认提交成功。'))
    }
    catch (error) {
      if (error instanceof AppError && error.code === 'AUTH_REQUIRED') {
        invalidateAutomationAccount(plan.owner, account.token)
        if (run?.submittedAt)
          this.finish(plan, run, 'failed', '接龙管家拒绝了已失效的登录，请重新扫码并核对今日记录。')
        this.needsLogin(plan, run?.submittedAt
          ? undefined
          : run || undefined)
      }
      else if (run) {
        const uncertain = !!run.submittedAt && !(error instanceof AppError && error.code === 'UPSTREAM_ERROR')
        this.finish(plan, run, uncertain ? 'unknown' : 'failed', uncertain ? '提交结果未确认，请先在官网核对，系统不会自动重复提交。' : (error as Error).message)
      }
      else {
        // 连待办都未创建时保留可见状态，避免下次 tick 重复轰击上游接口。
        const failed = insertDailyCheckin({
          planId: plan.id,
          date,
          schema: plan.schema,
          draft: { signature: '', number: '', values: plan.schema.values },
          source: 'empty',
          sourceDate: '',
          status: 'ready',
          revision: 1,
          privacyAgreed: false,
          message: '',
        })
        this.finish(plan, failed, 'failed', (error as Error).message)
      }
    }
  }

  async tick() {
    if (this.busy)
      return
    this.busy = true
    try {
      for (const plan of plans().filter(plan => plan.enabled)) {
        for (const old of recentCheckins(plan.id).filter(run => run.date < beijingDate(this.dependencies.now()) && !terminal.has(run.status))) {
          updateDailyCheckin({
            ...old,
            status: old.submittedAt ? 'unknown' : 'missed',
            message: old.submittedAt ? '往日提交结果待核实，不自动重发。' : '已错过当天签到，不补交往日记录。',
            finishedAt: this.dependencies.now(),
          })
        }
        await this.execute(plan, this.dependencies.now())
      }
    }
    finally {
      this.busy = false
    }
  }
}

export const automations = new AutomationService()
