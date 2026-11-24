<script setup lang="ts">
import { t as translate } from '@/i18n'
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { runAgentTurn, type AgentEvent, type AgentMessage } from '@/services/canvas/agent'
import { runContinuousTurn } from '@/services/continuous/capture'
import { editSelectedCanvasText, isDirectNodeShortcut, isSelectedTextEdit, runSelectedNodeShortcut } from '@/services/canvas/selectedText'
import { rebuildCanvasGraph } from '@/services/canvas/layout'
import { friendlyAiError, isAbortError, isTimeoutAbort } from '@/services/ai/abort'
import { appendAgentMessage, getAgentState, setAgentAutonomy } from '@/services/canvas/taskStore'
import { estimateRequestText } from '@/services/canvas/toolRegistry'
import { onCanvasActivity, type CanvasActivity } from '@/services/canvas/canvasBridge'
import { nextExtractStage, nextPipelineStep } from '@/services/canvas/pipeline'
import { useProjectStore, useSettingsStore, useToastStore } from '@/stores'
import { desktop, isDesktop } from '@/services/desktop'
import { autodlVideoProfileId } from '@/services/ai/runtime'
import { docVideoResolutionLabel, pickDocVideoResolution, videoResolutionChoices, type DocVideoResolution } from '@/services/ai/modelOptions'
import { SCRIPT_REFERENCE_OPTIONS, normalizeScriptReference } from '@/services/ai/scriptReference'
import type { VideoGenModel } from '@/types'
import type { AgentAttachment } from '@/services/canvas/attachments'
import type { TraceRow, TraceStatus } from '@/services/canvas/agentTrace'
import type { AgentAutonomy, AspectRatio, CanvasNode, VideoResolution } from '@/types'
import AgentRichText from './AgentRichText.vue'
import AgentTraceList from './AgentTraceList.vue'
import {
  CUSTOM_STORY_SKILL_ID,
  GENERAL_STORY_SKILL_ID,
  STORY_SKILLS
} from '@/skills/storyStyles'
import {
  parseDirectorSkill,
  pickDirectorSkillFile,
  pickDirectorSkillFolder
} from '@/services/settings/directorSkill'

const props = withDefaults(
  defineProps<{
    selectedNode?: CanvasNode | null
  }>(),
  { selectedNode: null }
)

type StepStatus = TraceStatus

type FeedItem =
  | { id: string; type: 'msg'; role: 'user' | 'assistant'; content: string }
  | { id: string; type: 'run'; rows: TraceRow[] }

const feed = ref<FeedItem[]>([
  { id: 'welcome', type: 'msg', role: 'assistant', content: translate('agentChat.welcome') }
])
const messages = computed<AgentMessage[]>(() =>
  feed.value
    .filter((item): item is Extract<FeedItem, { type: 'msg' }> => item.type === 'msg')
    .map((item) => ({ role: item.role, content: item.content }))
)
const input = ref('')
const busy = ref(false)
const thinking = ref(false)
const log = ref('')
const trace = ref<TraceRow[]>([])
const chips = ref<{ label: string; text: string }[]>([
  { get label() { return translate('agentChat.breakDownScript') }, get text() { return translate('agentChat.breakDownScriptCommand') } },
  { get label() { return translate('agentChat.drawImage') }, get text() { return translate('agentChat.drawImageCommand') } },
  { get label() { return translate('agentChat.viewProgress') }, get text() { return translate('agentChat.viewProgressCommand') } }
])
const box = ref<HTMLElement | null>(null)
const autonomy = ref<AgentAutonomy>('gated')
const canvasLive = ref(false)
const canvasTrace = ref<TraceRow[]>([])
const project = useProjectStore()
const continuousEnabled = computed(() => Boolean(project.current?.continuousCaptureEnabled))
async function toggleContinuous() {
  if (busy.value || !project.current) return
  project.current.continuousCaptureEnabled = !continuousEnabled.value
  project.current.updatedAt = Date.now()
  project.setCanvas(rebuildCanvasGraph(project.current, true))
  await project.save()
  chips.value = continuousEnabled.value
    ? [{ label: project.current.continuousCapture ? translate('agentWorkspace.viewPlan') : translate('agentWorkspace.analyzeScript'), text: translate('agentWorkspace.viewPlan') }]
    : [{ label: translate('agentWorkspace.progress'), text: translate('agentWorkspace.progressRequest') }]
}
let offActivity: (() => void) | undefined
const settings = useSettingsStore()
const toast = useToastStore()
/** 이번 요청에 첨부할 로컬 파일. 텍스트는 파일 선택 시 읽어 둔다. */
const attachments = ref<AgentAttachment[]>([])
const TEXT_ATTACH_FILTERS = [
  { get name() { return translate('agentChat.textFiles') }, extensions: ['txt', 'md', 'markdown', 'fountain', 'srt', 'ass', 'lrc', 'json', 'csv'] }
]

async function pickAttachments() {
  if (!isDesktop()) {
    toast.warn(translate('agentChat.desktopRequired'))
    return
  }
  try {
    const files = await desktop().pickFiles(TEXT_ATTACH_FILTERS)
    if (!files?.length) return
    for (const p of files) {
      if (attachments.value.some((a) => a.path === p)) continue
      try {
        const raw = await desktop().readText(p)
        const content = raw.length > 200_000
          ? `${raw.slice(0, 200_000)}\n\n[${translate('agentChat.attachmentTruncated')}]`
          : raw
        attachments.value.push({ name: p.split(/[\\/]/).pop() || p, path: p, content })
      } catch (e) {
        toast.error(translate('agentChat.readFailed', { p0: p.split(/[\\/]/).pop() || p }))
        console.warn('[agent] Could not read attachment', e)
      }
    }
  } catch (e) {
    toast.error(translate('agentChat.fileSelectionFailed'))
    console.warn('[agent] Could not choose files', e)
  }
}

function removeAttachment(index: number) {
  attachments.value.splice(index, 1)
}

let controller: AbortController | null = null
const stopQueued = ref(false)
const continuousTurn = ref(false)

// Generation preferences apply to new nodes as soon as they change.
const ASPECT_OPTIONS: { value: AspectRatio; label: string }[] = [
  { value: '16:9', get label() { return translate('agentChat.landscape') } },
  { value: '9:16', get label() { return translate('agentChat.portrait') } },
  { value: '1:1', get label() { return translate('common.squareRatio') } },
  { value: '4:3', get label() { return translate('common.classicRatio') } },
  { value: '21:9', get label() { return translate('common.cinemaRatio') } }
]
/* 창작 환경설정에서 비율, 이미지 모델, 영상 모델을 함께 고른다. */
const prefOpen = ref(false)
const prefTab = ref<'video' | 'image' | 'knowledge' | 'comfyui'>('video')
/* 상위 요소의 overflow로 잘리지 않도록 body에 표시하고 버튼 기준으로 배치한다. */
const prefBtn = ref<HTMLElement | null>(null)
const prefPanel = ref<HTMLElement | null>(null)
const PANEL_WIDTH = 720
const prefStyle = ref<Record<string, string>>({})

function placeAnchoredPanel(btn: HTMLElement | null, widthCap: number) {
  const rect = btn?.getBoundingClientRect()
  if (!rect) return null
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(widthCap, vw - 24)
  const left = Math.max(12, Math.min(rect.left, vw - width - 12))
  const spaceAbove = rect.top - 12
  const spaceBelow = vh - rect.bottom - 12
  const style: Record<string, string> = { left: `${Math.round(left)}px`, width: `${Math.round(width)}px` }
  if (spaceAbove >= 260 || spaceAbove >= spaceBelow) {
    style.bottom = `${Math.round(vh - rect.top + 6)}px`
    style.maxHeight = `${Math.round(Math.max(240, Math.min(spaceAbove, 680)))}px`
  } else {
    style.top = `${Math.round(rect.bottom + 6)}px`
    style.maxHeight = `${Math.round(Math.max(240, Math.min(spaceBelow, 680)))}px`
  }
  return style
}

