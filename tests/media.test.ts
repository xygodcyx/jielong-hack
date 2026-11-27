import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'
import { stageMedia } from '../src/lib/media.ts'
import { getMedia, localRoot } from '../src/lib/store.ts'

const originalProbe = process.env.FFPROBE_PATH
afterEach(() => {
  if (originalProbe === undefined)
    delete process.env.FFPROBE_PATH
  else
    process.env.FFPROBE_PATH = originalProbe
})

it('node 上传在缺少 ffprobe 或图片损坏时返回可读错误，并删除暂存字节', async () => {
  const before = await readdir(join(localRoot, 'media'))
  process.env.FFPROBE_PATH = join(localRoot, 'missing-ffprobe')
  await expect(stageMedia('fixture-owner', new File(['fixture'], 'video.mp4', { type: 'video/mp4' }))).rejects.toMatchObject({ status: 422 })
  await expect(stageMedia('fixture-owner', new File(['fixture'], 'image.jpg', { type: 'image/jpeg' }))).rejects.toThrow('图片无法识别')
  expect(await readdir(join(localRoot, 'media'))).toEqual(before)
})

it.skipIf(process.platform === 'win32')('ffprobe 路径包含空格时仍可读取视频元数据，附件按原账号保存', async () => {
  const probe = join(localRoot, 'fixture ffprobe')
  await writeFile(probe, `#!${process.execPath}\nconsole.log(JSON.stringify({streams:[{codec_type:'video',width:320,height:240}],format:{duration:'3.5'}}))\n`, { mode: 0o700 })
  process.env.FFPROBE_PATH = probe
  const result = await stageMedia('fixture-video-owner', new File(['fixture-video'], 'video.mp4', { type: 'video/mp4' }))
  expect(result).toMatchObject({
    name: 'video.mp4',
    mediaType: 2,
    width: 320,
    height: 240,
    duration: 3.5,
  })
  expect(result).not.toHaveProperty('path')
  expect(getMedia('fixture-video-owner', result.id)?.path).toBe(join(localRoot, 'media', result.id))
  expect(getMedia('other-owner', result.id)).toBeNull()
})
