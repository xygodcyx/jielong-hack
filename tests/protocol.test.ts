import type { JsonObject, RecordValue } from '../src/shared.ts'
import { writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, assertApi } from '../src/lib/api.ts'
import { demoSchema } from '../src/lib/demo.ts'
import { createPayload, listThreads, loadSchema, validateDraft } from '../src/lib/forms.ts'
import { uploadHostAllowed, uploadToCos, validateMedia } from '../src/lib/media.ts'

let fetchSpy: { mockRestore: () => void } | undefined
afterEach(() => fetchSpy?.mockRestore())
const success = (Data: unknown) => Response.json({ Type: '000001', Data })
function mockFetch(implementation: (url: RequestInfo | URL) => Promise<Response>) {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(implementation)
}
describe('接龙和打卡协议', () => {
  it('默认仅使用官方支持的参与列表枚举，并保留原始分页', async () => {
    const calls: string[] = []
    mockFetch(async (url) => {
      calls.push(String(url))
      return Response.json({
        Type: '000001',
        Data: [
          { Id: 1, ThreadType: 90, Subject: '签到' },
          { Id: 2, ThreadType: 3, Subject: '投票' },
        ],
        Page: { PageIndex: 1, PageSize: 50, TotalRecords: 101 },
      })
    })
    const result = await listThreads('Bearer fixture')
    expect(new URL(calls[0]).searchParams.get('listType')).toBe('1')
    expect(result.threads).toHaveLength(1)
    expect(result.page.TotalRecords).toBe(101)
    await expect(listThreads('Bearer fixture', 1, 0)).rejects.toThrow('任务来源')
  })
  it('按水印修改抓包使用 FieldType=25、Files 和已有记录 ID', () => {
    const schema = demoSchema('demo-watermark', 123)
    schema.thread.id = '123456'
    const attachment = {
      RelativePath: 'fixture/photo.jpg',
      Url: 'https://jielong-file-cos.jielong.com/fixture.jpg',
      MediaType: 1,
      TenantTypeId: '300216',
    }
    const draft = {
      signature: '测试用户',
      number: '',
      values: schema.values.map(v => ({ ...v })),
    }
    draft.values[0].Files = [attachment]
    const payload = createPayload({
      ...schema,
      base: { EditToken: 'fresh-fixture-edit-token' },
    }, draft)
    expect(payload.Id).toBe(123)
    expect(payload.RecordValues[0].Files).toEqual([attachment])
    expect(payload.EditToken).toBe('fresh-fixture-edit-token')
    expect(payload.RecordValues[0].WatermarkPhotoFieldValues).toBeUndefined()
    expect(schema.endpoint).toBe('/api/FeedBack/AttendFeedBack')
  })
  it('打卡读取独立表单，保留超出安全整数范围的字符串 ID', async () => {
    const id = '9007199254740993123'
    const calls: URL[] = []
    const value: RecordValue = {
      FieldId: 1,
      Values: ['{"latitude":1.2,"longitude":3.4}'],
      Texts: ['测试地点'],
      Files: [],
      OtherValue: '',
      HasValue: true,
    }
    mockFetch(async (url) => {
      const parsed = new URL(String(url))
      calls.push(parsed)
      if (parsed.pathname.endsWith('/SimpleDetail'))
        return success({ ThreadType: 5 })
      if (parsed.pathname.endsWith('/Detail')) {
        return success({
          Thread: {
            ThreadId: 123,
            Subject: '周期打卡',
            ThreadType: 5,
            AllowAttend: true,
          },
          CheckIn: {
            CheckInStatus: { AllowCheckIn: false },
          },
        })
      }
      return success({
        Subject: '周期打卡',
        IsEnabledNumber: true,
        NumberName: '学号',
        CheckInSetting: {
          Signature: { IsRequired: true },
          Settings: [
            { Id: 1, Name: '位置', FieldType: 16 },
          ],
        },
        CheckInRecord: {
          Id: id,
          IsCurrentUser: true,
          EnabledEdit: true,
          EditToken: 'new-edit-token',
          Signature: '测试用户',
          Number: 10,
          RecordValues: [value],
        },
      })
    })
    const schema = await loadSchema('Bearer fixture', '123', id)
    expect(schema.recordId).toBe(id)
    expect(calls[2].pathname).toBe('/api/CheckIn/EditRecordDetail')
    expect(calls[2].searchParams.get('recordId')).toBe(id)
    const payload = createPayload(schema, { signature: schema.signature, number: schema.number, values: schema.values })
    expect(payload.Id).toBe(id)
    expect(payload.DateTarget).toBe('')
    expect(payload.MinuteTarget).toBe(-1)
    expect(payload.IsNameNumberComfirm).toBe(false)
    expect(payload.FeedbackItemId).toBeUndefined()
    expect(schema.endpoint).toBe('/api/CheckIn/EditRecord')
    expect(payload.EditToken).toBe('new-edit-token')
  })
  it('不把 HTTP 200 的业务拒绝识别为成功', () => {
    expect(() => assertApi({ Type: '200005', Description: '已结束' })).toThrow('已结束')
    expect(() => assertApi({ Type: '100000' })).toThrow('登录已失效')
    expect(() => assertApi(null as unknown as JsonObject)).toThrow()
  })
  it('拒绝将账号凭证发往接口域名以外', async () => {
    await expect(api('https://example.com', 'Bearer fixture')).rejects.toThrow('无效的接口地址')
  })
})
describe('表单验证与媒体上传', () => {
  function filled() {
    const schema = demoSchema('demo-watermark')
    const draft = {
      signature: '测试用户',
      number: '',
      values: structuredClone(schema.values),
    }
    draft.values.find(x => x.FieldId === 2)!.Values = ['1']
    const location = draft.values.find(x => x.FieldId === 5)!
    location.Values = ['{"latitude":1.2,"longitude":3.4}']
    location.Texts = ['测试地点']
    return { schema, draft }
  }
  it('拒绝缺失必填字段、伪造选项、无效坐标与过多图片', () => {
    const { schema, draft } = filled()
    expect(validateDraft(schema, draft).values[1].Texts).toEqual(['日常签到'])
    draft.values[1].Values = ['does-not-exist']
    expect(() => validateDraft(schema, draft)).toThrow('无效选项')
    draft.values[1].Values = ['1']
    draft.values[4].Values = ['{"latitude":100,"longitude":0}']
    expect(() => validateDraft(schema, draft)).toThrow('有效地址和经纬度')
    draft.values[4].Values = ['{"latitude":1,"longitude":0}']
    draft.values[0].Files = Array.from({ length: 10 }, () => ({ LocalId: 'fixture' }))
    expect(() => validateDraft(schema, draft)).toThrow('0–9')
  })
  it('禁止覆盖只读字段', () => {
    const { schema, draft } = filled()
    schema.fields[5].IsDisabled = true
    draft.values[5].Texts = ['覆盖']
    expect(() => validateDraft(schema, draft)).toThrow('不可修改')
  })
  it('拒绝视频超时长、类型错误以及存储地址重定向', () => {
    const schema = demoSchema('demo-watermark')
    expect(() => validateMedia({ mediaType: 2, size: 100, duration: 121 }, schema.fields[3], schema)).toThrow('时长')
    expect(() => validateMedia({ mediaType: 3, size: 100 }, schema.fields[0], schema)).toThrow('类型')
    expect(uploadHostAllowed('https://jielong-file-cos.jielong.com')).toBe(true)
    expect(uploadHostAllowed('https://jielong.com.evil.test')).toBe(false)
    expect(uploadHostAllowed('http://127.0.0.1:3210')).toBe(false)
  })
  it('使用新 COS 凭证，存储上传不携带登录 Authorization', async () => {
    const { localRoot } = await import('../src/lib/store.ts')
    const path = `${localRoot}/fixture.jpg`
    await writeFile(path, 'fixture-bytes')
    const calls: {
      url: string
      options: RequestInit
    }[] = []
    const fetcher = (async (url: URL | string, options: RequestInit) => {
      calls.push({
        url: String(url),
        options,
      })
      if (calls.length === 1) {
        return success({
          Host: 'https://jielong-file-cos.jielong.com',
          Key: 'fixture',
          Policy: 'policy',
          ContentType: 'image/jpeg',
          Algorithm: 'sha1',
          Ak: 'ak',
          KeyTime: 'time',
          Signature: 'signature',
          Callback: 'callback',
        })
      }
      return success({
        RelativePath: 'fixture.jpg',
        Url: 'https://jielong-file-cos.jielong.com/fixture.jpg',
        MediaType: 1,
        Name: 'fixture.jpg',
        TenantTypeId: '300221',
      })
    }) as typeof fetch
    const file = await uploadToCos('Bearer fixture', {
      path,
      name: 'fixture.jpg',
      mime: 'image/jpeg',
      mediaType: 1,
      size: 13,
      width: 2,
      height: 2,
    }, '123', true, fetcher)
    expect(JSON.parse(calls[0].options.body as string).tenantTypeId).toBe('300221')
    expect(new Headers(calls[0].options.headers).get('authorization')).toBe('Bearer fixture')
    expect(new Headers(calls[1].options.headers).get('authorization')).toBeNull()
    expect((calls[1].options.body as FormData).get('file')).toBeInstanceOf(File)
    expect(file.IsNewUpload).toBe(true)
  })
})
