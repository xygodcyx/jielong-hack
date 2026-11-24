export interface WatermarkOptions {
  enabled: boolean
  time: string
  address: string
  latitude: string
  longitude: string
  title: string
  showTime: boolean
  showAddress: boolean
  showCoordinates: boolean
}
export const WATERMARK_RENDER_VERSION = 'jielong-camera-reference-v6'
let brandPromise: Promise<HTMLCanvasElement> | null = null
function loadBrand(): Promise<HTMLCanvasElement> {
  if (!brandPromise) {
    brandPromise = (async () => {
      const image = new Image()
      image.src = '/watermark-logo.webp'
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(image, 0, 0)
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
      // 原图左侧为黄色圆标；仅将右侧字标变白，保留抗锯齿透明度。
      for (let y = 0; y < canvas.height; y++) {
        for (let x = canvas.height; x < canvas.width; x++) {
          const index = (y * canvas.width + x) * 4
          pixels.data[index] = 255
          pixels.data[index + 1] = 255
          pixels.data[index + 2] = 255
        }
      }
      ctx.putImageData(pixels, 0, 0)
      // 提供的 Logo：圆标 96×96，右侧字标的有效边界为 (112,26,180,44)。
      // 按完整相机截图排布：圆标使用文字行高，字标在该行内垂直居中。
      const aligned = document.createElement('canvas')
      aligned.width = 246
      aligned.height = 54
      const alignedCtx = aligned.getContext('2d')!
      alignedCtx.drawImage(canvas, 0, 0, 96, 96, 0, 0, 54, 54)
      alignedCtx.drawImage(canvas, 112, 26, 180, 44, 66, 5, 180, 44)
      return aligned
    })().catch(() => {
      brandPromise = null
      throw new Error('水印 Logo 加载失败，请刷新后重试。')
    })
  }
  return brandPromise
}
function drawBrand(ctx: CanvasRenderingContext2D, brand: HTMLCanvasElement, width: number, height: number, scale: number) {
  const logoHeight = 32 * scale
  const logoWidth = logoHeight * brand.width / brand.height
  const labelFont = 24 * scale
  const labelStyle = `500 ${labelFont}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`
  // 在独立图层中挖空文字，最终透出照片，而非在成图上擦出透明洞。
  const badge = document.createElement('canvas')
  const badgeCtx = badge.getContext('2d')!
  badgeCtx.font = labelStyle
  const metrics = badgeCtx.measureText('真实时间')
  const left = metrics.actualBoundingBoxLeft || 0
  const glyphWidth = (metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight) || metrics.width
  const ascent = metrics.actualBoundingBoxAscent || labelFont * 0.85
  const descent = metrics.actualBoundingBoxDescent || labelFont * 0.1
  badge.width = Math.max(1, Math.round(100 * scale))
  badge.height = Math.max(1, Math.round(32 * scale))
  const insetX = (badge.width - glyphWidth) / 2
  const insetY = (badge.height - ascent - descent) / 2
  const right = 46 * scale
  const x = width - right - logoWidth
  const badgeY = height - 57 * scale - badge.height
  const gap = 8 * scale
  ctx.save()
  ctx.globalAlpha = 0.94
  ctx.drawImage(brand, x, badgeY - gap - logoHeight, logoWidth, logoHeight)
  ctx.restore()
  const badgeX = width - right - badge.width
  badgeCtx.fillStyle = 'rgba(255,255,255,0.8)'
  badgeCtx.beginPath()
  badgeCtx.roundRect(0, 0, badge.width, badge.height, 4 * scale)
  badgeCtx.fill()
  badgeCtx.globalCompositeOperation = 'destination-out'
  badgeCtx.fillStyle = '#000'
  badgeCtx.font = labelStyle
  badgeCtx.textBaseline = 'alphabetic'
  badgeCtx.fillText('真实时间', insetX + left, insetY + ascent)
  ctx.drawImage(badge, badgeX, badgeY)
}

