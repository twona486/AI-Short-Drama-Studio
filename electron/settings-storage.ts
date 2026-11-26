import { app, safeStorage } from 'electron'
import path from 'node:path'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { getDbPath, kvGet, kvSet } from './sqlite'

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

let windowsKeyOnDisk = false

export async function waitForSettingsKey() {
  if (process.platform !== 'win32' || windowsKeyOnDisk) return
  // Chromium은 Windows의 DPAPI로 보호한 키를 Local State에 지연 기록한다.
  // 강제 종료 후에도 읽을 수 있는 시점까지 기존 설정을 그대로 보존한다.
  const state = path.join(app.getPath('sessionData'), 'Local State')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const key = JSON.parse(await readFile(state, 'utf8'))?.os_crypt?.encrypted_key
      if (typeof key === 'string' && key) {
        windowsKeyOnDisk = true
        return
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await delay(100)
  }
  throw new Error('Windows credential storage did not finish writing its key')
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

export async function writeSettings(root: string, raw: string) {
  await waitForSettingsKey()
  if (getDbPath() !== path.join(root, 'app.db')) throw new Error('Settings database changed during save')
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
