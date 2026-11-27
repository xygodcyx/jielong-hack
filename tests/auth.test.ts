import type { Session } from '../src/lib/store.ts'
import { expect, it } from 'bun:test'
import { accountKey, authenticated, invalidateSessionAuth, pollLogin, startLogin, syncSessionAuth } from '../src/lib/auth.ts'
import { automationAccount, invalidateAutomationAccount, saveAutomationAccount } from '../src/lib/automation-store.ts'
import { AutomationService } from '../src/lib/automations.ts'
import { db, deleteSession, getSession, saveSession } from '../src/lib/store.ts'

function fixture() {
  const owner = accountKey({
    Id: crypto.randomUUID(),
  })
  const session: Session = {
    id: crypto.randomUUID(),
    accountKey: owner,
    token: 'Bearer fixture-old',
    expire: Date.now() - 1000,
    user: { name: '原名称' },
    login: { uuid: 'fixture-local-qr', status: 'pending', expiresAt: Date.now() + 60000 },
  }
  return { owner, session }
}

it('旧版会话的 Token 过期后仍记住账号，并复用其他设备最后扫码取得的凭证', async () => {
  const { owner, session } = fixture()
  db.query('INSERT INTO sessions VALUES (?,?,?)').run(session.id, JSON.stringify(session), session.expire)
  const remembered = getSession(session.id)!
  expect(remembered.accountKey).toBe(owner)
  expect(authenticated(remembered)).toBe(false)
  const latest = {
    ...session,
    id: crypto.randomUUID(),
    token: 'Bearer fixture-latest',
    expire: Date.now() + 3600000,
    user: { name: '新名称' },
    login: { uuid: 'fixture-other-qr' },
  }
  await new AutomationService().registerLogin(owner, latest)
  syncSessionAuth(remembered)
  expect(authenticated(remembered)).toBe(true)
  expect(remembered.token).toBe(latest.token)
  expect(remembered.expire).toBe(latest.expire)
  expect(remembered.user).toEqual(latest.user)
  expect(remembered.id).toBe(session.id)
  expect(remembered.login).toEqual(session.login)
  expect(getSession(session.id)?.token).toBe(latest.token)
  expect(remembered.sessionExpiresAt!).toBeGreaterThan(latest.expire)
})

it('尚未过期的设备也采用最新凭证；凭证被拒绝后保留账号，续期可再次恢复', () => {
  const { owner, session } = fixture()
  session.expire = Date.now() + 72 * 3600000
  saveSession(session)
  const latest = { ...session, token: 'Bearer fixture-newer', expire: Date.now() + 3600000 }
  saveAutomationAccount(owner, latest, true)
  syncSessionAuth(session)
  expect(session.token).toBe(latest.token)
  expect(session.expire).toBe(latest.expire)
  saveAutomationAccount(owner, { ...latest, token: 'Bearer fixture-stale-request', expire: Date.now() + 72 * 3600000 })
  expect(automationAccount(owner)?.token).toBe(latest.token)
  invalidateAutomationAccount(owner, latest.token)
  saveAutomationAccount(owner, latest)
  expect(automationAccount(owner)?.expire).toBe(0)
  syncSessionAuth(session)
  expect(authenticated(session)).toBe(false)
  expect(getSession(session.id)?.accountKey).toBe(owner)
  saveAutomationAccount(owner, { ...latest, token: 'Bearer fixture-renewed' }, true)
  syncSessionAuth(session)
  expect(authenticated(session)).toBe(true)
  expect(session.token).toBe('Bearer fixture-renewed')
})