function placePrefPanel() {
  const style = placeAnchoredPanel(prefBtn.value, PANEL_WIDTH)
  if (style) prefStyle.value = style
}

const skillOpen = ref(false)
const skillTab = ref<'style' | 'genre' | 'mine'>('style')
const skillBtn = ref<HTMLElement | null>(null)
const skillPanel = ref<HTMLElement | null>(null)
const skillStyle = ref<Record<string, string>>({})
const importingSkill = ref(false)
const styleSkills = STORY_SKILLS.filter((skill) => skill.group === 'style')
const genreSkills = STORY_SKILLS.filter((skill) => skill.group === 'genre')
const storyIconFiles = import.meta.glob<string>('@/assets/story-icons/*.png', { eager: true, query: '?url', import: 'default' })
function storyIcon(id: string): string {
  const name = id === GENERAL_STORY_SKILL_ID ? 'general' : id
  return Object.entries(storyIconFiles).find(([path]) => path.endsWith(`/${name}.png`))?.[1] || ''
}
const activeStyleId = computed(() => settings.config.storyStyleId || GENERAL_STORY_SKILL_ID)
const activeGenreId = computed(() => settings.config.storyGenreId || GENERAL_STORY_SKILL_ID)
const activeStorySkillId = computed(() => skillTab.value === 'genre' ? activeGenreId.value : activeStyleId.value)
const importedSkill = computed(() => settings.config.directorSkill)
const activeStorySkillName = computed(() => {
  const style = activeStyleId.value === CUSTOM_STORY_SKILL_ID ? importedSkill.value?.name || translate('agentWorkspace.mySkill') : STORY_SKILLS.find((skill) => skill.id === activeStyleId.value)?.name || translate('agentWorkspace.genericSkill')
  const genre = STORY_SKILLS.find((skill) => skill.id === activeGenreId.value)?.name || translate('agentWorkspace.anyGenre')
  return `${style} · ${genre}`
})

function placeSkillPanel() {
  const style = placeAnchoredPanel(skillBtn.value, 560)
  if (style) skillStyle.value = style
}

function placeComposerPanels() {
  placePrefPanel()
  placeSkillPanel()
}

function togglePrefPanel() {
  prefOpen.value = !prefOpen.value
  if (prefOpen.value) {
    skillOpen.value = false
    prefStyle.value = {}
    nextTick(placePrefPanel)
  }
}

function closePrefPanel() {
  prefOpen.value = false
}

function toggleSkillPanel() {
  skillOpen.value = !skillOpen.value
  if (skillOpen.value) {
    prefOpen.value = false
    skillStyle.value = {}
    nextTick(placeSkillPanel)
  }
}

function closeSkillPanel() {
  skillOpen.value = false
}

function pickStorySkill(id: string) {
  if (id === GENERAL_STORY_SKILL_ID && skillTab.value === 'genre') {
    settings.update({ storyGenreId: GENERAL_STORY_SKILL_ID })
    return
  }
  settings.selectStorySkill(id)
}

async function saveImportedSkill(picked: { text: string; filename: string } | null) {
  if (!picked) return
  const doc = parseDirectorSkill(picked.text, picked.filename)
  settings.update({ directorSkill: doc })
  settings.selectStorySkill(CUSTOM_STORY_SKILL_ID)
  await settings.flush()
  toast.success(translate('agentWorkspace.skillImported', { name: doc.name }))
}

async function importStorySkill() {
  importingSkill.value = true
  try {
    await saveImportedSkill(await pickDirectorSkillFile())
  } catch (err: any) {
    toast.error(err?.message || translate('agentWorkspace.importFailed'))
  } finally {
    importingSkill.value = false
  }
}

async function importStorySkillFolder() {
  importingSkill.value = true
  try {
    await saveImportedSkill(await pickDirectorSkillFolder())
  } catch (err: any) {
    toast.error(err?.message || translate('agentWorkspace.importFailed'))
  } finally {
    importingSkill.value = false
  }
}

async function clearImportedSkill() {
  settings.update({ directorSkill: null })
  settings.selectStorySkill(GENERAL_STORY_SKILL_ID)
  await settings.flush()
  toast.success(translate('agentWorkspace.clearedSkill'))
}

const currentAspectRatio = computed<AspectRatio>(
  () => project.current?.settings?.aspectRatio || '16:9'
)
const imageProfiles = computed(() => settings.config.images ?? [])
const videoProfiles = computed(() => settings.config.videos ?? [])
const comfyImages = computed(() => imageProfiles.value.filter(p => p.adapter?.type === 'comfyui-prompt' && p.adapter.workflowTemplate))
const comfyVideos = computed(() => videoProfiles.value.filter(p => p.adapter?.type === 'comfyui-prompt' && p.adapter.workflowTemplate))
const activeImage = computed(
  () =>
    imageProfiles.value.find((p) => p.id === settings.config.activeImageId) ||
    imageProfiles.value[0]
)
const activeVideo = computed(
  () =>
    videoProfiles.value.find((p) => p.id === settings.config.activeVideoId) ||
    videoProfiles.value[0]
)
const activeImageLabel = computed(() => {
  const p = activeImage.value
  return p ? `${p.name} · ${p.model}` : translate('agentChat.imageModel')
})
const activeVideoLabel = computed(() => {
  const d = videoDefault.value
  if (d) return VIDEO_WORKFLOW_OPTIONS.find((w) => w.value === d)?.name || translate('agentChat.videoModel')
  const p = activeVideo.value
  return p ? p.name : translate('agentChat.videoModel')
})

/** 비율 아이콘의 내부 크기. 고정된 40×26 프레임 가운데에 배치한다. */
function ratioBoxStyle(value: AspectRatio) {
  const map: Record<AspectRatio, [number, number]> = {
    '16:9': [30, 17],
    '9:16': [13, 23],
    '1:1': [19, 19],
    '4:3': [24, 18],
    '21:9': [34, 15]
  }
  const [w, h] = map[value] ?? [30, 17]
  return { width: `${w}px`, height: `${h}px` }
}

/** 영상 모델 이름이 없으면 부제에 공급업체 또는 도메인을 표시한다. */
function videoSub(p: { provider?: string; baseUrl: string }): string {
  if (p.provider) return p.provider
  try {
    return new URL(p.baseUrl).host
  } catch {
    return p.baseUrl
  }
}

/* 여러 옵션을 연달아 선택할 수 있도록 패널을 열어 둔다. */
function pickAspectRatio(value: AspectRatio) {
  project.setAspectRatio(value)
}

function pickImage(id: string) {
  settings.selectImage(id)
}

function pickVideo(id: string) {
  // 개별 연결을 선택하면 내장 워크플로 기본값을 해제한다.
  settings.selectVideoModelDefault(undefined)
  settings.selectVideo(id)
}

