import { AppError } from './api.ts'

const dayMs = 86400000
export function beijingDate(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10)
}
export function offsetDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10)
}
export function validTime(value: unknown) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-2]):[0-5]\d$/.test(value))
    throw new AppError('请选择北京时间 00:00–22:59 之间的签到时间。')
  return value
}
export function scheduledAt(date: string, time: string) {
  return Date.parse(`${date}T${validTime(time)}:00+08:00`)
}
export function closingAt(date: string) {
  return Date.parse(`${date}T23:00:00+08:00`)
}
export function recordDate(record: Record<string, any>) {
  const target = record.CheckInTarget || record.FillCheckInTarget || record.DateCreated
  if (typeof target !== 'string')
    return ''
  // 接龙返回不带时区的业务日期；有时区的时间戳统一换成北京时间。
  return /(?:Z|[+-]\d\d:\d\d)$/.test(target)
    ? beijingDate(Date.parse(target))
    : target.slice(0, 10)
}
