import process from 'node:process'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import sharp from 'sharp'

let child: ReturnType<typeof Bun.spawn>
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
  return { status: response.status, data: await response.json() }
}
async function startServer() {
  child = Bun.spawn(['bun', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, PORT: '43210', JIELONG_DATA_DIR: `${process.env.JIELONG_DATA_DIR}/integration` },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  for (let i = 0; i < 50; i++) {
    try {
      await call('/api/auth/me')
      return
    }
    catch {
      await Bun.sleep(100)
    }
  }
  throw new Error('测试服务未能启动')
}
beforeAll(startServer, 10000)
afterAll(async () => {
  child?.kill()
  await child?.exited
})
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
  child.kill()
  await child.exited
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
  child.kill()
  await child.exited
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