/** 창작 환경설정과 영상 노드에서 같은 AutoDL 내장 워크플로를 선택할 수 있다. */
const VIDEO_WORKFLOW_OPTIONS: { value: VideoGenModel; name: string; desc: string }[] = [
  { value: 'h3', get name() { return translate('agentChat.h3') }, get desc() { return translate('agentChat.autoDLReference') } },
  { value: 'h3-v5', get name() { return translate('agentChat.h3v5') }, get desc() { return translate('agentChat.autoDLQuality') } },
  { value: 'wan-prime', get name() { return translate('agentChat.wan') }, get desc() { return translate('agentChat.requiresGrid') } }
]
const videoDefault = computed(() => settings.config.defaultVideoModel)
const preferenceResolutionChoices = computed(() => {
  const model = videoDefault.value
  const profile = model === 'wan-prime' || model === 'h3-v5' ? null : activeVideo.value
  const listed = videoResolutionChoices({ model, profile })
  if (listed.length) return listed
  const fallback: DocVideoResolution[] = model === 'h3-v5' ? ['768p', '1080p'] : ['768p']
  return fallback
})
const currentVideoResolution = computed<VideoResolution>(() => {
  const choices = preferenceResolutionChoices.value
  const stored = project.current?.settings.defaultVideoResolution
  return pickDocVideoResolution(stored, [...choices]) || choices[0]
})
const videoResolutionHint = computed(() => {
  const values = preferenceResolutionChoices.value
  if (values.includes('480p')) return translate('agentWorkspace.wanResolutions')
  if (values.includes('1080p')) return translate('agentWorkspace.h3Resolution')
  return translate('agentWorkspace.defaultResolution')
})
watch(preferenceResolutionChoices, (choices) => {
  if (!project.current || !choices.length) return
  const stored = project.current.settings.defaultVideoResolution
  const next = pickDocVideoResolution(stored, [...choices])
  if (next && next !== stored) project.setDefaultVideoResolution(next)
}, { immediate: true })

const scriptReferenceType = computed({
  get: () => normalizeScriptReference(settings.config.scriptReferenceType),
  set: (value: string) => settings.update({ scriptReferenceType: normalizeScriptReference(value) })
})
const videoChoice = computed({
  get: () => videoDefault.value ? `workflow:${videoDefault.value}` : `profile:${activeVideo.value?.id || ''}`,
  set: (value: string) => {
    if (value.startsWith('workflow:')) {
      const workflow = VIDEO_WORKFLOW_OPTIONS.find((item) => item.value === value.slice(9))
      if (workflow) pickVideoWorkflow(workflow.value)
    } else if (value.startsWith('profile:') && value.slice(8)) pickVideo(value.slice(8))
  }
})
const imageChoice = computed({
  get: () => activeImage.value?.id || '',
  set: (value: string) => { if (value) pickImage(value) }
})

function pickVideoResolution(value: VideoResolution) {
  project.setDefaultVideoResolution(value)
}

function pickVideoWorkflow(model: VideoGenModel) {
  settings.selectVideoModelDefault(model)
  // H3 내장 워크플로는 AutoDL 토큰을 쓰므로 현재 연결도 AutoDL로 맞춘다.
  if (model !== 'wan-prime') {
    const autodlId = autodlVideoProfileId()
    if (autodlId) settings.selectVideo(autodlId)
  }
}

/** 노드의 모델 선택 목록과 동일한 공급업체 라벨을 사용한다. */
function videoProfileTag(p: { provider?: string; baseUrl?: string; adapter?: { type?: string } }): string {
  const zealman = p.provider === 'zealman' || p.adapter?.type === 'zealman-workflow'
  const autodl = !zealman && (p.provider === 'autodl' || /autodl\.art/i.test(p.baseUrl || ''))
  return zealman ? 'Zealman' : autodl ? 'AutoDL' : ''
}

const estimate = computed(() => estimateRequestText(input.value))

/** 자유 캔버스에서 현재 선택한 노드 카드. */
const selectedGenNode = computed(() => {
  const n = props.selectedNode
  if (!n || (n.type !== 'imageGen' && n.type !== 'videoGen')) return null
  return n
})
const selectedKindLabel = computed(() =>
  selectedGenNode.value?.type === 'videoGen' ? translate('agentWorkspace.imageToVideo') : selectedGenNode.value ? translate('agentWorkspace.imageGeneration') :
    ['shotVideo', 'compose', 'final', 'export'].includes(props.selectedNode?.type || '') ? translate('agentWorkspace.video') : translate('agentWorkspace.canvasNode')
)
const canContinueSelected = computed(() => ['videoGen', 'shotVideo', 'compose', 'final', 'export'].includes(props.selectedNode?.type || ''))
const polishChips = [
  { get label() { return translate('agentChat.moreVisual') }, get text() { return translate('agentChat.moreVisualCommand') } },
  { get label() { return translate('agentChat.clearActions') }, get text() { return translate('agentChat.clearActionsCommand') } },
  { get label() { return translate('agentChat.matchStory') }, get text() { return translate('agentChat.matchStoryCommand') } }
]

onMounted(() => {
  const saved = getAgentState()
  autonomy.value = 'gated'
  void setAgentAutonomy('gated')
  if (saved.messages.length) {
    feed.value = saved.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message, i) => ({
        id: `saved-${i}`,
        type: 'msg' as const,
        role: message.role as 'user' | 'assistant',
        content: message.content
      }))
  }
  window.addEventListener('pointerdown', onDocPointer, true)
  window.addEventListener('resize', placeComposerPanels)
  window.addEventListener('scroll', placeComposerPanels, true)
  window.addEventListener('keydown', onGlobalKey, true)
  offActivity = onCanvasActivity(applyCanvasActivity)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('resize', placeComposerPanels)
  window.removeEventListener('scroll', placeComposerPanels, true)
  window.removeEventListener('keydown', onGlobalKey, true)
  offActivity?.()
})

function onGlobalKey(ev: KeyboardEvent) {
  if (ev.key !== 'Escape') return
  if (prefOpen.value) closePrefPanel()
  if (skillOpen.value) closeSkillPanel()
}

function onDocPointer(ev: PointerEvent) {
  const el = ev.target as HTMLElement | null
  const inPref = !!el && (!!el.closest('.pref-pop') || !!prefPanel.value?.contains(el))
  const inSkill = !!el && (!!el.closest('.skill-pop') || !!skillPanel.value?.contains(el))
  if (!el?.closest('.bar-pop') && !inPref) closePrefPanel()
  if (!el?.closest('.bar-pop') && !inSkill) closeSkillPanel()
}

async function scrollToEnd() {
  await nextTick()
  box.value?.scrollTo({ top: box.value.scrollHeight, behavior: 'smooth' })
}

function upsertStep(key: string, patch: Partial<TraceRow>) {
  const i = trace.value.findIndex((s) => s.key === key)
  if (i >= 0) {
    trace.value[i] = { ...trace.value[i], ...patch }
  } else {
    trace.value = [...trace.value, { key, kind: 'step', label: patch.label || key, ...patch }]
  }
}

function upsertCanvasStep(key: string, patch: Partial<TraceRow>) {
  const i = canvasTrace.value.findIndex((s) => s.key === key)
  if (i >= 0) {
    canvasTrace.value[i] = { ...canvasTrace.value[i], ...patch }
  } else {
    canvasTrace.value = [...canvasTrace.value, { key, kind: 'step', label: patch.label || key, ...patch }]
  }
}

/** 계획 카드와 실행 단계의 상태를 동기화한다. */
function syncPlanSteps(stepKey: string, status: StepStatus) {
  for (const row of trace.value) {
    if (row.kind !== 'plan' || !row.plan) continue
    const step = row.plan.steps.find((s) => s.key === stepKey)
    if (step) step.status = status
  }
}

