import type { JsonObject } from '../shared.ts'
import { api, AppError, query } from './api.ts'

export interface ThreadReference {
  id: string
  kind?: 'feedback' | 'checkin'
}

export interface ShareReference {
  shareUrl: string
}

export type TaskReference = ThreadReference | ShareReference

export function parseThreadReference(raw: string): TaskReference {
  let value = raw.trim()
  if (/^demo-[a-z]+$/.test(value))
    return { id: value }
  if (/^[a-z\d]{1,64}$/i.test(value)) {
    return {
      id: validateId(value),
    }
  }
  if (/^(?:[\w-]+\.)*jielong\.com\//i.test(value))
    value = `https://${value}`
  try {
    let url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.hostname !== 'jielong.com' && !url.hostname.endsWith('.jielong.com')))
      throw new Error('Invalid task URL')
    if (url.hash.startsWith('#/'))
      url = new URL(url.hash.slice(1), url.origin)
    const parts = url.pathname.split('/').filter(Boolean)
    const route = (parts[0] || '').toLowerCase()
    if (route === 's' && parts.length >= 2)
      return { shareUrl: shareDestination(url).href }
    const kind = ['c', 'checkin-detail'].includes(route)
      ? 'checkin'
      : ['fb', 'feedback-detail'].includes(route)
          ? 'feedback'
          : undefined
    const parameter = url.searchParams.get('threadId') || url.searchParams.get('ThreadId')
    const id = parameter || (['fb', 'c'].includes(route) && parts.length === 2
      ? decodeURIComponent(parts[1])
      : '')
    return {
      id: validateId(id),
      kind,
    }
  }
  catch {
    throw new AppError('请输入接龙任务链接、短 ID 或数字 ThreadId。')
  }
}

function shareDestination(value: URL) {
  const url = new URL(value)
  if (url.protocol === 'http:')
    url.protocol = 'https:'
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['jielong.com', 'www.jielong.com', 'i.jielong.com'].includes(url.hostname))
    throw new AppError('分享链接的跳转目标不是受支持的接龙地址。')
  url.hash = ''
  return url
}

async function resolveShareLink(reference: ShareReference, fetcher: typeof fetch): Promise<ThreadReference> {
  let url = shareDestination(new URL(reference.shareUrl))
  const visited = new Set<string>()
  const signal = AbortSignal.timeout(15000)
  for (let hop = 0; hop < 5; hop++) {
    if (visited.has(url.href))
      throw new AppError('分享链接发生循环跳转，请检查链接。', 502, 'UPSTREAM_ERROR')
    visited.add(url.href)
    let response: Response
    try {
      // 分享跳转是公开请求，不携带账号 Token 或 Cookie，也不自动跟随未知目标。
      response = await fetcher(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'text/html, */*' },
        signal,
      })
    }
    catch {
      throw new AppError('无法读取分享链接，请检查网络后重试。', 502, 'NETWORK_ERROR')
    }
    await response.body?.cancel().catch(() => {})
    if (![301, 302, 303, 307, 308].includes(response.status))
      throw new AppError(`分享链接未返回有效的跳转目标（HTTP ${response.status}）。`, 502, 'UPSTREAM_ERROR')
    const location = response.headers.get('location')
    if (!location)
      throw new AppError('分享链接响应缺少跳转地址。', 502, 'UNSUPPORTED_SCHEMA')
    try {
      url = shareDestination(new URL(location, url))
    }
    catch (error) {
      if (error instanceof AppError)
        throw error
      throw new AppError('分享链接返回了无效的跳转地址。', 502, 'UNSUPPORTED_SCHEMA')
    }
    try {
      const target = parseThreadReference(url.href)
      if ('id' in target)
        return target
    }
    catch {
      // 允许官方站点的中间跳转页，下一轮仍逐跳验证地址并限制总次数。
    }
  }
  throw new AppError('分享链接跳转次数过多，请使用最终任务链接。', 502, 'UPSTREAM_ERROR')
}

function validateId(value: string) {
  if (!/^[a-z\d]{1,64}$/i.test(value) || /^0+$/.test(value))
    throw new AppError('任务 ID 格式无效。')
  return /^\d+$/.test(value)
    ? value.replace(/^0+/, '')
    : value
}

function numericThreadId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0
      ? String(value)
      : null
  }
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? value
    : null
}

export async function resolveThreadId(token: string, input: string | TaskReference, fetcher: typeof fetch = fetch): Promise<string> {
  const parsed = typeof input === 'string'
    ? parseThreadReference(input)
    : input
  const reference = 'shareUrl' in parsed
    ? await resolveShareLink(parsed, fetcher)
    : parsed
  if (/^\d+$/.test(reference.id))
    return reference.id
  const endpoints = reference.kind === 'checkin'
    ? ['/api/CheckIn/Detail']
    : reference.kind === 'feedback'
      ? ['/api/FeedBack/ThreadDetail']
      : ['/api/FeedBack/ThreadDetail', '/api/CheckIn/Detail']
  let firstError: unknown
  for (const endpoint of endpoints) {
    let body: JsonObject
    try {
      body = await api(query(endpoint, { threadId: reference.id }), token, undefined, fetcher)
    }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'UPSTREAM_ERROR')
        throw error
      firstError ??= error
      continue
    }
    const id = numericThreadId(body.Data?.Thread?.ThreadId ?? body.Data?.ThreadId)
    if (!id)
      throw new AppError('任务详情没有返回有效的 ThreadId。', 502, 'UNSUPPORTED_SCHEMA')
    return id
  }
  throw firstError || new AppError('无法解析该任务，请检查链接或 ID。')
}
