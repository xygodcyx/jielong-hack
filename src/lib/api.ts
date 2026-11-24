import type { JsonObject } from '../shared.ts'

export class AppError extends Error {
  constructor(message: string, public status = 400, public code = 'INVALID_REQUEST') {
    super(message)
  }
}
export function assertApi(body: JsonObject, status = 200) {
  if (status === 401 || status === 403 || ['100000', '100001'].includes(String(body?.Type))) {
    throw new AppError('登录已失效，请重新微信扫码。', 401, 'AUTH_REQUIRED')
  }
  if (status < 200 || status >= 300 || !body || body.Type !== '000001' || body.Success === false || body.Data === false) {
    throw new AppError(String(body?.Description || body?.Message || `接龙管家请求失败（HTTP ${status}）`).slice(0, 400), 502, 'UPSTREAM_ERROR')
  }
  return body
}
export async function api(path: string, token: string, data?: JsonObject, fetcher: typeof fetch = fetch): Promise<JsonObject> {
  const url = new URL(path.replace(/^\//, ''), 'https://i-api.jielong.com/')
  if (url.origin !== 'https://i-api.jielong.com')
    throw new AppError('无效的接口地址')
  let response: Response
  try {
    response = await fetcher(url, {
      method: data ? 'POST' : 'GET',
      redirect: 'error',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'origin': 'https://i.jielong.com',
        'referer': 'https://i.jielong.com/',
        ...(token
          ? { authorization: token }
          : {}),
      },
      ...(data
        ? {
            body: JSON.stringify(data),
          }
        : {}),
      signal: AbortSignal.timeout(25000),
    })
  }
  catch {
    throw new AppError('无法连接接龙管家，请检查网络后重试。', 502, 'NETWORK_ERROR')
  }
  const body = await response.json().catch(() => {
    throw new AppError('接龙管家返回了无法解析的数据。', 502)
  })
  return assertApi(body, response.status)
}
export function query(path: string, params: JsonObject) {
  return `${path}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [
    k,
    String(v),
  ]))}`
}