function onProgress(ev: AgentEvent) {
  log.value = ev.label
  if (ev.kind === 'intent') {
    trace.value = [
      { key: 'intent', kind: 'intent', label: ev.label },
      ...trace.value.filter((r) => r.kind !== 'intent')
    ]
  } else if (ev.kind === 'plan' && ev.plan) {
    const i = trace.value.findIndex((s) => s.kind === 'plan')
    const row: TraceRow = { key: 'plan', kind: 'plan', label: ev.label, plan: ev.plan }
    if (i >= 0) trace.value[i] = row
    else trace.value = [...trace.value.filter((r) => r.kind !== 'plan'), row]
  } else if (ev.kind === 'think') {
    thinking.value = true
    const i = trace.value.findIndex((s) => s.kind === 'think')
    const row: TraceRow = { key: 'think', kind: 'think', label: ev.label, status: 'running' }
    if (i >= 0) trace.value[i] = row
    else trace.value = [row, ...trace.value]
  } else if (ev.kind === 'step' && ev.step) {
    thinking.value = false
    const think = trace.value.find((s) => s.kind === 'think' && s.status === 'running')
    if (think) think.status = 'done'
    upsertStep(ev.step, {
      kind: 'step',
      label: ev.label,
      status: ev.status || 'running'
    })
    syncPlanSteps(ev.step, ev.status || 'running')
  } else if (ev.kind === 'log') {
    thinking.value = /想|생각|검토 중|thinking/i.test(ev.label)
    const running = [...trace.value].reverse().find((s) => s.kind === 'step' && s.status === 'running')
    const landed = /已上画布|已写入画布|已交付 \d+ 个可编辑分镜|캔버스에.*(?:반영|배치|추가)|편집 가능한 샷.*완료|added to (?:the )?canvas/i.test(ev.label)
    if (running && (ev.step === running.key || !ev.step)) {
      running.detail = ev.label
      if (landed) {
        running.status = 'done'
        running.label = ev.label
      }
    } else {
      trace.value = [
        ...trace.value,
        { key: `log-${trace.value.length}`, kind: 'log', label: ev.label }
      ]
    }
  }
  void scrollToEnd()
}

function applyCanvasActivity(ev: CanvasActivity) {
  if (ev.source === 'agent' && busy.value) return
  canvasLive.value = true
  if (!busy.value) log.value = ev.message || ev.label
  const landed = /已上画布|已写入画布|캔버스에.*(?:반영|배치|추가)|added to (?:the )?canvas/i.test(ev.message || ev.label || '')
  upsertCanvasStep(ev.nodeId, {
    kind: 'step',
    label: landed && ev.message ? ev.message : ev.label,
    status:
      ev.kind === 'done' || landed ? 'done' : ev.kind === 'error' ? 'fail' : 'running',
    detail: ev.message
  })
  if (ev.kind === 'done' || ev.kind === 'error') {
    void finishCanvasRun(ev)
  }
  void scrollToEnd()
}

async function finishCanvasRun(ev: CanvasActivity) {
  const stillRunning = canvasTrace.value.some(
    (row) => row.kind === 'step' && row.status === 'running' && row.key !== ev.nodeId
  )
  if (stillRunning) return
  if (canvasTrace.value.length) {
    feed.value.push({
      id: `canvas-${Date.now()}`,
      type: 'run',
      rows: canvasTrace.value.map((row) => ({ ...row }))
    })
  }
  const next = nextPipelineStep(project.current)
  const extractLabels = {
    subjects: 'nodeInspector.stepSubjects',
    scenes: 'nodeInspector.stepScenes',
    shots: 'nodeInspector.stepShots'
  }
  const stage = next?.id === 'board' ? nextExtractStage(project.current) : null
  const nextLabel = () => next ? translate(stage ? extractLabels[stage] : `agentChat.steps.${next.id}`) : ''
  const content =
    ev.kind === 'error'
      ? translate('agentChat.canvasRunFailed', {
          label: ev.label,
          error: ev.message || translate('agentChat.unknownError')
        })
      : [
          translate('agentChat.canvasRunCompleted', { label: ev.label }),
          ev.message,
          next
            ? translate('agentChat.canvasRunNext', { label: nextLabel() })
            : translate('agentChat.canvasRunFollowUp')
        ].filter(Boolean).join('\n')
  feed.value.push({ id: `a-${Date.now()}`, type: 'msg', role: 'assistant', content })
  await appendAgentMessage('assistant', content)
  if (!busy.value) {
    chips.value = next
      ? [
          { get label() { return translate('agentChat.continue', { p0: nextLabel() }) }, text: translate('agentChat.continueCommand') },
          { get label() { return translate('agentChat.quickPeek') }, get text() { return translate('agentChat.quickPeekCommand') } }
        ]
      : []
  }
  canvasLive.value = false
  canvasTrace.value = []
  if (!busy.value) log.value = ''
  await scrollToEnd()
}

async function sendText(text: string) {
  const t = text.trim()
  if (!t || busy.value) return
  input.value = ''
  const attachedNames = attachments.value.map((a) => a.name)
  const display = attachedNames.length ? `${t}\n\n📎 ${attachedNames.join('、')}` : t
  const attachOptions = attachments.value.slice()
  feed.value.push({ id: `u-${Date.now()}`, type: 'msg', role: 'user', content: display })
  await appendAgentMessage('user', t)
  attachments.value = []
  busy.value = true
  thinking.value = true
  log.value = attachedNames.length ? translate('agentChat.readingAttachments', { p0: attachedNames.join('、') }) : translate('agentChat.starting')
  trace.value = [{ key: 'think', kind: 'think', get label() { return translate('agentChat.deliberating') }, status: 'running' }]
  chips.value = []
  const turnController = new AbortController()
  stopQueued.value = false
  continuousTurn.value = continuousEnabled.value && !props.selectedNode
  controller = turnController
  await scrollToEnd()
  try {
    const options = {
      signal: turnController.signal,
      stopAfterCurrent: () => stopQueued.value,
      autonomy: autonomy.value,
      selectedNodeId: props.selectedNode?.id,
      attachments: attachOptions,
      history: messages.value.slice(0, -1).slice(-16).map((message) => ({ role: message.role, content: message.content }))
    }
    const result = props.selectedNode && isDirectNodeShortcut(t)
      ? {
          reply: await (onProgress({ kind: 'intent', label: translate('agentWorkspace.editSelected') }), runSelectedNodeShortcut(t, props.selectedNode, turnController.signal, (label) => onProgress({ kind: 'log', label }))),
          results: [],
          chips: []
        }
      : isSelectedTextEdit(t, props.selectedNode) && props.selectedNode
      ? {
          reply: await editSelectedCanvasText(t, props.selectedNode, turnController.signal),
          results: [],
          chips: []
        }
      : continuousEnabled.value
        ? await (continuousTurn.value = true, runContinuousTurn(t, onProgress, options))
        : await runAgentTurn(messages.value, t, onProgress, options)
    thinking.value = false
    const think = trace.value.find((s) => s.kind === 'think' && s.status === 'running')
    if (think) think.status = 'done'
    for (const row of trace.value) {
      if (row.kind === 'plan' && row.plan) {
        for (const step of row.plan.steps) {
          if (step.status === 'running') step.status = 'done'
        }
      }
    }
    if (trace.value.length) {
      feed.value.push({ id: `run-${Date.now()}`, type: 'run', rows: trace.value.map((row) => ({ ...row, plan: row.plan ? { ...row.plan, steps: row.plan.steps.map((s) => ({ ...s })) } : undefined })) })
    }
    feed.value.push({ id: `a-${Date.now()}`, type: 'msg', role: 'assistant', content: result.reply })
    await appendAgentMessage('assistant', result.reply)
    chips.value = result.chips
  } catch (e: any) {
    thinking.value = false
    attachments.value = attachOptions
    const cancelled = turnController.signal.aborted || (isAbortError(e) && !isTimeoutAbort(e))
    const content = cancelled
      ? translate('agentChat.turnStopped')
      : translate('agentChat.turnFailed', { error: friendlyAiError(e) })
    feed.value.push({ id: `a-${Date.now()}`, type: 'msg', role: 'assistant', content })
    await appendAgentMessage('assistant', content)
  } finally {
    busy.value = false
    thinking.value = false
    trace.value = []
    controller = null
    continuousTurn.value = false
    stopQueued.value = false
    await scrollToEnd()
  }
}

