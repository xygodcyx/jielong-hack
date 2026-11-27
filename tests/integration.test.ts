import { spawn } from 'node:child_process'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { afterAll, beforeAll, expect, it } from 'vitest'

let child: ReturnType<typeof spawn>
let childExited: Promise<number | null>
let cookie = ''
const origin = 'http://127.0.0.1:43210'
async function call(path: string, body?: unknown, session = cookie) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined
      ? 'GET'
      : 'POST',
    headers: {
      origin,
      cookie: session,
      ...(body instanceof FormData || body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
    },
    ...(body === undefined
      ? {}
      : {
          body: body instanceof FormData
            ? body
            : JSON.stringify(body),
        }),
  })
  if (response.headers.get('set-cookie'))
    cookie = response.headers.get('set-cookie')!.split(';')[0]
  return {
    status: response.status,
    data: await response.json(),
    setCookie: response.headers.get('set-cookie'),
  }
}
async function startServer() {
  child = spawn(process.execPath, ['--env-file-if-exists=.env', '--enable-source-maps', 'dist/server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '43210',
      PUBLIC_ORIGIN: origin,
      BASE_URL: origin,
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      TO_EMAIL: '',
      JIELONG_DATA_DIR: `${process.env.JIELONG_DATA_DIR}/integration`,
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  childExited = new Promise(resolve => child.once('exit', resolve))
  let errors = ''
  child.stderr!.on('data', (chunk) => {
    errors += String(chunk).slice(0, 10000)
  })
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('测试服务未能启动')), 5000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timeout)
      reject(new Error(`测试服务提前退出：${errors}`))
    })
    child.once('message', (message) => {
      if (message === 'ready') {
        clearTimeout(timeout)
        resolve()
      }
    })
  })
  await call('/api/auth/me')
}
async function stopServer() {
  if (!child)
    return
  child.kill('SIGTERM')
  expect(await childExited).toBe(0)
}
beforeAll(startServer, 10000)
afterAll(stopServer)
it('完整演示流程：隔离会话、校验、生成预览、确认提交、重复提交去重', async () => {
  expect((await call('/api/threads')).status).toBe(401)
  await call('/api/auth/demo', {})
  const tasks = await call('/api/threads?listType=1')
  expect(tasks.data.threads).toHaveLength(3)
  const badList = await call('/api/threads?listType=0')
  expect(badList.status).toBe(400)
  const form = (await call('/api/threads/demo-watermark/form')).data
  expect(form.recordId).toBe(0)
  expect(form.base).toBeUndefined()
  const draft = {
    signature: '测试用户',
    number: '',
    values: structuredClone(form.values),
  }
  expect((await call('/api/threads/demo-watermark/prepare', draft)).status).toBe(400)
  draft.values.find((v: any) => v.FieldId === 2).Values = ['1']
  const location = draft.values.find((v: any) => v.FieldId === 5)
  location.Values = ['{"latitude":1.2,"longitude":3.4}']
  location.Texts = ['测试地点']
  const image = await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 3,
      background: '#c8ded0',
    },
  }).jpeg().toBuffer()
  const upload = new FormData()
  upload.set('file', new File([new Uint8Array(image).buffer], 'watermark.jpg', { type: 'image/jpeg' }))
  const staged = await call('/api/media', upload)
  expect(staged.status).toBe(200)
  draft.values[0].Files = [
    { LocalId: staged.data.id },
  ]
  const ready = await call('/api/threads/demo-watermark/prepare', draft)
  expect(ready.status).toBe(200)
  expect(ready.data.payload.RecordValues[0].FieldType).toBe(25)
  expect(ready.data.payload.RecordValues[0].Files[0].MediaType).toBe(1)
  expect((await call('/api/history')).data.items).toHaveLength(0)
  const key = ready.data.key
  const ownCookie = cookie
  expect((await call('/api/threads/demo-watermark/submit', { key }, '')).status).toBe(401)
  cookie = ownCookie
  const responses = await Promise.all([
    call('/api/threads/demo-watermark/submit', { key }),
    call('/api/threads/demo-watermark/submit', { key }),
  ])
  expect(responses.some(r => r.status === 200)).toBe(true)
  expect(responses.every(r => [200, 409].includes(r.status))).toBe(true)
  const repeat = await call('/api/threads/demo-watermark/submit', { key })
  expect(repeat.status).toBe(200)
  expect(repeat.data.demo).toBe(true)
  expect((await call('/api/history')).data.items).toHaveLength(1)
  const csrf = await fetch(`${origin}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie, origin: 'https://unrelated.test' },
  })
  expect(csrf.status).toBe(403)
}, 10000)

it('手动添加分类在服务重启后保留，重复添加不重复建档', async () => {
  expect((await call('/api/manual-threads')).data.threads).toHaveLength(0)
  const first = await call('/api/manual-threads', { value: 'demo-watermark' })
  expect(first.status).toBe(200)
  expect(first.data.id).toBe('demo-watermark')
  expect(first.data.form.thread.title).toBe('校园日常签到')
  await call('/api/manual-threads', { value: 'demo-watermark' })
  expect((await call('/api/manual-threads')).data.page.TotalRecords).toBe(1)
  await stopServer()
  await startServer()
  const saved = await call('/api/manual-threads')
  expect(saved.status).toBe(200)
  expect(saved.data.threads.map((t: any) => t.id)).toEqual(['demo-watermark'])
  const ownCookie = cookie
  await call('/api/auth/me', undefined, '')
  await call('/api/auth/demo', {})
  expect((await call('/api/manual-threads')).data.threads).toHaveLength(0)
  cookie = ownCookie
  expect((await call('/api/manual-threads')).data.threads).toHaveLength(1)
}, 10000)

it('自动签到计划默认暂停、无需邮箱，待办重启保留且隔离其他账号', async () => {
  expect((await call('/api/automations', { threadId: 'demo-watermark' })).status).toBe(422)
  const created = await call('/api/automations', { threadId: 'demo-checkin' })
  expect(created.status).toBe(200)
  expect(created.data.plan.enabled).toBe(false)
  expect(created.data.run.source).toBe('empty')
  expect(created.data.run.schema.base).toBeUndefined()
  const id = created.data.plan.id
  expect((await call(`/api/automations/${id}/toggle`, { enabled: true })).status).toBe(400)
  const run = created.data.run
  run.draft.values[0].Texts = ['持久化的明日阅读计划']
  run.draft.values[1].Texts = [30]
  const saved = await call(`/api/automations/${id}/save`, {
    date: run.date,
    revision: run.revision,
    draft: run.draft,
    enabled: false,
    recipient: '',
    time: '18:00',
  })
  expect(saved.status).toBe(200)
  expect((await call(`/api/automations/${id}/save`, { date: run.date, revision: run.revision, draft: run.draft })).status).toBe(409)
  await stopServer()
  await startServer()
  const persisted = await call(`/api/automations/${id}/draft?date=${run.date}`)
  expect(persisted.status).toBe(200)
  expect(persisted.data.run.draft.values[0].Texts).toEqual(['持久化的明日阅读计划'])
  const listed = await call('/api/automations')
  expect(listed.data.plans).toHaveLength(1)
  expect(listed.data.plans[0].owner).toBeUndefined()
  expect(listed.data.plans[0].emailEnabled).toBe(false)
  const ownCookie = cookie
  await call('/api/auth/me', undefined, '')
  await call('/api/auth/demo', {})
  expect((await call(`/api/automations/${id}/draft`)).status).toBe(404)
  cookie = ownCookie
}, 10000)

it('两地登录共享最新凭证，过期设备保留身份，重启可恢复且主动退出只撤销当前设备', async () => {
  const ownCookie = cookie
  const database = new DatabaseSync(`${process.env.JIELONG_DATA_DIR}/integration/state.sqlite`)
  const owner = 'wechat:fixture-shared-login'
  const first = {
    id: crypto.randomUUID(),
    accountKey: owner,
    token: 'Bearer fixture-first-expired',
    expire: Date.now() - 1000,
    user: { name: '过期设备' },
  }
  const second = {
    ...first,
    id: crypto.randomUUID(),
    token: 'Bearer fixture-second-renewed',
    expire: Date.now() + 3600000,
    user: { name: '同一微信' },
    login: { status: 'success', expiresAt: Date.now() + 60000 },
  }
  const firstCookie = `jielong_session=${first.id}`
  const secondCookie = `jielong_session=${second.id}`
  try {
    for (const s of [first, second])
      database.prepare('INSERT INTO sessions VALUES (?,?,?)').run(s.id, JSON.stringify(s), s.expire)
    database.prepare('INSERT INTO automation_accounts VALUES (?,?)').run(owner, JSON.stringify(first))
    const expired = await call('/api/auth/me', undefined, firstCookie)
    expect(expired.data.authenticated).toBe(false)
    expect(expired.data.expired).toBe(true)
    expect(cookie).toBe(firstCookie)
    expect((await call('/api/manual-threads', undefined, firstCookie)).status).toBe(401)

    database.prepare('UPDATE automation_accounts SET data=? WHERE owner=?').run(JSON.stringify(second), owner)
    const restored = await call('/api/auth/me', undefined, firstCookie)
    expect(restored.data.authenticated).toBe(true)
    expect(restored.data.expired).toBe(false)
    expect(restored.data.scope).toBe(expired.data.scope)
    expect(restored.data.user.name).toBe('同一微信')
    expect(restored.data.expiresAt).toBe(second.expire)
    expect(restored.setCookie).toContain('Max-Age=31536000')
    expect(JSON.stringify(restored.data)).not.toContain(second.token)
    expect((await call('/api/manual-threads', undefined, firstCookie)).status).toBe(200)
    const persisted = database.prepare('SELECT data FROM sessions WHERE id=?').get(first.id) as { data: string }
    expect(JSON.parse(persisted.data).token).toBe(second.token)
    expect((await call('/api/auth/poll', {}, secondCookie)).data.status).toBe('success')

    await stopServer()
    await startServer()
    expect((await call('/api/auth/me', undefined, firstCookie)).data.authenticated).toBe(true)
    const logout = await call('/api/auth/logout', {}, firstCookie)
    expect(logout.setCookie).toContain('Max-Age=0')
    expect((await call('/api/auth/me', undefined, firstCookie)).data.authenticated).toBe(false)
    expect(cookie).not.toBe(firstCookie)
    expect((await call('/api/auth/me', undefined, secondCookie)).data.authenticated).toBe(true)
    expect((await call(`/api/auth/me?accountKey=${owner}`, undefined, '')).data.authenticated).toBe(false)
  }
  finally {
    database.close()
    cookie = ownCookie
  }
}, 10000)
