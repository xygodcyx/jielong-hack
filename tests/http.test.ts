import { writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { fileResponse, handleNodeRequest } from '../src/lib/http.ts'

const file = join(process.env.JIELONG_DATA_DIR!, 'fixture.txt')
const server = createServer((incoming, outgoing) => {
  void handleNodeRequest(incoming, outgoing, async (req) => {
    if (new URL(req.url).pathname === '/file')
      return fileResponse(file, req)
    return Response.json(await req.json(), {
      headers: { 'set-cookie': 'fixture=value; HttpOnly; SameSite=Strict' },
    })
  }, 1024)
})
let origin: string
beforeAll(async () => {
  await writeFile(file, 'fixture-content')
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('测试服务未监听端口')
  origin = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

it('node HTTP 保留 JSON 请求与响应 Cookie', async () => {
  const response = await fetch(`${origin}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '测试内容' }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ text: '测试内容' })
  expect(response.headers.get('set-cookie')).toContain('HttpOnly')
})

it('静态文件、HEAD 与媒体分段读取保留长度及状态', async () => {
  const full = await fetch(`${origin}/file`)
  expect(full.status).toBe(200)
  expect(await full.text()).toBe('fixture-content')
  const head = await fetch(`${origin}/file`, { method: 'HEAD' })
  expect(head.headers.get('content-length')).toBe('15')
  expect(await head.text()).toBe('')
  const partial = await fetch(`${origin}/file`, {
    headers: { range: 'bytes=0-6' },
  })
  expect(partial.status).toBe(206)
  expect(partial.headers.get('content-range')).toBe('bytes 0-6/15')
  expect(await partial.text()).toBe('fixture')
  const suffix = await fetch(`${origin}/file`, {
    headers: { range: 'bytes=-7' },
  })
  expect(await suffix.text()).toBe('content')
  const invalid = await fetch(`${origin}/file`, {
    headers: { range: 'bytes=50-' },
  })
  expect(invalid.status).toBe(416)
  expect(invalid.headers.get('content-range')).toBe('bytes */15')
})

it('已声明和分块传输的过大请求均返回 413', async () => {
  const declared = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${origin}/echo`, {
      method: 'POST',
      headers: { 'content-length': '2048' },
    }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    req.once('error', reject)
    req.end()
  })
  expect(declared).toBe(413)
  const chunked = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${origin}/echo`, {
      method: 'POST',
      headers: { 'transfer-encoding': 'chunked' },
    }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    req.once('error', reject)
    req.write('x'.repeat(1024))
    req.end('x')
  })
  expect(chunked).toBe(413)
})