function drawCameraText(ctx: CanvasRenderingContext2D, text: string, x: number, baseline: number, scale: number, maxWidth: number) {
  // 原相机的中文与拉丁字形不同；数字使用衬线字形，避免系统无衬线字体替代后变粗。
  const runs = (text.match(/[\p{Script=Han}\uFF01-\uFF60]+|[^\p{Script=Han}\uFF01-\uFF60]+/gu) || []).map((value) => {
    const chinese = /^[\p{Script=Han}\uFF01-\uFF60]/u.test(value)
    const font = chinese
      ? `300 ${34 * scale}px "PingFang SC", "Microsoft YaHei", sans-serif`
      : `400 ${36 * scale}px "Times New Roman", "Noto Serif", serif`
    ctx.font = font
    return { value, font, width: ctx.measureText(value).width }
  })
  const fullWidth = runs.reduce((sum, run) => sum + run.width, 0)
  ctx.save()
  ctx.translate(x, baseline)
  ctx.scale(Math.min(1, maxWidth / Math.max(1, fullWidth)), 1)
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'alphabetic'
  let offset = 0
  for (const run of runs) {
    ctx.font = run.font
    ctx.fillText(run.value, offset, 0)
    offset += run.width
  }
  ctx.restore()
}
export function localTime() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date()).replace(' ', 'T')
}
export function watermarkDefaults(): WatermarkOptions {
  return {
    enabled: true,
    time: localTime(),
    address: '',
    latitude: '',
    longitude: '',
    title: '',
    showTime: true,
    showAddress: true,
    showCoordinates: true,
  }
}
export async function composeImage(file: File, options: WatermarkOptions): Promise<Blob> {
  const url = URL.createObjectURL(file)
  const image = new Image()
  try {
    image.src = url
    await image.decode()
  }
  catch {
    URL.revokeObjectURL(url)
    throw new Error('无法读取图片，请选择 JPEG、PNG 或 WebP。')
  }
  const ratio = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(image.naturalWidth * ratio)
  canvas.height = Math.round(image.naturalHeight * ratio)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  URL.revokeObjectURL(url)
  if (options.enabled) {
    const brand = await loadBrand()
    const w = canvas.width
    const h = canvas.height
    // 以参考截图内 1080×1440 的照片为基准，不包含手机状态栏及底部按钮。
    const scale = Math.min(w / 1080, h / 480)
    const left = 44 * scale
    const bottom = 58 * scale
    const lineHeight = 52.5 * scale
    const lines: string[] = []
    if (options.title.trim())
      lines.push(options.title.trim())
    if (options.showTime) {
      const date = new Date(`${options.time}:00+08:00`)
      const weekday = Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'Asia/Shanghai' }).format(date)
        : ''
      const [day, time] = options.time.split('T')
      lines.push(`时间：${day?.replaceAll('-', '.') || ''} ${weekday} ${time || ''}`)
    }
    if (options.showAddress)
      lines.push(`地点：${options.address || '未填写地点'}`)
    if (options.showCoordinates && options.latitude !== '' && options.longitude !== '') {
      const lat = Number(options.latitude)
      const lng = Number(options.longitude)
      lines.push(`经纬度：${Math.abs(lat).toFixed(2)}°${lat >= 0
        ? 'N'
        : 'S'} ${Math.abs(lng).toFixed(2)}°${lng >= 0
        ? 'E'
        : 'W'}`)
    }
    let y = h - bottom - (lines.length - 1) * lineHeight
    for (const line of lines) {
      drawCameraText(ctx, line, left, y, scale, w - left - 220 * scale)
      y += lineHeight
    }
    drawBrand(ctx, brand, w, h, scale)
  }
  return new Promise((resolve, reject) => canvas.toBlob(b => b
    ? resolve(b)
    : reject(new Error('图片生成失败。')), 'image/jpeg', 0.94))
}
