import type { JsonObject } from '../shared.ts'
import { api, AppError, query } from './api.ts'
import { recordDate } from './checkin-calendar.ts'

export async function ownCheckin(token: string, threadId: string, date: string): Promise<JsonObject | null> {
  // 使用指定业务日期的官方记录列表，保留大整数记录 ID 为字符串。
  for (let pageIndex = 1; pageIndex <= 20; pageIndex++) {
    const body = await api(query('/api/CheckIn/Records', {
      threadId,
      dateTarget: date,
      pageIndex,
      pageSize: 100,
      sortBy: 1,
      isGetAll: false,
      isShowCommentAndAttitude: false,
      scopeGroupId: 0,
    }), token)
    if (!Array.isArray(body.Data))
      throw new AppError('无法核对本人打卡记录，本次未提交。', 502)
    const found = body.Data.filter((record: JsonObject) => record.IsCurrentUser === true && recordDate(record) === date)
      .sort((a: JsonObject, b: JsonObject) => String(b.DateCreated).localeCompare(String(a.DateCreated)))[0]
    if (found) {
      if (Array.isArray(found.RecordValues))
        return found
      const detail = await api(query('/api/CheckIn/RecordDetail', {
        threadId,
        recordId: String(found.Id),
      }), token)
      const record = detail.Data?.CheckInRecord || detail.Data?.Record || detail.Data
      if (!record || String(record.Id) !== String(found.Id) || record.IsCurrentUser !== true || !Array.isArray(record.RecordValues))
        throw new AppError('本人打卡详情不完整，本次未提交。', 502)
      return record
    }
    const total = Number(body.Page?.TotalRecords)
    if (body.Data.length < 100 || (Number.isFinite(total) && pageIndex * 100 >= total))
      return null
  }
  throw new AppError('记录过多，无法完整核对今日签到，本次未提交。', 502)
}
