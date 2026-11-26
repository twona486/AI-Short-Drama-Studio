<script setup lang="ts">
import { getTtsConfig } from '@/services/ai/runtime'
import { confirmAction } from '@/utils/confirmAction'
import { t as translate } from '@/i18n'
import { locale, setLocale } from '@/i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useProjectStore, useSettingsStore, useAssetsStore, useToastStore, endpointReady } from '@/stores'
import StudioSettings from '@/components/canvas/StudioSettings.vue'
import SetupAgent from '@/components/settings/SetupAgent.vue'
import ZealmanSettings from '@/components/settings/ZealmanSettings.vue'
import ComfySettings from '@/components/settings/ComfySettings.vue'
import AutodlSettings from '@/components/settings/AutodlSettings.vue'
import Tag from '@/components/common/Tag.vue'
import { estimateStorage } from '@/services/storage'
import { isFFmpegReady, getFFmpeg, resetFFmpeg } from '@/services/ffmpeg'
import { desktop, isDesktop } from '@/services/desktop'
import {
  parseDirectorSkill,
  pickDirectorSkillFile,
  pickDirectorSkillFolder
} from '@/services/settings/directorSkill'

const router = useRouter()
const route = useRoute()
const project = useProjectStore()
const settings = useSettingsStore()
const assets = useAssetsStore()
const toast = useToastStore()

const storage = ref<{ usage: number; quota: number }>({ usage: 0, quota: 0 })
const ffmpegReady = ref(isFFmpegReady())
const ffmpegLoading = ref(false)
const grantingAccess = ref(false)
const storageRoot = ref('')
const changingStorageRoot = ref(false)
const storageUnavailable = ref(false)
const appVersion = ref('0.1.5')

const diag = ref({
  crossOriginIsolated: false,
  sharedArrayBuffer: false,
  userAgent: '',
  localCore: false,
  jsDelivrReachable: false,
  unpkgReachable: false,
  npmmirrorReachable: false
})

const saving = ref(false)
const importingSkill = ref(false)
const directorSkill = computed(() => settings.config.directorSkill)
const directorPreview = computed(() => {
  const body = directorSkill.value?.body || ''
  return body.length > 180 ? `${body.slice(0, 180)}…` : body
})

async function saveDirectorFile(picked: { text: string; filename: string } | null) {
  if (!picked) return
  const doc = parseDirectorSkill(picked.text, picked.filename)
  settings.update({ directorSkill: doc })
  await settings.flush()
  toast.success(translate('settings.director.imported', { p0: doc.name }))
}

async function importDirectorSkill() {
  importingSkill.value = true
  try {
    await saveDirectorFile(await pickDirectorSkillFile())
  } catch (err: any) {
    toast.error(err?.message || translate('settings.director.failed'))
  } finally {
    importingSkill.value = false
  }
}

async function importDirectorFolder() {
  importingSkill.value = true
  try {
    await saveDirectorFile(await pickDirectorSkillFolder())
  } catch (err: any) {
    toast.error(err?.message || translate('settings.director.failed'))
  } finally {
    importingSkill.value = false
  }
}

async function clearDirectorSkill() {
  settings.update({ directorSkill: null })
  await settings.flush()
  toast.success(translate('settings.director.cleared'))
}

const llmReady = computed(() => endpointReady(settings.config.llm))
const assistantTargetsReady = computed(() =>
  ['vision', 'image', 'video'].every((kind) =>
    endpointReady(settings.config[kind as 'vision' | 'image' | 'video'])
  )
)

onMounted(async () => {
  await settings.ensureHydrated()
  storage.value = await estimateStorage()
  await assets.refresh()
  if (isDesktop()) {
    try {
      storageUnavailable.value = await desktop().getStorageRecovery() === 'unavailable'
      storageRoot.value = await desktop().getRoot()
      appVersion.value = await desktop().getVersion()
    } catch {
      /* desktop info is non-critical */
    }
  }
  await runDiagnostics()
})

const comfySettings = ref<InstanceType<typeof ComfySettings> | null>(null)

