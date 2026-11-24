import path from 'node:path'
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'

export const ROOT_PREF_FILE = 'storage-root.json'
export const USER_DATA_NAME = 'Drama Flow Studio'
const koreanProductName = '드라마 플로우 Studio'
const chineseProductName = '剧流 Studio'
const legacyPackageName = 'ai-cut'
const legacyNames = [koreanProductName, chineseProductName, 'AI Cut', legacyPackageName]
const migrationMarker = '.migrated-from'
const skippedEntries = new Set([
  migrationMarker, 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'LOCK',
  'Cache', 'GPUCache', 'Code Cache'
])

function directoryEntries(directory: string) {
  try {
    return readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function readStorageRootPreference(file: string): string | undefined {
  try {
    const root = String(JSON.parse(readFileSync(file, 'utf8'))?.root || '').trim()
    if (path.isAbsolute(root)) return path.normalize(root)
  } catch {
    // 첫 실행 또는 읽을 수 없는 설정이면 기본 저장 폴더를 사용한다.
  }
}

export function migrateUserData(appData: string, destination: string) {
  if (directoryEntries(destination)?.length) return

  const candidates = legacyNames.flatMap((name) => {
    const directory = path.join(appData, name)
    if (directory === destination) return []
    try {
      const info = lstatSync(directory)
      return info.isDirectory() ? [{ name, directory, modified: info.mtimeMs }] : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  })
  const source = candidates.sort((a, b) => b.modified - a.modified)[0]
  if (!source) return

  // 복사가 모두 끝나기 전에는 새 Chromium 프로필을 공개하지 않는다.
  const staging = mkdtempSync(path.join(path.dirname(destination), '.drama-flow-migration-'))
  try {
    cpSync(source.directory, staging, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (entry) => entry === source.directory || !skippedEntries.has(path.basename(entry))
    })

    // 한국어판이 중국어판의 사용자 지정 저장 폴더를 계속 읽던 동작을 이어받는다.
    const preference = path.join(staging, ROOT_PREF_FILE)
    if ([koreanProductName, legacyPackageName].includes(source.name) && !readStorageRootPreference(preference)) {
      const root = readStorageRootPreference(path.join(appData, chineseProductName, ROOT_PREF_FILE))
      if (root) {
        rmSync(preference, { force: true })
        writeFileSync(preference, JSON.stringify({ root }, null, 2))
      }
    }

    writeFileSync(path.join(staging, migrationMarker), `${source.name}\n`)
    const existingEntries = directoryEntries(destination)
    if (existingEntries?.length) return
    if (existingEntries) rmdirSync(destination)
    renameSync(staging, destination)
    console.info('[userData] 이전 버전의 설정을 복사했습니다.', source.name)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
