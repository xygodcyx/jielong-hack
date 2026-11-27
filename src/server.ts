import type { Session } from './lib/store.ts'
import type { Draft, FormSchema, JsonObject } from './shared.ts'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { accountMailInfo, LoginMailService, queueTestMail } from './lib/account-mail.ts'
import { api, AppError } from './lib/api.ts'
import { authenticated, invalidateSessionAuth, manualThreadOwner, pollLogin, startLogin, syncSessionAuth } from './lib/auth.ts'
import { getPlan, recoverInterruptedCheckins } from './lib/automation-store.ts'
import { automationMediaOwner, automations } from './lib/automations.ts'
import { demoSchema, demoThreads } from './lib/demo.ts'
import { createPayload, listThreads, loadSchema, records, validateDraft } from './lib/forms.ts'
import { fileResponse, handleNodeRequest } from './lib/http.ts'
import { flushNotices, mailHistory, mailSettings, mailStatus, recoverInterruptedMail } from './lib/mail.ts'
import { resolveFiles, stageMedia } from './lib/media.ts'
import { addHistory, db, deleteSession, getMedia, getSession, history, manualThreads, saveManualThread, saveSession, sessionMaxAge } from './lib/store.ts'
import { parseThreadReference, resolveThreadId } from './lib/thread-reference.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
let stopping = false
const backgroundJobs = new Set<Promise<unknown>>()
function runBackground(work: () => Promise<unknown>, message: string) {
  if (stopping)
    return
  const task = work().catch(() => console.warn(message)).finally(() => backgroundJobs.delete(task))
  backgroundJobs.add(task)
}
const loginMail = new LoginMailService(async (owner, session) => {
  await automations.registerLogin(owner, session)
  runBackground(() => automations.tick(), '自动签到检查未完成，下次检查将继续。')
})
const prepared = new Map<string, {
  owner: string
  schema: FormSchema
  payload: JsonObject
  expires: number
  fingerprint: string
  state: string
  result?: JsonObject
}>()
const locks = new Set<string>()
function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
function requireAuth(s: Session) {
  if (!authenticated(s))
    throw new AppError('请先使用微信扫码登录。', 401, 'AUTH_REQUIRED')
}
function schema(s: Session, id: string, recordId: string | number) {
  return s.demo
    ? Promise.resolve(demoSchema(id, recordId))
    : loadSchema(s.token!, id, recordId)
}
function publicSchema(form: FormSchema & {
  base?: JsonObject
}) {
  const { base: _, ...data } = form
  return data
}
async function resolveForSession(session: Session, value: string) {
  const reference = parseThreadReference(value)
  if (session.demo) {
    if (!('id' in reference) || !demoThreads.some(thread => thread.id === reference.id))
      throw new AppError('演示空间仅支持示例任务；添加真实任务请先微信登录。')
    return reference.id
  }
  return resolveThreadId(session.token!, reference)
}
async function routes(req: Request, url: URL, s: Session): Promise<Response> {
  const path = url.pathname
  if (path === '/api/auth/me' && req.method === 'GET') {
    return json({
      authenticated: authenticated(s),
      expired: !authenticated(s) && !!s.accountKey,
      demo: !!s.demo,
      user: s.user || null,
      expiresAt: s.token ? s.expire : null,
      scope: hash(s.id).slice(0, 20),
      mail: accountMailInfo(s),
    })
  }
  if (path === '/api/auth/demo' && req.method === 'POST') {
    if (s.token || s.accountKey)
      throw new AppError('请先退出当前微信账号，再进入演示。')
    s.demo = true
    s.user = { name: '体验用户', nickname: '本地演示' }
    saveSession(s)
    return json({ ok: true })
  }
  if (path === '/api/auth/login' && req.method === 'POST')
    return json(await startLogin(s))
  if (path === '/api/auth/login-mail' && req.method === 'POST') {
    const result = await loginMail.send(s)
    runBackground(() => flushNotices(), '邮件通知检查未完成。')
    return json(result)
  }
  if (path === '/api/auth/mail-status' && req.method === 'GET') {
    if (!accountMailInfo(s).remembered)
      throw new AppError('本地没有此微信账号的登录信息。', 403)
    const ids = url.searchParams.getAll('id')
    if (!ids.length || ids.length > 50)
      throw new AppError('邮件通知参数无效。')
    return json({
      notices: ids.map(id => mailStatus(s.accountKey!, id)),
    })
  }
  if (path === '/api/auth/poll' && req.method === 'POST') {
    const wasSuccessful = s.login?.status === 'success'
    const result = await pollLogin(s)
    if (!wasSuccessful && result.status === 'success' && s.accountKey) {
      await automations.registerLogin(s.accountKey, s)
      runBackground(() => automations.tick(), '自动签到检查未完成，下次检查将继续。')
    }
    return json(result)
  }
  if (path === '/api/auth/qr' && req.method === 'GET') {
    if (!s.login || s.login.expiresAt < Date.now())
      throw new AppError('二维码已失效。', 410)
    const r = await fetch(`https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(s.login.uuid)}`, {
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok)
      throw new AppError('无法载入二维码。', 502)
    return new Response(r.body, {
      headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
    })
  }
  if (path === '/api/auth/logout' && req.method === 'POST') {
    deleteSession(s.id)
    for (const [id, p] of prepared) {
      if (p.owner === s.id)
        prepared.delete(id)
    }
    return json({ ok: true })
  }
  requireAuth(s)
  if (path === '/api/notifications/test' && req.method === 'POST') {
    const body = await req.json()
    const id = queueTestMail(s, body.recipient)
    runBackground(() => flushNotices(), '邮件通知检查未完成。')
    return json({
      ids: [id],
    })
  }
  if (path === '/api/automations' && req.method === 'GET') {
    const owner = await manualThreadOwner(s)
    return json({
      plans: automations.list(owner),
      mail: mailSettings(),
      notices: mailHistory(owner),
    })
  }
  if (path === '/api/automations' && req.method === 'POST') {
    const body = await req.json()
    const id = await resolveForSession(s, String(body.threadId || ''))
    const plan = await automations.create(await manualThreadOwner(s), s, id)
    const { owner: _, schema: __, privacyHash: ___, ...publicPlan } = plan
    return json({
      plan: publicPlan,
      mail: mailSettings(),
      ...await automations.editableDaily(plan),
    })
  }
  const automationMatch = path.match(/^\/api\/automations\/([a-f\d-]{36})\/(draft|save|toggle|refresh|notify)$/)
  if (automationMatch) {
    const owner = await manualThreadOwner(s)
    const plan = getPlan(automationMatch[1], owner)
    if (automationMatch[2] === 'notify' && req.method === 'POST') {
      const id = automations.notify(owner, plan.id)
      runBackground(() => flushNotices(), '邮件通知检查未完成。')
      return json({
        ids: [id],
      })
    }
    if (automationMatch[2] === 'draft' && req.method === 'GET') {
      const { owner: _, schema: __, privacyHash: ___, ...publicPlan } = plan
      return json({
        plan: publicPlan,
        mail: mailSettings(),
        ...await automations.editableDaily(plan, url.searchParams.get('date') || undefined),
      })
    }
    if (automationMatch[2] === 'save' && req.method === 'POST') {
      const body = await req.json()
      return json({ run: await automations.save(owner, s, plan.id, String(body.date || ''), body) })
    }
    if (automationMatch[2] === 'toggle' && req.method === 'POST') {
      const body = await req.json()
      if (typeof body.enabled !== 'boolean')
        throw new AppError('请选择启动或暂停。')
      await automations.toggle(owner, plan.id, body.enabled)
      return json({ ok: true })
    }
    if (automationMatch[2] === 'refresh' && req.method === 'POST') {
      const body = await req.json()
      return json({ run: await automations.refresh(owner, s, plan.id, String(body.date || ''), body.revision) })
    }
  }
  if (path === '/api/threads' && req.method === 'GET') {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
    const type = Number(url.searchParams.get('listType') || 1)
    if (![1, 2, 5].includes(type) || page > 1000)
      throw new AppError('列表参数无效。')
    return json(s.demo
      ? {
          threads: demoThreads,
          page: { PageIndex: 1, PageSize: 50, TotalRecords: 3 },
        }
      : await listThreads(s.token!, page, type))
  }
  if (path === '/api/resolve' && req.method === 'POST') {
    const data = await req.json()
    return json({
      id: await resolveForSession(s, String(data.value || '')),
    })
  }
  if (path === '/api/manual-threads' && req.method === 'GET') {
    const page = Number(url.searchParams.get('page') || 1)
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000)
      throw new AppError('分页参数无效。')
    return json(manualThreads(await manualThreadOwner(s), page))
  }
  if (path === '/api/manual-threads' && req.method === 'POST') {
    const body = await req.json()
    const id = await resolveForSession(s, String(body.value || ''))
    const form = await schema(s, id, 0)
    saveManualThread(await manualThreadOwner(s), form.thread)
    return json({
      id: form.thread.id,
      form: publicSchema(form),
    })
  }
  if (path === '/api/history' && req.method === 'GET') {
    return json({
      items: [
        ...history(s.id),
        ...history(automationMediaOwner(await manualThreadOwner(s))),
      ].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100),
    })
  }
  if (path === '/api/media' && req.method === 'POST') {
    const data = await req.formData()
    const file = data.get('file')
    if (!(file instanceof File))
      throw new AppError('请选择文件。')
    return json(await stageMedia(s.id, file))
  }
  const mediaMatch = path.match(/^\/api\/(media|automation-media)\/([a-f\d-]{36})$/)
  if (mediaMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    const media = getMedia(mediaMatch[1] === 'automation-media'
      ? automationMediaOwner(await manualThreadOwner(s))
      : s.id, mediaMatch[2])
    if (!media)
      throw new AppError('附件不存在。', 404)
    const headers = { 'content-type': media.mime, 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(media.name)}`, 'cache-control': 'private, max-age=3600' }
    return fileResponse(media.path, req, headers)
  }
  const match = path.match(/^\/api\/threads\/([^/]+)\/(form|records|prepare|submit)$/)
  if (match) {
    const id = await resolveForSession(s, decodeURIComponent(match[1]))
    const action = match[2]
    const recordId = url.searchParams.get('recordId') || '0'
    if (!/^\d{1,24}$/.test(recordId))
      throw new AppError('记录 ID 无效。')
    if (action === 'form' && req.method === 'GET')
      return json(publicSchema(await schema(s, id, recordId)))
    if (action === 'records' && req.method === 'GET') {
      return json({
        records: s.demo
          ? []
          : await records(s.token!, id),
      })
    }
    if (action === 'prepare' && req.method === 'POST') {
      const lock = `${s.id}:${id}`
      if (locks.has(lock))
        throw new AppError('此任务正在处理，请稍候。', 409)
      locks.add(lock)
      try {
        const body = await req.json()
        const form = await schema(s, id, recordId)
        if (!form.canSubmit)
          throw new AppError(form.unavailableReason, 403)
        if (form.needPrivacy && body.privacyAgreed !== true)
          throw new AppError('请先确认表单的个人信息使用说明。')
        const draft = validateDraft(form, body as Draft)
        await resolveFiles(s.id, s.token || '', form, draft, !!s.demo)
        const payload = createPayload(form, draft)
        const key = crypto.randomUUID()
        const expiresAt = Date.now() + 10 * 60000
        for (const [k, v] of prepared) {
          if (v.expires < Date.now() || (v.owner === s.id && v.state === 'ready'))
            prepared.delete(k)
        }
        prepared.set(key, {
          owner: s.id,
          schema: form,
          payload,
          expires: expiresAt,
          fingerprint: hash({
            fields: form.fields,
            values: form.values,
            signature: form.signature,
            number: form.number,
          }),
          state: 'ready',
        })
        return json({
          key,
          expiresAt,
          payload,
          summary: {
            title: form.thread.title,
            signature: draft.signature,
            fieldCount: draft.values.filter(v => v.HasValue).length,
            files: draft.values.reduce((n, v) => n + v.Files.length, 0),
          },
          demo: !!s.demo,
        })
      }
      finally {
        locks.delete(lock)
      }
    }
    if (action === 'submit' && req.method === 'POST') {
      const { key } = await req.json()
      const item = prepared.get(String(key))
      if (!item || item.owner !== s.id || item.schema.thread.id !== id || item.expires < Date.now())
        throw new AppError('预览已过期，请重新预览。', 410)
      if (item.state === 'success')
        return json(item.result)
      if (item.state !== 'ready')
        throw new AppError('此请求已处理或结果待确认，请先查看官网记录。', 409)
      item.state = 'validating'
      try {
        const latest = await schema(s, id, item.schema.recordId)
        if (!latest.canSubmit || hash({
          fields: latest.fields,
          values: latest.values,
          signature: latest.signature,
          number: latest.number,
        }) !== item.fingerprint) {
          throw new AppError('表单权限或内容已变化，请重新打开并预览。', 409)
        }
        if (latest.base?.EditToken)
          item.payload.EditToken = latest.base.EditToken
        item.state = 'submitting'
        const result = s.demo
          ? { Type: '000001', Description: '演示提交完成，未向接龙管家发送数据。' }
          : await api(item.schema.endpoint, s.token!, item.payload)
        item.result = {
          ok: true,
          demo: !!s.demo,
          message: String(result.Description || '接龙管家已确认提交成功。'),
        }
        item.state = 'success'
        addHistory(s.id, {
          threadId: id,
          title: item.schema.thread.title,
          signature: item.payload.Signature,
          status: 'success',
          demo: !!s.demo,
          message: item.result.message,
          recordId: item.schema.recordId,
        })
        return json(item.result)
      }
      catch (e) {
        const uncertain = item.state === 'submitting' && !(e instanceof AppError && e.code === 'UPSTREAM_ERROR')
        item.state = uncertain ? 'unknown' : 'invalid'
        addHistory(s.id, {
          threadId: id,
          title: item.schema.thread.title,
          status: uncertain ? 'unknown' : 'failed',
          demo: !!s.demo,
          message: uncertain ? '请求结果未确认，请查看官网记录后再操作。' : (e as Error).message,
        })
        if (uncertain)
          throw new AppError('提交结果未确认，请先到官网核对记录，避免重复提交。', 502, 'SUBMISSION_UNCERTAIN')
        throw e
      }
    }
  }
  throw new AppError('接口不存在。', 404)
}
async function handleRequest(req: Request) {
  const url = new URL(req.url)
  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': 'default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' blob: data: https:; media-src \'self\' blob: https:; connect-src \'self\'; object-src \'none\'; base-uri \'self\'; frame-ancestors \'none\'; form-action \'self\'',
  }
  let cookie = ''
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.get('origin')
      if (origin !== (process.env.PUBLIC_ORIGIN || url.origin))
        throw new AppError('请求来源不匹配，请从网站内操作。', 403)
    }
    let response: Response
    if (url.pathname.startsWith('/api/')) {
      const sid = req.headers.get('cookie')?.match(/(?:^|;\s*)jielong_session=([a-f\d-]{36})/)?.[1]
      let s = sid
        ? getSession(sid)
        : null
      if (!s) {
        s = {
          id: crypto.randomUUID(),
          expire: Date.now() + 7 * 86400000,
        }
        saveSession(s)
      }
      syncSessionAuth(s)
      cookie = `jielong_session=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionMaxAge}${process.env.PUBLIC_ORIGIN?.startsWith('https:')
        ? '; Secure'
        : ''}`
      try {
        response = await routes(req, url, s)
      }
      catch (error) {
        if (!url.pathname.startsWith('/api/auth/') && error instanceof AppError && error.code === 'AUTH_REQUIRED')
          invalidateSessionAuth(s)
        throw error
      }
      if (url.pathname === '/api/auth/logout' && req.method === 'POST')
        cookie = cookie.replace(`Max-Age=${sessionMaxAge}`, 'Max-Age=0')
    }
    else if (req.method === 'GET' || req.method === 'HEAD') {
      const files: Record<string, string> = {
        '/': 'index.html',
        '/styles.css': 'styles.css',
        '/assets/app.js': 'assets/app.js',
        '/favicon.svg': 'favicon.svg',
        '/watermark-logo.webp': 'watermark-logo.webp',
      }
      const path = files[url.pathname]
      if (!path)
        throw new AppError('页面不存在。', 404)
      response = await fileResponse(join(root, 'public', path), req, { 'cache-control': 'no-cache' })
    }
    else {
      throw new AppError('请求方法不支持。', 405)
    }
    for (const [key, value] of Object.entries(headers))
      response.headers.set(key, value)
    if (cookie)
      response.headers.set('set-cookie', cookie)
    return response
  }
  catch (e) {
    const err = e instanceof AppError
      ? e
      : new AppError(e instanceof SyntaxError
          ? '请求数据格式错误。'
          : '处理失败，请重试。', e instanceof SyntaxError
          ? 400
          : 500)
    const response = json({ error: err.message, code: err.code }, err.status)
    for (const [key, value] of Object.entries(headers))
      response.headers.set(key, value)
    if (cookie)
      response.headers.set('set-cookie', cookie)
    return response
  }
}
async function start() {
  const activeRequests = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    const task = handleNodeRequest(request, response, handleRequest)
      .catch(() => { response.destroy() })
      .finally(() => activeRequests.delete(task))
    activeRequests.add(task)
  })
  server.requestTimeout = 90000
  server.timeout = 90000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(process.env.PORT) || 3210, process.env.HOST || '127.0.0.1', resolve)
  })
  recoverInterruptedCheckins()
  recoverInterruptedMail()
  const tick = () => {
    runBackground(() => automations.tick(), '自动签到检查未完成，下次检查将继续。')
    if (mailSettings().configured)
      runBackground(() => flushNotices(), '邮件通知检查未完成。')
  }
  const firstTick = setTimeout(tick, 1500)
  const interval = setInterval(tick, 30000)
  const loginMailInterval = setInterval(() => {
    runBackground(() => loginMail.tick(), '邮件扫码状态检查未完成。')
  }, 5000)
  runBackground(() => loginMail.tick(), '邮件扫码状态检查未完成。')
  const shutdown = async () => {
    if (stopping)
      return
    stopping = true
    clearTimeout(firstTick)
    clearInterval(interval)
    clearInterval(loginMailInterval)
    const deadline = setTimeout(() => {
      console.warn('退出等待超过 60 秒，保留执行状态，下次启动时核对。')
      server.closeAllConnections()
      process.exit(1)
    }, 60000)
    await new Promise<void>(resolve => server.close(() => resolve()))
    await Promise.allSettled([
      ...activeRequests,
      ...backgroundJobs,
    ])
    clearTimeout(deadline)
    db.close()
    process.exit(0)
  }
  const stop = () => {
    void shutdown().catch(() => process.exit(1))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const address = server.address()
  if (address && typeof address !== 'string')
    console.warn(`接龙工作台已启动：http://${address.address}:${address.port}`)
  process.send?.('ready')
}
void start().catch((error) => {
  console.error(error)
  process.exit(1)
})
