/**
 * 데스크톱 SQLite 데이터베이스 파일은 사용자가 선택한 폴더에 저장한다.
 * 모델 API 키 등 사용자 설정을 브라우저 localStorage 대신 여기에 보관한다.
 */
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

type Stmt = {
  run: (...params: unknown[]) => unknown
  get: (...params: unknown[]) => { value?: string } | undefined
}

type SqliteDb = {
  exec: (sql: string) => void
  prepare: (sql: string) => Stmt
  close: () => void
}

let db: SqliteDb | null = null
let filePath = ''

export function isAppDbOpen() {
  return db !== null
}

export function getDbPath() {
  return filePath
}

export async function openAppDb(root: string) {
  filePath = path.join(root, 'app.db')
  const mod = (await import('node:sqlite')) as {
    DatabaseSync: new (p: string) => SqliteDb
  }
  db = new mod.DatabaseSync(filePath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  migrateLegacySettingsJson(root)
  return filePath
}

function migrateLegacySettingsJson(root: string) {
  if (kvGet('settings') !== null) return
  const jsonPath = path.join(root, 'settings.json')
  if (!existsSync(jsonPath)) return
  const text = readFileSync(jsonPath, 'utf8')
  kvSet('settings', text)
}

export function kvGet(key: string): string | null {
  if (!db) return null
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
  return typeof row?.value === 'string' ? row.value : null
}

export function kvSet(key: string, value: string) {
  if (!db) throw new Error('SQLite database is closed')
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now())
}

export function closeAppDb() {
  try {
    db?.close()
  } catch {
    /* ignore */
  }
  db = null
  filePath = ''
}
