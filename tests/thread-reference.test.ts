import { describe, expect, it } from 'vitest'
import { parseThreadReference, resolveThreadId } from '../src/lib/thread-reference.ts'

describe('任务链接与短 ID', () => {
  it('接受任务链接、短 ID 和数字 ThreadId', () => {
    expect(parseThreadReference(' https://i.jielong.com/fb/2XY9XM9MCY?from=share#detail ')).toEqual({ id: '2XY9XM9MCY', kind: 'feedback' })
    expect(parseThreadReference('2XY9XM9MCY')).toEqual({ id: '2XY9XM9MCY' })
    expect(parseThreadReference('192102039')).toEqual({ id: '192102039' })
    expect(parseThreadReference('000192102039')).toEqual({ id: '192102039' })
    expect(parseThreadReference('i.jielong.com/fb/2XY9XM9MCY')).toEqual({ id: '2XY9XM9MCY', kind: 'feedback' })
  })

  it('保留打卡路径类型，支持查询参数、尾斜杠和 hash 链接', () => {
    expect(parseThreadReference('https://i.jielong.com/c/2XY9XM9MCY/')).toEqual({ id: '2XY9XM9MCY', kind: 'checkin' })
    expect(parseThreadReference('https://i.jielong.com/feedback-detail?threadId=2XY9XM9MCY')).toEqual({ id: '2XY9XM9MCY', kind: 'feedback' })
    expect(parseThreadReference('https://i.jielong.com/#/fb/2XY9XM9MCY')).toEqual({ id: '2XY9XM9MCY', kind: 'feedback' })
  })

  it('拒绝无效链接、协议和任务 ID', () => {
    for (const value of [
      '',
      '0',
      'javascript:alert(1)',
      'https://i.jielong.com.evil.test/fb/2XY9XM9MCY',
      'https://i.jielong.com/fb/',
      'https://i.jielong.com/fb/../../',
      'https://user:password@i.jielong.com/fb/2XY9XM9MCY',
    ])
      expect(() => parseThreadReference(value)).toThrow()
  })

  it('从详情响应读取真实 ThreadId，使用当前会话的凭证', async () => {
    const calls: { url: URL, headers: Headers }[] = []
    const fetcher = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: new URL(String(url)),
        headers: new Headers(init?.headers),
      })
      return Response.json({
        Type: '000001',
        Data: {
          Thread: { ThreadId: 192102039, ThreadStrId: '2XY9XM9MCY', ThreadType: 0 },
        },
      })
    }, {
      preconnect: () => {},
    }) as typeof fetch
    expect(await resolveThreadId('Bearer fixture-current-session', 'https://i.jielong.com/fb/2XY9XM9MCY', fetcher)).toBe('192102039')
    expect(calls).toHaveLength(1)
    expect(calls[0].url.pathname).toBe('/api/FeedBack/ThreadDetail')
    expect(calls[0].url.searchParams.get('threadId')).toBe('2XY9XM9MCY')
    expect(calls[0].headers.get('authorization')).toBe('Bearer fixture-current-session')
    expect(await resolveThreadId('Bearer fixture-current-session', '192102039', fetcher)).toBe('192102039')
    expect(calls).toHaveLength(1)
  })

  it('打卡短 ID 使用打卡详情，裸短 ID 可以识别打卡', async () => {
    const calls: string[] = []
    const fetcher = Object.assign(async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname
      calls.push(path)
      return Response.json(path === '/api/FeedBack/ThreadDetail'
        ? { Type: '200040', Description: '此任务为打卡' }
        : {
            Type: '000001',
            Data: {
              Thread: { ThreadId: 12345, ThreadType: 5 },
            },
          })
    }, {
      preconnect: () => {},
    }) as typeof fetch
    expect(await resolveThreadId('Bearer fixture', '2XY9XM9MCY', fetcher)).toBe('12345')
    expect(calls).toEqual(['/api/FeedBack/ThreadDetail', '/api/CheckIn/Detail'])
    calls.length = 0
    expect(await resolveThreadId('Bearer fixture', 'https://i.jielong.com/c/2XY9XM9MCY', fetcher)).toBe('12345')
    expect(calls).toEqual(['/api/CheckIn/Detail'])
  })

  it('登录失效与缺少 ThreadId 时不会继续错误加载其他接口', async () => {
    let calls = 0
    const fetcher = Object.assign(async () => {
      calls++
      return Response.json({ Type: '100000', Description: '登录失效' })
    }, {
      preconnect: () => {},
    }) as typeof fetch
    await expect(resolveThreadId('Bearer fixture', '2XY9XM9MCY', fetcher)).rejects.toThrow('登录已失效')
    expect(calls).toBe(1)
    const malformed = Object.assign(async () => Response.json({ Type: '000001', Data: {} }), {
      preconnect: () => {},
    }) as typeof fetch
    await expect(resolveThreadId('Bearer fixture', '2XY9XM9MCY', malformed)).rejects.toThrow('ThreadId')
  })
})

