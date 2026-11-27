import type { Session } from './store.ts'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { api, AppError, query } from './api.ts'
import { automationAccount, invalidateAutomationAccount } from './automation-store.ts'
import { getSession, saveSession } from './store.ts'

export function authenticated(s: Session) {
  return !!(s.demo || (s.token && s.expire > Date.now()))
}

export function syncSessionAuth(s: Session) {
  if (s.demo || !s.accountKey)
    return
  const account = automationAccount(s.accountKey)
  if (!account || account.demo)
    return
  // 只同步该账号的凭证，浏览器会话、草稿和二维码状态保持各自独立。
  s.token = account.token
  s.expire = account.expire
  s.user = account.user || s.user
  saveSession(s)
}

export function invalidateSessionAuth(s: Session) {
  if (s.demo)
    return
  if (s.accountKey)
    invalidateAutomationAccount(s.accountKey, s.token)
  const current = getSession(s.id)
  if (current && current.accountKey === s.accountKey && current.token === s.token) {
    current.expire = 0
    saveSession(current)
  }
}

const inflight = new Set<string>()
function requireCurrentLogin(s: Session) {
  const current = getSession(s.id)
  if (!current || current.login?.uuid !== s.login?.uuid)
    throw new AppError('登录会话已变化，请重新获取二维码。', 409)
}
export async function startLogin(s: Session, fetcher: typeof fetch = fetch) {
  const url = new URL('https://open.weixin.qq.com/connect/qrconnect')
  url.search = new URLSearchParams({ appid: process.env.WECHAT_APP_ID || 'wx4a23ae4b8f291087', scope: 'snsapi_login', redirect_uri: 'https://i.jielong.com/login-callback' }).toString()
  const r = await fetcher(url, {
    signal: AbortSignal.timeout(20000),
  }).catch(() => {
    throw new AppError('微信二维码获取失败，请检查网络。', 502)
  })
  const html = await r.text()
  const uuid = html.match(/uuid=([\w-]+)/)?.[1] || html.match(/connect\/qrcode\/([\w-]+)/)?.[1]
  if (!r.ok || !uuid)
    throw new AppError('无法获取微信二维码，请稍后重试。', 502)
  requireCurrentLogin(s)
  s.login = { uuid, status: 'pending', expiresAt: Date.now() + 300000 }
  saveSession(s)
  return { status: 'pending', expiresAt: s.login.expiresAt, qrUrl: '/api/auth/qr' }
}
export async function pollLogin(s: Session, fetcher: typeof fetch = fetch) {
  if (!s.login)
    throw new AppError('请先获取二维码。')
  if (s.login.expiresAt < Date.now()) {
    s.login.status = 'expired'
    saveSession(s)
    return { status: 'expired' }
  }
  if (['success', 'expired'].includes(s.login.status) || inflight.has(s.id))
    return { status: s.login.status }
  inflight.add(s.id)
  try {
    const r = await fetcher(`https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${encodeURIComponent(s.login.uuid)}&last=404`, {
      signal: AbortSignal.timeout(18000),
    })
    const text = await r.text()
    requireCurrentLogin(s)
    const status = Number(text.match(/wx_errcode\s*=\s*(\d+)/)?.[1])
    if (status === 405) {
      const code = text.match(/wx_code\s*=\s*['"]([^'"]+)['"]/)?.[1]
      if (!code)
        throw new AppError('微信授权未返回登录码。', 502)
      const body = await api(query('/api/User/OpenAuth', { code }), '', {}, fetcher)
      if (!body.Data?.Token)
        throw new AppError('登录响应缺少凭证。', 502)
      const token = `Bearer ${body.Data.Token}`
      const raw = body.Data.Expire
      let expiry = typeof raw === 'string' && !/^\d+$/.test(raw)
        ? Date.parse(raw)
        : Number(raw)
      if (expiry > 0 && expiry < 1e12)
        expiry *= 1000
      const expire = Number.isFinite(expiry) && expiry > Date.now()
        ? expiry
        : Date.now() + 72 * 3600000
      const current = await api('/api/User/CurrentUser', token, undefined, fetcher)
      const key = accountKey(current.Data)
      requireCurrentLogin(s)
      if (s.login.expectedAccountKey && key !== s.login.expectedAccountKey) {
        s.login.status = 'expired'
        saveSession(s)
        throw new AppError('请使用发送邮件时绑定的原微信账号扫码。', 403)
      }
      s.token = token
      s.expire = expire
      s.user = publicUser(current.Data)
      s.accountKey = key
      s.demo = false
      s.login.status = 'success'
      saveSession(s)
    }
    else if ([402, 403, 666].includes(status)) {
      s.login.status = 'expired'
      saveSession(s)
    }
    else if (status === 404) {
      s.login.status = 'scanned'
      saveSession(s)
    }
    return { status: s.login.status }
  }
  catch (e) {
    if (e instanceof AppError)
      throw e
    return { status: s.login.status }
  }
  finally {
    inflight.delete(s.id)
  }
}
export function publicUser(u: any) {
  return { name: u.FormInfo?.FormUserName || u.FormInfo?.Name || u.Nickname || '微信用户', nickname: u.Nickname || '', avatar: u.Avatar || '' }
}

export function accountKey(user: { Id?: unknown, OpenId?: unknown }) {
  const id = user.Id || user.OpenId
  if (typeof id !== 'string' && typeof id !== 'number')
    throw new AppError('当前账号缺少身份标识，请重新登录。', 401, 'AUTH_REQUIRED')
  return `wechat:${createHash('sha256').update(String(id)).digest('hex')}`
}

export async function manualThreadOwner(session: Session) {
  if (session.demo)
    return `demo:${session.id}`
  if (!session.accountKey) {
    const current = await api('/api/User/CurrentUser', session.token || '')
    session.accountKey = accountKey(current.Data)
    saveSession(session)
  }
  return session.accountKey
}