function cancel() {
  if (continuousTurn.value) {
    stopQueued.value = true
    log.value = translate('agentWorkspace.stopPending')
    return
  }
  controller?.abort()
  log.value = translate('agentChat.stopping')
}

const copiedMsg = ref('')
let msgTimer: ReturnType<typeof setTimeout> | undefined

async function copyMsg(id: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    } catch {
      return
    }
  }
  copiedMsg.value = id
  if (msgTimer) clearTimeout(msgTimer)
  msgTimer = setTimeout(() => (copiedMsg.value = ''), 1500)
}

async function send() {
  await sendText(input.value)
}

function visibleRows(rows: TraceRow[]) {
  return rows.filter((row) => row.kind !== 'think')
}
</script>

<template>
  <aside class="agent">
    <section class="target" :class="{ empty: !selectedNode }">
      <p class="k">{{ $t('common.selectedModel') }}</p>
      <p v-if="selectedNode" class="name">
        {{ selectedNode.data.label || selectedNode.id }}
        <small>{{ selectedKindLabel }}</small>
      </p>
      <p v-else class="name dim">{{ $t('agentChat.noSelectedNode') }}</p>
      <p v-if="selectedNode?.data.prompt" class="preview">{{ selectedNode.data.prompt }}</p>
      <div v-if="(selectedGenNode || canContinueSelected) && !busy" class="target-chips">
        <button v-for="c in selectedGenNode ? polishChips : []" :key="c.label" type="button" @click="sendText(c.text)">
          {{ c.label }}
        </button>
        <button v-if="canContinueSelected" type="button" @click="sendText($t('agentWorkspace.continueFromTailRequest'))">{{ $t('agentWorkspace.continueFromTail') }}</button>
      </div>
    </section>

    <div ref="box" class="msgs">
      <template v-for="item in feed" :key="item.id">
        <div v-if="item.type === 'msg'" class="msg" :class="item.role">
          <div class="bubble">
            <AgentRichText :content="item.id === 'welcome' ? $t('agentChat.welcome') : item.content" />
            <button
              v-if="item.role === 'assistant'"
              type="button"
              class="bubble-copy"
              :class="{ ok: copiedMsg === item.id }"
              :title="copiedMsg === item.id ? $t('common.copied') : $t('agentChat.copyReply')"
              @click="copyMsg(item.id, item.id === 'welcome' ? $t('agentChat.welcome') : item.content)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15V5a2 2 0 0 1 2-2h8" />
              </svg>
            </button>
          </div>
        </div>
        <div v-else class="turn">
          <AgentTraceList :rows="visibleRows(item.rows)" />
        </div>
      </template>

      <div v-if="canvasLive && canvasTrace.length" class="turn">
        <AgentTraceList :rows="canvasTrace" />
      </div>

      <div v-if="busy" class="turn">
        <div v-if="thinking" class="think">
          <span class="dot-pulse"><i /><i /><i /></span>
          <span>{{ $t('agentChat.thinking') }}</span>
        </div>
        <AgentTraceList :rows="visibleRows(trace)" />
      </div>
    </div>

    <div v-if="chips.length && !busy && !canvasLive" class="chips">
      <button
        v-for="c in chips"
        :key="c.text + c.label"
        type="button"
        :class="{ go: /^(?:继续|계속)/.test(c.text) || /^(?:继续|계속)/.test(c.label) }"
        @click="sendText(c.text)"
      >
        {{ c.label }}
      </button>
    </div>

    <form class="composer" @submit.prevent="send">
      <p v-if="continuousEnabled" class="capture-hint">{{ $t('agentWorkspace.captureHint') }}</p>
      <p v-if="!continuousEnabled && input.trim() && estimate.calls" class="estimate">
        {{ $t('agentChat.estimated') }} {{ estimate.calls }} {{ $t('common.requestCountEstimate') }} {{ Math.max(1, Math.ceil(estimate.seconds / 60)) }} {{ $t('common.minutes') }}
      </p>
      <div class="box" :class="{ busy }">
        <div v-if="attachments.length" class="attach-chips">
          <span v-for="(a, i) in attachments" :key="a.path || a.name" class="attach-chip">
            📎 {{ a.name }}
            <button type="button" :disabled="busy" :title="$t('agentChat.removeAttachment')" @click="removeAttachment(i)">×</button>
          </span>
        </div>
        <textarea
          v-model="input"
          rows="5"
          :disabled="busy"
          :placeholder="continuousEnabled ? $t('agentWorkspace.capturePlaceholder') : $t('agentChat.placeholder')"
          @keydown.enter.exact.prevent="send"
        />
        <div class="bar">
          <div class="bar-pop">
            <button
              type="button"
              class="bar-btn attach-btn"
              :disabled="busy"
              :title="$t('agentChat.attachmentHint')"
              @click.stop="pickAttachments"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 12.5l-8.2 8.2a5.6 5.6 0 0 1-7.9-7.9L13 4.7a3.8 3.8 0 0 1 5.4 5.4l-8.1 8.1a1.9 1.9 0 0 1-2.7-2.7l7.5-7.5" />
              </svg>
              <span>{{ $t('agentChat.attachments') }}</span>
            </button>
          </div>
          <div class="bar-pop pref-pop">
            <button
              ref="prefBtn"
              type="button"
              class="bar-btn pref-btn"
              :disabled="busy"
              :title="$t('agentChat.preferencesSummary', { p0: currentAspectRatio, p1: activeImageLabel, p2: activeVideoLabel })"
              @click.stop="togglePrefPanel"
            >
              <svg viewBox="0 0 24 24" class="pref-icon" aria-hidden="true">
                <path d="M4 8h10M18 8h2M4 16h2M10 16h10" />
                <circle cx="16" cy="8" r="2.2" />
                <circle cx="8" cy="16" r="2.2" />
              </svg>
              <span>{{ $t('agentChat.preferences') }}</span>
            </button>
            <Teleport to="body">
              <div
                v-if="prefOpen"
                ref="prefPanel"
                class="pref-panel"
                :class="{ floating: true }"
                :style="prefStyle"
                @click.stop
              >
              <div class="pref-tabs">
                <button
                  type="button"
                  :class="{ on: prefTab === 'video' }"
                  @click="prefTab = 'video'"
                >
                  {{ $t('agentChat.videoPreferences') }}
                </button>
                <button
                  type="button"
                  :class="{ on: prefTab === 'image' }"
                  @click="prefTab = 'image'"
                >
                  {{ $t('agentChat.imagePreferences') }}
                </button>
                <button type="button" :class="{ on: prefTab === 'knowledge' }" @click="prefTab = 'knowledge'">{{ $t('agentWorkspace.writingReferences') }}</button>
                <button type="button" :class="{ on: prefTab === 'comfyui' }" @click="prefTab = 'comfyui'">ComfyUI</button>
              </div>
              <div v-if="prefTab === 'comfyui'" class="pref-comfy">
                <label>{{ $t('agentWorkspace.imageWorkflow') }}
                  <select class="pref-select" :disabled="!comfyImages.length" :value="comfyImages.some(p => p.id === settings.config.activeImageId) ? settings.config.activeImageId : ''" @change="pickImage(($event.target as HTMLSelectElement).value)">
                    <option value="" disabled>{{ comfyImages.length ? $t('agentWorkspace.chooseImageWorkflow') : $t('agentWorkspace.noImageWorkflow') }}</option>
                    <option v-for="p in comfyImages" :key="p.id" :value="p.id">{{ p.name }}</option>
                  </select>
                </label>
                <label>{{ $t('agentWorkspace.videoWorkflow') }}
                  <select class="pref-select" :disabled="!comfyVideos.length" :value="!videoDefault && comfyVideos.some(p => p.id === settings.config.activeVideoId) ? settings.config.activeVideoId : ''" @change="pickVideo(($event.target as HTMLSelectElement).value)">
                    <option value="" disabled>{{ comfyVideos.length ? $t('agentWorkspace.chooseVideoWorkflow') : $t('agentWorkspace.noVideoWorkflow') }}</option>
                    <option v-for="p in comfyVideos" :key="p.id" :value="p.id">{{ p.name }}</option>
                  </select>
                </label>
                <p v-if="!comfyImages.length || !comfyVideos.length" class="pref-hint">{{ $t('agentWorkspace.importWorkflowHint') }}</p>
              </div>
              <div v-else-if="prefTab !== 'knowledge'" class="pref-body">
                <div class="pref-models">
                  <p class="pref-k">{{ $t('agentChat.modelSelection') }}</p>
                  <template v-if="prefTab === 'video'">
                    <select v-model="videoChoice" class="pref-select" :aria-label="$t('agentWorkspace.chooseVideoModel')">
                      <optgroup :label="$t('agentWorkspace.builtInWorkflow')">
                        <option v-for="w in VIDEO_WORKFLOW_OPTIONS" :key="w.value" :value="`workflow:${w.value}`">{{ w.name }}</option>
                      </optgroup>
                      <optgroup v-if="videoProfiles.length" :label="$t('common.configuredVideo')">
                        <option v-for="p in videoProfiles" :key="p.id" :value="`profile:${p.id}`">{{ videoProfileTag(p) ? `${videoProfileTag(p)} · ${p.name}` : p.name }}</option>
                      </optgroup>
                      <option v-if="!videoProfiles.length && !videoDefault" value="profile:">{{ $t('agentWorkspace.chooseVideoModelHint') }}</option>
                    </select>
                    <p class="pref-k pref-k-gap">{{ $t('agentWorkspace.videoResolution') }}</p>
                    <div class="res-row">
                      <button
                        v-for="r in preferenceResolutionChoices"
                        :key="r"
                        type="button"
                        class="res-btn"
                        :class="{ on: currentVideoResolution === r }"
                        @click="pickVideoResolution(r)"
                      >
                        {{ docVideoResolutionLabel(r) }}
                      </button>
                    </div>
                    <p class="pref-hint">{{ videoResolutionHint }}</p>
                  </template>
                  <template v-else>
                    <select v-model="imageChoice" class="pref-select" :aria-label="$t('agentWorkspace.chooseImageModel')">
                      <option v-if="!imageProfiles.length" value="">{{ $t('agentWorkspace.addImageModel') }}</option>
                      <option v-for="p in imageProfiles" :key="p.id" :value="p.id">{{ p.name }} · {{ p.model }}</option>
                    </select>
                  </template>
                </div>
                <div class="pref-ratios">
                  <p class="pref-k">{{ $t('common.frameRatio') }}</p>
                  <div class="ratio-grid">
                    <button
                      v-for="a in ASPECT_OPTIONS"
                      :key="a.value"
                      type="button"
                      class="ratio-item"
                      :class="{ on: currentAspectRatio === a.value }"
                      @click="pickAspectRatio(a.value)"
                    >
                      <span class="ratio-box" :style="ratioBoxStyle(a.value)" />
                      <span class="ratio-label">{{ a.value }}</span>
                    </button>
                  </div>
                  <p class="pref-hint">{{ $t('agentChat.preferenceHint') }}</p>
                </div>
              </div>
              <div v-else class="knowledge-preference">
                <p class="pref-k">{{ $t('agentWorkspace.chooseReferences') }}</p>
                <p class="pref-hint">{{ $t('agentWorkspace.referenceHint') }}</p>
                <div class="knowledge-grid"><button v-for="item in SCRIPT_REFERENCE_OPTIONS" :key="item.value" type="button" class="knowledge-option" :class="{ on: scriptReferenceType === item.value }" @click="scriptReferenceType = item.value">{{ item.label }}</button></div>
              </div>
              </div>
            </Teleport>
          </div>
          <div class="bar-pop skill-pop">
            <button
              ref="skillBtn"
              type="button"
              class="bar-btn pref-btn"
              :class="{ on: activeStyleId !== GENERAL_STORY_SKILL_ID || activeGenreId !== GENERAL_STORY_SKILL_ID }"
              :disabled="busy"
              :title="$t('agentWorkspace.activeSkill', { name: activeStorySkillName })"
              @click.stop="toggleSkillPanel"
            >
              <svg viewBox="0 0 24 24" class="pref-icon" aria-hidden="true">
                <path d="M7 4.5h10a1.5 1.5 0 0 1 1.5 1.5V20l-6.5-3.2L5.5 20V6A1.5 1.5 0 0 1 7 4.5Z" />
              </svg>
              <span>{{ $t('studioUpdate.skills') }}</span>
            </button>
            <Teleport to="body">
              <div
                v-if="skillOpen"
                ref="skillPanel"
                class="pref-panel skill-panel"
                :style="skillStyle"
                @click.stop
              >
                <div class="pref-tabs">
                  <button type="button" :class="{ on: skillTab === 'style' }" @click="skillTab = 'style'">{{ $t('agentWorkspace.shotStyle') }}</button>
                  <button type="button" :class="{ on: skillTab === 'genre' }" @click="skillTab = 'genre'">{{ $t('agentWorkspace.genre') }}</button>
                  <button type="button" :class="{ on: skillTab === 'mine' }" @click="skillTab = 'mine'">{{ $t('agentWorkspace.mine') }}</button>
                </div>
                <div class="skill-body">
                  <button
                    type="button"
                    class="pref-model"
                    :class="{ on: activeStorySkillId === GENERAL_STORY_SKILL_ID }"
                    @click="pickStorySkill(GENERAL_STORY_SKILL_ID)"
                  >
                    <span class="pref-radio" />
                    <img v-if="storyIcon(GENERAL_STORY_SKILL_ID)" class="skill-icon" :src="storyIcon(GENERAL_STORY_SKILL_ID)" alt="" />
                    <span class="pref-model-text">
                      <b>{{ skillTab === 'genre' ? $t('agentWorkspace.anyGenre') : $t('agentWorkspace.genericSkill') }}</b>
                      <small>{{ skillTab === 'genre' ? $t('agentWorkspace.followGenre') : $t('agentWorkspace.followStyle') }}</small>
                    </span>
                  </button>
                  <template v-if="skillTab === 'style'">
                    <button
                      v-for="skill in styleSkills"
                      :key="skill.id"
                      type="button"
                      class="pref-model"
                      :class="{ on: activeStorySkillId === skill.id }"
                      @click="pickStorySkill(skill.id)"
                    >
                      <span class="pref-radio" />
                      <img v-if="storyIcon(skill.id)" class="skill-icon" :src="storyIcon(skill.id)" alt="" />
                      <span class="pref-model-text">
                        <b>{{ skill.name }}</b>
                        <small>{{ skill.summary }}</small>
                      </span>
                    </button>
                  </template>
                  <template v-else-if="skillTab === 'genre'">
                    <button
                      v-for="skill in genreSkills"
                      :key="skill.id"
                      type="button"
                      class="pref-model"
                      :class="{ on: activeStorySkillId === skill.id }"
                      @click="pickStorySkill(skill.id)"
                    >
                      <span class="pref-radio" />
                      <img v-if="storyIcon(skill.id)" class="skill-icon" :src="storyIcon(skill.id)" alt="" />
                      <span class="pref-model-text">
                        <b>{{ skill.name }}</b>
                        <small>{{ skill.summary }}</small>
                      </span>
                    </button>
                  </template>
                  <template v-else>
                    <button
                      v-if="importedSkill"
                      type="button"
                      class="pref-model"
                      :class="{ on: activeStorySkillId === CUSTOM_STORY_SKILL_ID }"
                      @click="pickStorySkill(CUSTOM_STORY_SKILL_ID)"
                    >
                      <span class="pref-radio" />
                      <span class="pref-model-text">
                        <b>{{ importedSkill.name }}</b>
                        <small>{{ importedSkill.filename || $t('agentWorkspace.importedFilename') }}</small>
                      </span>
                    </button>
                    <p v-else class="pref-empty">{{ $t('agentWorkspace.noImported') }}</p>
                    <div class="skill-acts">
                      <button type="button" class="skill-act" :disabled="importingSkill" @click="importStorySkill">
                        {{ importingSkill ? $t('common.reading') : importedSkill ? $t('agentWorkspace.replaceSkill') : $t('agentWorkspace.importSkill') }}
                      </button>
                      <button
                        v-if="isDesktop()"
                        type="button"
                        class="skill-act"
                        :disabled="importingSkill"
                        @click="importStorySkillFolder"
                      >
                        {{ $t('settings.director.importFolder') }}
                      </button>
                      <button v-if="importedSkill" type="button" class="skill-act danger" @click="clearImportedSkill">{{ $t('common.clear') }}</button>
                    </div>
                  </template>
                  <p class="pref-hint">{{ $t('agentWorkspace.combineHint') }}</p>
                </div>
              </div>
            </Teleport>
          </div>
          <button type="button" class="bar-btn capture-switch" role="switch" :aria-checked="continuousEnabled" :class="{ on: continuousEnabled }" :disabled="busy" :title="$t('studioUpdate.continuousHint')" @click="toggleContinuous">
            <span class="capture-switch-track" aria-hidden="true"><span /></span><span>{{ $t('studioUpdate.continuousCapture') }}</span>
          </button>
          <button
            v-if="busy"
            type="button"
            class="icon-act stop"
            :class="{ 'stop-queue': continuousTurn }"
            :title="continuousTurn ? $t('agentWorkspace.stopAfterCurrent') : $t('common.stop')"
            :aria-label="continuousTurn ? $t('agentWorkspace.stopNext') : $t('common.stop')"
            @click="cancel"
          >
            <span v-if="continuousTurn">{{ stopQueued ? $t('agentWorkspace.waitingCurrent') : $t('agentWorkspace.stopFollowing') }}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" rx="1.5" />
            </svg>
          </button>
          <button
            v-else
            type="submit"
            class="icon-act send"
            :title="$t('common.send')"
            :disabled="!input.trim()"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h12M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>
    </form>
  </aside>
