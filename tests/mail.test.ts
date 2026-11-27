import type { Transporter } from 'nodemailer'
import { Buffer } from 'node:buffer'
import nodemailer from 'nodemailer'
import { expect, it, vi } from 'vitest'
import { flushNotices, mailHistory, queueNotice, recoverInterruptedMail, renderNotice, sendNotice, validEmail } from '../src/lib/mail.ts'
import { db } from '../src/lib/store.ts'

it('邮件通知去重、持久化与失败退避，不实际发送邮件', async () => {
  const owner = crypto.randomUUID()
  const key = crypto.randomUUID()
  const notice = {
    title: '今日已完成',
    subject: '签到结果',
    lines: ['内容已提交'],
  }
  queueNotice(key, owner, 'test@example.com', notice, 100)
  queueNotice(key, owner, 'test@example.com', notice, 100)
  let calls = 0
  await flushNotices(100, async () => {
    calls++
    throw new Error('mock SMTP failure')
  })
  expect(calls).toBe(1)
  expect(mailHistory(owner)[0]?.state).toBe('pending')
  await flushNotices(101, async () => {
    calls++
  })
  expect(calls).toBe(1)
  await flushNotices(600100, async () => {
    calls++
  })
  expect(calls).toBe(2)
  expect(mailHistory(owner)[0]?.state).toBe('sent')
  await flushNotices(700100, async () => {
    calls++
  })
  expect(calls).toBe(2)
})

it('重启不重复发送结果不明的邮件；模板转义正文，拒绝邮箱注入', () => {
  const owner = crypto.randomUUID()
  queueNotice(owner, owner, 'test@example.com', {
    title: '<script>',
    subject: 'test',
    lines: ['a & b'],
  })
  db.prepare('UPDATE mail_outbox SET state=\'sending\' WHERE id=?').run(owner)
  recoverInterruptedMail()
  expect(mailHistory(owner)[0]?.state).toBe('unknown')
  const rendered = renderNotice({
    title: '<script>',
    subject: 'test',
    lines: ['a & b'],
  })
  expect(rendered.html).toContain('&lt;script&gt;')
  expect(rendered.html).toContain('a &amp; b')
  expect(() => validEmail('test@example.com\r\nBCC:a@b.com')).toThrow()
})

it('登录二维码作为内嵌 PNG 附件交给邮件服务，不使用远程图片或本机文件路径', async () => {
  vi.stubEnv('SMTP_HOST', 'fixture.invalid')
  vi.stubEnv('SMTP_USER', 'sender@example.com')
  vi.stubEnv('SMTP_PASS', 'fixture-password')
  const sendMail = vi.fn(async (_message: unknown) => ({}))
  const create = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail } as unknown as Transporter)
  try {
    await sendNotice('test@example.com', {
      subject: '二维码',
      title: '登录',
      lines: ['扫码'],
      qrImage: Buffer.from('fixture-image').toString('base64'),
    })
    const message = sendMail.mock.calls[0]![0] as any
    expect(message.to).toBe('test@example.com')
    expect(message.html).toContain('cid:wechat-login-qr')
    expect(message.attachments).toHaveLength(1)
    expect(message.attachments[0].content.toString()).toBe('fixture-image')
    expect(message.attachments[0].contentType).toBe('image/png')
    expect(message.attachments[0].path).toBeUndefined()
    expect(message.attachments[0].cid).toBe('wechat-login-qr')
  }
  finally {
    create.mockRestore()
    vi.unstubAllEnvs()
  }
})

it('队列中前一封邮件阻塞至二维码过期时，不再发送后续过期二维码', async () => {
  vi.useFakeTimers()
  try {
    const now = Date.now()
    const owner = crypto.randomUUID()
    queueNotice(`${owner}:first`, owner, 'test@example.com', { subject: '先发', title: '先发', lines: [] }, now)
    queueNotice(`${owner}:qr`, owner, 'test@example.com', {
      subject: '二维码',
      title: '登录',
      lines: [],
      expiresAt: now + 300000,
    }, now + 1)
    const send = vi.fn(async () => {
      vi.setSystemTime(now + 600000)
    })
    await flushNotices(now + 1, send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(mailHistory(owner).find(notice => notice.id.endsWith(':qr'))?.state).toBe('expired')
  }
  finally {
    vi.useRealTimers()
  }
})
