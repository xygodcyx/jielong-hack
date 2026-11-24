export const $ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector)!
export function esc(v: unknown) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  }[c]!))
}
export function safeUrl(v: unknown) {
  try {
    const u = new URL(String(v), location.origin)
    return ['https:', 'blob:'].includes(u.protocol) || u.origin === location.origin
      ? u.href
      : ''
  }
  catch {
    return ''
  }
}
export function bytes(n: number) {
  return n < 1024 * 1024
    ? `${(n / 1024).toFixed(0)} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`
}
export async function request(path: string, body?: unknown): Promise<any> {
  const response = await fetch(path, {
    method: body === undefined
      ? 'GET'
      : 'POST',
    credentials: 'same-origin',
    headers: body instanceof FormData
      ? {}
      : body === undefined
        ? {}
        : { 'content-type': 'application/json' },
    ...(body === undefined
      ? {}
      : {
          body: body instanceof FormData
            ? body
            : JSON.stringify(body),
        }),
  })
  const result = await response.json()
  if (!response.ok) {
    if (response.status === 401)
      document.dispatchEvent(new Event('auth-expired'))
    throw new Error(result.error || '请求失败，请重试。')
  }
  return result
}
const paths: Record<string, string> = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 10 5-3v10l-5-3"/>',
  pin: '<path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 18 17"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"/>',
  edit: '<path d="m16 3 5 5L9 20l-6 1 1-6Z M14 5l5 5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M14 7l5 5-5 5M8 12h12"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  wechat: '<path d="M21 10.5c0 3.6-4 6.5-9 6.5-1.3 0-2.6-.2-3.8-.6L4 19l1.1-4C3.7 13.8 3 12.2 3 10.5 3 6.9 7 4 12 4s9 2.9 9 6.5Z"/><path d="M8 10h.01M16 10h.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01"/>',
}
export const icon = (name: string, cls = '') => `<svg class="icon ${cls}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`
let dbPromise: Promise<IDBDatabase>
function db() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('jielong-studio', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('drafts')
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}
export async function readDraft(key: string): Promise<any> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const r = d.transaction('drafts').objectStore('drafts').get(key)
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}
export async function writeDraft(key: string, value: unknown) {
  const d = await db()
  return new Promise<void>((resolve, reject) => {
    const t = d.transaction('drafts', 'readwrite')
    t.objectStore('drafts').put(value, key)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}
export async function removeDraft(key: string) {
  const d = await db()
  return new Promise<void>((resolve, reject) => {
    const t = d.transaction('drafts', 'readwrite')
    t.objectStore('drafts').delete(key)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}
