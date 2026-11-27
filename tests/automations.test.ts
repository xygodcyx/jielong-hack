import type { AutomationDependencies } from '../src/lib/automations.ts'
import type { Session } from '../src/lib/store.ts'
import type { JsonObject } from '../src/shared.ts'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'
import { AppError } from '../src/lib/api.ts'
import { automationAccount, dailyCheckin, getPlan, plans, recoverInterruptedCheckins, saveAutomationAccount, savePlan, updateDailyCheckin } from '../src/lib/automation-store.ts'
import { automationMediaOwner, AutomationService } from '../src/lib/automations.ts'
import { beijingDate, closingAt, offsetDate, recordDate, scheduledAt, validTime } from '../src/lib/checkin-calendar.ts'
import { demoSchema } from '../src/lib/demo.ts'
import { mailHistory } from '../src/lib/mail.ts'
import { db, getMedia, saveMedia } from '../src/lib/store.ts'

const stamp = (time: string) => Date.parse(`2026-11-24T${time}:00+08:00`)
afterEach(() => {
  for (const plan of plans())
    savePlan({ ...plan, enabled: false })
  db.prepare('DELETE FROM mail_outbox WHERE owner LIKE \'test-automation:%\'').run()
})
async function fixture(overrides: Partial<AutomationDependencies> = {}) {
  let now = stamp('17:00')
  let submissions = 0
  const owner = `test-automation:${crypto.randomUUID()}`
  const session: Session = {
    id: crypto.randomUUID(),
    token: `Bearer fixture-${owner}`,
    expire: now + 72 * 3600000,
    accountKey: owner,
  }
  const schema = demoSchema('demo-checkin')
  schema.thread.id = '123456'
  const record: JsonObject = {
    Id: '9007199254740993123',
    IsCurrentUser: true,
    CheckInTarget: '2026-11-23',
    Signature: '昨日署名',
    Number: '',
    RecordValues: structuredClone(schema.values),
  }
  record.RecordValues[0].Texts = ['昨天的阅读内容']
  record.RecordValues[1].Texts = [45]
  const dependencies: AutomationDependencies = {
    now: () => now,
    load: async () => structuredClone(schema),
    find: async (_token, _thread, date) => date === '2026-11-23'
      ? structuredClone(record)
      : null,
    files: async (_owner, _token, _schema, draft) => draft,
    submit: async () => {
      submissions++
      return { Description: 'fixture success' }
    },
    ...overrides,
  }
  const service = new AutomationService(dependencies)
  const plan = await service.create(owner, session, schema.thread.id)
  const run = await service.ensureDaily(plan, '2026-11-24')
  const enable = () => service.save(owner, session, plan.id, run.date, {
    revision: dailyCheckin(plan.id, run.date)!.revision,
    draft: structuredClone(run.draft),
    enabled: true,
    time: '18:00',
    recipient: '',
  })
  return {
    service,
    dependencies,
    owner,
    session,
    schema,
    record,
    plan,
    run,
    enable,
    clock: (time: number) => { now = time },
    submissions: () => submissions,
  }
}

it('北京时间日期、午夜换日、昨日与补交截止不受服务器时区影响', () => {
  expect(beijingDate(Date.parse('2026-11-24T16:00:00Z'))).toBe('2026-11-25')
  expect(offsetDate('2026-03-01', -1)).toBe('2026-02-28')
  expect(scheduledAt('2026-11-24', '18:00')).toBe(stamp('18:00'))
  expect(closingAt('2026-11-24')).toBe(stamp('23:00'))
  expect(recordDate({ CheckInTarget: '2026-11-24T00:00:00' })).toBe('2026-11-24')
  expect(recordDate({ DateCreated: '2026-11-23T17:00:00Z' })).toBe('2026-11-24')
  expect(() => validTime('23:00')).toThrow()
  expect(() => validTime('8:00')).toThrow()
})

