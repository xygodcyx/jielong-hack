import type { Field, FormSchema, JsonObject } from '../shared.ts'
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { api, AppError, assertApi } from './api.ts'
import { getMedia, localRoot, saveMedia } from './store.ts'

const dir = join(localRoot, 'media')
mkdirSync(dir, { recursive: true, mode: 0o700 })
const execute = promisify(execFile)
export async function stageMedia(owner: string, file: File) {
  if (!file.size || file.size > 100 * 1024 * 1024)
    throw new AppError('单个文件须大于 0，且不超过 100 MB。')
  const id = crypto.randomUUID()
  const path = join(dir, id)
  const name = Array.from(file.name).map(c => c.charCodeAt(0) < 32 || '/\\'.includes(c)
    ? '_'
    : c).join('').slice(0, 180) || 'upload'
  await writeFile(path, new Uint8Array(await file.arrayBuffer()), { mode: 0o600 })
  let mediaType = 3
  let width = 0
  let height = 0
  let duration = 0
  let mime = 'application/octet-stream'
  try {
    const meta = await sharp(path, { limitInputPixels: 60000000 }).metadata()
    const mimes: JsonObject = {
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      heif: 'image/heic',
    }
    if (!mimes[meta.format || ''])
      throw new Error('unsupported image')
    mediaType = 1
    width = meta.width || 0
    height = meta.height || 0
    mime = mimes[meta.format!]
  }
  catch {
    if (/^(?:image|video|audio)\//.test(file.type)) {
      if (file.type.startsWith('image/')) {
        await unlink(path)
        throw new AppError('图片无法识别，仅支持 JPEG、PNG、WebP、GIF、HEIC。')
      }
      let metadata: any
      try {
        const result = await execute(process.env.FFPROBE_PATH || 'ffprobe', [
          '-v',
          'error',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          path,
        ], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 })
        metadata = JSON.parse(result.stdout)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          await unlink(path)
          throw new AppError('上传视频和音频需要安装 ffmpeg（包含 ffprobe）。', 422)
        }
      }
      const stream = metadata?.streams?.find((x: any) => x.codec_type === (file.type.startsWith('video/')
        ? 'video'
        : 'audio'))
      if (!stream) {
        await unlink(path)
        throw new AppError('媒体文件损坏或格式不支持。')
      }
      mediaType = file.type.startsWith('video/')
        ? 2
        : 4
      mime = file.type
      width = Number(stream.width) || 0
      height = Number(stream.height) || 0
      duration = Number(metadata.format?.duration || stream.duration) || 0
      if (!duration) {
        await unlink(path)
        throw new AppError('无法读取媒体时长。')
      }
    }
  }
  const data = {
    id,
    path,
    name,
    size: file.size,
    mime,
    mediaType,
    width,
    height,
    duration,
    url: `/api/media/${id}`,
  }
  saveMedia(owner, id, data)
  const { path: _, ...publicData } = data
  return publicData
}
export function validateMedia(file: JsonObject, field: Field, schema: FormSchema) {
  const types: Record<number, number> = { 8: 1, 25: 1, 19: 1, 9: 2, 15: 4 }
  if (types[field.FieldType] && file.mediaType !== types[field.FieldType])
    throw new AppError(`「${field.Name}」文件类型不正确。`)
  const config = schema.uploadConfig[field.FieldType === 10
    ? 'File'
    : file.mediaType === 1
      ? 'Image'
      : file.mediaType === 2
        ? 'Video'
        : file.mediaType === 4
          ? 'Audio'
          : 'File'] || {}
  const maxMb = Number(config.Size) || 100
  if (file.size > maxMb * 1024 * 1024)
    throw new AppError(`「${field.Name}」文件大小不能超过 ${maxMb} MB。`)
  const maxSeconds = Math.min(...[
    Number(config.Seconds),
    Number(field.Duration),
  ].filter(x => x > 0))
  if (file.duration && file.duration > maxSeconds)
    throw new AppError(`「${field.Name}」媒体时长不能超过 ${maxSeconds} 秒。`)
  if (field.FieldType === 10 && Array.isArray(field.Extensions) && field.Extensions.length) {
    const extension = extname(file.name).slice(1).toLowerCase()
    if (!field.Extensions.some((x: any) => String(x).replace(/^\./, '').toLowerCase() === extension))
      throw new AppError(`「${field.Name}」文件扩展名不符合要求。`)
  }
}
export function uploadHostAllowed(raw: string) {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && (u.hostname.endsWith('.jielong.com') || u.hostname.endsWith('.myqcloud.com'))
  }
  catch {
    return false
  }
}
export async function uploadToCos(token: string, media: JsonObject, threadId: string, checkin = false, fetcher: typeof fetch = fetch) {
  const policyBody = await api('/api/Attachment/CosUploadPolicy', token, {
    tenantTypeId: checkin ? '300221' : '300216',
    fileName: media.name,
    associateId: Number(threadId) || threadId,
    yunStore: 2,
  }, fetcher)
  const p = policyBody.Data
  const keys = [
    'Host',
    'Key',
    'Policy',
    'ContentType',
    'Algorithm',
    'Ak',
    'KeyTime',
    'Signature',
    'Callback',
  ]
  if (!p || keys.some(k => typeof p[k] !== 'string' || !p[k]) || !uploadHostAllowed(p.Host))
    throw new AppError('上传凭证或存储地址无效，未提交签到。', 502)
  const form = new FormData()
  const fields = {
    'key': p.Key,
    'policy': p.Policy,
    'success_action_status': '200',
    'Content-Type': p.ContentType,
    'q-sign-algorithm': p.Algorithm,
    'q-ak': p.Ak,
    'q-key-time': p.KeyTime,
    'q-signature': p.Signature,
    'x-cos-callback': p.Callback,
  }
  for (const [k, v] of Object.entries(fields))
    form.append(k, v)
  form.append('file', new File([
    new Uint8Array(await readFile(media.path)),
  ], media.name, { type: media.mime }))
  // 存储鉴权来自临时签名；此请求绝不携带账号 Authorization。
  const r = await fetcher(p.Host, {
    method: 'POST',
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  })
  const b = assertApi(await r.json() as JsonObject, r.status)
  const f = b.Data
  if (!f?.RelativePath || !f.Url || Number(f.MediaType) !== media.mediaType)
    throw new AppError('上传回调附件信息不完整，未提交签到。', 502)
  return {
    ...f,
    Width: f.Width || media.width,
    Height: f.Height || media.height,
    Time: f.Time || Math.ceil(media.duration),
    IsNewUpload: true,
  }
}
export async function resolveFiles(owner: string, token: string, schema: FormSchema, draft: JsonObject, demo = false) {
  // 在任何外部上传之前，验证所有文件及字段归属。
  const jobs: {
    value: JsonObject
    index: number
    media: JsonObject
  }[] = []
  for (const value of draft.values) {
    const field = schema.fields.find(f => f.Id === value.FieldId)!
    const existing = schema.values.find(v => v.FieldId === field.Id)?.Files || []
    for (const [index, file] of value.Files.entries()) {
      if (file.LocalId) {
        const media = getMedia(owner, String(file.LocalId))
        if (!media)
          throw new AppError('本地附件已失效，请重新选择。')
        validateMedia(media, field, schema)
        jobs.push({ value, index, media })
      }
      else {
        const original = existing.find(f => f.RelativePath === file.RelativePath && f.TenantTypeId === file.TenantTypeId)
        if (!original)
          throw new AppError('附件不属于当前表单，请重新上传。')
        value.Files[index] = structuredClone(original)
      }
    }
  }
  for (const job of jobs) {
    const f = job.media
    job.value.Files[job.index] = demo
      ? {
          RelativePath: `demo/${f.id}`,
          Url: f.url,
          Name: f.name,
          FileName: f.name,
          Size: f.size,
          MediaType: f.mediaType,
          Width: f.width,
          Height: f.height,
          Time: f.duration,
          TenantTypeId: 'demo',
          IsNewUpload: true,
        }
      : await uploadToCos(token, f, schema.thread.id, schema.thread.type === 5)
  }
  return draft
}
