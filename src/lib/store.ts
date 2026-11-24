import type { JsonObject, Thread } from '../shared.ts'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'

export const localRoot = process.env.JIELONG_DATA_DIR || join(import.meta.dir, '../../.local')
mkdirSync(localRoot, { recursive: true, mode: 0o700 })
const db = new Database(join(localRoot, 'state.sqlite'), { create: true })
chmodSync(join(localRoot, 'state.sqlite'), 0o600)
db.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS drafts (owner TEXT NOT NULL, thread TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,thread));
  CREATE TABLE IF NOT EXISTS saved_threads (owner TEXT NOT NULL, thread_id TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(owner,thread_id));`)
export interface Session extends JsonObject {
  id: string
  token?: string
  expire: number
  demo?: boolean
  user?: JsonObject
  login?: JsonObject
  accountKey?: string
}

export function saveManualThread(owner: string, thread: Thread) {
  const now = Date.now()
  db.query(`INSERT INTO saved_threads (owner,thread_id,data,created,updated) VALUES (?,?,?,?,?)
    ON CONFLICT(owner,thread_id) DO UPDATE SET data=excluded.data,updated=excluded.updated`).run(owner, thread.id, JSON.stringify(thread), now, now)
}

export function manualThreads(owner: string, pageIndex = 1, pageSize = 50) {
  const rows = db.query('SELECT data,created,updated FROM saved_threads WHERE owner=? ORDER BY created DESC,thread_id ASC LIMIT ? OFFSET ?').all(owner, pageSize, (pageIndex - 1) * pageSize) as { data: string, created: number, updated: number }[]
  const count = db.query('SELECT COUNT(*) AS total FROM saved_threads WHERE owner=?').get(owner) as { total: number }
  return {
    threads: rows.map(row => ({
      ...JSON.parse(row.data) as Thread,
      savedAt: row.created,
      updatedAt: row.updated,
    })),
    page: { PageIndex: pageIndex, PageSize: pageSize, TotalRecords: count.total },
  }
}
export function saveSession(s: Session) {
  db.query('INSERT OR REPLACE INTO sessions VALUES (?,?,?)').run(s.id, JSON.stringify(s), s.expire)
}
export function getSession(id: string): Session | null {
  const r = db.query('SELECT data, expires FROM sessions WHERE id=?').get(id) as any
  return r && r.expires > Date.now()
    ? JSON.parse(r.data)
    : null
}
export function deleteSession(id: string) {
  db.query('DELETE FROM sessions WHERE id=?').run(id)
  db.query('DELETE FROM drafts WHERE owner=?').run(id)
}
export function addHistory(owner: string, data: JsonObject) {
  const id = crypto.randomUUID()
  const now = Date.now()
  db.query('INSERT INTO history VALUES (?,?,?,?)').run(id, owner, JSON.stringify({ id, createdAt: now, ...data }), now)
}
export function history(owner: string) {
  return (db.query('SELECT data FROM history WHERE owner=? ORDER BY created DESC LIMIT 100').all(owner) as any[]).map(x => JSON.parse(x.data))
}
export function saveMedia(owner: string, id: string, data: JsonObject) {
  db.query('INSERT INTO media VALUES (?,?,?,?)').run(id, owner, JSON.stringify(data), Date.now())
}
export function getMedia(owner: string, id: string): JsonObject | null {
  const row = db.query('SELECT data FROM media WHERE owner=? AND id=?').get(owner, id) as any
  return row
    ? JSON.parse(row.data)
    : null
}
export function saveDraft(owner: string, thread: string, data: JsonObject) {
  db.query('INSERT OR REPLACE INTO drafts VALUES (?,?,?)').run(owner, thread, JSON.stringify(data))
}
export function getDraft(owner: string, thread: string) {
  const row = db.query('SELECT data FROM drafts WHERE owner=? AND thread=?').get(owner, thread) as any
  return row
    ? JSON.parse(row.data)
    : null
}
export function removeDraft(owner: string, thread: string) {
  db.query('DELETE FROM drafts WHERE owner=? AND thread=?').run(owner, thread)
}