it('新访客、其他账号、演示会话和已主动退出的设备不能恢复该账号', () => {
  const { owner, session } = fixture()
  saveSession(session)
  saveAutomationAccount(owner, { ...session, token: 'Bearer fixture-valid', expire: Date.now() + 3600000 }, true)
  const guest: Session = {
    id: crypto.randomUUID(),
    expire: Date.now() + 3600000,
    user: session.user,
  }
  syncSessionAuth(guest)
  expect(authenticated(guest)).toBe(false)
  expect(guest.accountKey).toBeUndefined()
  const other = {
    ...session,
    accountKey: accountKey({ Id: 'fixture-unrelated-account' }),
  }
  syncSessionAuth(other)
  expect(authenticated(other)).toBe(false)
  expect(other.token).toBe(session.token)
  const demo = { ...session, demo: true }
  syncSessionAuth(demo)
  expect(demo.token).toBe(session.token)
  deleteSession(session.id)
  expect(getSession(session.id)).toBeNull()
  expect(automationAccount(owner)?.token).toBe('Bearer fixture-valid')
  const expiredMemory = { ...session, sessionExpiresAt: Date.now() - 1000 }
  saveSession(expiredMemory)
  expect(getSession(session.id)).toBeNull()
})

it('旧请求迟到的登录失效响应不会使刚刚续期的新凭证失效', () => {
  const { owner, session } = fixture()
  saveSession(session)
  const latest = { ...session, token: 'Bearer fixture-racing-renewal', expire: Date.now() + 3600000 }
  saveAutomationAccount(owner, latest, true)
  saveSession(latest)
  invalidateSessionAuth(session)
  expect(automationAccount(owner)?.token).toBe(latest.token)
  expect(automationAccount(owner)?.expire).toBe(latest.expire)
  expect(getSession(session.id)?.expire).toBe(latest.expire)
  invalidateSessionAuth(latest)
  expect(authenticated(getSession(session.id)!)).toBe(false)
  expect(automationAccount(owner)?.expire).toBe(0)
})

it('扫码完成且账号身份验证成功后才替换原账号凭证', async () => {
  const { session } = fixture()
  saveSession(session)
  let rejectUser = true
  const fetcher = (async (input, options) => {
    const url = new URL(String(input))
    if (url.pathname === '/connect/qrconnect')
      return new Response('fixture uuid=fixture-new-qr')
    if (url.pathname === '/connect/l/qrconnect')
      return new Response('window.wx_errcode=405;window.wx_code="fixture-code";')
    if (url.pathname === '/api/User/OpenAuth') {
      return Response.json({
        Type: '000001',
        Data: { Token: 'fixture-scanned', Expire: Date.now() + 3600000 },
      })
    }
    if (url.pathname === '/api/User/CurrentUser') {
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer fixture-scanned')
      return Response.json(rejectUser
        ? { Type: '100000' }
        : {
            Type: '000001',
            Data: { Id: 'fixture-verified-account', Nickname: '扫码账号' },
          })
    }
    throw new Error('不应请求其他地址')
  }) as typeof fetch
  await startLogin(session, fetcher)
  const original = structuredClone(session)
  await expect(pollLogin(session, fetcher)).rejects.toThrow('登录已失效')
  expect(session.token).toBe(original.token)
  expect(session.accountKey).toBe(original.accountKey)
  rejectUser = false
  expect((await pollLogin(session, fetcher)).status).toBe('success')
  expect(session.token).toBe('Bearer fixture-scanned')
  expect(session.accountKey).toBe(accountKey({ Id: 'fixture-verified-account' }))
  expect(authenticated(session)).toBe(true)
})

it('扫码请求进行中主动退出，迟到的授权响应不能重新建立登录会话', async () => {
  const { owner, session } = fixture()
  saveSession(session)
  const latest = { ...session, token: 'Bearer fixture-other-device', expire: Date.now() + 3600000 }
  saveAutomationAccount(owner, latest, true)
  const fetcher = (async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/connect/l/qrconnect')
      return new Response('window.wx_errcode=405;window.wx_code="fixture-code";')
    if (url.pathname === '/api/User/OpenAuth') {
      return Response.json({
        Type: '000001',
        Data: { Token: 'fixture-late', Expire: Date.now() + 3600000 },
      })
    }
    if (url.pathname === '/api/User/CurrentUser') {
      deleteSession(session.id)
      return Response.json({
        Type: '000001',
        Data: { Id: 'fixture-late-account' },
      })
    }
    throw new Error('不应请求其他地址')
  }) as typeof fetch
  await expect(pollLogin(session, fetcher)).rejects.toThrow('登录会话已变化')
  expect(getSession(session.id)).toBeNull()
  expect(automationAccount(owner)?.token).toBe(latest.token)
})
