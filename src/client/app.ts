import type { DailyCheckin } from '../automation-shared.ts'
import type { Draft, Field, FormSchema, JsonObject, RecordValue, Thread } from '../shared.ts'
import { runLabels } from '../automation-shared.ts'
import { blankValue, fieldLabels } from '../shared.ts'
import { $, bytes, esc, icon, readDraft, removeDraft, request, safeUrl, writeDraft } from './helpers.ts'
import { composeImage, WATERMARK_RENDER_VERSION, watermarkDefaults } from './watermark.ts'

interface LocalFile {
  id: string
  fieldId: number
  file: File
  url?: string
  stagedId?: string
  stagedFingerprint?: string
}
let me: any = { authenticated: false }
let threads: Thread[] = []
let view = 'tasks'
let listType = 1
let page = 1
let more = false
let busy = false
let schema: FormSchema | null = null
let draft: Draft = { signature: '', number: '', values: [] }
let locals: LocalFile[] = []
let watermark = watermarkDefaults()
let prepared: any = null
let submitted = false
let loginEpoch = 0
let saveTimer: ReturnType<typeof setTimeout>
let previewEpoch = 0
let selectedPreview: string | null = null
let activeFilter = 'all'
let search = ''
let savedAt = ''
let lastPreviewUrl = ''
let taskLoadEpoch = 0
let scheduled: { plan: JsonObject, run: DailyCheckin, editable: boolean, mailConfigured: boolean } | null = null
let pendingAutomatic: JsonObject | null = null
let automationReturn = new URLSearchParams(location.search).has('automation')
const app = $('#app')
const modalRoot = $('#modal-root')
function typeLabel(n: number) {
  return n === 5
    ? '打卡'
    : n === 90
      ? '签到'
      : '接龙'
}
const button = (label: string, action: string, cls = 'button', extra = '') => `<button type="button" class="${cls}" data-action="${action}" ${extra}>${label}</button>`
const input = (label: string, value: unknown, attrs: string) => `<label class="input-label">${label}<input value="${esc(value)}" ${attrs}></label>`
function toast(message: string, error = false) {
  const node = document.createElement('div')
  node.className = `toast ${error ? 'error' : ''}`
  node.textContent = message
  $('#toasts').append(node)
  setTimeout(() => node.remove(), 5000)
}
function draftKey() {
  return `${me.scope || 'guest'}:${scheduled
    ? `automatic:${scheduled.plan.id}:${scheduled.run.date}`
    : `${schema?.thread.id}:${schema?.recordId || 0}`}`
}
function changed() {
  submitted = false
  prepared = null
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void saveCurrent().catch(() => toast('草稿保存失败，请保持页面打开。', true))
  }, 500)
  updateSummary()
}
async function saveCurrent() {
  if (!schema || submitted)
    return
  await writeDraft(draftKey(), {
    draft,
    locals: locals.map(({ url: _, ...f }) => f),
    watermark,
    schemaHash: JSON.stringify(schema.fields),
    scheduleRevision: scheduled?.run.revision,
    scheduleTime: scheduled?.plan.time,
    scheduleRecipient: scheduled?.plan.recipient,
    schedulePrivacy: scheduled?.run.privacyAgreed,
    at: Date.now(),
  })
  savedAt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date())
  const label = $('#save-state')
  if (label) {
    label.textContent = scheduled
      ? `本机已暂存 ${savedAt} · 请保存待办`
      : `草稿已保存 ${savedAt}`
  }
}
function releaseUrls() {
  for (const f of locals) {
    if (f.url)
      URL.revokeObjectURL(f.url)
  }
  if (lastPreviewUrl)
    URL.revokeObjectURL(lastPreviewUrl)
  lastPreviewUrl = ''
}
function profileContent() {
  return `<span class="avatar">${esc(me.user?.name?.slice(0, 1) || '未')}</span><div><strong>${esc(me.user?.name || '尚未登录')}</strong><small>${me.demo
    ? '演示空间'
    : me.authenticated ? '微信已连接' : '连接你的微信账号'}</small></div>${me.authenticated || me.expired
    ? button(icon('logout'), 'logout', 'icon-button', 'aria-label="退出登录"')
    : ''}`
}
function connectionStatus() {
  return me.demo
    ? '<span class="badge demo-badge">演示模式</span>'
    : me.authenticated ? '<span class="connected"><i></i> 微信已连接</span>' : '<span class="muted">本地工作台</span>'
}
function shell(content: string) {
  app.innerHTML = `<aside class="sidebar"><a class="brand" href="/" aria-label="接龙工作台首页"><span class="brand-symbol">${icon('layers')}</span><span>接龙工作台<small>JIELONG STUDIO</small></span></a>
    <div class="workspace-label">个人工作空间</div><nav aria-label="主导航">
    ${[
      ['tasks', 'grid', '我的任务'],
      ['manual', 'edit', '手动添加'],
      ['automation', 'clock', '自动签到'],
      ['studio', 'layers', '水印工作室'],
      ['history', 'file', '提交记录'],
    ].map(([id, i, label]) => button(`${icon(i)}<span>${label}</span>${id === 'studio'
      ? '<span class="tiny-tag">本地</span>'
      : ''}`, `nav-${id}`, `nav-item ${view === id
      ? 'active'
      : ''}`)).join('')}</nav>
    <div class="sidebar-bottom"><div class="local-note">${icon('shield')}<span>本机保存登录状态<small>手动确认或按计划执行</small></span></div>${button(`${icon('help')} 使用说明`, 'help', 'nav-item')}
    <div class="profile">${profileContent()}</div></div></aside>
    <div class="main-shell"><header class="topbar"><div class="breadcrumb">个人空间 <span>/</span> ${view === 'studio'
      ? '水印工作室'
      : view === 'manual'
        ? schema ? '手动添加 / 编辑任务' : '手动添加'
        : view === 'automation'
          ? scheduled ? '自动签到 / 编辑待办' : '自动签到'
          : view === 'history'
            ? '提交记录'
            : schema ? '编辑任务' : '我的任务'}</div><div class="topbar-end">${connectionStatus()}<span class="top-date">${new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    }).format(new Date())}</span></div></header>
    ${me.expired
      ? authBanner()
      : ''}<main id="main" tabindex="-1">${content}</main><footer class="app-footer"><span>接龙工作台 · 让每一份记录井井有条</span><span>LOCAL WORKSPACE</span></footer></div>`
}
function welcome() {
  shell(`<section class="page-heading"><div><div class="eyebrow">YOUR DAILY WORKSPACE</div><h1>把每一次签到，<br class="mobile-break">都安排妥当。</h1><p>连接微信，集中查看接龙与打卡。照片、视频、位置，在一处编辑。</p></div><span class="heading-mark">${icon('grid')}</span></section>
    <section class="welcome-grid"><div class="connect-card"><div class="section-kicker">从这里开始</div><div class="wechat-mark">${icon('wechat')}</div><h2>连接你的微信账号</h2><p>微信扫一扫，即可加载你参与和发布的<br>接龙、签到与打卡任务。</p>${button(`${icon('wechat')} 微信扫码登录`, 'login', 'button primary large')}<div class="connect-divider"><span>或先了解工作台</span></div>${button('进入演示空间', 'demo', 'button ghost wide')}<small class="connection-footnote">登录凭证仅保存在本机服务端</small></div>
    <div class="welcome-tools"><div class="feature-card green-feature"><span class="feature-icon">${icon('layers')}</span><div><span class="eyebrow">PHOTO STUDIO</span><h2>你的照片，自动加上水印</h2><p>上传照片，编辑时间、地点与经纬度。<br>即刻预览，生成后也可以直接下载。</p>${button('打开水印工作室', 'nav-studio', 'text-button')}</div><div class="mini-photo"><div class="mini-photo-art"></div><span>时间 · 地点 · 经纬度</span></div></div>
    <div class="feature-row"><div class="feature-card"><span class="feature-icon">${icon('edit')}</span><h3>按表单，自由填写</h3><p>动态加载字段。图片、视频、位置和文字一目了然。</p></div><div class="feature-card"><span class="feature-icon">${icon('eye')}</span><h3>确认后，再提交</h3><p>草稿自动保存，提交前核对全部内容，每一步心中有数。</p></div></div><div class="workflow-strip"><span>${icon('wechat')} 微信连接</span><i></i><span>${icon('edit')} 编辑内容</span><i></i><span>${icon('shield')} 确认提交</span></div></div></section>`)
}
function tasksPage() {
  schema = null
  scheduled = null
  const manual = view === 'manual'
  shell(`<section class="page-heading compact"><div><div class="eyebrow">${manual ? 'SAVED TASKS' : 'MY WORKSPACE'}</div><h1>${manual ? '手动添加' : '我的任务'}<span class="title-dot">.</span></h1><p>${manual ? '通过链接或 ID 添加的任务，已保存在当前账号下。' : '接龙、签到与打卡，在这里统一处理。'}</p></div><div class="heading-actions">${button(`${icon('plus')} 添加任务`, 'import', 'button')}${button(`${icon('refresh')} 刷新`, 'refresh', 'button primary')}</div></section>
    ${me.demo ? '<div class="notice demo-notice">演示空间使用虚拟任务。你可以编辑、上传、生成水印并体验提交，不会影响真实记录。</div>' : ''}
    <section class="stats-row"><div><span>当前列表任务</span><strong>${threads.length.toString().padStart(2, '0')}</strong></div><div><span>接龙与签到</span><strong>${threads.filter(x => x.type !== 5).length.toString().padStart(2, '0')}</strong></div><div><span>周期打卡</span><strong>${threads.filter(x => x.type === 5).length.toString().padStart(2, '0')}</strong></div><div class="stats-description">${icon('layers')}<span>准备好你的下一份记录<small>打开任务，开始编辑</small></span></div></section>
    <section class="task-section"><div class="task-toolbar"><div class="tabs" role="tablist" aria-label="任务类型">${[
      ['all', '全部任务'],
      ['feedback', '接龙 / 签到'],
      ['checkin', '打卡'],
    ].map(([id, label]) => button(label, `filter-${id}`, `tab ${activeFilter === id
      ? 'active'
      : ''}`, `role="tab" aria-selected="${activeFilter === id}"`)).join('')}</div><div class="task-controls"><label class="search-input">${icon('search')}<input id="task-search" placeholder="搜索任务名称" value="${esc(search)}" aria-label="搜索任务名称"></label>${manual
      ? ''
      : `<select id="list-type" aria-label="任务来源">${[
        [1, '我参与的'],
        [2, '我发布的'],
        [5, '我收藏的'],
      ].map(([n, label]) => `<option value="${n}" ${listType === n
        ? 'selected'
        : ''}>${label}</option>`).join('')}</select>`}</div></div><div id="task-cards"></div><div class="load-more">${more
      ? button('加载更多任务', 'more', 'button')
      : ''}</div></section>`)
  renderTaskCards()
}
function renderTaskCards() {
  const target = $('#task-cards')
  if (!target)
    return
  const list = threads.filter(t => (activeFilter === 'all' || (activeFilter === 'checkin'
    ? t.type === 5
    : t.type !== 5)) && t.title.toLowerCase().includes(search.toLowerCase()))
  target.innerHTML = list.length
    ? `<div class="task-grid">${list.map((t, i) => `<article class="task-card"><div class="task-card-top"><span class="task-icon ${t.type === 5
      ? 'blue'
      : i % 2
        ? 'amber'
        : ''}">${icon(t.type === 5
      ? 'file'
      : t.type === 90
        ? 'shield'
        : 'layers')}</span><span class="badge ${t.status === 'closed'
      ? 'closed'
      : ''}">${t.status === 'open'
      ? '开放中'
      : t.status === 'closed'
        ? '已结束'
        : '查看可用状态'}</span></div><div class="task-type">${typeLabel(t.type)}</div><h2>${esc(t.title)}</h2><p>${esc(t.author || '接龙管家任务')}</p><div class="task-card-bottom"><span>${icon('file')} ${esc(t.date?.split('T')[0] || '打开查看详情')}</span>${button(`打开任务 ${icon('chevron')}`, 'open-task', 'text-button', `data-id="${esc(t.id)}"`)}</div></article>`).join('')}<button class="add-task-card" data-action="import">${icon('plus')}<strong>打开另一个任务</strong><span>粘贴接龙链接或任务 ID</span></button></div>`
    : `<div class="empty-state">${icon('grid')}<h2>${busy ? '正在加载任务…' : '这里还没有任务'}</h2><p>${search
      ? '试试其他关键词。'
      : view === 'manual'
        ? '添加接龙链接、短 ID 或数字 ThreadId，下次可以直接打开。'
        : '切换任务来源，或粘贴任务链接打开。'}</p>${button('添加任务', 'import', 'button')}</div>`
}
async function loadTasks(append = false) {
  const epoch = ++taskLoadEpoch
  const taskView = view
  busy = true
  if (!append) {
    threads = []
    page = 1
    tasksPage()
  }
  try {
    const data = await request(view === 'manual'
      ? `/api/manual-threads?page=${page}`
      : `/api/threads?page=${page}&listType=${listType}`)
    if (epoch !== taskLoadEpoch || view !== taskView)
      return
    threads = [
      ...new Map([
        ...threads,
        ...data.threads,
      ].map(t => [t.id, t])).values(),
    ] as Thread[]
    more = data.page.PageIndex * data.page.PageSize < data.page.TotalRecords
    busy = false
    tasksPage()
  }
  catch (e) {
    busy = false
    if (epoch === taskLoadEpoch && view === taskView)
      tasksPage()
    throw e
  }
}
function fileUrl(f: JsonObject): string {
  if (f.ClientId) {
    const local = locals.find(x => x.id === f.ClientId)
    if (!local)
      return ''
    return local.url ||= URL.createObjectURL(local.file)
  }
  return safeUrl(f.Url)
}
function limits(f: Field) {
  const t = [8, 19, 25].includes(f.FieldType)
    ? 'Image'
    : f.FieldType === 9
      ? 'Video'
      : f.FieldType === 15
        ? 'Audio'
        : 'File'
  const config = schema?.uploadConfig[t] || {}
  return {
    max: f.FieldType === 25
      ? f.MaxPhotoCount || 9
      : t === 'Image'
        ? f.MaxImageCount || config.Limit || 9
        : f.FileCountLimit?.MaxCount || config.Limit || 9,
    mb: config.Size || (t === 'Image'
      ? 15
      : 100),
  }
}
function fieldHtml(f: Field, v: RecordValue) {
  const id = f.Id
  const t = f.FieldType
  const disabled = !!(f.IsDisabled || f.IsFixed)
  const dis = disabled ? 'disabled' : ''
  if (f.IsHidden)
    return ''
  if (t === 12)
    return `<div class="form-description">${esc(f.Description || f.Name)}</div>`
  if (t === 13) {
    return `<div class="form-description">${esc(f.Name)}${f.ImageDescription?.Url
      ? `<img src="${esc(safeUrl(f.ImageDescription.Url))}" alt="${esc(f.Name)}">`
      : ''}</div>`
  }
  if (t === 14)
    return '<hr class="form-divider">'
  let content = ''
  const attrs = `data-field="${id}" ${dis}`
  if (t < 5 && t >= 0) {
    const options = f.ControlOptions?.Options || []
    content = t === 4
      ? `<select ${attrs}><option value="">请选择</option>${options.map((o: JsonObject) => `<option value="${esc(o.Value)}" ${v.Values.map(String).includes(String(o.Value))
        ? 'selected'
        : ''}>${esc(o.Text)}</option>`).join('')}</select>`
      : `<div class="choice-group">${options.map((o: JsonObject) => `<label class="choice"><input type="${[1, 3].includes(t)
        ? 'checkbox'
        : 'radio'}" name="field-${id}" value="${esc(o.Value)}" ${attrs} ${v.Values.map(String).includes(String(o.Value))
        ? 'checked'
        : ''}>${o.Image?.Url
        ? `<img src="${esc(safeUrl(o.Image.Url))}" alt="">`
        : ''}<span>${esc(o.Text)}</span></label>`).join('')}</div>`
  }
  else if ([8, 9, 10, 15, 19, 25].includes(t)) {
    const l = limits(f)
    const accept = [8, 19, 25].includes(t)
      ? 'image/jpeg,image/png,image/webp'
      : t === 9
        ? 'video/*'
        : t === 15
          ? 'audio/*'
          : Array.isArray(f.Extensions)
            ? f.Extensions.map((x: string) => `.${x.replace(/^\./, '')}`).join(',')
            : ''
    content = `${t === 25
      ? `<div class="watermark-inline"><span>${icon('layers')} ${watermark.enabled ? '已开启自动水印' : '保留原图'}</span>${button('编辑水印', 'watermark-settings', 'text-button')}</div>`
      : ''}<div class="media-grid">${v.Files.map((file, i) => `<div class="media-item">${[8, 19, 25].includes(t)
      ? `<button type="button" class="thumbnail-button" data-action="preview-file" data-field="${id}" data-index="${i}" aria-label="预览图片"><img src="${esc(fileUrl(file))}" alt="${esc(file.Name || file.FileName || '已选图片')}"></button>`
      : t === 9
        ? `<video src="${esc(fileUrl(file))}" controls preload="metadata"></video>`
        : t === 15
          ? `<audio src="${esc(fileUrl(file))}" controls preload="metadata"></audio>`
          : `<a class="file-tile" href="${esc(fileUrl(file))}" target="_blank" rel="noreferrer">${icon('file')}<span>${esc(file.Name || file.FileName || '文件')}</span></a>`}${!disabled
      ? button(icon('close'), 'remove-file', 'remove-file', `data-field="${id}" data-index="${i}" aria-label="移除附件"`)
      : ''}<small>${esc(file.Name || file.FileName || '已上传附件')}</small></div>`).join('')}</div>
      ${!disabled && v.Files.length < l.max
        ? `<label class="upload-area" data-drop="${id}" tabindex="0">${icon(t === 25
          ? 'layers'
          : 'upload')}<span><strong>${t === 25
          ? '选择照片，自动添加水印'
          : t === 9
            ? '选择视频'
            : t === 15
              ? '选择音频'
              : t === 19
                ? '上传签名图片'
                : '点击上传，或拖拽文件到这里'}</strong><small>最多 ${l.max} 个 · 单个不超过 ${l.mb} MB</small></span><input type="file" data-upload="${id}" accept="${accept}" ${t === 19
          ? ''
          : 'multiple'} aria-label="${esc(f.Name)}上传"></label>`
        : ''}${t === 19 && !disabled
        ? button(`${icon('edit')} 手写签名`, 'signature', 'button small', `data-field="${id}"`)
        : ''}`
  }
  else if (t === 16) {
    let loc: any = {}
    try {
      loc = JSON.parse(v.Values[0] || '{}')
    }
    catch { }
    content = `<div class="location-box">${input('地点名称 / 详细地址', v.Texts[0] || '', `data-location="address" data-field="${id}" placeholder="输入要提交的地点" ${dis}`)}<div class="two-columns">${input('纬度', loc.latitude ?? '', `type="number" step="any" min="-90" max="90" data-location="latitude" data-field="${id}" placeholder="-90 至 90" ${dis}`)}${input('经度', loc.longitude ?? '', `type="number" step="any" min="-180" max="180" data-location="longitude" data-field="${id}" placeholder="-180 至 180" ${dis}`)}</div><div class="location-actions">${!disabled
      ? button(`${icon('location')} 获取当前位置`, 'geolocate', 'text-button', `data-field="${id}"`)
      : ''}<small>坐标按表单值提交，地址可直接修改。</small></div></div>`
  }
  else if ([5, 6, 7, 11, 20, 22, 23, 27].includes(t)) {
    const type = t === 6 || t === 11
      ? 'number'
      : t === 7
        ? (f.DateType === 0
            ? 'date'
            : f.DateType === 1
              ? 'time'
              : 'datetime-local')
        : 'text'
    content = f.IsTextarea
      ? `<textarea ${attrs} rows="3" placeholder="${esc(f.Tip || '请输入')}" ${f.MaxLength
        ? `maxlength="${f.MaxLength}"`
        : ''}>${esc(v.Texts[0] || '')}</textarea>`
      : `<input ${attrs} type="${type}" value="${esc(v.Texts[0] ?? '')}" placeholder="${esc(f.Tip || '请输入')}" ${t === 6
        ? `step="any" ${f.IsLimitation
          ? `min="${Number(f.MinNum)}" max="${Number(f.MaxNum)}"`
          : ''}`
        : ''}>`
  }
  else {
    content = `<details class="advanced-field"><summary>编辑${esc(fieldLabels[t] || '结构化字段')}内容</summary><p class="muted">保留字段的数据结构，仅修改其中的值。</p><textarea ${attrs} data-structured="true" rows="7" spellcheck="false">${esc(JSON.stringify(v, null, 2))}</textarea></details>`
  }
  return `<fieldset class="form-field" id="field-${id}" ${dis}><legend>${esc(f.Name || fieldLabels[t])}${f.IsRequired ? '<span class="required">*</span>' : ''}<span class="field-type">${esc(fieldLabels[t] || '其他字段')}${disabled ? ' · 只读' : ''}</span></legend>${f.Tip && t !== 25
    ? `<p class="field-tip">${esc(f.Tip)}</p>`
    : ''}${content}</fieldset>`
}
function watermarkControls() {
  return `<div class="wm-control-heading"><h3>水印设置</h3><label class="switch"><input id="wm-enabled" type="checkbox" ${watermark.enabled ? 'checked' : ''} aria-label="自动添加水印"><span></span></label></div><p class="field-tip">先生成水印图片，再按图片附件上传。</p>
    <div class="wm-controls ${watermark.enabled ? '' : 'dimmed'}">${input('时间（北京时间）', watermark.time, 'type="datetime-local" data-watermark="time"')}${input('地点', watermark.address, 'data-watermark="address" placeholder="输入照片上的地点"')}
    <div class="two-columns">${input('纬度', watermark.latitude, 'type="number" min="-90" max="90" step="any" data-watermark="latitude" placeholder="纬度"')}${input('经度', watermark.longitude, 'type="number" min="-180" max="180" step="any" data-watermark="longitude" placeholder="经度"')}</div>${input('自定义标题（可选）', watermark.title, 'data-watermark="title" placeholder="添加一行标题"')}
    <div class="wm-checks">${[
      ['showTime', '时间'],
      ['showAddress', '地点'],
      ['showCoordinates', '经纬度'],
    ].map(([k, label]) => `<label><input type="checkbox" data-watermark="${k}" ${(watermark as any)[k] ? 'checked' : ''}>${label}</label>`).join('')}</div>${view !== 'studio'
      ? button('使用表单中的位置', 'sync-location', 'text-button')
      : ''}</div>`
}
function editorPage() {
  if (!schema)
    return
  const studio = view === 'studio'
  const hasWatermark = schema.fields.some(f => f.FieldType === 25)
  shell(`<section class="editor-heading"><div><div class="editor-breadcrumb">${!studio
    ? button(`${icon('back')} ${scheduled
        ? '自动签到'
        : view === 'manual'
          ? '手动添加'
          : '我的任务'}`, scheduled
        ? 'nav-automation'
        : view === 'manual'
          ? 'nav-manual'
          : 'nav-tasks', 'text-button')
    : '<span class="eyebrow">PHOTO STUDIO</span>'}</div><h1>${esc(schema.thread.title)}</h1><p>${studio
    ? '一张照片，一份清晰的时间与地点记录。'
    : scheduled
      ? `循环打卡 · ${esc(scheduled.run.date)} · ${esc(runLabels[scheduled.run.status])}`
      : `${typeLabel(schema.thread.type)} · ${esc(schema.thread.author || '接龙管家')} · ${schema.recordId ? '编辑已有记录' : '新建记录'}`}</p>${!studio
    ? `<div class="thread-identifier"><span>ThreadId</span><code>${esc(schema.thread.id)}</code></div>`
    : ''}</div><div class="heading-actions">${!studio
    ? scheduled
      ? button(`${icon('refresh')} 更新原表单`, 'auto-refresh-form', 'button', scheduled.editable ? '' : 'disabled') + button(scheduled.run.date === beijingDay()
        ? '编辑明日待办'
        : '查看今日待办', 'auto-other-day', 'button')
      : button(`${icon('file')} 我的已有记录`, 'records', 'button') + (schema.thread.type === 5
        ? button(`${icon('clock')} 启动循环签到`, 'auto-start', 'button primary')
        : '')
    : ''}<span id="save-state" class="draft-state">${savedAt
    ? scheduled
      ? `本机已暂存 ${savedAt} · 请保存待办`
      : `草稿已保存 ${savedAt}`
    : scheduled ? '待办保存在本机服务端' : '自动保存本地草稿'}</span></div></section>
    ${!schema.canSubmit && !scheduled
      ? `<div class="notice error-notice">${esc(schema.unavailableReason)}</div>`
      : ''}${!studio && me.demo
      ? '<div class="notice demo-notice">当前为演示任务，所有提交仅记录在本机。</div>'
      : ''}
    <div class="editor-grid"><form id="editor-form" class="editor-form">${scheduled
      ? automaticSettings()
      : ''}<fieldset class="editor-fields" ${scheduled && !scheduled.editable
      ? 'disabled'
      : ''}><section class="form-card"><div class="card-heading"><span class="feature-icon">${icon(studio ? 'layers' : 'edit')}</span><div><h2>${studio ? '上传照片' : '填写表单'}</h2><p>${studio ? '支持 JPEG、PNG、WebP，可批量生成水印。' : '根据任务要求，准备好这次的记录。'}</p></div></div>
    ${!studio
      ? `<div class="identity-fields">${input(`署名${schema.requireSignature ? '<span class="required">*</span>' : ''}`, draft.signature, `id="signature-input" maxlength="200" placeholder="请输入署名" ${schema.requireSignature ? 'required' : ''}`)}${schema.requireNumber
        ? input(`${esc(schema.numberLabel)}<span class="required">*</span>`, draft.number, 'id="number-input" maxlength="200" required')
        : ''}</div>`
      : ''}${schema.fields.map(f => fieldHtml(f, draft.values.find(v => v.FieldId === f.Id) || blankValue(f))).join('')}
    ${schema.needPrivacy
      ? `<label class="privacy-consent"><input id="privacy-consent" type="checkbox" required ${scheduled?.run.privacyAgreed ? 'checked' : ''}>我已阅读原任务的个人信息使用说明，同意将所填内容提交至该任务。</label>`
      : ''}</section></fieldset>
    <div class="editor-submit"><span>${icon('shield')} ${studio
      ? '图片在本地生成'
      : scheduled ? '保存后按北京时间自动执行' : '核对预览后，再确认提交'}</span>${scheduled
      ? `<div class="automatic-save-actions">${button(scheduled.plan.enabled ? '保存并暂停' : '仅保存待办', 'auto-save-paused', 'button', scheduled.editable ? '' : 'disabled')}${button(scheduled.plan.enabled ? '保存本次待办' : '保存并启动循环签到', 'auto-save', 'button primary large', scheduled.editable ? '' : 'disabled')}</div>`
      : button(studio
          ? `${icon('download')} 导出水印照片`
          : `${icon('eye')} 预览并准备提交`, studio ? 'export' : 'prepare', 'button primary large', !schema.canSubmit && !studio
          ? 'disabled'
          : '')}</div></form>
    <aside class="preview-sidebar"><section class="preview-card"><div class="preview-card-title"><h2>${hasWatermark ? '照片预览' : '表单概览'}</h2><span class="badge subtle">实时预览</span></div><div id="photo-preview" class="photo-preview"><div class="preview-placeholder">${icon('layers')}<strong>让照片带上你的记录</strong><span>选择照片后，在这里预览效果</span></div></div><div id="preview-caption" class="preview-caption">${hasWatermark ? '水印将直接合成到图片中' : '所有内容均可在提交前核对'}</div>${hasWatermark
      ? watermarkControls()
      : ''}</section>${!studio
      ? '<section class="summary-card"><h3>本次记录</h3><div id="form-summary"></div></section>'
      : ''}<p class="preview-note">${icon('shield')} ${studio ? '生成与下载都在浏览器内完成。' : '原任务的开放时间、权限与审核结果以接龙管家为准。'}</p></aside></div>`)
  updateSummary()
  void updatePreview()
}
function updateSummary() {
  const target = $('#form-summary')
  if (!target)
    return
  const completed = draft.values.filter(v => v.Files.length || v.Values.length || v.Texts.some(x => String(x) !== ''))
  target.innerHTML = `<div><span>填写人</span><strong>${esc(draft.signature || '待填写')}</strong></div><div><span>已填写字段</span><strong>${completed.length} / ${schema?.fields.filter(f => ![12, 13, 14].includes(f.FieldType) && !f.IsHidden).length || 0}</strong></div><div><span>媒体附件</span><strong>${draft.values.reduce((n, v) => n + v.Files.length, 0)} 个</strong></div>`
}
async function updatePreview() {
  const epoch = ++previewEpoch
  const target = $('#photo-preview')
  if (!target || !schema)
    return
  const candidates = draft.values.flatMap(v => v.Files.map(f => ({
    f,
    field: schema!.fields.find(x => x.Id === v.FieldId)!,
  }))).filter(x => [8, 19, 25].includes(x.field.FieldType))
  const current = candidates.find(x => x.f.ClientId === selectedPreview) || candidates.find(x => x.field.FieldType === 25) || candidates[0]
  if (!current) {
    target.innerHTML = `<div class="preview-placeholder">${icon('layers')}<strong>让照片带上你的记录</strong><span>选择照片后，在这里预览效果</span></div>`
    return
  }
  const { f, field } = current
  const local = locals.find(x => x.id === f.ClientId)
  let src = fileUrl(f)
  if (local && field.FieldType === 25) {
    try {
      const blob = await composeImage(local.file, watermark)
      if (epoch !== previewEpoch)
        return
      if (lastPreviewUrl)
        URL.revokeObjectURL(lastPreviewUrl)
      src = lastPreviewUrl = URL.createObjectURL(blob)
    }
    catch (e) {
      if (epoch === previewEpoch)
        toast((e as Error).message, true)
      return
    }
  }
  if (epoch !== previewEpoch)
    return
  target.innerHTML = `<img src="${esc(src)}" alt="${field.FieldType === 25
    ? '水印效果预览'
    : '图片预览'}">`
  $('#preview-caption').textContent = `${f.Name || f.FileName || '已选照片'}${local
    ? ` · ${bytes(local.file.size)}`
    : ''}`
}
async function openTask(id: string, recordId: string | number = 0, providedSchema?: FormSchema) {
  taskLoadEpoch++
  await saveCurrent()
  const data = providedSchema || await request(`/api/threads/${encodeURIComponent(id)}/form?recordId=${encodeURIComponent(recordId)}`)
  releaseUrls()
  scheduled = null
  schema = data
  submitted = false
  draft = {
    signature: data.signature || me.user?.name || '',
    number: data.number,
    values: structuredClone(data.values),
  }
  locals = []
  watermark = watermarkDefaults()
  prepared = null
  savedAt = ''
  selectedPreview = null
  if (view !== 'manual')
    view = 'tasks'
  const setting = data.fields.find((f: Field) => f.FieldType === 25)?.WatermarkPhotoSetting
  if (setting) {
    const bits = Number(setting.AntiCheating?.WatermarkPhoto ?? 7)
    watermark.showTime = !!(bits & 1)
    watermark.showAddress = !!(bits & 2)
    watermark.showCoordinates = !!(bits & 4)
    watermark.title = setting.Title || ''
  }
  try {
    const saved = await readDraft(draftKey())
    if (saved && saved.schemaHash === JSON.stringify(schema!.fields)) {
      draft = saved.draft
      locals = saved.locals
      watermark = saved.watermark
      toast('已恢复本地草稿')
    }
  }
  catch { }
  editorPage()
  window.scrollTo(0, 0)
}
async function openStudio() {
  taskLoadEpoch++
  await saveCurrent()
  releaseUrls()
  scheduled = null
  view = 'studio'
  submitted = false
  schema = {
    thread: {
      id: 'local-watermark',
      title: '水印工作室',
      author: '',
      type: 0,
      status: 'open',
      date: '',
    },
    fields: [
      {
        Id: 1,
        Name: '你的照片',
        FieldType: 25,
        MaxPhotoCount: 30,
      },
    ],
    values: [],
    signature: '',
    number: '',
    recordId: 0,
    itemId: 0,
    requireSignature: false,
    requireNumber: false,
    numberLabel: '',
    uploadConfig: {
      Image: { Size: 30 },
    },
    canSubmit: true,
    unavailableReason: '',
    endpoint: '',
    needPrivacy: false,
  }
  draft = {
    signature: '',
    number: '',
    values: [
      blankValue(schema.fields[0]),
    ],
  }
  locals = []
  watermark = watermarkDefaults()
  prepared = null
  savedAt = ''
  try {
    const saved = await readDraft(draftKey())
    if (saved) {
      draft = saved.draft
      locals = saved.locals
      watermark = saved.watermark
    }
  }
  catch { }
  editorPage()
}
async function addFiles(fieldId: number, files: File[]) {
  const f = schema!.fields.find(f => f.Id === fieldId)!
  const v = draft.values.find(v => v.FieldId === fieldId)!
  const l = limits(f)
  if (f.IsDisabled || f.IsFixed)
    return
  if (v.Files.length + files.length > l.max)
    throw new Error(`「${f.Name}」最多选择 ${l.max} 个文件。`)
  for (const file of files) {
    if (!file.size || file.size > l.mb * 1024 * 1024)
      throw new Error(`文件「${file.name}」超过 ${l.mb} MB 或为空。`)
    if ([8, 19, 25].includes(f.FieldType) && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
      throw new Error('照片请使用 JPEG、PNG 或 WebP 格式。')
    if (f.FieldType === 9 && !file.type.startsWith('video/'))
      throw new Error('请选择视频文件。')
  }
  for (const file of files) {
    const id = crypto.randomUUID()
    locals.push({ id, fieldId, file })
    v.Files.push({
      ClientId: id,
      Name: file.name,
      FileName: file.name,
      MediaType: [8, 19, 25].includes(f.FieldType)
        ? 1
        : f.FieldType === 9
          ? 2
          : f.FieldType === 15
            ? 4
            : 3,
    })
    selectedPreview = id
  }
  changed()
  editorPage()
}
function modal(title: string, content: string, footer = '') {
  modalRoot.innerHTML = `<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-heading"><h2>${title}</h2>${button(icon('close'), 'close-modal', 'icon-button', 'aria-label="关闭弹窗"')}</div><div class="modal-content">${content}</div>${footer
    ? `<div class="modal-footer">${footer}</div>`
    : ''}</section></div>`
  setTimeout(() => $<HTMLElement>('input,button', modalRoot)?.focus(), 0)
}
function closeModal() {
  loginEpoch++
  pendingAutomatic = null
  modalRoot.innerHTML = ''
}
async function login() {
  const epoch = ++loginEpoch
  modal('微信扫码登录', '<div class="qr-loading">正在获取微信登录二维码…</div>')
  const data = await request('/api/auth/login', {})
  if (epoch !== loginEpoch)
    return
  modal('微信扫码登录', `<div class="qr-panel"><div class="qr-frame"><img src="${esc(data.qrUrl)}?t=${Date.now()}" alt="微信登录二维码"></div><h3 id="qr-status">请使用微信扫一扫</h3><p>扫码后在微信中确认登录<br>二维码约 5 分钟内有效</p></div>`)
  while (epoch === loginEpoch) {
    const result = await request('/api/auth/poll', {})
    if (epoch !== loginEpoch)
      return
    if (result.status === 'success') {
      closeModal()
      me = await request('/api/auth/me')
      toast('微信连接成功')
      if (automationReturn || view === 'automation')
        await automationPage()
      else
        await loadTasks()
      return
    }
    if (result.status === 'expired') {
      $('#qr-status').textContent = '二维码已过期'
      $('.qr-panel').insertAdjacentHTML('beforeend', button('刷新二维码', 'login', 'button primary'))
      return
    }
    if (result.status === 'scanned')
      $('#qr-status').textContent = '已扫码，请在微信中确认'
    await new Promise(r => setTimeout(r, 1500))
  }
}
async function stageOutgoing() {
  const outgoing = structuredClone(draft)
  for (const value of outgoing.values) {
    for (const [index, f] of value.Files.entries()) {
      if (!f.ClientId)
        continue
      const local = locals.find(l => l.id === f.ClientId)!
      const field = schema!.fields.find(x => x.Id === value.FieldId)!
      const fingerprint = JSON.stringify(field.FieldType === 25
        ? { watermark, renderer: WATERMARK_RENDER_VERSION }
        : null)
      if (!local.stagedId || local.stagedFingerprint !== fingerprint) {
        if ($('#prepare-progress'))
          $('#prepare-progress').textContent = `正在处理 ${local.file.name}…`
        const data = new FormData()
        let file = local.file
        if (field.FieldType === 25 && watermark.enabled) {
          const blob = await composeImage(file, watermark)
          file = new File([blob], `${file.name.replace(/\.[^.]+$/, '')}-watermark.jpg`, { type: 'image/jpeg' })
        }
        data.append('file', file)
        const staged = await request('/api/media', data)
        local.stagedId = staged.id
        local.stagedFingerprint = fingerprint
      }
      value.Files[index] = { LocalId: local.stagedId }
    }
  }
  return outgoing
}
async function prepare() {
  if (scheduled)
    throw new Error('请使用保存待办按钮。')
  const form = $<HTMLFormElement>('#editor-form')
  if (!form.reportValidity())
    return
  await saveCurrent()
  modal('正在准备预览', '<div class="prepare-progress"><span class="spinner"></span><h3 id="prepare-progress">正在验证表单…</h3><p>完成后请核对内容，再确认提交。</p></div>')
  const outgoing = await stageOutgoing()
  $('#prepare-progress').textContent = '正在上传附件并生成最终预览…'
  prepared = await request(`/api/threads/${encodeURIComponent(schema!.thread.id)}/prepare?recordId=${encodeURIComponent(schema!.recordId)}`, { ...outgoing, privacyAgreed: !schema!.needPrivacy || $<HTMLInputElement>('#privacy-consent')?.checked })
  const rows = prepared.payload.RecordValues.filter((v: RecordValue) => v.HasValue).map((v: RecordValue) => `<div class="review-row"><strong>${esc(v.FieldName)}</strong><div>${v.Texts.map((x: any) => `<span>${esc(x)}</span>`).join('')}${v.FieldType === 16 && v.Values[0]
    ? `<code>${esc(v.Values[0])}</code>`
    : ''}${v.Files.map((f: JsonObject) => `<a href="${esc(safeUrl(f.Url))}" target="_blank" rel="noreferrer">${f.MediaType === 1
    ? `<img src="${esc(safeUrl(f.Url))}" alt="${esc(f.Name || f.FileName)}">`
    : icon('file')}<span>${esc(f.Name || f.FileName)}</span></a>`).join('')}</div></div>`).join('')
  modal('确认本次提交', `<div class="review-title"><span class="feature-icon">${icon('shield')}</span><div><h3>${esc(schema!.thread.title)}</h3><p>${schema!.recordId ? '修改已有记录' : '新建记录'} · ${esc(draft.signature)} · ${prepared.summary.files} 个附件</p></div></div>${me.demo ? '<div class="notice demo-notice">演示提交：仅保存本机记录。</div>' : ''}<div class="review-fields">${rows || '<p>本次仅提交署名。</p>'}</div><details class="payload-details"><summary>查看提交数据</summary><pre>${esc(JSON.stringify(prepared.payload, null, 2))}</pre></details><p class="field-tip">预览在 10 分钟内有效。请核对水印图片、位置和所有字段。</p>`, button('返回编辑', 'close-modal', 'button') + button(me.demo ? '确认演示提交' : '确认提交至接龙管家', 'submit', 'button primary'))
}
async function submit(buttonEl: HTMLButtonElement) {
  if (!prepared)
    throw new Error('请重新生成预览。')
  buttonEl.disabled = true
  buttonEl.textContent = '正在提交…'
  try {
    const result = await request(`/api/threads/${encodeURIComponent(schema!.thread.id)}/submit`, { key: prepared.key })
    submitted = true
    clearTimeout(saveTimer)
    await removeDraft(draftKey())
    prepared = null
    modal('提交完成', `<div class="success-panel"><span>${icon('shield')}</span><h3>${result.demo ? '演示提交成功' : '接龙管家已确认提交'}</h3><p>${esc(result.message)}</p></div>`, button('返回任务列表', 'done', 'button primary'))
  }
  catch (e) {
    prepared = null
    modal('提交未完成', `<div class="notice error-notice">${esc((e as Error).message)}</div>`, button('返回编辑', 'close-modal', 'button'))
    throw e
  }
}
async function exportImages() {
  const files = locals.filter(f => schema!.fields.find(x => x.Id === f.fieldId)?.FieldType === 25)
  if (!files.length)
    throw new Error('请先选择要生成水印的照片。')
  for (const file of files) {
    const blob = await composeImage(file.file, watermark)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${file.file.name.replace(/\.[^.]+$/, '')}-watermark.jpg`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
  toast(`已生成 ${files.length} 张照片`)
}
async function historyPage() {
  await saveCurrent()
  schema = null
  scheduled = null
  view = 'history'
  shell('<div class="empty-state">正在加载提交记录…</div>')
  if (!me.authenticated) {
    welcome()
    return
  }
  const data = await request('/api/history')
  shell(`<section class="page-heading compact"><div><div class="eyebrow">ACTIVITY</div><h1>提交记录<span class="title-dot">.</span></h1><p>在当前账号会话中，查看每次提交的结果。</p></div>${button(`${icon('refresh')} 刷新`, 'nav-history', 'button')}</section><section class="history-list">${data.items.length
    ? data.items.map((x: any) => `<article class="history-item"><span class="history-icon ${x.status !== 'success'
        ? 'warning'
        : ''}">${icon(x.status === 'success'
        ? 'shield'
        : 'help')}</span><div><h3>${esc(x.title)} ${x.demo ? '<span class="badge demo-badge">演示</span>' : ''}</h3><p>${esc(x.message)}</p><small>${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(x.createdAt))}${x.signature
        ? ` · ${esc(x.signature)}`
        : ''}</small></div><span class="badge ${x.status !== 'success'
        ? 'closed'
        : ''}">${x.status === 'success'
        ? '已完成'
        : x.status === 'unknown'
          ? '待核实'
          : '未提交'}</span></article>`).join('')
    : `<div class="empty-state">${icon('file')}<h2>还没有提交记录</h2><p>完成第一次提交后，你会在这里看到结果。</p></div>`}</section>`)
}
async function showRecords() {
  const data = await request(`/api/threads/${encodeURIComponent(schema!.thread.id)}/records`)
  modal('我的已有记录', data.records.length
    ? `<div class="record-list">${data.records.map((r: any) => `<button class="record-item" data-action="edit-record" data-id="${esc(r.id)}" ${r.editable ? '' : 'disabled'}><span><strong>${esc(r.signature || '我的记录')}</strong><small>${esc(r.date)}</small></span><span>${r.editable ? '编辑' : '当前不可编辑'}</span></button>`).join('')}</div>`
    : '<div class="empty-state"><h3>当前列表没有可编辑的本人记录</h3><p>可新建记录，或在官网确认当前账号与权限。</p></div>')
}
function beijingDay(offset = 0) {
  return new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10)
}
function automaticSettings() {
  const { plan, run, editable, mailConfigured } = scheduled!
  return `<section class="form-card automatic-settings"><div class="card-heading"><span class="feature-icon">${icon('clock')}</span><div><h2>${esc(run.date)} · ${editable
    ? '待签到内容'
    : esc(runLabels[run.status])}</h2><p>${run.sourceDate
    ? `初始内容来自 ${esc(run.sourceDate)} 的本人签到。`
    : run.source === 'edited'
      ? '这份内容已手动填写并保存。'
      : '昨天没有本人签到记录，请填写这次的内容。'}</p></div><span class="badge ${plan.enabled ? '' : 'closed'}">${plan.enabled ? '循环已启动' : '已暂停'}</span></div>
    <div class="notice ${editable ? '' : 'demo-notice'}">${esc(run.message)}${!editable
      ? ' 可切换到下一次待办继续编辑。'
      : ''}</div>
    <div class="two-columns">${input('自动签到时间（北京时间）', plan.time, `id="auto-time" type="time" min="00:00" max="22:59" required ${editable ? '' : 'disabled'}`)}${input('通知邮箱（可留空）', plan.recipient, `id="auto-recipient" type="text" inputmode="email" placeholder="留空则仅在站内查看" maxlength="254" ${editable ? '' : 'disabled'}`)}</div>
    <p class="field-tip">${mailConfigured ? '邮件服务可用；邮箱留空或填写不完整时使用站内模式。' : '邮件服务未配置完整，当前使用站内模式，不影响自动签到。'} 登录过期后，在网站重新扫码即可恢复。</p>
    <p class="field-tip">到点后自动提交；若已过设定时间，会在当天 23:00 前核对并补交。复用的照片保留原有水印，可重新上传替换。</p></section>`
}
async function automationPage() {
  taskLoadEpoch++
  await saveCurrent()
  releaseUrls()
  schema = null
  scheduled = null
  view = 'automation'
  if (!me.authenticated) {
    automationReturn = true
    shell(`<div class="empty-state">${icon('clock')}<h2>登录后管理自动签到</h2><p>使用原微信账号重新扫码，查看计划与当天待办。</p>${button('微信扫码登录', 'login', 'button primary')}</div>`)
    return
  }
  const data = await request('/api/automations')
  if (view !== 'automation' || schema)
    return
  const mailStates: Record<string, string> = {
    pending: '等待发送',
    sending: '发送中',
    sent: '已发送',
    failed: '发送失败',
    unknown: '请检查收件箱',
  }
  shell(`<section class="page-heading compact"><div><div class="eyebrow">DAILY ROUTINES</div><h1>自动签到<span class="title-dot">.</span></h1><p>安排循环打卡，提前编辑每一天的待签到内容。</p></div>${button(`${icon('refresh')} 刷新状态`, 'nav-automation', 'button')}</section>
    <div class="automatic-intro"><div>${icon('clock')}<strong>按北京时间执行</strong><p>默认 18:00，可为每个任务单独设置。每天默认复制本人昨日记录。</p></div><div>${icon('shield')}<strong>待办保存在本机</strong><p>关闭网页后继续运行；请保持本机服务运行。登录过期时等待重新扫码。</p></div><div>${icon('file')}<strong>${data.mail.configured ? '可选邮件通知' : '站内模式'}</strong><p>${data.mail.configured ? '填写邮箱可接收结果和续期提醒，也可以留空。' : '无需配置邮箱，结果、待办与登录状态都在这里查看。'}</p></div></div>
    ${me.demo ? '<div class="notice demo-notice">演示计划只在本机模拟执行，不会发送真实签到或邮件。</div>' : ''}
    <section class="automatic-list">${data.plans.length
      ? data.plans.map((plan: JsonObject) => {
          const today = plan.today as DailyCheckin | null
          const status = plan.loginExpired
            ? '等待重新登录'
            : today ? runLabels[today.status] : '等待生成待办'
          return `<article class="automatic-card"><div class="automatic-card-heading"><span class="task-icon blue">${icon('clock')}</span><div><span class="task-type">循环打卡 · ThreadId ${esc(plan.thread.id)}</span><h2>${esc(plan.thread.title)}</h2></div><span class="badge ${!plan.enabled || plan.loginExpired || today?.status === 'unknown' || today?.status === 'failed'
            ? 'closed'
            : ''}">${plan.enabled
            ? esc(status)
            : '已暂停'}</span></div>
        <div class="automatic-facts"><div><span>每日计划时间</span><strong>${esc(plan.time)} <small>北京时间</small></strong></div><div><span>通知方式</span><strong>${plan.emailEnabled
          ? esc(plan.recipient)
          : '站内查看'}</strong></div><div><span>今日状态</span><strong>${esc(status)}</strong></div></div>
        <p class="automatic-message">${esc(plan.loginExpired
          ? '请使用原微信账号重新登录，恢复当天的签到。'
          : today?.message || '打开待办即可填写或核对当天内容。')}</p>
        <div class="automatic-card-actions">${plan.loginExpired
          ? button(`${icon('wechat')} 重新扫码`, 'login', 'button primary')
          : ''}${button(`${icon('edit')} ${plan.enabled ? '编辑下次待办' : '编辑并启动'}`, 'auto-open', 'button', `data-id="${esc(plan.id)}"`)}${today
          ? button('查看今日内容', 'auto-open', 'text-button', `data-id="${esc(plan.id)}" data-date="${beijingDay()}"`)
          : ''}${plan.enabled
          ? button('暂停循环签到', 'auto-pause', 'text-button', `data-id="${esc(plan.id)}"`)
          : ''}</div>
        ${plan.recent.length
          ? `<details class="automatic-records"><summary>最近签到记录</summary>${plan.recent.slice(0, 7).map((run: DailyCheckin) => `<div><time>${esc(run.date)}</time><span>${esc(runLabels[run.status])}</span><p>${esc(run.message)}</p></div>`).join('')}</details>`
          : ''}</article>`
        }).join('')
      : `<div class="empty-state">${icon('clock')}<h2>安排你的第一个循环签到</h2><p>打开周期打卡任务，点击“启动循环签到”，核对内容后保存。</p>${button('查看我的任务', 'nav-tasks', 'button primary')}</div>`}</section>
    ${data.notices.length
      ? `<section class="automatic-mail-history"><h2>最近邮件通知</h2>${data.notices.map((notice: JsonObject) => `<div><span>${esc(notice.subject)}</span><span class="muted">${esc(mailStates[notice.state] || notice.state)}</span></div>`).join('')}</section>`
      : ''}`)
}
async function useAutomatic(data: JsonObject) {
  await saveCurrent()
  releaseUrls()
  taskLoadEpoch++
  view = 'automation'
  scheduled = {
    plan: data.plan,
    run: data.run,
    editable: data.editable,
    mailConfigured: !!data.mail?.configured,
  }
  schema = data.run.schema
  draft = structuredClone(data.run.draft)
  locals = []
  watermark = watermarkDefaults()
  prepared = null
  submitted = false
  savedAt = ''
  selectedPreview = null
  const setting = schema!.fields.find(field => field.FieldType === 25)?.WatermarkPhotoSetting
  if (setting) {
    const bits = Number(setting.AntiCheating?.WatermarkPhoto ?? 7)
    watermark.showTime = !!(bits & 1)
    watermark.showAddress = !!(bits & 2)
    watermark.showCoordinates = !!(bits & 4)
    watermark.title = setting.Title || ''
  }
  try {
    const saved = await readDraft(draftKey())
    if (data.editable && saved?.scheduleRevision === data.run.revision && saved.schemaHash === JSON.stringify(schema!.fields)) {
      draft = saved.draft
      locals = saved.locals
      watermark = saved.watermark
      scheduled.plan.time = saved.scheduleTime || scheduled.plan.time
      scheduled.plan.recipient = saved.scheduleRecipient ?? scheduled.plan.recipient
      scheduled.run.privacyAgreed = saved.schedulePrivacy ?? scheduled.run.privacyAgreed
      toast('已恢复本机暂存内容，请保存到待办后生效')
    }
  }
  catch { }
  editorPage()
  window.scrollTo(0, 0)
}
async function openAutomatic(id: string, date = '') {
  await useAutomatic(await request(`/api/automations/${encodeURIComponent(id)}/draft${date
    ? `?date=${date}`
    : ''}`))
}
async function prepareAutomatic(enabled: boolean) {
  if (!scheduled?.editable || !$<HTMLFormElement>('#editor-form').reportValidity())
    return
  await saveCurrent()
  const privacyAgreed = !schema!.needPrivacy || $<HTMLInputElement>('#privacy-consent')?.checked === true
  modal('准备待签到内容', '<div class="prepare-progress"><span class="spinner"></span><h3 id="prepare-progress">正在保存本机附件…</h3><p>确认后保存到待办，按计划执行。</p></div>')
  const outgoing = await stageOutgoing()
  pendingAutomatic = {
    planId: scheduled.plan.id,
    date: scheduled.run.date,
    revision: scheduled.run.revision,
    draft: outgoing,
    time: scheduled.plan.time,
    recipient: scheduled.plan.recipient,
    enabled,
    privacyAgreed,
  }
  const rows = outgoing.values.map(value => `<div class="review-row"><strong>${esc(schema!.fields.find(field => field.Id === value.FieldId)?.Name)}</strong><div>${value.Texts.map(text => `<span>${esc(text)}</span>`).join('')}${value.Files.map(file => `<span>${esc(file.Name || file.FileName || '本机附件')}</span>`).join('')}${value.Values.length && !value.Texts.length
    ? `<span>${esc(value.Values.join('、'))}</span>`
    : ''}</div></div>`).join('')
  modal(enabled ? '确认循环签到安排' : '保存并暂停循环签到', `<div class="review-title"><span class="feature-icon">${icon('clock')}</span><div><h3>${esc(schema!.thread.title)}</h3><p>${esc(scheduled.run.date)} · ${esc(scheduled.plan.time)}（北京时间） · ${esc(draft.signature)}</p></div></div><div class="notice">${enabled ? '确认后启动循环签到。若已过设定时间，将在当天 23:00 前核对并提交；后续每天默认复制昨天的本人记录。' : '保存这份待办，并暂停后续自动提交。'}</div><div class="review-fields">${rows}</div><p class="field-tip">${scheduled.mailConfigured && /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/.test(scheduled.plan.recipient)
    ? '结果及登录续期提醒将发送到所填邮箱。'
    : '当前使用站内模式，无需邮箱；请在网站查看结果和登录状态。'}</p>`, button('返回编辑', 'close-modal', 'button') + button(enabled ? '确认保存并启动' : '确认保存并暂停', 'auto-confirm-save', 'button primary'))
}
async function confirmAutomatic(el: HTMLButtonElement) {
  if (!pendingAutomatic || !scheduled)
    throw new Error('请重新核对待办。')
  const body = pendingAutomatic
  el.disabled = true
  try {
    const data = await request(`/api/automations/${body.planId}/save`, body)
    clearTimeout(saveTimer)
    await removeDraft(draftKey())
    submitted = true
    releaseUrls()
    locals = []
    scheduled.run = data.run
    scheduled.plan = {
      ...scheduled.plan,
      time: body.time,
      recipient: body.recipient,
      enabled: body.enabled,
    }
    draft = structuredClone(data.run.draft)
    schema = data.run.schema
    savedAt = ''
    closeModal()
    editorPage()
    toast(body.enabled ? '待办已保存，循环签到已启动' : '待办已保存，循环签到已暂停')
  }
  finally {
    el.disabled = false
  }
}
async function action(name: string, el: HTMLElement) {
  if (name === 'nav-automation') {
    await automationPage()
    return
  }
  if (name === 'auto-start') {
    const data = await request('/api/automations', { threadId: schema!.thread.id })
    await useAutomatic(data)
    return
  }
  if (name === 'auto-open') {
    await openAutomatic(el.dataset.id!, el.dataset.date || '')
    return
  }
  if (name === 'auto-other-day') {
    await openAutomatic(scheduled!.plan.id, scheduled!.run.date === beijingDay()
      ? beijingDay(1)
      : beijingDay())
    return
  }
  if (name === 'auto-refresh-form') {
    const data = await request(`/api/automations/${scheduled!.plan.id}/refresh`, { date: scheduled!.run.date, revision: scheduled!.run.revision })
    await removeDraft(draftKey())
    submitted = true
    await useAutomatic({
      ...scheduled,
      run: data.run,
      mail: { configured: scheduled!.mailConfigured },
    })
    return
  }
  if (name === 'auto-save' || name === 'auto-save-paused') {
    await prepareAutomatic(name === 'auto-save')
    return
  }
  if (name === 'auto-confirm-save') {
    await confirmAutomatic(el as HTMLButtonElement)
    return
  }
  if (name === 'auto-pause') {
    await request(`/api/automations/${el.dataset.id}/toggle`, { enabled: false })
    toast('已暂停后续自动签到')
    await automationPage()
    return
  }
  if (name === 'close-modal') {
    closeModal()
    return
  }
  if (name === 'nav-studio') {
    await openStudio()
    return
  }
  if (name === 'nav-tasks' || name === 'nav-manual' || name === 'done') {
    closeModal()
    await saveCurrent()
    releaseUrls()
    schema = null
    view = name === 'nav-manual' || (name === 'done' && view === 'manual')
      ? 'manual'
      : 'tasks'
    me = await request('/api/auth/me')
    me.authenticated
      ? await loadTasks()
      : welcome()
    return
  }
  if (name === 'nav-history') {
    await historyPage()
    return
  }
  if (name === 'help') {
    modal('使用工作台', `<div class="help-content"><h3>连接与选择任务</h3><p>微信扫码后，通过参与、发布或收藏查找接龙、签到与打卡。未出现在列表中的任务，可以粘贴链接直接打开。</p><h3>循环签到</h3><p>在周期打卡详情中点击“启动循环签到”，核对待办后保存。默认每日北京时间 18:00 执行，内容复制本人昨日记录，可单独修改今天或明天的待办。关闭网页仍会运行，请保持本机服务运行。</p><h3>登录续期与可选邮件</h3><p>邮箱和邮件服务均为可选。配置不完整时，结果只在站内显示。登录失效后重新扫码，可在当天设定时间至 23:00 之间核对并补交今日签到，不补交往日记录。</p><h3>编辑照片与位置</h3><p>水印相机接受本地图片，按你的设置合成时间、地点和经纬度。关闭自动水印即可使用原图。位置字段支持编辑地址与坐标。复用的照片保留原有水印，需要更新时可重新上传。</p><h3>编辑已有记录</h3><p>打开任务后选择“我的已有记录”。仅展示本人记录，可编辑状态由接龙管家返回。</p><h3>预览与提交</h3><p>准备预览会上传附件。确认后才发送表单；发生网络异常时，先在官网核对，避免重复提交。</p><h3>草稿与待办</h3><p>本机暂存位于当前浏览器；点击保存后，自动签到待办及附件保存在本机服务端，同一微信账号重新登录后仍可继续使用。</p></div>`)
    return
  }
  if (name === 'login') {
    await login()
    return
  }
  if (name === 'demo') {
    await request('/api/auth/demo', {})
    me = await request('/api/auth/me')
    view = 'tasks'
    await loadTasks()
    return
  }
  if (name === 'logout') {
    await saveCurrent()
    await request('/api/auth/logout', {})
    releaseUrls()
    schema = null
    scheduled = null
    me = await request('/api/auth/me')
    view = 'tasks'
    welcome()
    return
  }
  if (name === 'refresh') {
    await loadTasks()
    return
  }
  if (name === 'more') {
    page++
    await loadTasks(true)
    return
  }
  if (name.startsWith('filter-')) {
    activeFilter = name.slice(7)
    tasksPage()
    return
  }
  if (name === 'import') {
    if (!me.authenticated)
      throw new Error('请先登录微信或进入演示空间。')
    modal('添加任务', `${input('任务链接 / 分享链接 / 短 ID / ThreadId', '', 'id="import-input" placeholder="粘贴任务链接或 jielong.com/s/… 分享链接"')}<p class="field-tip">支持自动跳转的分享链接，也可直接输入短 ID 或数字 ThreadId。添加后保存在“手动添加”分类，同一任务自动去重。</p>`, button('添加并打开', 'resolve-task', 'button primary'))
    return
  }
  if (name === 'resolve-task') {
    const buttonEl = el as HTMLButtonElement
    buttonEl.disabled = true
    buttonEl.textContent = '正在解析并保存…'
    try {
      const data = await request('/api/manual-threads', {
        value: $<HTMLInputElement>('#import-input').value.trim(),
      })
      view = 'manual'
      activeFilter = 'all'
      search = ''
      await openTask(data.id, 0, data.form)
      closeModal()
      toast('任务已保存到“手动添加”')
    }
    finally {
      buttonEl.disabled = false
      buttonEl.textContent = '添加并打开'
    }
    return
  }
  if (name === 'open-task') {
    await openTask(el.dataset.id!)
    return
  }
  if (name === 'edit-record') {
    await openTask(schema!.thread.id, el.dataset.id!)
    closeModal()
    return
  }
  if (name === 'records') {
    await showRecords()
    return
  }
  if (name === 'remove-file') {
    const id = Number(el.dataset.field)
    const v = draft.values.find(v => v.FieldId === id)!
    const index = Number(el.dataset.index)
    const f = v.Files[index]
    v.Files.splice(index, 1)
    const local = locals.find(x => x.id === f.ClientId)
    if (local?.url)
      URL.revokeObjectURL(local.url)
    locals = locals.filter(x => x.id !== f.ClientId)
    changed()
    editorPage()
    return
  }
  if (name === 'preview-file') {
    const v = draft.values.find(v => v.FieldId === Number(el.dataset.field))!
    const f = v.Files[Number(el.dataset.index)]
    selectedPreview = f.ClientId
    await updatePreview()
    return
  }
  if (name === 'watermark-settings') {
    $<HTMLInputElement>('[data-watermark="time"]').focus()
    $('.preview-card').scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  if (name === 'sync-location') {
    const v = draft.values.find(v => schema!.fields.find(f => f.Id === v.FieldId)?.FieldType === 16)
    if (!v || !v.Values[0])
      throw new Error('请先填写表单位置。')
    const p = JSON.parse(v.Values[0])
    watermark.address = v.Texts[0] || ''
    watermark.latitude = String(p.latitude ?? '')
    watermark.longitude = String(p.longitude ?? '')
    changed()
    editorPage()
    return
  }
  if (name === 'geolocate') {
    if (!navigator.geolocation)
      throw new Error('此浏览器不支持定位，请手动填写。')
    const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, () => reject(new Error('未获取到位置，请允许定位或手动填写。')), { enableHighAccuracy: true, timeout: 15000 }))
    const v = draft.values.find(v => v.FieldId === Number(el.dataset.field))!
    v.Values = [
      JSON.stringify({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
    ]
    changed()
    editorPage()
    toast('已填入设备坐标，请补充地点名称（坐标系由设备提供）。')
    return
  }
  if (name === 'prepare') {
    await prepare()
    return
  }
  if (name === 'submit') {
    await submit(el as HTMLButtonElement)
    return
  }
  if (name === 'export') {
    await exportImages()
    return
  }
  if (name === 'signature') {
    openSignature(Number(el.dataset.field))
    return
  }
  if (name === 'clear-signature') {
    const canvas = $<HTMLCanvasElement>('#signature-canvas')
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height)
    return
  }
  if (name === 'save-signature') {
    const canvas = $<HTMLCanvasElement>('#signature-canvas')
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve))
    if (blob) {
      await addFiles(Number(canvas.dataset.field), [
        new File([blob], 'signature.png', { type: 'image/png' }),
      ])
      closeModal()
    }
  }
}
function openSignature(fieldId: number) {
  modal('手写签名', `<canvas id="signature-canvas" width="800" height="300" data-field="${fieldId}" aria-label="签名画布"></canvas>`, button('清空', 'clear-signature', 'button') + button('使用签名', 'save-signature', 'button primary'))
  const canvas = $<HTMLCanvasElement>('#signature-canvas')
  const ctx = canvas.getContext('2d')!
  let drawing = false
  ctx.lineWidth = 4
  ctx.lineCap = 'round'
  ctx.strokeStyle = '#172b24'
  const point = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]
  }
  canvas.onpointerdown = (e) => {
    drawing = true
    canvas.setPointerCapture(e.pointerId)
    ctx.beginPath()
    const [x, y] = point(e)
    ctx.moveTo(x, y)
  }
  canvas.onpointermove = (e) => {
    if (drawing) {
      const [x, y] = point(e)
      ctx.lineTo(x, y)
      ctx.stroke()
    }
  }
  canvas.onpointerup = () => drawing = false
  canvas.onpointercancel = () => drawing = false
}
document.addEventListener('click', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-action]')
  if (!el)
    return
  if (el instanceof HTMLButtonElement && el.disabled)
    return
  e.preventDefault()
  void action(el.dataset.action!, el).catch((err) => {
    if ($('#prepare-progress'))
      closeModal()
    toast(err.message, true)
  })
})
document.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement
  if (el.id === 'task-search') {
    search = el.value
    renderTaskCards()
    return
  }
  if (!schema)
    return
  if (scheduled && ['auto-time', 'auto-recipient'].includes(el.id)) {
    scheduled.plan[el.id === 'auto-time'
      ? 'time'
      : 'recipient'] = el.value
  }
  else if (scheduled && el.id === 'privacy-consent') {
    scheduled.run.privacyAgreed = el.checked
  }
  else if (el.id === 'signature-input') {
    draft.signature = el.value
  }
  else if (el.id === 'number-input') {
    draft.number = el.value
  }
  else if (el.dataset.watermark) {
    (watermark as any)[el.dataset.watermark] = el.type === 'checkbox'
      ? el.checked
      : el.value
    void updatePreview()
  }
  else if (el.id === 'wm-enabled') {
    watermark.enabled = el.checked
    editorPage()
  }
  else if (el.dataset.field) {
    const id = Number(el.dataset.field)
    const v = draft.values.find(v => v.FieldId === id)!
    const f = schema.fields.find(x => x.Id === id)!
    if (f.IsDisabled || f.IsFixed)
      return
    if (el.dataset.location) {
      const parent = $(`#field-${id}`)
      const address = $<HTMLInputElement>('[data-location="address"]', parent).value
      const lat = $<HTMLInputElement>('[data-location="latitude"]', parent).value
      const lng = $<HTMLInputElement>('[data-location="longitude"]', parent).value
      v.Texts = address
        ? [address]
        : []
      v.Values = lat !== '' && lng !== ''
        ? [
            JSON.stringify({
              latitude: Number(lat),
              longitude: Number(lng),
            }),
          ]
        : []
    }
    else if (el.dataset.structured) {
      try {
        const parsed = JSON.parse(el.value)
        Object.assign(v, parsed, { FieldId: id })
        el.setCustomValidity('')
      }
      catch {
        el.setCustomValidity('请输入有效 JSON')
      }
    }
    else if (f.FieldType < 5) {
      const parent = $(`#field-${id}`)
      v.Values = f.FieldType === 4
        ? (el.value
            ? [el.value]
            : [])
        : Array.from(parent.querySelectorAll<HTMLInputElement>('input:checked')).map(x => x.value)
      v.Texts = v.Values.map(x => f.ControlOptions.Options.find((o: any) => String(o.Value) === String(x))?.Text || '')
    }
    else {
      v.Texts = el.value !== ''
        ? [el.value]
        : []
    }
  }
  else {
    return
  }
  changed()
})
document.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement
  if (el.id === 'list-type') {
    listType = Number(el.value)
    void loadTasks().catch(e => toast(e.message, true))
  }
  if (el.dataset.upload && el.files) {
    void addFiles(Number(el.dataset.upload), Array.from(el.files)).catch(e => toast(e.message, true))
  }
})
document.addEventListener('dragover', (e) => {
  const target = (e.target as Element).closest('[data-drop]')
  if (target) {
    e.preventDefault()
    target.classList.add('dragover')
  }
})
document.addEventListener('dragleave', (e) => {
  (e.target as Element).closest('[data-drop]')?.classList.remove('dragover')
})
document.addEventListener('drop', (e) => {
  const target = (e.target as Element).closest<HTMLElement>('[data-drop]')
  if (target) {
    e.preventDefault()
    target.classList.remove('dragover')
    void addFiles(Number(target.dataset.drop), Array.from(e.dataTransfer?.files || [])).catch(e => toast(e.message, true))
  }
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape')
    closeModal()
  if (e.key === 'Tab' && modalRoot.firstElementChild) {
    const nodes = Array.from(modalRoot.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select,a[href]')).filter(x => x.offsetParent !== null)
    if (e.shiftKey && document.activeElement === nodes[0]) {
      e.preventDefault()
      nodes.at(-1)?.focus()
    }
    else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
      e.preventDefault()
      nodes[0]?.focus()
    }
  }
})
document.addEventListener('submit', (e) => {
  e.preventDefault()
})
function authBanner() {
  return `<div id="auth-banner" class="notice auth-banner">登录已失效，等待同账号其他设备续期，也可在此扫码恢复。${button('微信扫码恢复', 'login', 'button')}</div>`
}
let checkingRememberedLogin = false
async function refreshRememberedLogin() {
  if (!me.expired || checkingRememberedLogin || document.visibilityState !== 'visible' || modalRoot.firstElementChild)
    return
  checkingRememberedLogin = true
  const previous = me
  try {
    const current = await request('/api/auth/me')
    if (me !== previous || !current.authenticated || current.scope !== previous.scope)
      return
    me = current
    $('#auth-banner')?.remove()
    $('.profile').innerHTML = profileContent()
    $('.topbar-end').firstElementChild!.outerHTML = connectionStatus()
    toast('已同步此微信账号的最新登录状态')
    if (!schema && view !== 'studio') {
      if (view === 'automation' || automationReturn)
        await automationPage()
      else if (view === 'history')
        await historyPage()
      else
        await loadTasks()
    }
  }
  finally {
    checkingRememberedLogin = false
  }
}
document.addEventListener('auth-expired', () => {
  if (me.expired)
    return
  me.expired = true
  me.authenticated = false
  automationReturn = view === 'automation'
  toast('登录已失效，其他设备续期后会自动恢复，也可重新扫码。', true)
  if (!$('#auth-banner'))
    $('.topbar')?.insertAdjacentHTML('afterend', authBanner())
  $('.profile').innerHTML = profileContent()
  void refreshRememberedLogin().catch(() => { })
})
window.addEventListener('focus', () => {
  void refreshRememberedLogin().catch(() => { })
})
document.addEventListener('visibilitychange', () => {
  void refreshRememberedLogin().catch(() => { })
})
window.addEventListener('pagehide', () => {
  void saveCurrent()
})
async function init() {
  me = await request('/api/auth/me')
  if (me.authenticated) {
    if (automationReturn)
      await automationPage()
    else
      await loadTasks()
  }
  else {
    welcome()
  }
}
void init().catch((e) => {
  welcome()
  toast(e.message, true)
})
setInterval(() => {
  void refreshRememberedLogin().catch(() => { })
  if (view === 'automation' && !schema && me.authenticated && !me.expired && !modalRoot.firstElementChild && document.visibilityState === 'visible')
    void automationPage().catch(() => { })
}, 30000)