describe('接龙分享重定向', () => {
  const shareUrl = 'https://jielong.com/s/NjU2MTkyLDMwMDIwMSwxLDE5MTk2MTg5MQ=='

  it('保留不透明的分享参数，不将其当作任务 ID', () => {
    expect(parseThreadReference(shareUrl)).toEqual({ shareUrl })
    expect(parseThreadReference(shareUrl.replace('https://', ''))).toEqual({ shareUrl })
  })

  it('读取 302 目标后解析 ThreadId，公开跳转不携带 Token 或 Cookie', async () => {
    const calls: { url: URL, headers: Headers, redirect?: RequestRedirect, method?: string }[] = []
    const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({
        url,
        headers: new Headers(init?.headers),
        redirect: init?.redirect,
        method: init?.method,
      })
      if (url.hostname === 'jielong.com') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://i.jielong.com/fb/2XYXYRXSYX' },
        })
      }
      return Response.json({
        Type: '000001',
        Data: {
          Thread: { ThreadId: 191961891 },
        },
      })
    }, {
      preconnect: () => {},
    }) as typeof fetch
    expect(await resolveThreadId('Bearer fixture-current-session', shareUrl, fetcher)).toBe('191961891')
    expect(calls).toHaveLength(2)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].redirect).toBe('manual')
    expect(calls[0].headers.has('authorization')).toBe(false)
    expect(calls[0].headers.has('cookie')).toBe(false)
    expect(calls[1].url.hostname).toBe('i-api.jielong.com')
    expect(calls[1].url.searchParams.get('threadId')).toBe('2XYXYRXSYX')
    expect(calls[1].headers.get('authorization')).toBe('Bearer fixture-current-session')
  })

  it('支持多级、相对地址跳转，并保留最终打卡类型', async () => {
    const calls: URL[] = []
    const fetcher = Object.assign(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      calls.push(url)
      if (url.pathname.startsWith('/s/Nj')) {
        return new Response(null, {
          status: 301,
          headers: { location: '/s/next' },
        })
      }
      if (url.pathname === '/s/next') {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://i.jielong.com/c/2XYXYRXSYX' },
        })
      }
      return Response.json({
        Type: '000001',
        Data: {
          Thread: { ThreadId: 12345, ThreadType: 5 },
        },
      })
    }, {
      preconnect: () => {},
    }) as typeof fetch
    expect(await resolveThreadId('Bearer fixture', shareUrl, fetcher)).toBe('12345')
    expect(calls.map(url => url.pathname)).toEqual(['/s/NjU2MTkyLDMwMDIwMSwxLDE5MTk2MTg5MQ==', '/s/next', '/api/CheckIn/Detail'])
  })

  it('拒绝缺少 Location、失效页面和网络异常', async () => {
    for (const response of [
      new Response(null, { status: 302 }),
      new Response('expired', { status: 404 }),
      new Response('not a redirect', { status: 200 }),
    ]) {
      const fetcher = Object.assign(async () => response, {
        preconnect: () => {},
      }) as typeof fetch
      await expect(resolveThreadId('Bearer fixture', shareUrl, fetcher)).rejects.toThrow('分享链接')
    }
    const unavailable = Object.assign(async () => {
      throw new Error('network')
    }, {
      preconnect: () => {},
    }) as typeof fetch
    await expect(resolveThreadId('Bearer fixture', shareUrl, unavailable)).rejects.toThrow('无法读取分享链接')
  })

  it('检测循环并限制最多五次公开跳转', async () => {
    const loop = Object.assign(async () => new Response(null, {
      status: 302,
      headers: { location: shareUrl },
    }), {
      preconnect: () => {},
    }) as typeof fetch
    await expect(resolveThreadId('Bearer fixture', shareUrl, loop)).rejects.toThrow('循环跳转')
    let count = 0
    const chain = Object.assign(async () => {
      count++
      return new Response(null, {
        status: 302,
        headers: { location: `/s/hop-${count}` },
      })
    }, {
      preconnect: () => {},
    }) as typeof fetch
    await expect(resolveThreadId('Bearer fixture', shareUrl, chain)).rejects.toThrow('跳转次数过多')
    expect(count).toBe(5)
  })

  it('在访问外部域名、异常端口或带凭证的目标前拒绝跳转', async () => {
    for (const location of [
      'https://unrelated.test/fb/2XYXYRXSYX',
      'https://i.jielong.com.evil.test/fb/2XYXYRXSYX',
      'https://127.0.0.1/fb/2XYXYRXSYX',
      'https://i.jielong.com:8080/fb/2XYXYRXSYX',
      'https://user:password@i.jielong.com/fb/2XYXYRXSYX',
      'javascript:alert(1)',
    ]) {
      let count = 0
      const fetcher = Object.assign(async () => {
        count++
        return new Response(null, {
          status: 302,
          headers: { location },
        })
      }, {
        preconnect: () => {},
      }) as typeof fetch
      await expect(resolveThreadId('Bearer fixture', shareUrl, fetcher)).rejects.toThrow('跳转目标')
      expect(count).toBe(1)
    }
  })
})