it('默认精确复制本人昨日内容，编辑待办不修改历史；到点提交一次且重建调度器不重复', async () => {
  const f = await fixture()
  expect(f.run.sourceDate).toBe('2026-11-23')
  expect(f.run.draft.values[0].Texts).toEqual(['昨天的阅读内容'])
  await f.service.tick()
  expect(f.submissions()).toBe(0)
  f.run.draft.values[0].Texts = ['今天修改后的内容']
  await f.enable()
  expect(f.record.RecordValues[0].Texts).toEqual(['昨天的阅读内容'])
  await f.service.tick()
  expect(f.submissions()).toBe(0)
  f.clock(stamp('18:00'))
  await Promise.all([
    f.service.tick(),
    f.service.tick(),
  ])
  expect(f.submissions()).toBe(1)
  expect(dailyCheckin(f.plan.id, f.run.date)?.status).toBe('success')
  await new AutomationService(f.dependencies).tick()
  expect(f.submissions()).toBe(1)
  expect(mailHistory(f.owner)).toHaveLength(0)
})

it('无昨日记录时保留空表单，必填未完成不能启动；不退回更早记录', async () => {
  const f = await fixture({
    find: async () => null,
  })
  expect(f.run.source).toBe('empty')
  await expect(f.enable()).rejects.toThrow('请填写')
  expect(getPlan(f.plan.id).enabled).toBe(false)
})

it('未填写邮箱或邮箱配置不完整仍可启动，站内保留结果', async () => {
  const f = await fixture()
  await f.service.save(f.owner, f.session, f.plan.id, f.run.date, {
    revision: f.run.revision,
    draft: f.run.draft,
    enabled: true,
    recipient: '未填写完整@',
  })
  expect(getPlan(f.plan.id).enabled).toBe(true)
  expect(getPlan(f.plan.id).recipient).toBe('')
  f.clock(stamp('18:05'))
  await f.service.tick()
  expect(f.submissions()).toBe(1)
  expect(mailHistory(f.owner)).toHaveLength(0)
})

it('今日已签到则仅记录已完成，不重复提交', async () => {
  const f = await fixture()
  f.dependencies.find = async (_token, _id, date) => date === f.run.date
    ? { Id: 'today' }
    : f.record
  const service = new AutomationService(f.dependencies)
  await f.enable()
  f.clock(stamp('18:00'))
  await service.tick()
  expect(f.submissions()).toBe(0)
  expect(dailyCheckin(f.plan.id, f.run.date)?.message).toContain('无需重复提交')
})

it('登录失效等待续期，恢复同一账号后仅补交当天；过 23:00 和往日不补交', async () => {
  const f = await fixture()
  await f.enable()
  saveAutomationAccount(f.owner, {
    ...f.session,
    expire: stamp('17:30'),
  }, true)
  f.clock(stamp('18:00'))
  await f.service.tick()
  expect(dailyCheckin(f.plan.id, f.run.date)?.status).toBe('needs_login')
  expect(f.submissions()).toBe(0)
  f.clock(stamp('19:00'))
  await f.service.registerLogin(f.owner, {
    ...f.session,
    token: 'Bearer renewed',
    expire: stamp('22:59'),
  })
  await f.service.tick()
  expect(f.submissions()).toBe(1)
  expect(automationAccount(f.owner)?.token).toBe('Bearer renewed')

  const late = await fixture()
  await late.enable()
  late.clock(stamp('23:00'))
  await late.service.registerLogin(late.owner, late.session)
  await late.service.tick()
  expect(late.submissions()).toBe(0)
  expect(dailyCheckin(late.plan.id, late.run.date)?.status).toBe('missed')
  late.clock(Date.parse('2026-11-25T17:00:00+08:00'))
  await late.service.tick()
  expect(late.submissions()).toBe(0)
})

it('网络结果不明和服务提交中重启都不自动重发', async () => {
  let calls = 0
  const f = await fixture({
    submit: async () => {
      calls++
      throw new AppError('fixture network error', 502, 'NETWORK_ERROR')
    },
  })
  await f.enable()
  f.clock(stamp('18:00'))
  await f.service.tick()
  expect(dailyCheckin(f.plan.id, f.run.date)?.status).toBe('unknown')
  await new AutomationService(f.dependencies).tick()
  expect(calls).toBe(1)
  const interrupted = await fixture()
  await interrupted.enable()
  updateDailyCheckin({
    ...dailyCheckin(interrupted.plan.id, interrupted.run.date)!,
    status: 'submitting',
    submittedAt: stamp('18:00'),
  })
  recoverInterruptedCheckins()
  expect(dailyCheckin(interrupted.plan.id, interrupted.run.date)?.status).toBe('unknown')
  interrupted.clock(stamp('18:30'))
  await interrupted.service.tick()
  expect(interrupted.submissions()).toBe(0)
})

