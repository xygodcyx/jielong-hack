import { expect, it } from 'bun:test'
import { accountKey, manualThreadOwner } from '../src/lib/auth.ts'
import { demoThreads } from '../src/lib/demo.ts'
import { manualThreads, saveManualThread } from '../src/lib/store.ts'

it('手动分类按真实任务去重，同一账号换会话后仍保留且不同账号隔离', async () => {
  const owner = accountKey({ Id: 'fixture-account-a' })
  const other = accountKey({ Id: 'fixture-account-b' })
  const firstSession = {
    id: 'first-session',
    token: 'fixture',
    expire: Date.now() + 60_000,
    accountKey: owner,
  }
  const secondSession = { ...firstSession, id: 'relogged-session' }
  expect(await manualThreadOwner(firstSession)).toBe(await manualThreadOwner(secondSession))
  const task = { ...demoThreads[0], id: '192102039' }
  saveManualThread(owner, task)
  const created = manualThreads(owner).threads[0].savedAt
  saveManualThread(owner, { ...task, title: '更新后的任务标题' })
  const saved = manualThreads(await manualThreadOwner(secondSession))
  expect(saved.page.TotalRecords).toBe(1)
  expect(saved.threads[0].id).toBe('192102039')
  expect(saved.threads[0].title).toBe('更新后的任务标题')
  expect(saved.threads[0].savedAt).toBe(created)
  expect(manualThreads(other).threads).toHaveLength(0)
})
