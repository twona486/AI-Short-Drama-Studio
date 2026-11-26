import { safeStorage } from 'electron'
import path from 'node:path'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { kvGet, kvSet } from './sqlite'

const SCHEMA_VERSION = 1

export function encryptSecret(value: string) {
  if (!safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('OS credential storage unavailable')
  }
  return safeStorage.encryptString(value).toString('base64')
}

export function decryptSecret(value: string) {
  return safeStorage.decryptString(Buffer.from(value, 'base64'))
}

export function encodeSettings(raw: string) {
  const data = encryptSecret(raw)
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, data })
}

function legacySettings(root: string) {
  try {
    return readFileSync(path.join(root, 'settings.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return null
  }
}

export function readSettings(root: string) {
  const raw = kvGet('settings') ?? legacySettings(root)
  return raw === null ? null : decodeSettings(raw)
}

function decodeSettings(raw: string) {
  let decoded: { schemaVersion?: number; data?: string } | null
  try {
    decoded = JSON.parse(raw)
  } catch {
    // 기존 손상 설정은 렌더러의 복구 경로에서 처리한다.
    return raw
  }
  switch (decoded?.schemaVersion ?? 0) {
    case 0: return raw
    case SCHEMA_VERSION:
      if (typeof decoded?.data !== 'string') throw new Error('Invalid encrypted settings')
      return decryptSecret(decoded.data)
    default: throw new Error('Unsupported settings schema')
  }
}

export function writeSettings(root: string, raw: string) {
  // 암호화가 실패하면 기존 레코드를 유지한다.
  kvSet('settings', encodeSettings(raw))
  const legacy = legacySettings(root)
  if (legacy === null || decodeSettings(legacy) !== legacy) return
  const dir = mkdtempSync(path.join(root, '.settings-'))
  try {
    const file = path.join(dir, 'settings.json')
    writeFileSync(file, encodeSettings(legacy), { mode: 0o600 })
    renameSync(file, path.join(root, 'settings.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
