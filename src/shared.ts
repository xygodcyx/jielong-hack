export type JsonObject = Record<string, any>
export interface Field extends JsonObject {
  Id: number
  Name: string
  FieldType: number
  IsRequired?: boolean
  IsDisabled?: boolean
  IsHidden?: boolean
}
export interface RecordValue extends JsonObject {
  FieldId: number
  Values: any[]
  Texts: any[]
  Files: JsonObject[]
  HasValue: boolean
  OtherValue: string
}
export interface Thread {
  id: string
  title: string
  author: string
  type: number
  status: 'open' | 'closed' | 'unknown'
  date: string
  description?: string
}
export interface FormSchema {
  thread: Thread
  fields: Field[]
  values: RecordValue[]
  signature: string
  number: string
  recordId: string | number
  itemId: number
  requireSignature: boolean
  requireNumber: boolean
  numberLabel: string
  uploadConfig: JsonObject
  canSubmit: boolean
  unavailableReason: string
  endpoint: string
  needPrivacy: boolean
}
export interface Draft {
  signature: string
  number: string
  values: RecordValue[]
}
export const fieldLabels: Record<number, string> = {
  0: '单选',
  1: '多选',
  2: '图文单选',
  3: '图文多选',
  4: '下拉选择',
  5: '文本',
  6: '数字',
  7: '日期时间',
  8: '图片',
  9: '视频',
  10: '文件',
  11: '评分',
  12: '说明',
  13: '图片说明',
  14: '分页',
  15: '音频',
  16: '位置',
  17: '矩阵单选',
  18: '矩阵多选',
  19: '手写签名',
  20: '省市区',
  21: '拼图',
  22: '多级选择',
  23: '手机验证',
  24: '表格',
  25: '水印相机',
  26: '矩阵填空',
  27: '扫码录入',
  28: '矩阵表单',
}
export function blankValue(field: Field): RecordValue {
  const selected = field.ControlOptions?.Options?.filter((x: JsonObject) => x.IsSelected) || []
  const value: RecordValue = {
    FieldId: field.Id,
    Values: selected.map((x: JsonObject) => String(x.Value)),
    Texts: selected.map((x: JsonObject) => x.Text),
    Files: [],
    OtherValue: '',
    MatrixValues: [],
    Scores: [],
    HasValue: selected.length > 0,
  }
  if ([5, 6, 7].includes(field.FieldType) && field.Defaultvalue !== '' && field.Defaultvalue != null) {
    value.Texts = [field.Defaultvalue]
    value.HasValue = true
  }
  return value
}