</template>

<style scoped>
.agent {
  position: relative;
  width: 100%;
  height: 100%;
  flex-shrink: 0;
  min-width: 0;
  border-right: none;
  background: var(--nb-bg-1);
  color: var(--nb-t1);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-x: hidden;
}

/* 선택한 자유 캔버스 노드 카드 */
.target {
  margin: 12px 14px 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--nb-accent) 8%, var(--nb-bg-2));
  border: 1px solid var(--nb-line-accent);
}
.target.empty {
  background: transparent;
  border-color: transparent;
}
.k {
  margin: 0;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.14em;
  color: var(--nb-accent);
}
.name {
  margin: 4px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--nb-t1);
}
.name small {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--nb-bg-4);
  font-weight: 500;
  font-size: 10px;
  color: var(--nb-t3);
}
.name.dim,
.preview.dim {
  font-weight: 400;
  color: var(--nb-t4);
}
.preview {
  margin: 6px 0 0;
  max-height: 60px;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.55;
  color: var(--nb-t2);
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.target-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 8px;
}
.target-chips button {
  margin: 0;
  padding: 3px 8px;
  border: none;
  border-radius: 4px;
  background: var(--nb-bg-3);
  color: var(--nb-t2);
  font-size: 11px;
  cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease;
}
.target-chips button:hover {
  background: var(--nb-bg-4);
  color: var(--nb-t1);
}

