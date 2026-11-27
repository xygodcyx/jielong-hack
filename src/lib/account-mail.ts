import type { Session } from './store.ts'
import { Buffer } from 'node:buffer'
import sharp from 'sharp'
import { AppError } from './api.ts'
import { authenticated, pollLogin, startLogin } from './auth.ts'
import { automationAccount, plans } from './automation-store.ts'
import { mailSettings, queueManualNotice, queueNotice, siteUrl, validEmail } from './mail.ts'
import { db, deleteSession, getSession, saveSession } from './store.ts'

db.exec(`CREATE TABLE IF NOT EXISTS login_mail_requests (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, created INTEGER NOT NULL,
  expires INTEGER NOT NULL, state TEXT NOT NULL
);`)

function optionalEmail(value: unknown) {
  try {
    return validEmail(value)
  }
  catch { return '' }
}
export function accountMailInfo(session: Session) {
  const remembered = !!session.accountKey && !session.demo && !!session.user
  const recipients = remembered
    ? [
        ...new Set(plans(session.accountKey!).filter(plan => !plan.demo).map(plan => optionalEmail(plan.recipient)).filter(Boolean)),
      ]
    : []
  if (remembered && !recipients.length) {
    const fallback = optionalEmail(mailSettings().defaultRecipient)
    if (fallback)
      recipients.push(fallback)
  }
  return { remembered, configured: mailSettings().configured, recipients }
}

export function queueTestMail(session: Session, recipient: unknown) {
  if (session.demo)
    throw new AppError('演示空间不发送真实邮件。')
  if (!authenticated(session) || !session.accountKey)
    throw new AppError('请先使用微信扫码登录。', 401, 'AUTH_REQUIRED')
  return queueManualNotice('account-test', session.accountKey, validEmail(recipient), {
    subject: '【接龙工作台】邮件发送测试',
    title: '邮件发送测试与账号信息',
    lines: [
      '收到这封邮件，说明本次邮件已成功送达。',
      `微信名称：${session.user?.name || '微信用户'}`,
      `微信昵称：${session.user?.nickname || '未提供'}`,
      `登录状态：${authenticated(session)
        ? '有效'
        : '已过期'}`,
      `Token 到期时间：${new Date(session.expire).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`,
      `自动签到计划：${plans(session.accountKey).length} 个。`,
      '此测试不会提交签到或更改循环计划。',
    ],
    actionUrl: `${siteUrl()}/?automation=1`,
    actionLabel: '打开工作台',
  })
}

interface LoginMailRequest {
  id: string
  owner: string
  created: number
  expires: number
  state: string
}

export class LoginMailService {
  private sending = new Set<string>()
  private polling = new Set<string>()

  constructor(
    private register: (owner: string, session: Session) => Promise<void>,
    private fetcher: typeof fetch = fetch,
  ) {}