async function saveSettings() {
  if (saving.value) return
  saving.value = true
  try {
    if (section.value === 'comfyui' && comfySettings.value && !comfySettings.value.savePending()) {
      toast.warn(translate('settingsWorkflow.workflowNotSaved'))
      return
    }
    await settings.flush()
    toast.success(translate('settings.configSaved'))
    if (section.value === 'llm' && endpointReady(settings.config.llm)) {
      const needsAssistant = !['vision', 'image', 'video'].every((kind) =>
        endpointReady(settings.config[kind as 'vision' | 'image' | 'video'])
      )
      if (needsAssistant) {
        toast.success(translate('settings.onboarding.next'))
        await router.replace('/settings/agent')
      }
    }
  } catch (e: any) {
    toast.error(e?.message || translate('settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function openSettingsFolder() {
  if (!isDesktop()) return
  try {
    const root = await desktop().getRoot()
    await desktop().openPath(root)
  } catch {
    toast.error(translate('settings.storage.openFailed'))
  }
}

async function chooseStorageFolder() {
  if (!isDesktop() || changingStorageRoot.value) return
  try {
    const selected = await desktop().pickDirectory()
    if (!selected || (selected === storageRoot.value && !storageUnavailable.value)) return
    const ok = await confirmAction(
      translate('settings.storage.confirm', { p0: selected })
    )
    if (!ok) return
    changingStorageRoot.value = true
    toast.info(translate('settings.storage.transfer'), 10000)
    storageRoot.value = await desktop().setRoot(selected)
    toast.success(translate('settings.storage.changed'))
    setTimeout(() => window.location.reload(), 700)
  } catch (err: any) {
    toast.error(err?.message || translate('settings.storage.failed'), 8000)
  } finally {
    changingStorageRoot.value = false
  }
}

watch(() => route.query.chooseStorage, async (choose) => {
  if (choose !== '1' || !isDesktop()) return
  await router.replace('/settings/system')
  await chooseStorageFolder()
}, { immediate: true })

async function grantFileAccess() {
  if (!isDesktop()) return
  grantingAccess.value = true
  try {
    await desktop().requestFileAccess()
    toast.success(translate('settings.permissions.granted'))
  } catch (err: any) {
    toast.error(err?.message || translate('settings.permissions.failed'))
  } finally {
    grantingAccess.value = false
  }
}

async function openWindowsSecurity() {
  if (!isDesktop()) return
  try {
    await desktop().openWindowsSecurity()
  } catch {
    toast.error(translate('settings.permissions.openFailed'))
  }
}

async function runDiagnostics() {
  diag.value.userAgent = navigator.userAgent
  diag.value.crossOriginIsolated = self.crossOriginIsolated
  diag.value.sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined'
  try {
    const r = await fetch('/ffmpeg/ffmpeg-core.js', { method: 'HEAD' })
    diag.value.localCore = r.ok
  } catch {
    diag.value.localCore = false
  }
  diag.value.jsDelivrReachable = await ping('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js')
  diag.value.unpkgReachable = await ping('https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js')
  diag.value.npmmirrorReachable = await ping('https://registry.npmmirror.com/@ffmpeg/core@0.12.6/files/dist/umd/ffmpeg-core.js')
}

async function ping(url: string): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 5000)
    const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: ctl.signal })
    clearTimeout(timer)
    try { await r.body?.cancel() } catch {}
    return r.ok || r.status === 206
  } catch {
    return false
  }
}

async function warmupFFmpeg() {
  ffmpegLoading.value = true
  try {
    await getFFmpeg((msg) => toast.info(msg, 1500))
    ffmpegReady.value = true
    toast.success(translate('settings.engine.ffmpegReady'))
    await runDiagnostics()
  } catch (e: any) {
    toast.error(translate('settings.engine.ffmpegError', { error: e.message }), 8000)
  } finally {
    ffmpegLoading.value = false
  }
}

function resetAndRetry() {
  resetFFmpeg()
  ffmpegReady.value = false
  toast.info(translate('settings.engine.reset'))
  runDiagnostics()
}