/* 메시지 목록 */
.msgs {
  flex: 1;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 8px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.msg {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
  animation: msg-in 0.24s ease;
}
@keyframes msg-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.msg.user {
  justify-content: flex-end;
}
.bubble {
  min-width: 0;
  max-width: 100%;
  padding: 9px 12px;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
  word-break: break-word;
  color: var(--nb-t2);
}
.msg.user .bubble {
  max-width: 88%;
  padding: 8px 12px;
  background: var(--nb-accent-soft);
  border: 1px solid var(--nb-line-accent);
  color: var(--nb-t1);
}
.msg.assistant .bubble {
  position: relative;
  flex: 1;
  background: var(--nb-bg-2);
  border: 1px solid var(--nb-line-2);
}
.bubble-copy {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: var(--nb-bg-3);
  color: var(--nb-t3);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.msg:hover .bubble-copy {
  opacity: 1;
}
.bubble-copy:hover {
  color: var(--nb-t1);
  background: var(--nb-bg-4);
}
.bubble-copy.ok {
  opacity: 1;
  color: var(--nb-success);
  background: var(--nb-success-soft);
}
.bubble-copy svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.turn {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0 2px;
  border-top: none;
  min-width: 0;
}

/* 실행 내역 */
.think {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-3);
}
.dot-pulse {
  display: inline-flex;
  gap: 4px;
}
.dot-pulse i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-text-1);
  animation: dot-bounce 1s ease-in-out infinite;
}
.dot-pulse i:nth-child(2) { animation-delay: 0.15s; }
.dot-pulse i:nth-child(3) { animation-delay: 0.3s; }
@keyframes dot-bounce {
  0%, 100% { opacity: 0.3; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}
/* 빠른 명령 */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 16px 10px;
  min-width: 0;
  overflow-x: hidden;
}
.chips button {
  margin: 0;
  padding: 5px 12px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 11px;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}
.chips button:hover {
  background: var(--color-fill-hover);
  color: var(--color-text-1);
}
.chips button.go {
  background: var(--nb-accent);
  color: var(--nb-accent-ink);
  font-size: 12px;
  font-weight: 650;
  padding: 6px 14px;
}
.chips button.go:hover {
  background: #67e4fb;
  color: var(--nb-accent-ink);
}

