import type { Notice } from '../src/lib/mail.ts'
import type { Session } from '../src/lib/store.ts'
import { Buffer } from 'node:buffer'
import sharp from 'sharp'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { accountMailInfo, LoginMailService, queueTestMail } from '../src/lib/account-mail.ts'
import { accountKey, syncSessionAuth } from '../src/lib/auth.ts'
import { automationAccount, saveAutomationAccount, savePlan } from '../src/lib/automation-store.ts'
import { AutomationService } from '../src/lib/automations.ts'
import { demoSchema } from '../src/lib/demo.ts'
import { flushNotices, mailHistory, mailStatus, renderNotice } from '../src/lib/mail.ts'
import { db, deleteSession, getSession, saveSession } from '../src/lib/store.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXFkAAAAASUVORK5CYII=', 'base64')
beforeEach(() => {
  vi.stubEnv('SMTP_HOST', 'smtp.fixture.invalid')
  vi.stubEnv('SMTP_USER', 'sender@example.com')
  vi.stubEnv('SMTP_PASS', 'fixture-password')
  vi.stubEnv('TO_EMAIL', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  const rows = db.prepare('SELECT id FROM login_mail_requests').all() as { id: string }[]
  for (const row of rows)
    deleteSession(row.id)
  db.prepare('DELETE FROM login_mail_requests').run()
  db.prepare('DELETE FROM mail_outbox').run()
})
async function fixture() {
  const userId = crypto.randomUUID()
  const owner = accountKey({ Id: userId })
  const session: Session = {
    id: crypto.randomUUID(),
    accountKey: owner,
    token: 'Bearer fixture-expired-token',
    expire: Date.now() - 1000,
    user: { name: '测试微信', nickname: '测试昵称' },
  }
  saveSession(session)
  saveAutomationAccount(owner, session, true)
  const service = new AutomationService({
    load: async () => demoSchema('demo-checkin'),
  })
  const plan = await service.create(owner, session, 'demo-checkin')
  savePlan({ ...plan, recipient: 'account@example.com' })
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/connect/qrconnect')
      return new Response(`uuid=fixture-${crypto.randomUUID()}`)
    if (url.pathname.startsWith('/connect/qrcode/')) {
      return new Response(png, {
        headers: { 'content-type': 'image/png' },
      })
    }
    if (url.pathname === '/connect/l/qrconnect')
      return new Response('window.wx_errcode=405;window.wx_code="fixture-code";')
    if (url.pathname === '/api/User/OpenAuth') {
      return Response.json({
        Type: '000001',
        Data: { Token: 'fixture-renewed-token', Expire: Date.now() + 3600000 },
      })
    }
    if (url.pathname === '/api/User/CurrentUser') {
      return Response.json({
        Type: '000001',
        Data: { Id: userId, Nickname: '测试微信' },
      })
    }
    throw new Error('不应请求其他地址')
  })
  return {
    owner,
    session,
    service,
    plan,
    fetcher: fetcher as typeof fetch & typeof fetcher,
  }
}

it('仅记住的真实账号可以发登录邮件；缺少 SMTP、收件人或登录仍有效时明确拒绝', async () => {
  const f = await fixture()
  const mail = new LoginMailService(vi.fn(), f.fetcher)
  const guest = {
    id: crypto.randomUUID(),
    expire: 0,
    user: f.session.user,
  }
  expect(accountMailInfo(guest)).toEqual({ remembered: false, configured: true, recipients: [] })
  await expect(mail.send(guest)).rejects.toThrow('本地没有')
  await expect(mail.send({ ...f.session, demo: true })).rejects.toThrow('本地没有')
  await expect(mail.send({ ...f.session, expire: Date.now() + 60000 })).rejects.toThrow('仍然有效')
  vi.stubEnv('SMTP_PASS', '')
  await expect(mail.send(f.session)).rejects.toThrow('SMTP')
  vi.stubEnv('SMTP_PASS', 'fixture-password')
  savePlan({ ...f.plan, recipient: '' })
  await expect(mail.send(f.session)).rejects.toThrow('没有已保存的通知邮箱')
  expect(f.fetcher).not.toHaveBeenCalled()
})

it('登录邮件使用本账号已保存邮箱并去重，内嵌二维码，重复点击限流', async () => {
  const f = await fixture()
  savePlan({
    ...f.plan,
    id: crypto.randomUUID(),
    thread: { ...f.plan.thread, id: 'duplicate-recipient' },
    recipient: 'account@example.com',
  })
  savePlan({
    ...f.plan,
    id: crypto.randomUUID(),
    owner: 'wechat:other-account',
    recipient: 'other@example.com',
  })
  const mail = new LoginMailService(vi.fn(), f.fetcher)
  const result = await mail.send(f.session)
  expect(result.recipients).toEqual(['account@example.com'])
  expect(result.ids).toHaveLength(1)
  expect(result.expiresAt).toBeGreaterThan(Date.now())
  await expect(mail.send(f.session)).rejects.toThrow('一分钟')
  const delivered: { recipient: string, notice: Notice }[] = []
  await flushNotices(Date.now(), async (recipient, notice) => {
    delivered.push({ recipient, notice })
  })
  expect(delivered).toHaveLength(1)
  expect(delivered[0]!.recipient).toBe('account@example.com')
  expect((await sharp(Buffer.from(delivered[0]!.notice.qrImage!, 'base64')).metadata()).format).toBe('png')
  expect(renderNotice(delivered[0]!.notice).html).toContain('cid:wechat-login-qr')
  expect(JSON.stringify(delivered)).not.toContain(f.session.token)
  expect(mailStatus(f.owner, result.ids[0]!).state).toBe('sent')
  expect(() => mailStatus('wechat:other-account', result.ids[0]!)).toThrow('不存在')
})

