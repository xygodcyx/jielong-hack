import type { Transporter } from 'nodemailer'
import process from 'node:process'
import nodemailer from 'nodemailer'
import { AppError } from './api.ts'
import { db } from './store.ts'

export interface Notice {
  subject: string
  title: string
  lines: string[]
  actionLabel?: string
  actionUrl?: string
}
db.exec(`CREATE TABLE IF NOT EXISTS mail_outbox (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, recipient TEXT NOT NULL,
  data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL, updated INTEGER NOT NULL, error TEXT NOT NULL DEFAULT ''
);`)

export function validEmail(value: unknown): string {
  const email = String(value || '').trim()
  if (email.length > 254 || !/^[^\s<>@,;]+@[^\s,;<>@][^\s,.;<>@]*\.[^\s,;<>@]+$/.test(email))
    throw new AppError('请填写一个有效的通知邮箱。')
  return email
}
export function mailSettings() {
  return {
    configured: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    defaultRecipient: process.env.TO_EMAIL || '',
    baseUrl: siteUrl(),
  }
}
export function siteUrl() {
  for (const value of [process.env.BASE_URL, process.env.PUBLIC_ORIGIN]) {
    try {
      const url = new URL(value || '')
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
        return url.origin
    }
    catch { }
  }
  return `http://127.0.0.1:${Number(process.env.PORT) || 3210}`
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  })[c]!)
}
export function renderNotice(notice: Notice) {
  const text = [
    notice.title,
    ...notice.lines,
    ...(notice.actionUrl
      ? [`${notice.actionLabel || '打开工作台'}：${notice.actionUrl}`]
      : []),
  ].join('\n\n')
  const html = `<div style="background:#f4f7f5;padding:32px 16px;font-family:Arial,'PingFang SC',sans-serif;color:#193a2c"><div style="max-width:560px;margin:auto;background:white;border-radius:16px;padding:32px"><div style="font-size:12px;color:#688476;letter-spacing:2px">接龙工作台 · 自动签到</div><h1 style="font-size:24px">${escapeHtml(notice.title)}</h1>${notice.lines.map(line => `<p style="font-size:15px;line-height:1.8;color:#405d4e">${escapeHtml(line)}</p>`).join('')}${notice.actionUrl
    ? `<a href="${escapeHtml(notice.actionUrl)}" style="display:inline-block;background:#245f46;color:white;padding:13px 22px;border-radius:9px;text-decoration:none">${escapeHtml(notice.actionLabel || '打开工作台')}</a>`
    : ''}<p style="margin-top:28px;font-size:12px;color:#89988e">请保持本机服务运行。邮件链接仅打开页面，签到操作在工作台内确认。</p></div></div>`
  return { text, html }
}
let transport: Transporter | undefined
export async function sendNotice(recipient: string, notice: Notice) {
  if (!mailSettings().configured)
    throw new AppError('尚未配置 SMTP 邮件服务。', 503)
  const port = Number(process.env.SMTP_PORT) || 465
  transport ||= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE
      ? process.env.SMTP_SECURE === 'true'
      : port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  })
  await transport.sendMail({
    from: { name: process.env.EMAIL_FROM_NAME || '接龙工作台', address: process.env.SMTP_USER! },
    to: validEmail(recipient),
    subject: notice.subject,
    ...renderNotice(notice),
    headers: { 'X-Auto-Response-Suppress': 'OOF, AutoReply' },
  })
}
export function queueNotice(id: string, owner: string, recipient: string, notice: Notice, now = Date.now()) {
  db.prepare('INSERT OR IGNORE INTO mail_outbox (id,owner,recipient,data,next_at,updated) VALUES (?,?,?,?,?,?)')
    .run(id, owner, validEmail(recipient), JSON.stringify(notice), now, now)
}
let flushing = false
export async function flushNotices(now = Date.now(), send = sendNotice) {
  if (flushing)
    return
  flushing = true
  try {
    const rows = db.prepare('SELECT id,owner,recipient,data,attempts FROM mail_outbox WHERE state=\'pending\' AND next_at<=? ORDER BY next_at LIMIT 10').all(now) as { id: string, owner: string, recipient: string, data: string, attempts: number }[]
    for (const row of rows) {
      const claimed = db.prepare('UPDATE mail_outbox SET state=\'sending\',attempts=attempts+1,updated=? WHERE id=? AND state=\'pending\'').run(now, row.id)
      if (!claimed.changes)
        continue
      try {
        await send(row.recipient, JSON.parse(row.data))
        db.prepare('UPDATE mail_outbox SET state=\'sent\',updated=?,error=\'\' WHERE id=?').run(now, row.id)
      }
      catch {
        // 不把 SMTP 响应或凭证写入网页/日志；失败退避，最多尝试五次。
        db.prepare('UPDATE mail_outbox SET state=?,next_at=?,updated=?,error=? WHERE id=?')
          .run(row.attempts >= 4
            ? 'failed'
            : 'pending', now + Math.min(3600000, 600000 * 2 ** row.attempts), now, '邮件未发送成功，请检查 SMTP 配置与邮箱。', row.id)
      }
    }
  }
  finally {
    flushing = false
  }
}
export function mailHistory(owner: string) {
  return (db.prepare('SELECT id,data,state,attempts,updated,error FROM mail_outbox WHERE owner=? ORDER BY updated DESC LIMIT 20').all(owner) as { id: string, data: string, state: string, attempts: number, updated: number, error: string }[])
    .map(({ data, ...row }) => ({ ...row, subject: (JSON.parse(data) as Notice).subject }))
}
export function recoverInterruptedMail() {
  // SMTP 可能已接收邮件，重启时不重复发送结果不明的那一封。
  db.prepare('UPDATE mail_outbox SET state=\'unknown\',error=? WHERE state=\'sending\'').run('服务在发送邮件时重启，请检查收件箱。')
}