  async send(session: Session) {
    const info = accountMailInfo(session)
    if (!info.remembered)
      throw new AppError('本地没有此微信账号的登录信息，请先在网站扫码登录。', 403)
    if (authenticated(session))
      throw new AppError('当前登录仍然有效，无需发送登录二维码。', 409)
    if (!info.configured)
      throw new AppError('尚未配置 SMTP 邮件服务。', 503)
    if (!info.recipients.length)
      throw new AppError('此账号没有已保存的通知邮箱，请先在网站扫码并设置邮箱。')
    const owner = session.accountKey!
    const now = Date.now()
    const last = db.prepare('SELECT created FROM login_mail_requests WHERE owner=? ORDER BY created DESC LIMIT 1').get(owner) as { created: number } | undefined
    if (this.sending.has(owner) || (last && now - last.created < 60000))
      throw new AppError('已请求发送，请等待一分钟后再试。', 429)
    this.sending.add(owner)
    const id = crypto.randomUUID()
    try {
      db.prepare('INSERT INTO login_mail_requests VALUES (?,?,?,?,?)').run(id, owner, now, now + 300000, 'starting')
      const loginSession: Session = { id, expire: 0 }
      saveSession(loginSession)
      const login = await startLogin(loginSession, this.fetcher)
      loginSession.login!.expectedAccountKey = owner
      saveSession(loginSession)
      const response = await this.fetcher(`https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(loginSession.login!.uuid)}`, {
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok)
        throw new AppError('无法载入二维码，请稍后重试。', 502)
      const image = Buffer.from(await response.arrayBuffer())
      let qrImage: Buffer
      try {
        if (!image.length || image.length > 1024 * 1024)
          throw new Error('Invalid image size')
        const decoder = sharp(image, { limitInputPixels: 4000000 })
        const metadata = await decoder.metadata()
        if (!['png', 'jpeg', 'webp', 'gif'].includes(metadata.format || ''))
          throw new Error('Invalid image format')
        qrImage = await decoder.png().toBuffer()
      }
      catch {
        throw new AppError('微信二维码图片无效，请稍后重试。', 502)
      }
      // 获取二维码期间，其他设备可能已续期或发起设备已退出/切换账号。
      const current = getSession(session.id)
      if (!current || current.accountKey !== owner || (automationAccount(owner)?.expire || 0) > Date.now())
        throw new AppError('登录状态已变化，请刷新页面。', 409)
      db.prepare('UPDATE login_mail_requests SET state=\'pending\',expires=? WHERE id=?').run(login.expiresAt, id)
      const ids = info.recipients.map((recipient, index) => {
        const noticeId = `login-qr:${id}:${index}`
        queueNotice(noticeId, owner, recipient, {
          subject: '【接龙工作台】微信登录二维码',
          title: '请使用原微信账号恢复登录',
          lines: [
            `微信名称：${session.user?.name || '微信用户'}`,
            '请使用此账号的微信扫描下方二维码，也可打开邮件中的 PNG 附件扫码。',
            `二维码有效期至：${new Date(login.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间），约 5 分钟内有效。`,
            '扫码后在微信中确认。无需保持网页打开，但本机服务需要保持运行。',
            '恢复后，已启用的计划仅在设定时间至当天 23:00 之间核对并补交今日签到，不补交往日记录。',
          ],
          qrImage: qrImage.toString('base64'),
          expiresAt: login.expiresAt,
          actionUrl: `${siteUrl()}/?automation=1`,
          actionLabel: '在网站重新扫码',
        })
        return noticeId
      })
      return { ids, recipients: info.recipients, expiresAt: login.expiresAt }
    }
    catch (error) {
      deleteSession(id)
      db.prepare('DELETE FROM login_mail_requests WHERE id=?').run(id)
      if (error instanceof AppError)
        throw error
      throw new AppError('登录二维码获取失败，请稍后重试。', 502)
    }
    finally {
      this.sending.delete(owner)
    }
  }

  async tick() {
    const requests = db.prepare('SELECT * FROM login_mail_requests').all() as unknown as LoginMailRequest[]
    await Promise.allSettled(requests.map(async (request) => {
      if (this.polling.has(request.id))
        return
      if (request.expires <= Date.now() || request.state === 'done') {
        deleteSession(request.id)
        if (request.created + 60000 <= Date.now())
          db.prepare('DELETE FROM login_mail_requests WHERE id=?').run(request.id)
        return
      }
      if (request.state !== 'pending')
        return
      this.polling.add(request.id)
      try {
        const session = getSession(request.id)
        if (!session || (automationAccount(request.owner)?.expire || 0) > Date.now()) {
          db.prepare('UPDATE login_mail_requests SET state=\'done\' WHERE id=?').run(request.id)
          deleteSession(request.id)
          return
        }
        // 成功扫码后服务重启，也能在下一轮完成凭证登记。
        const result = await pollLogin(session, this.fetcher)
        if (result.status === 'success' && session.accountKey === request.owner) {
          await this.register(request.owner, session)
          db.prepare('UPDATE login_mail_requests SET state=\'done\' WHERE id=?').run(request.id)
          deleteSession(request.id)
        }
        else if (result.status === 'expired') {
          db.prepare('UPDATE login_mail_requests SET state=\'done\' WHERE id=?').run(request.id)
          deleteSession(request.id)
        }
      }
      catch {
        // 网络故障等待下轮；不输出授权码、Token 或上游响应。
      }
      finally {
        this.polling.delete(request.id)
      }
    }))
  }
}