/* 입력 영역 */
.composer {
  padding: 10px 12px 12px;
  border-top: none;
  min-width: 0;
}
.capture-hint { margin: 0 0 8px; padding: 8px 10px; border-radius: 8px; background: var(--nb-ai-soft); color: var(--nb-ai); font-size: 11px; line-height: 1.5; }
.capture-switch { gap: 5px; white-space: nowrap; }
.capture-switch-track { display: inline-flex; flex: 0 0 24px; align-items: center; width: 24px; height: 14px; padding: 2px; border-radius: 12px; background: var(--nb-bg-4); box-sizing: border-box; }
.capture-switch-track > span { width: 10px; height: 10px; border-radius: 50%; background: var(--nb-t2); transition: transform .15s; }
.capture-switch.on .capture-switch-track { background: var(--nb-accent); }
.capture-switch.on .capture-switch-track > span { transform: translateX(10px); background: var(--nb-accent-ink); }
.estimate {
  margin: 0 0 6px;
  font-size: 11px;
  color: var(--color-text-4);
}
.box {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--nb-bg-2);
  border: 1px solid var(--nb-line-2);
  border-radius: 10px;
  padding: 8px 8px 6px;
  outline: 1px solid transparent;
  outline-offset: -1px;
  transition: outline-color 0.2s ease, border-color 0.2s ease, background-color 0.2s ease;
}
.box:focus-within {
  border-color: var(--nb-line-accent);
  outline-color: var(--nb-accent-soft);
}
textarea {
  width: 100%;
  min-height: 96px;
  resize: none;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-text-1);
  padding: 4px 6px 8px;
  font: inherit;
  font-size: 13px;
  line-height: 1.55;
}
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  min-width: 0;
}
.bar-pop {
  position: relative;
  flex-shrink: 0;
}
.attach-btn svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.attach-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 6px 6px;
}
.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--nb-accent-soft);
  color: var(--nb-accent);
  font-size: 11px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.attach-chip button {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  padding: 0 1px;
}
.bar-btn {
  height: 28px;
  margin: 0;
  min-width: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 11px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  white-space: nowrap;
  overflow: hidden;
  transition: background-color 0.15s, color 0.15s;
}
.bar-btn:hover:not(:disabled) {
  background: var(--color-fill-hover);
  color: var(--color-text-1);
}
.bar-btn:active:not(:disabled) {
  background: var(--color-fill-strong);
}
.bar-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.bar-btn i {
  width: 0;
  height: 0;
  border-left: 3.5px solid transparent;
  border-right: 3.5px solid transparent;
  border-top: 4px solid currentColor;
  opacity: 0.7;
}
.menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 8;
  width: 220px;
  padding: 6px;
  border: none;
  border-radius: 4px;
  background: var(--nb-bg-2);
  border: 1px solid var(--nb-line-3);
  box-shadow: var(--nb-e3);
}
.model-menu {
  width: 248px;
  max-height: 280px;
  overflow: auto;
  right: 0;
  left: auto;
}
/* 창작 환경설정 팝업 */
.pref-btn {
  gap: 5px;
  padding: 0 10px;
}
.pref-btn.on {
  color: var(--color-text-1);
  background: var(--color-fill);
}
.skill-panel {
  width: 560px;
}
.skill-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
}
.skill-body .pref-model { align-items: center; min-height: 58px; }
.skill-body .pref-radio { margin-top: 0; }
.skill-icon { width: 44px; height: 44px; object-fit: contain; flex: 0 0 44px; }
.skill-body .pref-model-text small { white-space: normal; line-height: 1.45; }
.skill-acts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.skill-act {
  height: 30px;
  margin: 0;
  padding: 0 12px;
  border: none;
  border-radius: 4px;
  background: var(--nb-bg-3);
  color: var(--nb-t1);
  font-size: 12px;
  cursor: pointer;
}
.skill-act.danger {
  color: var(--color-error, #f87171);
}
.skill-act:disabled {
  opacity: 0.45;
  cursor: default;
}
.pref-icon {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
}
.pref-panel {
  position: fixed;
  z-index: 2000;
  border: none;
  border-radius: 4px;
  background: var(--nb-bg-2);
  border: 1px solid var(--nb-line-3);
  box-shadow: var(--nb-e3);
  overflow: auto;
  animation: pref-pop 0.12s ease-out;
}
@keyframes pref-pop {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.pref-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 10px 0;
}
.pref-tabs button {
  margin: 0;
  padding: 6px 14px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.pref-tabs button.on {
  background: var(--color-fill);
  color: var(--color-text-1);
}
.pref-body {
  display: grid;
  grid-template-columns: 1fr 190px;
  gap: 0;
  padding: 10px;
}
.pref-models {
  min-width: 0;
  padding-right: 10px;
  border-right: none;
  max-height: 520px;
  overflow: auto;
}
.pref-select {
  display: block;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border: none;
  border-radius: 4px;
  background: var(--nb-bg-3);
  color: var(--nb-t1);
  font-size: 12px;
}
.pref-comfy { display: grid; gap: 12px; padding: 14px; min-width: 0; }
.pref-comfy label { display: grid; gap: 6px; min-width: 0; font-size: 12px; color: var(--color-text-2); }
.pref-comfy .pref-select { min-width: 0; max-width: 100%; box-sizing: border-box; text-overflow: ellipsis; }
.pref-comfy .pref-hint { margin: 0; }
.knowledge-preference { padding: 14px; }
.knowledge-preference .pref-hint { margin: 4px 0 14px; }
.knowledge-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 8px; }
.knowledge-option { padding: 10px 12px; border: 1px solid var(--nb-line-2); border-radius: 8px; background: var(--nb-bg-3); color: var(--nb-t2); text-align: left; cursor: pointer; }
.knowledge-option.on { color: var(--nb-accent); background: var(--nb-accent-soft); border-color: var(--nb-line-accent); }
.pref-k-gap {
  margin-top: 14px;
}
.res-row {
  display: flex;
  gap: 8px;
  padding: 0 4px 6px;
}
.res-btn {
  height: 32px;
  min-width: 72px;
  padding: 0 12px;
  border: none;
  border-radius: 4px;
  background: var(--nb-bg-3);
  color: var(--nb-t2);
  font-size: 12px;
  cursor: pointer;
}
.res-btn.on {
  color: var(--nb-accent);
  background: var(--nb-accent-soft);
  border: 1px solid var(--nb-line-accent);
}

/* 영상 워크플로와 구성된 연결의 그룹 제목 */
.pref-g {
  margin: 10px 4px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--color-text-4);
}
.pref-g:first-child {
  margin-top: 2px;
}
.pref-empty {
  margin: 4px;
  padding: 10px;
  font-size: 11px;
  color: var(--color-text-4);
}
.pref-model {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  margin: 0 0 2px;
  padding: 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.pref-model:hover {
  background: var(--color-fill);
}
.pref-model.on {
  background: var(--color-fill);
}
.pref-radio {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  margin-top: 2px;
  border: 1.5px solid var(--color-text-4);
  border-radius: 50%;
}
.pref-model.on .pref-radio {
  border-color: var(--nb-accent);
  background: var(--nb-accent);
  box-shadow: inset 0 0 0 2.5px var(--color-bg-1);
}
.pref-model-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pref-model-text b {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pref-model-text small {
  font-size: 10.5px;
  color: var(--color-text-4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pref-ratios {
  padding-left: 12px;
}
.ratio-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ratio-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 56px;
  height: 56px;
  margin: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-3);
  cursor: pointer;
}
.ratio-item:hover {
  background: var(--color-fill);
}
.ratio-item.on {
  background: var(--nb-accent-soft);
  color: var(--nb-accent);
}
.ratio-box {
  border: 1.5px solid currentColor;
  border-radius: 3px;
}
.ratio-label {
  font-size: 10px;
}
.pref-hint {
  margin: 10px 2px 2px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--color-text-4);
}
.menu-g {
  margin: 8px 8px 4px;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: var(--color-text-4);
}
.menu-g:first-of-type {
  margin-top: 2px;
}
.empty {
  margin: 0 8px 8px;
  font-size: 11px;
  color: var(--color-text-4);
}
.menu > button,
.model-item {
  display: block;
  width: 100%;
  margin: 0;
  padding: 7px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--color-text-2);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.model-item span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.menu > button.on,
.menu > button:hover,
.model-item.on,
.model-item:hover {
  background: var(--color-fill);
  color: var(--color-text-1);
}
.tip {
  margin: 6px 2px 2px;
  padding-top: 6px;
  border-top: none;
  font-size: 11px;
  line-height: 1.45;
  color: var(--color-text-4);
}
.icon-act {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  margin: 0 0 0 auto;
  padding: 0;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.icon-act svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.icon-act.stop-queue { width: auto; min-width: 28px; padding: 0 8px; gap: 4px; font-size: 11px; white-space: nowrap; }
.send {
  border-radius: 8px;
  background: var(--nb-accent);
  color: var(--nb-accent-ink);
  transition: background 0.18s ease;
}
.send:hover:not(:disabled) {
  background: #4ce0ff;
}
.send:disabled {
  opacity: 0.35;
  cursor: default;
}
.stop {
  background: var(--nb-danger-soft);
  color: var(--nb-danger);
  border: none;
  border-radius: 4px;
}
.stop svg {
  fill: currentColor;
  stroke: none;
}
</style>
