import { expect, it } from 'bun:test'
import { flushNotices, mailHistory, queueNotice, recoverInterruptedMail, renderNotice, validEmail } from '../src/lib/mail.ts'
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
  db.query('UPDATE mail_outbox SET state=\'sending\' WHERE id=?').run(owner)
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
