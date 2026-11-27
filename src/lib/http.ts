import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { Buffer } from 'node:buffer'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AppError } from './api.ts'

export async function handleNodeRequest(incoming: IncomingMessage, outgoing: ServerResponse, handler: (request: Request) => Promise<Response>, maxBodySize = 105 * 1024 * 1024) {
  try {
    const headers = new Headers()
    for (let index = 0; index < incoming.rawHeaders.length; index += 2)
      headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
    const method = incoming.method || 'GET'
    const chunks: Buffer[] = []
    let size = 0
    if (Number(headers.get('content-length')) > maxBodySize)
      throw new AppError('请求体不能超过 105 MB。', 413, 'PAYLOAD_TOO_LARGE')
    for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
      size += chunk.length
      if (size > maxBodySize)
        throw new AppError('请求体不能超过 105 MB。', 413, 'PAYLOAD_TOO_LARGE')
      chunks.push(chunk)
    }
    const request = new Request(new URL(incoming.url || '/', `http://${headers.get('host') || 'localhost'}`), {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : {
            body: Buffer.concat(chunks, size),
          }),
    })
    const response = await handler(request)
    outgoing.statusCode = response.status
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie')
        outgoing.setHeader(key, value)
    })
    const cookies = response.headers.getSetCookie()
    if (cookies.length)
      outgoing.setHeader('set-cookie', cookies)
    if (method === 'HEAD' || !response.body) {
      await response.body?.cancel()
      outgoing.end()
    }
    else {
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream), outgoing)
    }
  }
  catch (error) {
    if (outgoing.headersSent || outgoing.destroyed) {
      outgoing.destroy()
      return
    }
    const problem = error instanceof AppError
      ? error
      : new AppError('请求处理失败，请重试。', 500)
    outgoing.writeHead(problem.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'close',
      'x-content-type-options': 'nosniff',
    })
    outgoing.end(JSON.stringify({ error: problem.message, code: problem.code }))
    incoming.resume()
  }
}

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}
export async function fileResponse(path: string, request: Request, initialHeaders: HeadersInit = {}) {
  const info = await stat(path).catch(() => {
    throw new AppError('文件不存在。', 404)
  })
  if (!info.isFile())
    throw new AppError('文件不存在。', 404)
  const headers = new Headers(initialHeaders)
  if (!headers.has('content-type'))
    headers.set('content-type', mimeTypes[extname(path)] || 'application/octet-stream')
  headers.set('accept-ranges', 'bytes')
  let start = 0
  let end = info.size - 1
  let status = 200
  const range = request.method === 'GET'
    ? request.headers.get('range')
    : null
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/)
    if (match && (match[1] || match[2])) {
      start = match[1]
        ? Number(match[1])
        : Math.max(0, info.size - Number(match[2]))
      end = match[1] && match[2]
        ? Math.min(Number(match[2]), end)
        : end
    }
    if (!match || (!match[1] && !match[2]) || start > end || start >= info.size || (!match[1] && Number(match[2]) === 0)) {
      headers.set('content-range', `bytes */${info.size}`)
      return new Response(null, { status: 416, headers })
    }
    status = 206
    headers.set('content-range', `bytes ${start}-${end}/${info.size}`)
  }
  headers.set('content-length', String(Math.max(0, end - start + 1)))
  const body = request.method === 'HEAD' || !info.size
    ? null
    : Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>
  return new Response(body, { status, headers })
}
