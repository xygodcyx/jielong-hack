import type { Draft, Field, FormSchema, JsonObject, RecordValue, Thread } from '../shared.ts'
import { blankValue } from '../shared.ts'
import { api, AppError, query } from './api.ts'
import { resolveThreadId } from './thread-reference.ts'

export function normalizeThread(raw: JsonObject): Thread {
  const ended = raw.IsEnded === true || raw.IsEnd === true || raw.DeleteStatus > 0
  return {
    id: String(raw.ThreadId || raw.Id || raw.ThreadStrId),
    title: String(raw.Subject || raw.Title || '未命名签到'),
    type: Number(raw.ThreadType ?? 0),
    author: String(raw.Author || raw.Nickname || ''),
    date: String(raw.SpecialTime || raw.DateCreated || ''),
    status: ended ? 'closed' : 'unknown',
  }
}
export async function listThreads(token: string, pageIndex = 1, listType = 1) {
  if (![1, 2, 5].includes(listType))
    throw new AppError('任务来源无效，请选择参与、发布或收藏。')
  const body = await api(query('/api/Thread/Threads', { pageIndex, pageSize: 50, listType }), token)
  if (!Array.isArray(body.Data))
    throw new AppError('签到列表响应结构发生变化。', 502)
    // 0 = 接龙，5 = 周期打卡，90 = 签到。分页仍按原始列表推进，避免漏过其他类型。
  return {
    threads: body.Data.filter((x: JsonObject) => x && [0, 5, 90].includes(Number(x.ThreadType))).map(normalizeThread),
    page: body.Page || { PageIndex: pageIndex, TotalRecords: body.Data.length, PageSize: 50 },
  }
}
export async function records(token: string, threadId: string) {
  threadId = await resolveThreadId(token, threadId)
  const simple = await api(query('/api/Thread/SimpleDetail', { threadId }), token)
  const checkin = Number(simple.Data?.ThreadType ?? simple.Data?.Thread?.ThreadType) === 5
  const body = await api(query(checkin ? '/api/CheckIn/Records' : '/api/FeedBack/GetPagingFeedBackRecords', {
    threadId,
    itemId: 0,
    sortBy: 1,
    pageIndex: 1,
    pageSize: 100,
    isGetAll: false,
    isShowCommentAndAttitude: false,
    scopeGroupId: 0,
  }), token)
  if (!Array.isArray(body.Data))
    throw new AppError('记录列表响应结构发生变化。', 502)
  return body.Data.filter((r: JsonObject) => r.IsCurrentUser === true).map((r: JsonObject) => ({
    id: r.Id,
    signature: r.Signature,
    date: r.DateCreated,
    editable: r.EnabledEdit === true,
  }))
}
export async function loadSchema(token: string, threadId: string, recordId: string | number = 0): Promise<FormSchema & {
  base: JsonObject
}> {
  threadId = await resolveThreadId(token, threadId)
  const editing = String(recordId) !== '0'
  const simple = await api(query('/api/Thread/SimpleDetail', { threadId }), token)
  const type = Number(simple.Data?.ThreadType ?? simple.Data?.Thread?.ThreadType ?? 0)
  const checkin = type === 5
  if (![0, 5, 90].includes(type))
    throw new AppError('当前优先支持接龙、签到和打卡，此任务类型尚未适配。', 422)
  const detail = await api(query(checkin ? '/api/CheckIn/Detail' : '/api/FeedBack/ThreadDetail', { threadId }), token)
  const rawThread = detail.Data?.Thread || detail.Data
  const state = detail.Data?.FeedBack || detail.Data?.CheckIn || detail.Data?.CheckInInfo || {}
  const body = await api(query(checkin ? '/api/CheckIn/EditRecordDetail' : '/api/FeedBack/GetEditFeedBackRecord', {
    threadId,
    recordId,
    ...(checkin
      ? { fillNumber: 0 }
      : {}),
  }), token)
  const form = body.Data
  const settings = form?.FeedBackSetting || form?.CheckInSetting || form?.Setting || form?.RecordSetting
  if (!Array.isArray(settings?.Settings))
    throw new AppError('此任务的表单结构暂未识别，请使用官网打开。', 422, 'UNSUPPORTED_SCHEMA')
  const base = form.FeedBackRecord || form.CheckInRecord || {}
  if (editing && (String(base.Id) !== String(recordId) || base.IsCurrentUser !== true || base.EnabledEdit === false || form.EnabledEdit === false)) {
    throw new AppError('这条记录当前不可编辑。', 403)
  }
  const fields: Field[] = settings.Settings
  const values = fields.map(f => editing
    ? base.RecordValues?.find((v: RecordValue) => v.FieldId === f.Id) || blankValue(f)
    : blankValue(f))
  const thread = normalizeThread({ ...rawThread, ThreadId: threadId, ThreadType: form.ThreadType ?? type })
  thread.description = String(rawThread?.ThreadBody?.filter?.((x: JsonObject) => x.Text?.Content).map((x: JsonObject) => x.Text.Content).join('\n') || '')
  const allowed = editing
    ? true
    : rawThread?.AllowAttend !== false && form.AllowCheckIn !== false && state.AllowAttend !== false && state.IsEnd !== true && state.IsEnded !== true && state.CheckInStatus?.AllowCheckIn !== false
  const schema: FormSchema & {
    base: JsonObject
  } = {
    thread,
    fields,
    values,
    signature: String(base.Signature || form.Signature || ''),
    number: String(base.Number || form.Number || ''),
    recordId: editing ? base.Id : 0,
    itemId: Number(base.FeedbackItemId || 0),
    requireSignature: settings.Signature?.IsRequired !== false,
    requireNumber: !!form.IsEnabledNumber,
    numberLabel: form.NumberName || '编号 / 学号',
    uploadConfig: form.UploadConfig || rawThread.UploadConfig || {},
    canSubmit: allowed && thread.status !== 'closed',
    unavailableReason: state.CheckInStatus?.CheckInMsg || state.Reason || '该任务已结束或当前不允许提交。',
    endpoint: checkin ? '/api/CheckIn/EditRecord' : '/api/FeedBack/AttendFeedBack',
    needPrivacy: !!form.NeedAgreePrivacyPolicy,
    base: editing
      ? base
      : {},
  }
  if (schema.canSubmit)
    thread.status = 'open'
  return schema
}
export function mediaType(field: Field) {
  return [8, 19, 25].includes(field.FieldType)
    ? 'Image'
    : field.FieldType === 9
      ? 'Video'
      : field.FieldType === 15
        ? 'Audio'
        : 'File'
}
export function countLimit(field: Field, config: JsonObject = {}) {
  const type = mediaType(field)
  const c = config[type] || {}
  const max = field.FieldType === 25
    ? field.MaxPhotoCount || 9
    : type === 'Image'
      ? field.MaxImageCount || c.Limit || 9
      : field.FileCountLimit?.MaxCount || c.Limit || 9
  const min = field.IsRequired
    ? (type === 'Image' && field.FieldType !== 25
        ? field.MinImageCount || 1
        : 1)
    : 0
  return {
    min,
    max: Math.min(100, Math.max(1, Number(max))),
    maxMb: Number(c.Size) || (type === 'Image'
      ? 15
      : 100),
  }
}
export function validateDraft(schema: FormSchema, draft: Draft) {
  if (!schema.canSubmit)
    throw new AppError(schema.unavailableReason)
  if (!draft || !Array.isArray(draft.values))
    throw new AppError('表单数据不完整。')
  if (schema.requireSignature && !draft.signature?.trim())
    throw new AppError('请填写署名。')
  if (schema.requireNumber && !draft.number?.trim())
    throw new AppError(`请填写${schema.numberLabel}。`)
  if ((draft.signature || '').length > 200 || (draft.number || '').length > 200)
    throw new AppError('署名或编号过长。')
  if (new Set(draft.values.map(v => v.FieldId)).size !== draft.values.length)
    throw new AppError('表单存在重复字段。')
  if (draft.values.some(v => !schema.fields.some(f => f.Id === v.FieldId)))
    throw new AppError('表单字段已发生变化，请重新打开。')
  const normalized: RecordValue[] = []
  for (const field of schema.fields) {
    const v = structuredClone(draft.values.find(v => v.FieldId === field.Id) || blankValue(field))
    const old = schema.values.find(v => v.FieldId === field.Id) || blankValue(field)
    if (field.IsDisabled || field.IsFixed) {
      if (JSON.stringify(v) !== JSON.stringify(old))
        throw new AppError(`「${field.Name}」不可修改。`)
      normalized.push(old)
      continue
    }
    if (![v.Values, v.Texts, v.Files].every(Array.isArray))
      throw new AppError(`「${field.Name}」数据格式错误。`)
    const hasValue = v.Files.length > 0 || v.Values.some(x => x !== '' && x != null) || v.Texts.some(x => x !== '' && x != null) || !!v.OtherValue || !!v.FillInMatrixFieldValues?.length || !!v.MatrixValues?.length || !!v.CustomTableValues?.length || !!v.MatrixFormValues?.length
    if (field.IsRequired && !field.IsHidden && ![12, 13, 14].includes(field.FieldType) && !hasValue)
      throw new AppError(`请填写「${field.Name}」。`)
    if ([0, 1, 2, 3, 4].includes(field.FieldType)) {
      const options = field.ControlOptions?.Options || []
      if (v.Values.some(x => !options.some((o: JsonObject) => String(o.Value) === String(x))))
        throw new AppError(`「${field.Name}」包含无效选项。`)
      if ([0, 2, 4].includes(field.FieldType) && v.Values.length > 1)
        throw new AppError(`「${field.Name}」只能选择一项。`)
      const min = Number(field.ControlOptions?.MinSelectCount) || 0
      const max = Number(field.ControlOptions?.MaxSelectCount) || 0
      if (hasValue && (v.Values.length < min || (max > 0 && v.Values.length > max)))
        throw new AppError(`「${field.Name}」选项数量不符合要求。`)
      v.Texts = v.Values.map(x => options.find((o: JsonObject) => String(o.Value) === String(x)).Text)
    }
    if (field.FieldType === 6 && hasValue) {
      const n = Number(v.Texts[0])
      if (v.Texts[0] === '' || !Number.isFinite(n) || (field.IsLimitation && (n < Number(field.MinNum) || n > Number(field.MaxNum))))
        throw new AppError(`「${field.Name}」数字超出范围。`)
      v.Texts = [n]
    }
    if (field.FieldType === 5 && hasValue) {
      const len = String(v.Texts[0] || '').length
      if (len < Number(field.MinLength || 0) || (field.MaxLength > 0 && len > field.MaxLength))
        throw new AppError(`「${field.Name}」文字长度不符合要求。`)
    }
    if (field.FieldType === 16 && hasValue) {
      let loc: JsonObject
      try {
        loc = JSON.parse(v.Values[0])
      }
      catch {
        throw new AppError(`「${field.Name}」经纬度格式错误。`)
      }
      if (typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number' || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude) || Math.abs(loc.latitude) > 90 || Math.abs(loc.longitude) > 180 || !String(v.Texts[0] || '').trim())
        throw new AppError(`「${field.Name}」请填写有效地址和经纬度。`)
    }
    if ([8, 9, 10, 15, 19, 25].includes(field.FieldType)) {
      const { min, max } = countLimit(field, schema.uploadConfig)
      if (v.Files.length < min || v.Files.length > max)
        throw new AppError(`「${field.Name}」需要 ${min}–${max} 个文件。`)
    }
    v.FieldId = field.Id
    v.FieldType = field.FieldType
    v.FieldName = field.Name
    v.HasValue = hasValue
    normalized.push(v)
  }
  return {
    ...draft,
    signature: draft.signature.trim(),
    number: draft.number.trim(),
    values: normalized,
  }
}
export function createPayload(schema: FormSchema & {
  base?: JsonObject
}, draft: Draft): JsonObject {
  const payload: JsonObject = {
    Id: schema.recordId,
    ThreadId: /^\d+$/.test(schema.thread.id)
      ? Number(schema.thread.id)
      : schema.thread.id,
    Number: draft.number,
    Signature: draft.signature,
    RecordValues: draft.values,
    FeedbackItemId: schema.itemId,
    IsNeedManualAudit: false,
    IsCurrentUser: true,
  }
  if (schema.thread.type === 5) {
    delete payload.FeedbackItemId
    payload.DateTarget = ''
    payload.MinuteTarget = -1
    payload.IsNameNumberComfirm = false
  }
  // shuiyin-2.har: 修改仍用 AttendFeedBack；FieldType=25 直接回填 Files。
  // 编辑凭证从当前账号的新响应中取得，不能从浏览器表单或抓包复制。
  for (const key of [
    'EditToken',
    'ThreadStrId',
    'ResultType',
    'IsAllowInvisible',
    'IsInvisible',
  ]) {
    if (schema.base?.[key] != null)
      payload[key] = schema.base[key]
  }
  return payload
}