it('并发编辑使用版本校验，账号隔离，已开始提交后拒绝覆盖待办', async () => {
  const f = await fixture()
  await f.enable()
  await expect(f.service.save(f.owner, f.session, f.plan.id, f.run.date, { revision: 1, draft: f.run.draft })).rejects.toThrow('待办已被更新')
  await expect(f.service.toggle('other-account', f.plan.id, true)).rejects.toThrow('不存在')
  f.clock(stamp('18:00'))
  await f.service.tick()
  await expect(f.service.save(f.owner, f.session, f.plan.id, f.run.date, { revision: 3, draft: f.run.draft })).rejects.toThrow('已经处理')
})

it('上传期间暂停或跨日，不发送最终表单；原任务暂未开放时等待而不提交', async () => {
  const f = await fixture()
  await f.enable()
  f.dependencies.files = async (_owner, _token, _form, draft) => {
    savePlan({
      ...getPlan(f.plan.id),
      enabled: false,
    })
    return draft
  }
  f.clock(stamp('18:00'))
  await new AutomationService(f.dependencies).tick()
  expect(f.submissions()).toBe(0)
  expect(dailyCheckin(f.plan.id, f.run.date)?.status).toBe('ready')
  const closed = await fixture()
  await closed.enable()
  closed.schema.canSubmit = false
  closed.schema.unavailableReason = '尚未开放'
  closed.clock(stamp('18:00'))
  await closed.service.tick()
  expect(closed.submissions()).toBe(0)
  expect(dailyCheckin(closed.plan.id, closed.run.date)?.status).toBe('waiting')
})

it('附件绑定账号持久化，换登录会话仍可使用；拒绝借用其他账号附件', async () => {
  const f = await fixture()
  const id = crypto.randomUUID()
  saveMedia(f.session.id, id, {
    id,
    name: 'photo.jpg',
    path: '/tmp/fixture',
    size: 100,
    mediaType: 1,
    width: 10,
    height: 10,
    mime: 'image/jpeg',
  })
  f.run.draft.values[2].Files = [
    { LocalId: id },
  ]
  await f.enable()
  const retained = dailyCheckin(f.plan.id, f.run.date)!.draft.values[2].Files[0]
  expect(retained.LocalId).not.toBe(id)
  expect(getMedia(automationMediaOwner(f.owner), retained.LocalId)).not.toBeNull()
  await f.service.save(f.owner, {
    ...f.session,
    id: crypto.randomUUID(),
  }, f.plan.id, f.run.date, { revision: 2, draft: dailyCheckin(f.plan.id, f.run.date)!.draft })
  const other = await fixture()
  other.run.draft.values[2].Files = [retained]
  await expect(other.enable()).rejects.toThrow('附件已失效')
})

it('登录失效邮件按凭证去重，重新登录通知与结果通知各一次', async () => {
  const previous = { host: process.env.SMTP_HOST, user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  process.env.SMTP_HOST = 'fixture.invalid'
  process.env.SMTP_USER = 'fixture@example.com'
  process.env.SMTP_PASS = 'fixture-not-a-secret'
  try {
    const f = await fixture()
    await f.enable()
    savePlan({
      ...getPlan(f.plan.id),
      recipient: 'fixture@example.com',
    })
    saveAutomationAccount(f.owner, {
      ...f.session,
      expire: stamp('17:30'),
    }, true)
    f.clock(stamp('18:00'))
    await f.service.tick()
    await f.service.tick()
    expect(mailHistory(f.owner)).toHaveLength(1)
    await f.service.registerLogin(f.owner, {
      ...f.session,
      token: 'Bearer renewed',
      expire: stamp('22:00'),
    })
    await f.service.tick()
    await f.service.tick()
    expect(mailHistory(f.owner).map(x => x.subject).sort()).toEqual(['【接龙工作台】今日签到已完成', '【接龙工作台】微信登录已恢复', '【接龙工作台】微信登录已过期'].sort())
  }
  finally {
    for (const [name, value] of Object.entries({ SMTP_HOST: previous.host, SMTP_USER: previous.user, SMTP_PASS: previous.pass })) {
      if (value === undefined)
        delete process.env[name]
      else
        process.env[name] = value
    }
  }
})