async function exportProjectData() {
  const data = {
    version: '0.1.0',
    exportedAt: Date.now(),
    projects: project.allProjects,
    settings: settings.config
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `ai-cut-export-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast.success(translate('settings.backup.exported'))
}

function importProjectData() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      if (Array.isArray(data.projects)) {
        for (const p of data.projects) {
          await import('@/services/storage').then((m) => m.saveProject(p))
        }
        await project.refreshList()
        toast.success(translate('settings.backup.imported', { p0: data.projects.length }))
      } else {
        toast.error(translate('settings.backup.invalid'))
      }
    } catch (e: any) {
      toast.error(translate('settings.backup.failed', { error: e.message }))
    }
  }
  input.click()
}

async function clearAll() {
  if (!await confirmAction(translate('settings.backup.confirm'))) return
  for (const p of project.allProjects) {
    await project.remove(p.id)
  }
  toast.success(translate('settings.backup.cleared'))
}

function formatSize(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let b = bytes
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024
    i++
  }
  return `${b.toFixed(1)} ${units[i]}`
}

const assetStats = computed(() => {
  const stats = { image: 0, video: 0, audio: 0, total: 0 }
  for (const a of assets.all) {
    if (a.kind === 'image') stats.image++
    if (a.kind === 'video') stats.video++
    if (a.kind === 'audio') stats.audio++
    stats.total++
  }
  return stats
})

const storagePct = computed(() => {
  if (!storage.value.quota) return 0
  return (storage.value.usage / storage.value.quota) * 100
})

type SettingsSection = 'agent' | 'llm' | 'vision' | 'image' | 'tts' | 'video' | 'comfyui' | 'autodl' | 'zealman' | 'system'
const SECTIONS: SettingsSection[] = ['agent', 'llm', 'vision', 'image', 'tts', 'video', 'comfyui', 'autodl', 'zealman', 'system']

const nav = [
  {
    id: 'llm' as const,
    get label() { return translate('settings.nav.llm.label') },
    get desc() { return translate('settings.nav.llm.desc') },
    get lead() { return translate('settings.nav.llm.lead') }
  },
  {
    id: 'agent' as const,
    get label() { return translate('common.setupAssistant') },
    get desc() { return translate('settings.nav.agent.desc') },
    get lead() { return translate('settings.nav.agent.lead') }
  },
  {
    id: 'vision' as const,
    get label() { return translate('common.vision') },
    get desc() { return translate('settings.nav.vision.desc') },
    get lead() { return translate('settings.nav.vision.lead') }
  },
  {
    id: 'image' as const,
    get label() { return translate('common.imageGeneration') },
    get desc() { return translate('settings.nav.image.desc') },
    get lead() { return translate('settings.nav.image.lead') }
  },
  {
    id: 'tts' as const,
    get label() { return translate('common.voiceover') },
    get desc() { return translate('settings.nav.tts.desc') },
    get lead() { return translate('settings.nav.tts.lead') }
  },
  {
    id: 'video' as const,
    get label() { return translate('common.video') },
    get desc() { return translate('settings.nav.video.desc') },
    get lead() { return translate('settings.nav.video.lead') }
  },
  {
    id: 'comfyui' as const,
    get label() { return translate('settingsWorkflow.connection') },
    get desc() { return translate('settingsWorkflow.manage') },
    get lead() { return translate('settingsWorkflow.hint') }
  },
  {
    id: 'autodl' as const,
    get label() { return translate('settings.nav.autodl.label') },
    get desc() { return translate('settings.nav.autodl.desc') },
    get lead() { return translate('settings.nav.autodl.lead') }
  },
  {
    id: 'zealman' as const,
    get label() { return translate('settings.nav.zealman.label') },
    get desc() { return translate('settings.nav.zealman.desc') },
    get lead() { return translate('settings.nav.zealman.lead') }
  },
  {
    id: 'system' as const,
    get label() { return translate('common.system') },
    get desc() { return translate('settings.nav.system.desc') },
    get lead() { return translate('settings.nav.system.lead') }
  }
]

const section = computed<SettingsSection>(() => {
  const fallback: SettingsSection = llmReady.value ? 'agent' : 'llm'
  const raw = String(route.params.section || fallback)
  return SECTIONS.includes(raw as SettingsSection) ? (raw as SettingsSection) : fallback
})

const currentNav = computed(() => nav.find((n) => n.id === section.value) || nav[0])

function go(id: SettingsSection) {
  router.replace(`/settings/${id}`)
}

function goBack() {
  if (window.history.length > 1) router.back()
  else router.push('/')
}

function navReady(id: SettingsSection) {
  const c = settings.config
  if (id === 'llm') return endpointReady(c.llm)
  if (id === 'vision') return endpointReady(c.vision)
  if (id === 'image') return endpointReady(c.image)
  if (id === 'tts') return endpointReady(getTtsConfig())
  if (id === 'video') return endpointReady(c.video)
  if (id === 'autodl') {
    return Boolean(c.autodlToken?.trim()) &&
      c.videos.some((item) => item.provider === 'autodl' && item.apiKey?.trim() === c.autodlToken.trim())
  }
  if (id === 'zealman') return c.videos.some((item) => item.provider === 'zealman' && Boolean(item.baseUrl))
  return false
}
</script>

<template>
  <div class="settings">
    <header class="top">
      <button type="button" class="back" @click="goBack">{{ $t('common.back') }}</button>
      <div class="brand">
        <h1>{{ currentNav.label }}</h1>
        <span class="crumb">{{ $t('settings.crumb') }} {{ currentNav.label }}</span>
      </div>
      <label class="language-select">
        {{ $t('settings.language') }}
        <select :value="locale" @change="setLocale(($event.target as HTMLSelectElement).value === 'zh' ? 'zh' : 'ko')">
          <option value="ko">한국어</option>
          <option value="zh">{{ $t('settings.languageChinese') }}</option>
        </select>
      </label>
    </header>

    <div class="body">
      <nav class="side" :aria-label="$t('settings.sections')">
        <p class="group">{{ $t('settings.aiGroup') }}</p>
        <RouterLink
          v-for="item in nav.slice(0, 8)"
          :key="item.id"
          :to="`/settings/${item.id}`"
          replace
          active-class=""
          exact-active-class=""
          :class="{ on: section === item.id }"
        >
          <span class="lab">{{ item.label }}</span>
          <span
            v-if="item.id !== 'agent'"
            class="state"
            :class="{ ok: navReady(item.id) }"
          >{{ navReady(item.id) ? $t('common.configured') : $t('common.unconfigured') }}</span>
        </RouterLink>
        <p class="group">{{ $t('settings.appGroup') }}</p>
        <RouterLink
          to="/settings/system"
          replace
          active-class=""
          exact-active-class=""
          :class="{ on: section === 'system' }"
        >
          <span class="lab">{{ $t('common.system') }}</span>
        </RouterLink>
      </nav>

      <main class="main">
        <p class="page-lead">
          {{ currentNav.lead }}
        </p>
        <section
          v-if="(section === 'llm' || section === 'agent') && !(section === 'agent' && assistantTargetsReady)"
          class="onboarding"
        >
          <div class="onboarding-head">
            <div>
              <b>{{ $t('settings.onboarding.title') }}</b>
              <p>{{ $t('settings.onboarding.description') }}</p>
            </div>
            <span v-if="assistantTargetsReady" class="onboarding-done">{{ $t('settings.onboarding.ready') }}</span>
          </div>
          <div class="onboarding-steps">
            <button
              type="button"
              class="onboarding-step"
              :class="{ active: section === 'llm', done: llmReady }"
              @click="go('llm')"
            >
              <i>{{ llmReady ? '✓' : '1' }}</i>
              <span>
                <b>{{ $t('settings.onboarding.setLlm') }}</b>
                <small>{{ $t('settingsWorkflow.saveHint') }}</small>
              </span>
            </button>
            <div class="onboarding-arrow">→</div>
            <button
              type="button"
              class="onboarding-step"
              :class="{ active: section === 'agent', locked: !llmReady, done: assistantTargetsReady }"
              :disabled="!llmReady"
              @click="go('agent')"
            >
              <i>{{ assistantTargetsReady ? '✓' : '2' }}</i>
              <span>
                <b>{{ $t('settings.onboarding.setAssistant') }}</b>
                <small>{{ llmReady ? $t('settings.onboarding.setAssistantHint') : $t('settings.onboarding.locked') }}</small>
              </span>
            </button>
          </div>
        </section>

        <SetupAgent v-show="section === 'agent'" @open="go($event as SettingsSection)" />
        <AutodlSettings v-if="settings.diskReady && section === 'autodl'" />
        <ZealmanSettings v-if="settings.diskReady && section === 'zealman'" />
        <ComfySettings v-if="settings.diskReady && section === 'comfyui'" ref="comfySettings" />
        <StudioSettings
          v-if="settings.diskReady && section !== 'agent' && section !== 'zealman' && section !== 'autodl' && section !== 'system' && section !== 'comfyui'"
          :module="section"
        />
        <p v-else-if="!settings.diskReady && section !== 'agent' && section !== 'system'" class="loading">
          {{ $t('settings.readingConfig') }}
        </p>

        <div v-else-if="section === 'system'" class="sys">
          <section class="panel">
            <h2>{{ $t('settingsWorkflow.appearance') }}</h2>
            <p class="card-desc">{{ $t('settingsWorkflow.appearanceHint') }}</p>
            <div class="theme-choices">
              <button type="button" :class="{ on: settings.config.theme !== 'light' }" @click="settings.update({ theme: 'dark' })">
                <strong>{{ $t('settingsWorkflow.dark') }}</strong>
                <span>{{ $t('settingsWorkflow.darkHint') }}</span>
              </button>
              <button type="button" :class="{ on: settings.config.theme === 'light' }" @click="settings.update({ theme: 'light' })">
                <strong>{{ $t('settingsWorkflow.light') }}</strong>
                <span>{{ $t('settingsWorkflow.lightHint') }}</span>
              </button>
            </div>
          </section>
          <section class="panel">
            <h2>{{ $t('settings.director.title') }}</h2>
            <p class="card-desc">
              {{ $t('settings.director.description') }}
            </p>
            <p v-if="directorSkill" class="path">{{ directorSkill.name }}<span v-if="directorSkill.filename"> · {{ directorSkill.filename }}</span></p>
            <p v-else class="muted">{{ $t('settings.director.empty') }}</p>
            <p v-if="directorSkill" class="muted small skill-preview">{{ directorPreview }}</p>
            <div class="acts">
              <button type="button" class="mini" :disabled="importingSkill" @click="importDirectorSkill">
                {{ importingSkill ? $t('common.reading') : directorSkill ? $t('settings.director.replace') : $t('settings.director.import') }}
              </button>
              <button v-if="isDesktop()" type="button" class="mini" :disabled="importingSkill" @click="importDirectorFolder">
                {{ $t('settings.director.importFolder') }}
              </button>
              <button v-if="directorSkill" type="button" class="link" @click="clearDirectorSkill">{{ $t('common.clear') }}</button>
            </div>
          </section>

          <section v-if="isDesktop() && desktop().platform === 'win32'" class="panel">
            <h2>{{ $t('settings.permissions.title') }}</h2>
            <p class="card-desc">
              {{ $t('settings.permissions.description') }}
            </p>
            <p class="muted">
              {{ $t('settings.permissions.exclude') }}
            </p>
            <div class="acts">
              <button type="button" class="mini" :disabled="grantingAccess" @click="grantFileAccess">
                {{ grantingAccess ? $t('settings.permissions.waiting') : $t('settings.permissions.grant') }}
              </button>
              <button type="button" class="mini" @click="openWindowsSecurity">{{ $t('settings.permissions.openSecurity') }}</button>
            </div>
          </section>

          <section class="panel">
            <h2>{{ $t('settings.engine.title') }}</h2>
            <p class="card-desc">
              {{ $t('settings.engine.description') }}
            </p>
            <div class="engine-row">
              <div>
                <div class="engine-name">FFmpeg</div>
                <p class="muted small">{{ $t('settings.engine.status') }}{{ ffmpegReady ? $t('settings.engine.ready') : $t('settings.engine.notLoaded') }}</p>
              </div>
              <button
                v-if="!ffmpegReady"
                type="button"
                class="mini"
                :disabled="ffmpegLoading"
                @click="warmupFFmpeg"
              >
                {{ ffmpegLoading ? $t('common.loading') : $t('settings.engine.load') }}
              </button>
              <button v-else type="button" class="link" @click="resetAndRetry">{{ $t('common.reset') }}</button>
            </div>
            <details class="diag">
              <summary>{{ $t('settings.engine.diagnostics') }}</summary>
              <div class="diag-row">
                <span>{{ $t('settings.engine.threading') }}<i>{{ $t('settings.engine.threadingHint') }}</i></span>
                <Tag :type="diag.crossOriginIsolated ? 'success' : 'error'" size="sm">{{ diag.crossOriginIsolated ? $t('common.enabled') : $t('common.disabled') }}</Tag>
              </div>
              <div class="diag-row">
                <span>{{ $t('settings.engine.memory') }}<i>{{ $t('settings.engine.memoryHint') }}</i></span>
                <Tag :type="diag.sharedArrayBuffer ? 'success' : 'error'" size="sm">{{ diag.sharedArrayBuffer ? $t('common.supported') : $t('common.unsupported') }}</Tag>
              </div>
              <div class="diag-row">
                <span>{{ $t('settings.engine.local') }}<i>{{ $t('settings.engine.localHint') }}</i></span>
                <Tag :type="diag.localCore ? 'success' : 'warning'" size="sm">{{ diag.localCore ? $t('common.available') : $t('settings.engine.downloadNeeded') }}</Tag>
              </div>
              <div class="diag-row">
                <span>{{ $t('settings.engine.cdnOne') }}<i>jsDelivr</i></span>
                <Tag :type="diag.jsDelivrReachable ? 'success' : 'error'" size="sm">{{ diag.jsDelivrReachable ? $t('common.connectedStatus') : $t('common.disconnectedStatus') }}</Tag>
              </div>
              <div class="diag-row">
                <span>{{ $t('settings.engine.cdnTwo') }}<i>unpkg</i></span>
                <Tag :type="diag.unpkgReachable ? 'success' : 'error'" size="sm">{{ diag.unpkgReachable ? $t('common.connectedStatus') : $t('common.disconnectedStatus') }}</Tag>
              </div>
              <div class="diag-row">
                <span>{{ $t('settings.engine.mirror') }}<i>npmmirror</i></span>
                <Tag :type="diag.npmmirrorReachable ? 'success' : 'error'" size="sm">{{ diag.npmmirrorReachable ? $t('common.connectedStatus') : $t('common.disconnectedStatus') }}</Tag>
              </div>
              <button type="button" class="link" @click="runDiagnostics">{{ $t('settings.engine.recheck') }}</button>
            </details>
          </section>

          <section class="panel">
            <h2>{{ $t('settings.storage.modelLocation') }}</h2>
            <p class="card-desc">
              {{ $t('settings.storage.apiKeys') }}
            </p>
            <p v-if="settings.persistPath" class="path">{{ settings.persistPath }}</p>
            <p v-else class="muted">{{ $t('settings.storage.browserLocal') }}</p>
          </section>

          <section class="panel">
            <h2>{{ $t('settings.storage.title') }}</h2>
            <p class="card-desc">
              {{ $t('settings.storage.description') }}
            </p>
            <p v-if="isDesktop()" class="path storage-path">{{ storageRoot || $t('common.reading') }}</p>
            <p v-else class="muted">{{ $t('settings.storage.browserManaged') }}</p>
            <div v-if="isDesktop()" class="acts storage-actions">
              <button type="button" class="mini" @click="openSettingsFolder">{{ $t('settings.storage.open') }}</button>
              <button
                type="button"
                class="mini"
                :disabled="changingStorageRoot"
                @click="chooseStorageFolder"
              >
                {{ changingStorageRoot ? $t('settings.storage.moving') : $t('settings.storage.change') }}
              </button>
            </div>
            <div class="storage-bar"><div class="storage-bar-fill" :style="{ width: storagePct + '%' }" /></div>
            <div class="storage-info">
              <span>{{ $t('settings.storage.used') }} {{ formatSize(storage.usage) }} {{ $t('settings.storage.quota') }} {{ formatSize(storage.quota) }}</span>
              <span>{{ storagePct.toFixed(1) }}%</span>
            </div>
            <div class="ss">
              <div><b>{{ assetStats.image }}</b><span>{{ $t('common.image') }}</span></div>
              <div><b>{{ assetStats.video }}</b><span>{{ $t('common.video') }}</span></div>
              <div><b>{{ assetStats.audio }}</b><span>{{ $t('common.audio') }}</span></div>
              <div><b>{{ assetStats.total }}</b><span>{{ $t('common.total') }}</span></div>
            </div>
          </section>

          <section class="panel">
            <h2>{{ $t('settings.backup.title') }}</h2>
            <p class="card-desc">
              {{ $t('settings.backup.description') }}
            </p>
            <div class="acts">
              <button type="button" class="mini" @click="exportProjectData">{{ $t('settings.backup.export') }}</button>
              <button type="button" class="mini" @click="importProjectData">{{ $t('settings.backup.import') }}</button>
              <button type="button" class="danger" @click="clearAll">{{ $t('settings.backup.clearAll') }}</button>
            </div>
          </section>

          <section class="panel">
            <h2>{{ $t('common.about') }}</h2>
            <div class="about-row"><span>{{ $t('common.version') }}</span><b>v{{ appVersion }}</b></div>
            <div class="about-row qq-group">
              <span><i>QQ</i> {{ $t('settings.community') }}</span>
              <b>13892383</b>
            </div>
          </section>
        </div>
      </main>
    </div>
    <footer v-if="section !== 'system'" class="save-bar">
      <span>{{ $t('settings.localChangesOnly') }}</span>
      <button type="button" class="save" :disabled="saving || !settings.diskReady" @click="saveSettings">
        {{ saving ? $t('common.saving') : $t('settings.saveChanges') }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.settings {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--nb-bg-0);
  color: var(--nb-t1);
}
.top {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 60px;
  padding: 0 20px;
  border-bottom: none;
  background: transparent;
  flex-shrink: 0;
}
.back {
  flex-shrink: 0;
  margin: 0;
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #9a9aa3;
  font-size: 12px;
  cursor: pointer;
}
.back:hover {
  color: #d4d4d8;
  background: #1c1c20;
}
.brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.language-select {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  font-size: 13px;
}

.language-select select {
  color: inherit;
  background: var(--bg-2, #191922);
  border: 1px solid var(--line, #353542);
  border-radius: 6px;
  padding: 4px 8px;
}
.brand h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 680;
  letter-spacing: -0.015em;
}
.crumb {
  font-size: 11px;
  color: var(--color-text-4);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.side {
  width: 220px;
  flex-shrink: 0;
  border-right: none;
  background: transparent;
  padding: 8px 8px 14px 4px;
  overflow-y: auto;
}
.group {
  margin: 14px 10px 6px;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.12em;
  color: var(--color-text-4);
}
.group:first-child {
  margin-top: 0;
}
.side a {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 0 2px;
  padding: 8px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #a3a3a8;
  font-size: 13px;
  text-align: left;
  text-decoration: none;
  transition: background 0.18s ease, color 0.18s ease;
}
.side a:hover {
  background: #1c1c20;
  color: #d4d4d8;
}
.side a.on {
  background: #26262b;
  color: #d4d4d8;
  font-weight: 600;
}
.state {
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: 3px;
  border: none;
  background: #222226;
  color: #8d8d93;
  font-size: 10px;
  font-weight: 500;
}
.state.ok {
  background: #24302a;
  color: #b7c9be;
}
.diag-row span i {
  display: block;
  font-style: normal;
  font-size: 10px;
  color: var(--color-text-4);
  margin-top: 1px;
}
.main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 22px 28px 40px;
}
.page-lead {
  max-width: 720px;
  margin: 0 0 18px;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 12.5px;
  line-height: 1.65;
  color: #8d8d93;
}
.onboarding {
  max-width: 900px;
  margin: 0 0 16px;
  padding: 14px 16px;
  border: none;
  border-radius: 4px;
  background: #18181b;
}
.onboarding-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.onboarding-head > div > b { font-size: 15px; color: var(--color-text-1); }
.onboarding-head p { margin: 4px 0 0; color: var(--color-text-3); font-size: 12px; }
.onboarding-done { flex-shrink: 0; color: #b7c9be; font-size: 12px; }
.onboarding-steps {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: stretch;
  gap: 10px;
}
.onboarding-step {
  display: flex;
  align-items: center;
  gap: 11px;
  margin: 0;
  padding: 13px 14px;
  text-align: left;
  border: none;
  border-radius: 4px;
  background: #1c1c1f;
  color: #b7b7bc;
  cursor: pointer;
  transition: background 0.18s ease;
}
.onboarding-step.active { background: #26262b; }
.onboarding-step.done i { background: #24302a; color: #b7c9be; }
.onboarding-step.locked { opacity: 0.5; cursor: not-allowed; }
.onboarding-step i {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: 4px;
  background: #2a2a2e;
  color: #c8c8cc;
  font-style: normal;
  font-weight: 700;
}
.onboarding-step span { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.onboarding-step b { font-size: 13px; color: var(--color-text-1); }
.onboarding-step small { color: var(--color-text-4); line-height: 1.4; }
.onboarding-arrow { align-self: center; color: var(--color-text-4); }
@media (max-width: 760px) {
  .onboarding-steps { grid-template-columns: 1fr; }
  .onboarding-arrow { display: none; }
}
.loading {
  margin: 12px 0;
  font-size: 13px;
  color: var(--color-text-4);
}
.save-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 20px;
  border-top: none;
  background: #161618;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.save-bar span {
  font-size: 12px;
  color: var(--color-text-4);
}
.save {
  margin: 0;
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  background: #3a3a40;
  color: #e4e4e7;
  font-size: 12.5px;
  font-weight: 650;
  cursor: pointer;
  transition: background 0.18s ease;
}
.save:hover:not(:disabled) {
  background: #48484f;
}
.save:disabled {
  opacity: 0.5;
  cursor: default;
}
.sys {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 14px;
  max-width: 940px;
}
.panel {
  padding: 16px;
  border: 1px solid var(--nb-line-2);
  border-radius: 10px;
  background: var(--nb-bg-2);
  color: var(--nb-t1);
}
.theme-choices {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.theme-choices button {
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--nb-line-2);
  border-radius: 10px;
  background: var(--nb-bg-3);
  color: var(--nb-t2);
  text-align: left;
  cursor: pointer;
}
.theme-choices button strong {
  color: var(--nb-t1);
  font-size: 13px;
}
.theme-choices button span {
  color: var(--nb-t3);
  font-size: 11px;
}
.theme-choices button.on {
  border-color: var(--nb-line-accent);
  background: var(--nb-accent-soft);
}
.panel h2 {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 680;
  letter-spacing: -0.01em;
}
.card-desc,
.muted {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--color-text-3);
  line-height: 1.6;
}
.muted.small {
  margin: 3px 0 0;
  font-size: 11px;
}
.skill-preview {
  white-space: pre-wrap;
  max-height: 4.8em;
  overflow: hidden;
}
.engine-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: none;
  border-radius: 4px;
  background: #141416;
  margin-bottom: 10px;
}
.engine-name {
  font-size: 13px;
  font-weight: 620;
}
.mini,
.danger,
.link {
  margin: 0;
  padding: 7px 12px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease;
}
.mini {
  border: none;
  background: #26262b;
  color: #d0d0d4;
}
.mini:hover:not(:disabled) {
  background: #323238;
}
.mini:disabled {
  opacity: 0.5;
  cursor: default;
}
.link {
  color: var(--color-accent);
  background: transparent;
}
.danger {
  border: none;
  background: transparent;
  color: #c4a0a0;
}
.danger:hover {
  background: #2a2222;
}
.diag {
  margin-top: 10px;
  font-size: 12px;
}
.diag summary {
  cursor: pointer;
  padding: 6px 0;
  color: var(--color-text-3);
  font-size: 11.5px;
}
.diag-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 0;
  border-bottom: none;
  color: var(--color-text-2);
  font-size: 12px;
}
.acts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.storage-bar {
  height: 6px;
  background: var(--color-bg-2);
  border-radius: 99px;
  overflow: hidden;
  margin: 14px 0 6px;
}
.storage-bar-fill {
  height: 100%;
  background: #5a5a62;
}
.path {
  margin: 0 0 12px;
  padding: 9px 11px;
  font-size: 11px;
  line-height: 1.5;
  word-break: break-all;
  color: var(--color-text-2);
  background: #141416;
  border: none;
  border-radius: 4px;
}
.storage-info {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--color-text-4);
  margin-bottom: 12px;
}
.ss {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.ss div {
  text-align: center;
  padding: 10px 6px;
  border: none;
  border-radius: 4px;
  background: #141416;
}
.ss b {
  display: block;
  font-size: 17px;
  font-weight: 680;
}
.ss span {
  font-size: 11px;
  color: var(--color-text-4);
}
.about-row {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: none;
  font-size: 12px;
  color: var(--color-text-3);
}
.about-row:last-child {
  border-bottom: none;
}
.about-row b {
  color: var(--color-text-1);
  font-weight: 600;
}
.about-row.qq-group {
  align-items: center;
  margin-top: 10px;
  padding: 12px 14px;
  border: none;
  border-radius: 4px;
  background: #1c1c1f;
  box-shadow: none;
}
.qq-group span {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #b7b7bc;
  font-weight: 600;
}
.qq-group span i {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  background: #2a2a2e;
  color: #d0d0d4;
  font-size: 10px;
  font-style: normal;
  font-weight: 700;
  letter-spacing: -0.3px;
  box-shadow: none;
}
.about-row.qq-group b {
  color: #d4d4d8;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 1.5px;
  text-shadow: none;
}
.settings :deep(input),
.settings :deep(select),
.settings :deep(textarea) {
  border-color: transparent;
  border-radius: 4px;
  color: #c8c8ce;
  outline: 1px solid transparent;
  outline-offset: -1px;
  transition: outline-color 0.2s ease, background-color 0.2s ease;
}
.settings :deep(input:focus),
.settings :deep(select:focus),
.settings :deep(textarea:focus) {
  border-color: transparent;
  outline-color: rgba(255, 255, 255, 0.12);
}
.settings :deep(button),
.settings :deep(.panel),
.settings :deep(article) {
  border-radius: 4px;
}
.settings :deep(.panel),
.settings :deep(article) {
  border-color: transparent;
}
</style>
