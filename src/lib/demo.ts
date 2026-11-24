import type { Field, FormSchema, JsonObject, Thread } from '../shared.ts'
import { blankValue } from '../shared.ts'

export const demoThreads: Thread[] = [
  {
    id: 'demo-watermark',
    title: '校园日常签到',
    author: '校园事务中心',
    type: 90,
    status: 'open',
    date: '每日开放',
    description: '完成今日签到，填写信息并上传照片。',
  },
  {
    id: 'demo-event',
    title: '社团活动 · 现场记录',
    author: '学生社团',
    type: 0,
    status: 'open',
    date: '活动期间开放',
    description: '活动现场的图片与视频记录。',
  },
  {
    id: 'demo-checkin',
    title: '每日学习打卡',
    author: '学习小组',
    type: 5,
    status: 'open',
    date: '每天一次',
    description: '记录阅读进度和学习时长。',
  },
]
export function demoSchema(id: string, recordId: string | number = 0): FormSchema & {
  base: JsonObject
} {
  const match = demoThreads.find(x => x.id === id)
  if (!match)
    throw new Error('演示任务不存在')
  const thread = structuredClone(match)
  const fields: Field[] = id === 'demo-checkin'
    ? [
        {
          Id: 1,
          Name: '今天读了什么',
          FieldType: 5,
          IsRequired: true,
          IsTextarea: true,
          MaxLength: 500,
        },
        {
          Id: 2,
          Name: '学习时长（分钟）',
          FieldType: 6,
          IsRequired: true,
          IsLimitation: true,
          MinNum: 1,
          MaxNum: 1440,
        },
        {
          Id: 3,
          Name: '学习照片',
          FieldType: 8,
          MaxImageCount: 9,
        },
      ]
    : [
        {
          Id: 1,
          Name: '水印相机',
          Tip: '选择照片，自动生成时间、地点与经纬度水印。',
          FieldType: 25,
          MaxPhotoCount: 9,
          WatermarkPhotoSetting: {
            WatermarkType: 0,
            AntiCheating: { WatermarkPhoto: 7, TimeFormat: 0 },
          },
        },
        {
          Id: 2,
          Name: '签到类型',
          FieldType: 0,
          IsRequired: true,
          ControlOptions: {
            Options: [
              { Value: '1', Text: '日常签到' },
              { Value: '2', Text: '活动签到' },
            ],
          },
        },
        {
          Id: 3,
          Name: '现场图片',
          FieldType: 8,
          MaxImageCount: 9,
        },
        {
          Id: 4,
          Name: '现场视频',
          FieldType: 9,
          Duration: 120,
          FileCountLimit: { MaxCount: 3 },
        },
        {
          Id: 5,
          Name: '签到位置',
          FieldType: 16,
          IsRequired: true,
        },
        {
          Id: 6,
          Name: '补充说明',
          FieldType: 5,
          IsTextarea: true,
          MaxLength: 2000,
        },
        {
          Id: 7,
          Name: '参与项目',
          FieldType: 1,
          ControlOptions: {
            Options: [
              { Value: '1', Text: '校园活动' },
              { Value: '2', Text: '志愿服务' },
              { Value: '3', Text: '体育锻炼' },
            ],
          },
        },
        {
          Id: 8,
          Name: '附件',
          FieldType: 10,
          FileCountLimit: { MaxCount: 6 },
        },
      ]
  return {
    thread,
    fields,
    values: fields.map(blankValue),
    signature: '体验用户',
    number: '',
    recordId: String(recordId) === '0'
      ? 0
      : recordId,
    itemId: 0,
    requireSignature: true,
    requireNumber: false,
    numberLabel: '学号',
    canSubmit: true,
    unavailableReason: '',
    uploadConfig: {
      Image: { Size: 15 },
      Video: { Size: 100, Seconds: 120 },
      File: { Size: 30 },
      Audio: { Size: 20, Seconds: 120 },
    },
    endpoint: thread.type === 5
      ? '/api/CheckIn/EditRecord'
      : '/api/FeedBack/AttendFeedBack',
    needPrivacy: false,
    base: {},
  }
}