it('二维码图片统一转为 PNG 附件，也接受 JPEG；拒绝上游返回的网页内容', async () => {
  const f = await fixture()
  const jpeg = await sharp(png).jpeg().toBuffer()
  const fetcher = (async (input, options) => new URL(String(input)).pathname.startsWith('/connect/qrcode/')
    ? new Response(new Uint8Array(jpeg).buffer)
    : f.fetcher(input, options)) as typeof fetch
  await new LoginMailService(vi.fn(), fetcher).send(f.session)
  await flushNotices(Date.now(), async (_recipient, notice) => {
    const metadata = await sharp(Buffer.from(notice.qrImage!, 'base64')).metadata()
    expect(metadata.format).toBe('png')
    expect(metadata.width).toBe(1)
  })
  const other = await fixture()
  const bad = (async (input, options) => new URL(String(input)).pathname.startsWith('/connect/qrcode/')
    ? new Response('<html>not a QR code</html>')
    : other.fetcher(input, options)) as typeof fetch
  await expect(new LoginMailService(vi.fn(), bad).send(other.session)).rejects.toThrow('二维码图片无效')
  expect(mailHistory(other.owner)).toHaveLength(0)
})

it('邮件扫码独立于网页轮询，服务实例恢复后登记同一微信凭证，已绑定设备自动恢复', async () => {
  const f = await fixture()
  await new LoginMailService(vi.fn(), f.fetcher).send(f.session)
  const register = vi.fn((owner: string, session: Session) => f.service.registerLogin(owner, session))
  const restored = new LoginMailService(register, f.fetcher)
  await restored.tick()
  expect(register).toHaveBeenCalledTimes(1)
  expect(register.mock.calls[0]![0]).toBe(f.owner)
  expect(automationAccount(f.owner)?.token).toBe('Bearer fixture-renewed-token')
  syncSessionAuth(f.session)
  expect(f.session.expire).toBeGreaterThan(Date.now())
  expect(f.session.token).toBe('Bearer fixture-renewed-token')
  await restored.tick()
  expect(register).toHaveBeenCalledTimes(1)
  expect(mailHistory(f.owner).some(notice => notice.subject.includes('二维码'))).toBe(true)
})

it('扫码账号不匹配时拒绝更新原账号，二维码到期后停止后台轮询', async () => {
  const f = await fixture()
  const wrongUser = (async (input, options) => new URL(String(input)).pathname === '/api/User/CurrentUser'
    ? Response.json({
        Type: '000001',
        Data: { Id: 'fixture-wrong-account' },
      })
    : f.fetcher(input, options)) as typeof fetch
  const register = vi.fn()
  const mail = new LoginMailService(register, wrongUser)
  await mail.send(f.session)
  await mail.tick()
  expect(register).not.toHaveBeenCalled()
  expect(automationAccount(f.owner)?.token).toBe(f.session.token)
  const row = db.prepare('SELECT id FROM login_mail_requests WHERE owner=?').get(f.owner) as { id: string }
  expect(getSession(row.id)?.token).toBeUndefined()
  expect(getSession(row.id)?.login?.status).toBe('expired')
  db.prepare('UPDATE login_mail_requests SET expires=0 WHERE id=?').run(row.id)
  const calls = f.fetcher.mock.calls.length
  await mail.tick()
  expect(f.fetcher.mock.calls).toHaveLength(calls)
  expect(getSession(row.id)).toBeNull()
})

it('二维码邮件过期不投递，发送失败不在十分钟后重发失效二维码', async () => {
  const f = await fixture()
  const result = await new LoginMailService(vi.fn(), f.fetcher).send(f.session)
  const send = vi.fn(async () => {})
  await flushNotices(result.expiresAt + 1, send)
  expect(send).not.toHaveBeenCalled()
  expect(mailStatus(f.owner, result.ids[0]!).state).toBe('expired')

  db.prepare('DELETE FROM login_mail_requests').run()
  const second = await new LoginMailService(vi.fn(), f.fetcher).send(f.session)
  const fail = vi.fn(async () => {
    throw new Error('fixture SMTP failure')
  })
  await flushNotices(Date.now(), fail)
  expect(mailStatus(f.owner, second.ids[0]!).state).toBe('failed')
  await flushNotices(Date.now() + 600000, fail)
  expect(fail).toHaveBeenCalledTimes(1)
})

it('测试邮件包含账号名称、北京时间到期时间，不包含 Token；发送限流且不改计划', async () => {
  const f = await fixture()
  f.session.expire = Date.now() + 3600000
  const before = JSON.stringify(f.plan)
  const id = queueTestMail(f.session, 'test@example.com')
  expect(() => queueTestMail(f.session, 'second@example.com')).toThrow('一分钟')
  let delivered: Notice | undefined
  await flushNotices(Date.now(), async (recipient, notice) => {
    expect(recipient).toBe('test@example.com')
    delivered = notice
  })
  expect(delivered?.lines.join('\n')).toContain('测试微信')
  expect(delivered?.lines.join('\n')).toContain('Token 到期时间：')
  expect(delivered?.lines.join('\n')).toContain('北京时间')
  expect(JSON.stringify(delivered)).not.toContain(f.session.token)
  expect(mailStatus(f.owner, id).state).toBe('sent')
  expect(JSON.stringify(f.plan)).toBe(before)
  expect(() => queueTestMail({ ...f.session, demo: true }, 'test@example.com')).toThrow('演示')
  expect(() => queueTestMail(f.session, 'invalid')).toThrow('有效的通知邮箱')
})
