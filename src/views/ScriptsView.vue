<script setup lang="ts">
import { confirmAction } from '@/utils/confirmAction'
import { t as translate, uiPunctuation } from '@/i18n'
/**
 * 대본 관리.
 *
 * 왼쪽은 로컬 Markdown 대본 목록, 오른쪽은 대본 편집기다.
 * - 회차 편집에서는 제목, 본문, 회차 순서를 수정한다.
 * - Markdown 원문에서 전체를 수정하고 미리보기에서 결과를 확인한다.
 * 대본은 저장 폴더의 _scripts/<id>.md에 보관하며 리소스 라이브러리에서 재사용할 수 있다.
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useScriptsStore, useSettingsStore, useToastStore } from '@/stores'
import { llmModelGroups } from '@/stores/settings'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import Tag from '@/components/common/Tag.vue'
import { pickScriptFile } from '@/utils/pickPlayFile'
import { markdownToHtml } from '@/utils/markdown'
import { parseScriptDoc, serializeScriptDoc, toEpisodes, updateEpisode } from '@/utils/scriptEpisodes'
import { paintScreenplay } from '@/utils/screenplayPaint'
import { SCREENPLAY_FORMAT_RULES, normalizeScreenplayBody } from '@/utils/screenplayFormat'
import { callLLM } from '@/services/ai/client'
import { assertScriptCompletion } from '@/services/ai/scriptCompletion'
import { SCRIPT_REFERENCE_OPTIONS, normalizeScriptReference, scriptReferenceBrief } from '@/services/ai/scriptReference'
import { SHORT_DRAMA_WRITING_RULES } from '@/services/ai/shortDramaRhythm'
import { importedDirectorPrefix } from '@/services/settings/directorSkill'
import { desktop, isDesktop } from '@/services/desktop'
import { parseJsonRobust } from '@/utils/jsonRepair'
import type { ScriptEpisode } from '@/types'

type EditorTab = 'episodes' | 'markdown' | 'preview'

const router = useRouter()
const scripts = useScriptsStore()
const project = useProjectStore()
const settings = useSettingsStore()
const toast = useToastStore()

const keyword = ref('')
const SIDE_WIDTH_KEY = 'aicut:scripts:side-width'
const AGENT_WIDTH_KEY = 'aicut:scripts:agent-width'

function storedWidth(key: string, fallback: number, min: number, max: number) {
  const raw = localStorage.getItem(key)
  const n = Number(raw)
  if (raw == null || raw === '' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const sideWidth = ref(storedWidth(SIDE_WIDTH_KEY, 220, 168, 420))
const agentWidth = ref(storedWidth(AGENT_WIDTH_KEY, 320, 260, 560))
const resizingPane = ref<'side' | 'agent' | ''>('')

function startPaneResize(which: 'side' | 'agent', ev: PointerEvent) {
  ev.preventDefault()
  const startX = ev.clientX
  const start = which === 'side' ? sideWidth.value : agentWidth.value
  resizingPane.value = which
  const move = (e: PointerEvent) => {
    const dx = e.clientX - startX
    if (which === 'side') sideWidth.value = Math.min(420, Math.max(168, start + dx))
    else agentWidth.value = Math.min(560, Math.max(260, start - dx))
  }
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    resizingPane.value = ''
    localStorage.setItem(SIDE_WIDTH_KEY, String(sideWidth.value))
    localStorage.setItem(AGENT_WIDTH_KEY, String(agentWidth.value))
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
}

const activeId = ref('')
const detailOpen = ref(false)
const activeTab = ref<EditorTab>('episodes')
const markdown = ref('')
const dirty = ref(false)
const saving = ref(false)
const activeEpisodeIndex = ref(0)
const titleEditing = ref('')
/** 타이핑 중 Markdown 정리로 입력이 끊기지 않도록 현재 회차의 편집 초안을 유지한다. */
const draft = ref<{ index: number; title: string; content: string } | null>(null)
const scriptPaintEl = ref<HTMLElement | null>(null)
const scriptInputEl = ref<HTMLTextAreaElement | null>(null)
const scriptPaint = computed(() => paintScreenplay(draft.value?.content || ''))
const scriptMode = ref<'source' | 'preview'>('source')
const caret = ref({ line: 1, col: 1 })
const episodeChars = computed(() => (draft.value?.content || '').replace(/\s/g, '').length)
const savedLabel = computed(() => {
  if (saving.value) return translate('scriptDesk.saving')
  if (dirty.value) return translate('scriptDesk.unsaved')
  const ts = activeDoc.value?.updatedAt
  if (!ts) return translate('scriptDesk.saved')
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return translate('scriptDesk.savedTime', { time: `${pad(d.getHours())}:${pad(d.getMinutes())}` })
})
const otherDocs = computed(() => scripts.docs.filter((doc) => doc.id !== activeId.value))

function scenesIn(content: string) {
  return content.split('\n').flatMap((line) => {
    const trimmed = line.trim()
    if (/^#{2,}\s+/.test(trimmed) || /^(?:场景|장면|Scene)\s*[0-9０-９]/i.test(trimmed)) {
      return [trimmed.replace(/^#+\s*/, '')]
    }
    return []
  })
}

function readCaret() {
  const input = scriptInputEl.value
  if (!input) return
  const pos = input.selectionStart || 0
  const before = input.value.slice(0, pos)
  caret.value = { line: before.split('\n').length, col: pos - before.lastIndexOf('\n') }
}

function editCommand(command: 'undo' | 'redo') {
  scriptInputEl.value?.focus()
  document.execCommand(command)
  readCaret()
}

function askWriter(text: string) {
  episodeHint.value = text
  void writeCurrentEpisode()
}

const activeDoc = computed(() => scripts.docs.find((d) => d.id === activeId.value) ?? null)

const episodes = computed<ScriptEpisode[]>(() => {
  if (!activeDoc.value) return []
  return toEpisodes(parseScriptDoc(markdown.value), activeDoc.value.id)
})

const filteredDocs = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return scripts.docs
  return scripts.docs.filter((d) => d.title.toLowerCase().includes(kw))
})

const totalWords = computed(() => episodes.value.reduce((sum, ep) => sum + ep.wordCount, 0))
const previewHtml = computed(() => markdownToHtml(markdown.value))

function fmtTime(ts: number) {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function sourceLabel(source: string) {
  return source === 'ai-generated' ? translate('scripts.sourceAi') : source === 'imported' ? translate('scripts.sourceImport') : translate('scripts.sourceManual')
}

async function loadContent(id: string, force = false) {
  markdown.value = await scripts.readContent(id, force)
  syncDraft(0)
  dirty.value = false
}

/** 회차를 편집 초안에 불러온다. */
function syncDraft(index: number) {
  activeEpisodeIndex.value = index
  const ep = episodes.value[index]
  draft.value = ep ? { index, title: ep.title, content: ep.content } : null
}

function openEpisode(index: number) {
  if (draft.value && draft.value.index === index) return
  if (draft.value) flushDraft()
  syncDraft(index)
}

async function openScript(id: string) {
  if (id !== activeId.value) {
    if (dirty.value && !confirmDiscard()) return
    flushDraft()
    activeId.value = id
    await loadContent(id)
  }
  titleEditing.value = scripts.docs.find((d) => d.id === id)?.title || ''
  detailOpen.value = true
}

function backToLibrary() {
  flushDraft()
  detailOpen.value = false
}

function confirmDiscard() {
  return confirmAction(translate('scripts.unsavedConfirm'))
}

function markDirty() {
  dirty.value = true
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 초안이 바뀌면 0.8초 뒤에 Markdown으로 반영해 저장한다. */
function scheduleFlush() {
  dirty.value = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushDraft, 800)
  syncScriptScroll()
}

function syncScriptScroll() {
  const input = scriptInputEl.value
  const paint = scriptPaintEl.value
  if (!input || !paint) return
  paint.scrollTop = input.scrollTop
  paint.scrollLeft = input.scrollLeft
}

function flushDraft() {
  if (!draft.value || !activeId.value) return
  const { index, title, content } = draft.value
  markdown.value = updateEpisode(markdown.value, index, {
    title: title.trim() || translate('scripts.defaultEpisodeTitle', { p0: index + 1 }),
    content
  })
  void persistQuiet()
}

async function commitTitle() {
  if (!activeId.value || !activeDoc.value) return
  const clean = titleEditing.value.trim()
  if (!clean || clean === activeDoc.value.title) {
    titleEditing.value = activeDoc.value.title
    return
  }
  try {
    await scripts.rename(activeId.value, clean)
    markdown.value = await scripts.readContent(activeId.value, true)
    dirty.value = false
    toast.success(translate('scripts.renamed'))
  } catch (e: any) {
    toast.error(translate('scripts.renameFailed', { p0: e?.message ?? e }))
  }
}

async function persistQuiet() {
  if (!activeId.value) return
  saving.value = true
  try {
    await scripts.setContent(activeId.value, markdown.value)
    dirty.value = false
  } catch (e: any) {
    toast.error(translate('scripts.saveFailed', { p0: e?.message ?? e }))
  } finally {
    saving.value = false
  }
}

async function saveNow() {
  if (!activeId.value) return
  flushDraft()
  await persistQuiet()
  toast.success(translate('scripts.savedLocally'))
}

/** 회차 제목은 초안에서 수정한 뒤 지연 저장한다. */
function onTitleInput(index: number, ev: Event) {
  if (!draft.value || draft.value.index !== index) openEpisode(index)
  if (!draft.value) return
  draft.value.title = (ev.target as HTMLInputElement).value
  scheduleFlush()
}

async function addEpisode() {
  if (!activeId.value) return
  flushDraft()
  const index = await scripts.addEpisode(activeId.value)
  await loadContent(activeId.value, true)
  activeTab.value = 'episodes'
  toast.success(translate('scripts.episodeAdded', { p0: index + 1 }))
  await nextTick()
  scrollEpisodeIntoView(index)
}

function scrollEpisodeIntoView(index: number) {
  const el = document.getElementById(`ep-${index}`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

async function insertEpisodeAfter(index: number) {
  if (!activeId.value) return
  flushDraft()
  const at = await scripts.insertEpisodeAt(activeId.value, index + 1)
  await loadContent(activeId.value, true)
  toast.success(translate('scripts.episodeInserted'))
}

async function removeEpisode(index: number) {
  if (!activeId.value) return
  if (episodes.value.length <= 1) {
    toast.warn(translate('common.keepOneEpisode'))
    return
  }
  const target = episodes.value[index]
  if (!await confirmAction(translate('scripts.deleteConfirm', { p0: target?.title ?? translate('scripts.defaultEpisodeTitle', { p0: index + 1 }) }))) return
  draft.value = null
  try {
    await scripts.removeEpisodeAt(activeId.value, index)
  } catch (e: any) {
    toast.error(e?.message ?? translate('common.deleteFailed'))
    return
  }
  await loadContent(activeId.value, true)
  toast.success(translate('scripts.episodeDeleted'))
}

async function moveEpisode(index: number, offset: -1 | 1) {
  if (!activeId.value) return
  const target = index + offset
  if (target < 0 || target >= episodes.value.length) return
  flushDraft()
  await scripts.reorderEpisode(activeId.value, index, target)
  await loadContent(activeId.value, true)
  syncDraft(target)
}

async function createScript() {
  await scripts.ensureLoaded()
  const doc = await scripts.create({
    title: translate('scripts.untitled', { p0: scripts.docs.length + 1 }),
    source: 'manual'
  })
  activeId.value = doc.id
  titleEditing.value = doc.title
  detailOpen.value = true
  await loadContent(doc.id, true)
  activeTab.value = 'episodes'
  toast.success(translate('scripts.created'))
}

const llmGroups = computed(() => llmModelGroups(settings.config.llms ?? []))
const llmModel = computed(() => settings.config.llm.model)

const genChoice = computed({
  get() {
    const id = settings.config.activeLlmId
    const model = settings.config.llm.model
    return id && model ? `${id}::${model}` : ''
  },
  set(v: string) {
    const sep = v.indexOf('::')
    if (sep <= 0) return
    settings.selectLlmModel(v.slice(0, sep), v.slice(sep + 2))
  }
})

const episodeHint = ref('')
type WritingMessage = { role: 'user' | 'assistant'; content: string; episode: number; time: number }
type StoryPlan = { brief: string; outline: string; episodes: Array<{ title: string; summary: string }>; stage: 'outline-review' | 'ready' | 'episode-review' | 'complete'; nextIndex: number }
const writingMessages = ref<WritingMessage[]>([])
const storyPlan = ref<StoryPlan | null>(null)
const writingMode = ref<'auto' | 'series' | 'episode'>('auto')
const planEditing = ref(false)
const planKey = (id: string) => `script-writing-plan:v1:${id}`
const writingHistoryLoading = ref(false)
const writingHistoryError = ref(false)
const writingList = ref<HTMLElement | null>(null)
const writingKey = (id: string) => `script-writing-chat:v1:${id}`
let historyLoadToken = 0
let historyWrites = Promise.resolve()

watch(activeId, async (id) => {
  const token = ++historyLoadToken
  writingMessages.value = []
  storyPlan.value = null
  planEditing.value = false
  writingHistoryError.value = false
  if (!id) return
  writingHistoryLoading.value = true
  try {
    await historyWrites
    const raw = isDesktop() ? await desktop().kvGet(writingKey(id)) : localStorage.getItem(writingKey(id))
    const rows: unknown = raw ? JSON.parse(raw) : []
    if (token !== historyLoadToken) return
    writingMessages.value = Array.isArray(rows) ? rows.filter((row): row is WritingMessage =>
      row && (row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string' && typeof row.episode === 'number'
    ).slice(-100) : []
    const savedPlan = isDesktop() ? await desktop().kvGet(planKey(id)) : localStorage.getItem(planKey(id))
    if (token !== historyLoadToken) return
    if (savedPlan) {
      const plan = JSON.parse(savedPlan) as StoryPlan
      if (Array.isArray(plan.episodes) && typeof plan.outline === 'string' && ['outline-review', 'ready', 'episode-review', 'complete'].includes(plan.stage)) storyPlan.value = plan
    }
  } catch {
    if (token === historyLoadToken) writingHistoryError.value = true
  } finally {
    if (token === historyLoadToken) writingHistoryLoading.value = false
  }
}, { immediate: true })

function addWritingMessage(id: string, message: WritingMessage) {
  if (id !== activeId.value) return
  writingMessages.value = [...writingMessages.value, message].slice(-100)
  const data = JSON.stringify(writingMessages.value)
  historyWrites = historyWrites.catch(() => {}).then(async () => {
    if (isDesktop()) await desktop().kvSet(writingKey(id), data)
    else localStorage.setItem(writingKey(id), data)
  }).catch(() => { writingHistoryError.value = true })
  void nextTick(() => { if (writingList.value) writingList.value.scrollTop = writingList.value.scrollHeight })
}
async function saveStoryPlan(id: string, plan: StoryPlan | null) {
  const text = JSON.stringify(plan)
  if (isDesktop()) await desktop().kvSet(planKey(id), text)
  else localStorage.setItem(planKey(id), text)
  if (id === activeId.value) storyPlan.value = plan
}
const scriptReferenceType = computed({
  get: () => normalizeScriptReference(settings.config.scriptReferenceType),
  set: (value: string) => settings.update({ scriptReferenceType: normalizeScriptReference(value) })
})
const episodeWriting = ref(false)
const writingPhase = ref<'episode' | 'outline' | 'chat'>('episode')
const episodeElapsed = ref(0)
let episodeTimer: ReturnType<typeof setInterval> | undefined
let episodeAbort: AbortController | null = null

function startWriting() {
  episodeWriting.value = true
  episodeElapsed.value = 0
  episodeTimer = setInterval(() => { episodeElapsed.value++ }, 1000)
  episodeAbort = new AbortController()
  return episodeAbort
}

function finishWriting() {
  if (episodeTimer) clearInterval(episodeTimer)
  episodeTimer = undefined
  episodeWriting.value = false
  episodeAbort = null
}

async function writeStoryPlan(brief: string, revision = false) {
  const id = activeId.value
  if (!id || !llmModel.value || episodeWriting.value) return
  const oldPlan = revision ? storyPlan.value : null
  if (!brief.trim() && !oldPlan) { toast.warn(translate('scriptDesk.describeStory')); return }
  writingPhase.value = 'outline'
  const controller = startWriting()
  const request = brief.trim() || oldPlan?.brief || ''
  addWritingMessage(id, { role: 'user', content: request, episode: -1, time: Date.now() })
  try {
    const resp = await callLLM({
      model: llmModel.value, disableThinking: true, temperature: 0.6, useProviderOutputLimit: true,
      timeoutMs: 300_000, signal: controller.signal,
      messages: [
        { role: 'system', content: `${importedDirectorPrefix()}${SHORT_DRAMA_WRITING_RULES}\nPlan an outline and an episode directory for the entire short drama. Do not write episode scripts yet. Respect the requested number of episodes, durations, genre and ending. For an unspecified count, suggest eight episodes and explain in the outline that the count can change. Each episode needs a dramatic task, evolving conflict and a hook for the next episode. Preserve causal and character continuity. Use natural, polite conversational Korean for audience-facing prose. Output only valid JSON without code fences: {"outline":"synopsis, cast, relationships, world rules and emotional arc","episodes":[{"title":"Korean episode title","summary":"Korean episode progression and ending"}]}.\n${scriptReferenceBrief(settings.config.scriptReferenceType, request)}` },
        { role: 'user', content: `${revision && oldPlan ? `Previous outline: ${oldPlan.outline}\nPrevious episode directory: ${JSON.stringify(oldPlan.episodes)}\nRequested revision: ` : 'Writing brief: '}${request}` }
      ]
    })
    assertScriptCompletion(resp)
    const parsed = parseJsonRobust(resp.content)
    const outline = typeof parsed?.outline === 'string' ? parsed.outline.trim() : ''
    const rows = Array.isArray(parsed?.episodes) ? parsed.episodes : []
    const planned = rows.map((row: any) => ({ title: String(row?.title || '').trim(), summary: String(row?.summary || '').trim() }))
    if (!outline || !planned.length || planned.length > 100 || planned.some((row: { title: string; summary: string }) => !row.title || !row.summary)) throw new Error(translate('scriptDesk.invalidOutline'))
    if (controller.signal.aborted || activeId.value !== id) throw new Error(translate('scriptDesk.writeInterrupted'))
    await saveStoryPlan(id, { brief: revision && oldPlan ? `${oldPlan.brief}\nRevision: ${request}` : request, outline, episodes: planned, stage: 'outline-review', nextIndex: 0 })
    episodeHint.value = ''
    planEditing.value = true
    addWritingMessage(id, { role: 'assistant', content: translate('scriptDesk.outlineReady', { count: planned.length }), episode: -1, time: Date.now() })
  } catch (error: any) {
    const message = controller.signal.aborted ? translate('scriptDesk.outlineCanceled') : translate('scriptDesk.outlineFailed', { reason: error?.message || translate('scriptDesk.retry') })
    if (activeId.value === id) addWritingMessage(id, { role: 'assistant', content: message, episode: -1, time: Date.now() })
    toast.warn(message)
  } finally { finishWriting() }
}

async function writePlannedEpisode() {
  const plan = storyPlan.value
  const id = activeId.value
  if (!plan || !id || episodeWriting.value || !llmModel.value || plan.stage !== 'ready') return
  const index = plan.nextIndex
  const episode = plan.episodes[index]
  if (!episode) return
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  flushDraft()
  const parsed = parseScriptDoc(markdown.value)
  if (index > parsed.episodes.length) { toast.warn(translate('scriptDesk.episodeListChanged')); return }
  if (index > 0 && parsed.episodes.slice(0, index).some((item) => !item.content.trim())) { toast.warn(translate('scriptDesk.finishEarlier')); return }
  const existing = parsed.episodes[index]?.content.trim() || ''
  const snapshot = markdown.value
  if (existing && !await confirmAction(translate('scriptDesk.replaceEpisode', { number: index + 1 }))) return
  if (activeId.value !== id || markdown.value !== snapshot || episodeWriting.value) return
  const prior = parsed.episodes.slice(0, index).map((ep, i) => `Episode ${i + 1}: ${ep.title}\n${ep.content}`).join('\n\n')
  writingPhase.value = 'episode'
  const controller = startWriting()
  addWritingMessage(id, { role: 'assistant', content: translate('scriptDesk.writingStarted', { number: index + 1, title: episode.title }), episode: index, time: Date.now() })
  try {
    const resp = await callLLM({ model: llmModel.value, disableThinking: true, temperature: 0.6, useProviderOutputLimit: true, timeoutMs: 300_000, signal: controller.signal,
      messages: [
        { role: 'system', content: `${importedDirectorPrefix()}${SHORT_DRAMA_WRITING_RULES}\nWrite the complete requested episode in natural Korean. Follow the approved outline and completed episodes. Carry forward relationships, time, location, props and unresolved conflicts. Preserve supplied dialogue and visible text unless the user requests changes. Edit only this episode.\n${SCREENPLAY_FORMAT_RULES}\n${scriptReferenceBrief(settings.config.scriptReferenceType, plan.brief, plan.outline, episode.summary)}` },
        { role: 'user', content: `Writing brief: ${plan.brief}\nApproved outline: ${plan.outline}\nFull episode directory: ${JSON.stringify(plan.episodes)}\nCompleted episodes${prior.length > 30000 ? ' (recent excerpt; refer to the outline for earlier episodes)' : ''}：\n${prior.slice(-30000) || '(first episode)'}\nEpisode to write: ${index + 1} · ${episode.title}\nEpisode goal: ${episode.summary}\n${existing ? `Existing episode to replace: \n${existing}` : ''}` }
      ] })
    assertScriptCompletion(resp)
    const body = normalizeScreenplayBody(String(resp.content || ''))
    if (!body) throw new Error(translate('scriptDesk.emptyResponse'))
    if (controller.signal.aborted || activeId.value !== id || markdown.value !== snapshot) throw new Error(translate('scriptDesk.documentChanged'))
    if (index === parsed.episodes.length) parsed.episodes.push({ title: episode.title, content: body })
    else parsed.episodes[index] = { title: episode.title, content: body }
    const updated = serializeScriptDoc(parsed)
    await scripts.setContent(id, updated)
    markdown.value = updated
    syncDraft(index)
    dirty.value = false
    const reviewPlan: StoryPlan = { ...plan, stage: 'episode-review' }
    try {
      await saveStoryPlan(id, reviewPlan)
    } catch {
      if (activeId.value === id) storyPlan.value = reviewPlan
      toast.warn(translate('scriptDesk.progressSaveFailed'))
    }
    addWritingMessage(id, { role: 'assistant', content: translate('scriptDesk.reviewEpisode', { number: index + 1 }), episode: index, time: Date.now() })
  } catch (error: any) {
    const message = controller.signal.aborted ? translate('scriptDesk.episodeCanceled') : translate('scriptDesk.episodeFailedReason', { reason: error?.message || translate('scriptDesk.retry') })
    if (activeId.value === id) addWritingMessage(id, { role: 'assistant', content: message, episode: index, time: Date.now() })
    toast.warn(message)
  } finally { finishWriting() }
}

async function confirmStoryPlan() {
  const plan = storyPlan.value
  if (!plan || !activeId.value || episodeWriting.value) return
  if (!plan.outline.trim() || plan.episodes.some((episode) => !episode.title.trim() || !episode.summary.trim())) { toast.warn(translate('scriptDesk.completeOutline')); return }
  try {
    await saveStoryPlan(activeId.value, { ...plan, stage: 'ready', nextIndex: 0 })
    planEditing.value = false
    episodeHint.value = ''
    await writePlannedEpisode()
  } catch (error: any) { toast.error(error?.message || translate('scriptDesk.outlineSaveFailed')) }
}

async function savePlanDraft() {
  if (!storyPlan.value || !activeId.value || episodeWriting.value) return
  try {
    await saveStoryPlan(activeId.value, { ...storyPlan.value, episodes: storyPlan.value.episodes.map((item) => ({ ...item })) })
    toast.success(translate('scriptDesk.outlineSaved'))
  } catch (error: any) { toast.error(error?.message || translate('scriptDesk.outlineSaveFailed')) }
}

async function confirmEpisodeAndContinue() {
  const plan = storyPlan.value
  const id = activeId.value
  if (!plan || !id || episodeWriting.value || plan.stage !== 'episode-review') return
  if (draft.value && draft.value.index !== plan.nextIndex) { toast.warn(translate('scriptDesk.inspectEpisode', { number: plan.nextIndex + 1 })); return }
  if (!draft.value?.content.trim()) { toast.warn(translate('scriptDesk.episodeEmpty')); return }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  markdown.value = updateEpisode(markdown.value, draft.value.index, { title: draft.value.title, content: draft.value.content })
  try {
    await scripts.setContent(id, markdown.value)
    dirty.value = false
    episodeHint.value = ''
    const nextIndex = plan.nextIndex + 1
    if (nextIndex >= plan.episodes.length) {
      await saveStoryPlan(id, { ...plan, nextIndex, stage: 'complete' })
      addWritingMessage(id, { role: 'assistant', content: translate('scriptDesk.allDone'), episode: -1, time: Date.now() })
      return
    }
    await saveStoryPlan(id, { ...plan, nextIndex, stage: 'ready' })
    await writePlannedEpisode()
  } catch (error: any) { toast.error(error?.message || translate('scriptDesk.saveFailed')) }
}

function obviousWriterChat(hint: string) {
  const text = hint.trim()
  return /^(?:你好|您好|嗨|hi|hello|hey|在吗|在不在|谢谢|谢了|辛苦了?|哈哈+|嗯+|哦+|啊+|好的|好呀|早安|晚安|你是谁|你能干什么|你能做什么|안녕|안녕하세요|고마워요|감사해요|감사합니다|누구세요|잘 지냈어요)[\s!！。.~～?？]*$/i.test(text)
    || /^(?:先别写|别写了|先不要写|等一下|等会儿|暂停|不用了|算了|잠깐|잠시만요|멈춰 주세요|아직 쓰지 마세요)[\s!！。]*$/.test(text)
}

async function classifyWriterIntent(hint: string, signal: AbortSignal): Promise<'chat' | 'write'> {
  if (obviousWriterChat(hint)) return 'chat'
  try {
    const resp = await callLLM({
      model: llmModel.value,
      disableThinking: true,
      temperature: 0,
      timeoutMs: 20_000,
      signal,
      messages: [
        {
          role: 'system',
          content: 'Classify the request as chat or write. Return only that word. Use chat for greetings, questions, critiques, progress discussion and requests to pause. Mentioning the script or episode does not authorize changes. Use write only for a clear request to create or edit a script, outline, dialogue or plot.'
        },
        { role: 'user', content: hint }
      ]
    })
    return /^write\b/i.test(String(resp.content || '').trim()) ? 'write' : 'chat'
  } catch (error: any) {
    if (signal.aborted) throw error
    return /(?:请|帮我|把).{0,12}(?:写|改|续)|^(?:写|改|续|扩|润色|重写|生成|创作|补)|써 주세요|다듬어 주세요|고쳐 주세요|작성해 주세요|이어 써/.test(hint) ? 'write' : 'chat'
  }
}

async function replyAsWriter(hint: string) {
  const id = activeId.value
  const current = draft.value
  if (!id || !current || !llmModel.value) return
  writingPhase.value = 'chat'
  const controller = startWriting()
  addWritingMessage(id, { role: 'user', content: hint, episode: current.index, time: Date.now() })
  const recent = writingMessages.value
    .filter((message) => message.episode === current.index || message.episode < 0)
    .slice(-8)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}：${message.content}`)
    .join('\n')
  const plan = storyPlan.value
  try {
    const resp = await callLLM({
      model: llmModel.value,
      disableThinking: true,
      temperature: 0.5,
      timeoutMs: 60_000,
      signal: controller.signal,
      messages: [
        {
          role: 'system',
          content: 'Answer as a screenwriting assistant in brief, natural Korean using the polite conversational register. Discuss characters, plot or progress, or respond to a greeting. Only edit a script when explicitly requested. Never claim to have written into an episode from chat.'
        },
        {
          role: 'user',
          content: `Script: ${activeDoc.value?.title || 'Untitled script'}\nCurrent episode: ${current.index + 1} · ${current.title}\nWriting progress: ${plan ? plan.stage : 'No series outline'}\nExisting excerpt: \n${current.content.trim().slice(0, 800) || '(empty)'}\nRecent conversation: \n${recent || '(none)'}\n\nCurrent message: ${hint}`
        }
      ]
    })
    const text = String(resp.content || '').trim()
    if (controller.signal.aborted || activeId.value !== id) return
    addWritingMessage(id, {
      role: 'assistant',
      content: text || translate('scriptDesk.assistantFallback'),
      episode: current.index,
      time: Date.now()
    })
    episodeHint.value = ''
  } catch (error: any) {
    if (activeId.value === id) {
      addWritingMessage(id, {
        role: 'assistant',
        content: controller.signal.aborted ? translate('scriptDesk.canceled') : translate('scriptDesk.responseFailed', { reason: error?.message || translate('scriptDesk.sendAgain') }),
        episode: current.index,
        time: Date.now()
      })
    }
  } finally {
    finishWriting()
  }
}

async function writeCurrentEpisode() {
  if (!draft.value || episodeWriting.value) return
  if (!llmModel.value) {
    toast.warn(translate('scripts.needModel'))
    return
  }
  const hint = episodeHint.value.trim()
  const existing = draft.value.content.trim()
  if (writingHistoryLoading.value) { toast.warn(translate('scriptDesk.loadingMessages')); return }
  if (storyPlan.value?.stage === 'outline-review' && /^\s*(?:确认|通过|开始写|可以|下一步|확인|좋아요|작성 시작|다음 단계)\s*[。！!]*$/.test(hint)) { await confirmStoryPlan(); return }
  if (storyPlan.value?.stage === 'episode-review' && /^\s*(?:确认|通过|继续|下一集|可以|下一步|확인|좋아요|계속|다음 화|다음 단계)\s*[。！!]*$/.test(hint)) { await confirmEpisodeAndContinue(); return }
  if (hint) {
    writingPhase.value = 'chat'
    const controller = startWriting()
    let turn: 'chat' | 'write' = 'chat'
    try {
      turn = await classifyWriterIntent(hint, controller.signal)
    } catch {
      finishWriting()
      return
    }
    finishWriting()
    if (turn === 'chat') {
      await replyAsWriter(hint)
      return
    }
  }
  if (storyPlan.value?.stage === 'outline-review' && hint && writingMode.value !== 'episode') { await writeStoryPlan(hint, true); return }
  const wantsSeries = writingMode.value === 'series' || (writingMode.value === 'auto' && (/(?:整部|整剧|全集|分集大纲|分集目录|多集|시리즈|전체 대본|전체 개요|회차별 개요)|(?:写|创作|策划|生成).{0,30}(?:短剧|剧本)(?!.*(?:本集|这一集|当前集))/.test(hint) || (!existing && /题材|科幻|悬疑|古装|都市|甜宠|穿越|重生|家庭伦理/.test(hint) && !/本集|这一集|当前集/.test(hint))))
  if (wantsSeries && hint) {
    const active = activeId.value
    if (storyPlan.value && !await confirmAction(translate('scriptDesk.replaceOutline'))) return
    if (activeId.value !== active || episodeWriting.value) return
    await writeStoryPlan(hint)
    return
  }
  if (!hint && !existing) {
    toast.warn(translate('scriptDesk.requestFirst'))
    return
  }
  const conversation = writingMessages.value.filter((message) => message.episode === draft.value?.index && message.role === 'user').slice(-6)
  episodeWriting.value = true
  writingPhase.value = 'episode'
  episodeElapsed.value = 0
  episodeTimer = setInterval(() => { episodeElapsed.value++ }, 1000)
  episodeAbort = new AbortController()
  const targetDocId = activeDoc.value?.id
  const targetDraft = draft.value
  if (targetDocId) addWritingMessage(targetDocId, { role: 'user', content: hint || translate('scriptDesk.completeEpisode'), episode: targetDraft.index, time: Date.now() })
  try {
    const resp = await callLLM({
      model: llmModel.value,
      disableThinking: true,
      useProviderOutputLimit: true,
      timeoutMs: 300_000,
      temperature: 0.7,
      signal: episodeAbort.signal,
      messages: [
        {
          role: 'system',
          content:
            `${importedDirectorPrefix()}${SHORT_DRAMA_WRITING_RULES}\nWrite only the requested episode script in natural Korean. Preserve supplied dialogue unless the user asks to revise it. Omit commentary and introductory notes.\n${SCREENPLAY_FORMAT_RULES}\n${scriptReferenceBrief(settings.config.scriptReferenceType, activeDoc.value?.title, draft.value.title, existing, hint)}`
        },
        {
          role: 'user',
          content: `Script: ${activeDoc.value?.title || 'Untitled script'}\nEpisode: ${draft.value.title}\nPrevious directions for context only. Prioritize the current request: \n${conversation.map((item) => item.content).join('\n') || '(none)'}\nExisting body: \n${existing || '(empty)'}\n\nCurrent request: ${hint || 'Complete this episode while preserving the existing events.'}`
        }
      ]
    })
    assertScriptCompletion(resp)
    const text = normalizeScreenplayBody(String(resp.content || ''))
    if (!text) throw new Error(translate('scriptDesk.noContent'))
    if (episodeAbort.signal.aborted) throw new Error(translate('scriptDesk.canceledShort'))
    if (activeDoc.value?.id !== targetDocId || draft.value !== targetDraft) {
      toast.warn(translate('scriptDesk.changedDuringWriting'))
      return
    }
    draft.value.content = text
    if (targetDocId) addWritingMessage(targetDocId, { role: 'assistant', content: translate('scriptDesk.episodeWritten'), episode: targetDraft.index, time: Date.now() })
    episodeHint.value = ''
    scheduleFlush()
    toast.success(translate('scriptDesk.episodeSuccess'))
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    if (episodeAbort?.signal.aborted) toast.warn(translate('scriptDesk.canceledShort'))
    else toast.error(msg || translate('scriptDesk.episodeFailed'))
    if (targetDocId && activeId.value === targetDocId) addWritingMessage(targetDocId, { role: 'assistant', content: episodeAbort?.signal.aborted ? translate('scriptDesk.writingCanceled') : translate('scriptDesk.writingIncomplete', { reason: msg || translate('scriptDesk.retry') }), episode: targetDraft.index, time: Date.now() })
  } finally {
    if (episodeTimer) clearInterval(episodeTimer)
    episodeTimer = undefined
    episodeWriting.value = false
    episodeAbort = null
  }
}

function cancelEpisodeWrite() {
  episodeAbort?.abort()
}

async function importScript() {
  let picked: { text: string; filename: string } | null = null
  try {
    picked = await pickScriptFile()
  } catch (e: any) {
    toast.error(e?.message ?? translate('scriptDesk.importFailed'))
    return
  }
  if (!picked) return
  try {
    const doc = await scripts.importMarkdown(picked.text, picked.filename)
    activeId.value = doc.id
    titleEditing.value = doc.title
    detailOpen.value = true
    await loadContent(doc.id, true)
    toast.success(translate('scripts.imported', { p0: doc.title }))
  } catch (e: any) {
    toast.error(e?.message ?? translate('common.importFailed'))
  }
}

async function downloadActive() {
  if (!activeId.value) return
  const ok = await scripts.download(activeId.value)
  if (ok) toast.success(translate('common.markdownExported'))
}

async function revealActive() {
  if (!activeId.value) return
  const ok = await scripts.revealFile(activeId.value)
  if (!ok) toast.warn(translate('scripts.desktopOnly'))
}

async function reloadFromDisk() {
  if (!activeId.value) return
  if (dirty.value && !(await confirmDiscard())) return
  await scripts.reloadFromDisk(activeId.value)
  draft.value = null
  await loadContent(activeId.value, true)
  toast.success(translate('scripts.loadedFromDisk'))
}

async function applyToProject() {
  flushDraft()
  await persistQuiet()
  if (!activeDoc.value || !markdown.value.trim()) {
    toast.warn(translate('common.emptyScriptContent'))
    return
  }
  if (!project.current) {
    toast.warn(translate('common.chooseProjectFirst'))
    return
  }
  const doc = activeDoc.value
  const prev = project.current.script
  project.setScript({
    id: prev?.id ?? `s_${Date.now().toString(36)}`,
    topic: doc.title,
    content: markdown.value.trim(),
    keywords: prev?.keywords ?? [],
    style: prev?.style ?? 'cinematic',
    aspectRatio: prev?.aspectRatio ?? project.current.settings.aspectRatio,
    shotDuration: prev?.shotDuration ?? project.current.settings.defaultShotDuration ?? 5,
    playReady: true,
    createdAt: prev?.createdAt ?? Date.now()
  })
  project.applyPlayTitle(doc.title)
  project.setPlayApproved(false)
  await project.save()
  toast.success(translate('scripts.sentToProject'))
  router.push('/studio')
}

async function removeActive() {
  const doc = activeDoc.value
  if (!doc) return
  if (!await confirmAction(translate('common.deleteNamedScript', { p0: doc.title }))) return
  await scripts.remove(doc.id)
  activeId.value = ''
  markdown.value = ''
  draft.value = null
  dirty.value = false
  detailOpen.value = false
  toast.success(translate('common.deleted'))
}

function copyMarkdown() {
  navigator.clipboard.writeText(markdown.value).then(
    () => toast.success(translate('scripts.copiedFull')),
    () => toast.error(translate('common.copyFailed'))
  )
}

watch(
  () => activeDoc.value?.title,
  (t) => {
    if (t) titleEditing.value = t
  }
)

watch(activeTab, (tab) => {
  if (tab === 'episodes') syncDraft(activeEpisodeIndex.value)
})

onBeforeUnmount(() => {
  episodeAbort?.abort()
  if (episodeTimer) clearInterval(episodeTimer)
  if (saveTimer) clearTimeout(saveTimer)
  flushDraft()
})

onMounted(async () => {
  await scripts.refresh()
  const pid = project.current?.id
  const prefer = pid ? scripts.docs.find((d) => d.projectId === pid) : undefined
  const first = prefer ?? scripts.docs[0]
  if (first) {
    activeId.value = first.id
    titleEditing.value = first.title
    await loadContent(first.id)
  }
})
</script>

<template>
  <div class="page" :class="{ detail: detailOpen, resizing: resizingPane }">
    <header v-if="!detailOpen" class="page-head">
      <div>
        <div class="kicker">{{ $t('scriptDesk.writing') }}</div>
        <h1>{{ detailOpen ? activeDoc?.title || $t('studioUpdate.scriptEntry') : $t('studioUpdate.scriptProjects') }}</h1>
        <p v-if="!detailOpen">
          {{ $t('scriptDesk.libraryHint') }}
        </p>
      </div>
      <div class="head-actions">
        <GradientButton type="ghost" @click="router.push('/')">{{ $t('drafts.home') }}</GradientButton>
        <GradientButton v-if="detailOpen" type="ghost" @click="backToLibrary">{{ $t('scriptDesk.back') }}</GradientButton>
        <GradientButton type="ghost" @click="router.push('/drafts')">{{ $t('studioUpdate.resources') }}</GradientButton>
        <GradientButton type="secondary" :title="$t('scriptDesk.importFormats')" @click="importScript">
          <template #icon>
            <svg class="import-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.25 10.25v1.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-1.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M8 2.75v6.1" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
              <path d="M5.35 6.55 8 9.2l2.65-2.65" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </template>
          {{ $t('scriptDocNode.import') }}
        </GradientButton>
        <GradientButton icon="＋" @click="createScript">{{ $t('common.newScript') }}</GradientButton>
      </div>
    </header>

    <div v-if="!detailOpen" class="library-tools">
      <input v-model="keyword" class="search" :placeholder="$t('scripts.search')" />
    </div>
    <div v-if="!detailOpen" class="library">
      <div v-if="!filteredDocs.length" class="empty-mini">
        {{ $t('scriptDesk.noScripts') }}
      </div>
      <button
        v-for="d in filteredDocs"
        :key="d.id"
        class="script-card"
        @click="openScript(d.id)"
      >
        <div class="si-title">{{ d.title }}</div>
        <div class="si-meta">
          <Tag size="sm">{{ sourceLabel(d.source) }}</Tag>
          {{ $t('scriptDesk.counts', { episodes: d.episodeCount, words: d.totalWords }) }}
        </div>
        <div class="si-time">{{ fmtTime(d.updatedAt) }}</div>
      </button>
    </div>

    <div v-else class="sc-page">
      <header class="sc-head">
        <div class="sc-head-copy">
          <span class="sc-kicker">{{ $t('scriptDesk.workspace') }}</span>
          <input class="sc-h1" :value="draft?.title || ''" :aria-label="$t('scriptDesk.episodeTitle')" @input="draft && onTitleInput(draft.index, $event)" />
          <p>{{ $t('scriptDesk.formatHint') }}</p>
        </div>
        <div class="sc-head-actions">
          <button type="button" class="nb-btn ghost" @click="backToLibrary">{{ $t('scriptDesk.backToLibrary') }}</button>
          <span class="savechip" :class="{ dirty }"><i />{{ savedLabel }}</span>
          <button type="button" class="nb-btn" @click="downloadActive">
            <svg viewBox="0 0 24 24"><path d="M12 16V4M8 8l4-4 4 4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
            {{ $t('scriptDesk.exportMarkdown') }}
          </button>
          <button type="button" class="nb-btn primary" @click="applyToProject">
            <svg viewBox="0 0 24 24"><path d="M12 3v5M12 16v5M3 12h5M16 12h5M6.3 6.3l3 3M14.7 14.7l3 3M17.7 6.3l-3 3M9.3 14.7l-3 3"/></svg>
            {{ $t('scriptDesk.storyboard') }}
          </button>
        </div>
      </header>
      <div class="sc-cols">
      <aside class="sc-lib">
        <div class="sc-lib-head">
          <span class="sc-panel-title"><i />{{ $t('common.scriptLibrary') }}</span>
          <button type="button" class="sc-icon" :title="$t('common.newScript')" @click="createScript">
            <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
        <div class="sc-lib-search">
          <input v-model="titleEditing" :aria-label="$t('scriptDesk.scriptName')" @change="commitTitle" @keydown.enter.prevent="commitTitle" />
        </div>
        <div class="sc-lib-body">
          <div class="sc-sec-t">{{ $t('scriptDesk.currentSeries', { title: activeDoc?.title }) }}</div>
          <template v-for="(ep, i) in episodes" :key="ep.id">
            <button type="button" class="sc-ep" :class="{ on: activeEpisodeIndex === i }" @click="openEpisode(i)">
              <svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>
              <span>{{ ep.title }}</span>
              <b>{{ ep.wordCount }}</b>
            </button>
              <button
              v-for="scene in activeEpisodeIndex === i ? scenesIn(draft && draft.index === i ? draft.content : ep.content) : []"
              :key="scene"
              type="button"
              class="sc-kid"
            >
              <span>{{ scene }}</span>
            </button>
          </template>
          <div v-if="otherDocs.length" class="sc-sec-t">{{ $t('scriptDesk.otherScripts') }}</div>
          <button v-for="doc in otherDocs" :key="doc.id" type="button" class="sc-other" @click="openScript(doc.id)">
            <span>{{ doc.title }}</span>
            <b>{{ $t('scriptDesk.episodesOnly', { count: doc.episodeCount }) }}</b>
          </button>
        </div>
        <div class="sc-lib-foot">
          <button type="button" class="nb-btn block" @click="addEpisode">
            <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
            {{ $t('scriptDesk.newChapter') }}
          </button>
          <div class="sc-lib-meta">
            <span>{{ $t('scriptDesk.seriesStats', { episodes: episodes.length, words: totalWords }) }}</span>
            <button type="button" class="sc-danger-text" @click="removeActive">{{ $t('scriptDesk.deleteScript') }}</button>
          </div>
        </div>
      </aside>
      <section v-if="activeDoc && draft" class="sc-mid">
        <div class="sc-toolbar">
          <div class="sc-seg">
            <button type="button" :class="{ on: scriptMode === 'source' }" @click="scriptMode = 'source'">{{ $t('scriptDesk.source') }}</button>
            <button type="button" :class="{ on: scriptMode === 'preview' }" @click="scriptMode = 'preview'">{{ $t('scriptDesk.preview') }}</button>
          </div>
          <i class="sc-vdiv" />
          <button type="button" class="sc-icon" :title="$t('scriptDesk.undo')" @click="editCommand('undo')">
            <svg viewBox="0 0 24 24"><path d="M4 9h10a5 5 0 0 1 0 10h-3"/><path d="m4 9 4-4M4 9l4 4"/></svg>
          </button>
          <button type="button" class="sc-icon" :title="$t('scriptDesk.redo')" @click="editCommand('redo')">
            <svg viewBox="0 0 24 24"><path d="M20 9H10a5 5 0 0 0 0 10h3"/><path d="m20 9-4-4M20 9l-4 4"/></svg>
          </button>
          <i class="sc-vdiv" />
          <button type="button" class="nb-btn sm" @click="addEpisode">{{ $t('scriptDesk.insertEpisode') }}</button>
          <button type="button" class="nb-btn sm" :disabled="draft.index === 0" @click="moveEpisode(draft.index, -1)">{{ $t('common.moveUp') }}</button>
          <button type="button" class="nb-btn sm" :disabled="draft.index === episodes.length - 1" @click="moveEpisode(draft.index, 1)">{{ $t('common.moveDown') }}</button>
          <button type="button" class="nb-btn sm danger" @click="removeEpisode(draft.index)">{{ $t('scriptDesk.deleteEpisode') }}</button>
          <span class="sc-toolbar-meta">{{ $t('scriptDesk.sceneStats', { words: episodeChars, scenes: scenesIn(draft.content).length }) }}</span>
        </div>
        <div class="episode-editor">
            <div class="episode-body-wrap" :class="{ preview: scriptMode === 'preview' }" :aria-busy="episodeWriting">
              <pre
                ref="scriptPaintEl"
                class="script-paint"
                :class="{ empty: !draft.content }"
                aria-hidden="true"
                v-html="draft.content ? scriptPaint : $t('scriptDesk.writingPlaceholder')"
              />
              <textarea
                ref="scriptInputEl"
                v-model="draft.content"
                class="episode-body"
                spellcheck="false"
                :readonly="episodeWriting || scriptMode === 'preview'"
                @input="scheduleFlush(); readCaret()"
                @scroll="syncScriptScroll"
                @click="readCaret"
                @keyup="readCaret"
              />
              <div v-if="episodeWriting && writingPhase !== 'chat'" class="episode-writing-overlay" role="status" aria-live="polite">
                <span class="episode-writing-spinner" aria-hidden="true" />
                <strong>{{ writingPhase === 'outline' ? $t('scriptDesk.outlining') : $t('scriptDesk.writingEpisode') }}</strong>
                <span>{{ $t('scriptDesk.elapsed', { seconds: episodeElapsed }) }} · {{ writingPhase === 'outline' ? $t('scriptDesk.reviewAfter') : $t('scriptDesk.insertAfter') }}</span>
                <button type="button" class="mini-btn" @click="cancelEpisodeWrite">{{ $t('scripts.cancelGeneration') }}</button>
              </div>
            </div>
          </div>
          <div class="sc-status">
            <span>{{ $t('scriptDesk.caret', { line: caret.line, column: caret.col }) }}</span>
            <span>{{ $t('scriptDesk.characters', { count: episodeChars }) }}</span>
            <span>Markdown · {{ activeDoc.filename }}</span>
          </div>
      </section>
      <aside v-if="activeDoc && draft" class="sc-ai" :aria-label="$t('scriptDesk.writer')">
        <header class="sc-ai-head">
          <span class="sc-panel-title ai"><i />{{ $t('scriptDesk.writer') }}</span>
          <span class="sc-badge">{{ llmModel || $t('studioSettings.noModel') }}</span>
        </header>
        <div ref="writingList" class="writing-history" aria-live="polite">
          <div class="writing-message assistant"><span>{{ $t('scriptDesk.writerShort') }}</span><p>{{ $t('scriptDesk.writerIntro') }}</p></div>
          <p v-if="writingHistoryLoading" class="writing-note">{{ $t('scriptDesk.loadingHistory') }}</p>
          <p v-if="writingHistoryError" class="writing-note">{{ $t('scriptDesk.historyError') }}</p>
          <div v-for="(message, i) in writingMessages" :key="`${message.time}-${i}`" class="writing-message" :class="message.role">
            <span>{{ message.role === 'user' ? $t('scriptDesk.you') : $t('scriptDesk.writerShort') }}<template v-if="message.episode >= 0"> · {{ $t('scriptDesk.episodesOnly', { count: message.episode + 1 }) }}</template></span>
            <p>{{ message.content }}</p>
          </div>
          <div v-if="episodeWriting" class="writing-message assistant writing-pending" role="status">
            <span>{{ $t('scriptDesk.writerShort') }}</span><p><i class="writing-pulse" /> {{ writingPhase === 'outline' ? $t('scriptDesk.outliningShort') : writingPhase === 'chat' ? $t('scriptDesk.replying') : $t('scriptDesk.writingShort') }}{{ uiPunctuation.comma }}{{ $t('scriptDesk.elapsed', { seconds: episodeElapsed }) }}</p>
          </div>
          <section v-if="storyPlan" class="story-plan">
            <div class="story-plan-heading"><strong>{{ $t('scriptDesk.outlineSize', { count: storyPlan.episodes.length }) }}</strong><button type="button" :disabled="episodeWriting" @click="planEditing = !planEditing">{{ planEditing ? $t('common.collapse') : $t('scriptDesk.viewOutline') }}</button></div>
            <p class="story-plan-status">{{ storyPlan.stage === 'outline-review' ? $t('scriptDesk.awaitOutline') : storyPlan.stage === 'episode-review' ? $t('scriptDesk.awaitEpisode', { number: storyPlan.nextIndex + 1 }) : storyPlan.stage === 'complete' ? $t('scriptDesk.allConfirmed') : $t('scriptDesk.episodeReady', { number: storyPlan.nextIndex + 1 }) }}</p>
            <div v-if="planEditing" class="story-plan-content">
              <label>{{ $t('scriptDesk.outlineAndCast') }}<textarea v-model="storyPlan.outline" :readonly="storyPlan.stage !== 'outline-review' || episodeWriting" rows="7" /></label>
              <label v-for="(episode, index) in storyPlan.episodes" :key="index">{{ $t('scriptDesk.episodesOnly', { count: index + 1 }) }}<input v-model="episode.title" :readonly="storyPlan.stage !== 'outline-review' || episodeWriting" /><textarea v-model="episode.summary" :readonly="storyPlan.stage !== 'outline-review' || episodeWriting" rows="3" /></label>
              <p v-if="storyPlan.stage === 'outline-review'">{{ $t('scriptDesk.editOutlineHint') }}</p>
              <button v-if="storyPlan.stage === 'outline-review'" type="button" class="story-plan-save" :disabled="episodeWriting" @click="savePlanDraft">{{ $t('scriptDesk.saveOutlineDraft') }}</button>
            </div>
            <button v-if="storyPlan.stage === 'outline-review'" type="button" class="story-plan-confirm" :disabled="episodeWriting" @click="confirmStoryPlan">{{ $t('scriptDesk.confirmOutline') }}</button>
            <button v-else-if="storyPlan.stage === 'episode-review'" type="button" class="story-plan-confirm" :disabled="episodeWriting" @click="confirmEpisodeAndContinue">{{ storyPlan.nextIndex + 1 >= storyPlan.episodes.length ? $t('scriptDesk.finishScript') : $t('scriptDesk.nextEpisode') }}</button>
            <button v-else-if="storyPlan.stage === 'ready'" type="button" class="story-plan-confirm" :disabled="episodeWriting" @click="writePlannedEpisode">{{ $t('scriptDesk.continueWriting', { episode: storyPlan.nextIndex + 1 }) }}</button>
          </section>
        </div>
        <div class="writing-compose">
          <div class="sc-acts">
            <button type="button" :disabled="episodeWriting" @click="askWriter($t('scriptDesk.continueRequest'))"><b>{{ $t('scriptDesk.continueScene') }}</b><span>{{ $t('scriptDesk.continueHint') }}</span></button>
            <button type="button" :disabled="episodeWriting" @click="askWriter($t('scriptDesk.rewriteRequest'))"><b>{{ $t('scriptDesk.rewriteScene') }}</b><span>{{ $t('scriptDesk.rewriteHint') }}</span></button>
            <button type="button" :disabled="episodeWriting" @click="askWriter($t('scriptDesk.polishRequest'))"><b>{{ $t('scriptDesk.polishDialogue') }}</b><span>{{ $t('scriptDesk.polishHint') }}</span></button>
            <button type="button" :disabled="episodeWriting" @click="askWriter($t('scriptDesk.shortenRequest'))"><b>{{ $t('scriptDesk.shorten') }}</b><span>{{ $t('scriptDesk.shortenHint') }}</span></button>
          </div>
          <div class="writing-options">
            <label><span>{{ $t('settings.nav.llm.label') }}</span><select v-model="genChoice" :disabled="episodeWriting" :aria-label="$t('settings.nav.llm.label')">
              <option v-if="!llmGroups.some((g) => g.models.length)" value="">{{ $t('common.noModel') }}</option>
              <optgroup v-for="g in llmGroups" :key="g.id" :label="g.name"><option v-for="m in g.models" :key="`${g.id}::${m}`" :value="`${g.id}::${m}`">{{ m }}</option></optgroup>
            </select></label>
            <label><span>{{ $t('scriptDesk.writingLibrary') }}</span><select v-model="scriptReferenceType" :disabled="episodeWriting" :aria-label="$t('scriptDesk.selectWritingLibrary')">
              <option v-for="item in SCRIPT_REFERENCE_OPTIONS" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select></label>
          </div>
          <label class="writing-mode"><span>{{ $t('scriptDesk.writingMode') }}</span><select v-model="writingMode" :disabled="episodeWriting"><option value="auto">{{ $t('scriptDesk.auto') }}</option><option value="series">{{ $t('scriptDesk.series') }}</option><option value="episode">{{ $t('scriptDesk.singleEpisode') }}</option></select></label>
          <textarea v-model="episodeHint" class="writing-input" :placeholder="$t('scriptDesk.askPlaceholder')" :disabled="episodeWriting" @keydown.ctrl.enter.prevent="writeCurrentEpisode" />
          <div class="writing-actions"><span>{{ $t('scriptDesk.sendHint') }}</span><button v-if="episodeWriting" class="writing-send cancel" type="button" @click="cancelEpisodeWrite">{{ $t('scripts.cancelGeneration') }}</button><button v-else class="writing-send" type="button" :disabled="writingHistoryLoading" @click="writeCurrentEpisode">{{ $t("common.send") }}</button></div>
        </div>
      </aside>
      </div>
    </div>

  </div>
</template>

<style scoped>
.page {
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  background: var(--nb-bg-0);
  color: var(--nb-t1);
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.kicker {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--color-text-4);
  margin-bottom: 4px;
}
.page-head h1 {
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.02em;
  margin: 0 0 6px;
  color: var(--color-text-1);
}
.page-head p {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-3);
  max-width: 640px;
  line-height: 1.6;
}
.head-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.import-icon {
  display: block;
  width: 14px;
  height: 14px;
}
.head-actions :deep(.grad-btn) {
  border-radius: 4px;
  box-shadow: none;
  font-weight: 550;
}
.head-actions :deep(.type-primary) {
  background: var(--nb-accent);
  color: var(--nb-accent-ink);
}
.head-actions :deep(.type-primary:hover:not(:disabled)) {
  background: #67e4fb;
}
.head-actions :deep(.type-secondary),
.head-actions :deep(.type-ghost) {
  background: transparent;
  border-color: transparent;
  color: #b7b7bc;
}
.head-actions :deep(.type-secondary:hover:not(:disabled)),
.head-actions :deep(.type-ghost:hover:not(:disabled)) {
  background: var(--nb-bg-4);
  color: #eee;
}

.page.detail {
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding: 0;
  gap: 0;
  background:
    radial-gradient(900px 480px at 18% -8%, rgba(53, 214, 247, 0.07), transparent 62%),
    var(--nb-bg-0);
}
.page.detail .page-head { align-items: center; gap: 8px; }
.page.detail .page-head > div:first-child { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.page.detail .kicker { margin: 0; white-space: nowrap; letter-spacing: 0; }
.page.detail .page-head h1 { margin: 0; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.page.detail .head-actions { gap: 6px; }
.page.detail .head-actions :deep(button) { min-height: 32px; padding: 5px 11px; font-size: 12px; }
.library-tools {
  display: flex;
}
.library-tools .search {
  width: min(360px, 100%);
}
.library {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  align-content: start;
}
.script-card {
  text-align: left;
  padding: 14px 14px 12px;
  border-radius: 4px;
  border: none;
  background: var(--nb-bg-2);
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 104px;
  cursor: pointer;
}
.script-card:hover {
  background: var(--nb-bg-3);
}
.script-card :deep(.tag) {
  border-radius: 3px;
  background: var(--nb-bg-4);
  color: #b7b7bc;
}
.workspace {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 0;
}
.pane-resizer {
  flex: 0 0 8px;
  margin: 0 -2px;
  cursor: col-resize;
  position: relative;
  z-index: 2;
  touch-action: none;
}
.pane-resizer::after {
  content: '';
  position: absolute;
  top: 12px;
  bottom: 12px;
  left: 3px;
  width: 1px;
  background: transparent;
}
.pane-resizer:hover::after,
.page.resizing .pane-resizer::after {
  background: rgba(255, 255, 255, 0.16);
}
.page.resizing {
  cursor: col-resize;
  user-select: none;
}
.ep-side {
  flex: none;
  min-height: 0;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0 8px 0 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ep-item {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: 8px;
  width: 100%;
  text-align: left;
  padding: 7px 8px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: #d8d8dc;
  cursor: pointer;
}
.ep-item:hover { background: var(--nb-bg-3); color: var(--nb-t1); }
.ep-item.active {
  background: var(--nb-accent-soft);
  color: var(--nb-accent);
}
.writing-agent {
  flex: none;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: none;
  border-radius: 0;
  background: transparent;
  padding-left: 8px;
}
.writing-agent-head { display: flex; align-items: center; gap: 10px; padding: 4px 2px 12px; border-bottom: none; }
.writing-agent-head strong { color: var(--nb-t1); font-size: 13px; font-weight: 600; }
.writing-agent-head p { margin: 2px 0 0; color: var(--nb-t3); font-size: 11px; }
.writing-agent-icon { display: grid; place-items: center; flex: 0 0 22px; height: 22px; border-radius: 4px; color: var(--nb-t2); background: var(--nb-bg-4); font-size: 13px; }
.writing-history { flex: 1; min-height: 120px; overflow-y: auto; padding: 8px 2px 12px; display: flex; flex-direction: column; gap: 12px; }
.writing-message { max-width: 96%; align-self: flex-start; min-width: 0; }
.writing-message.user { align-self: flex-end; }
.writing-message > span { display: block; margin: 0 2px 4px; color: var(--nb-t3); font-size: 11px; }
.writing-message.user > span { text-align: right; }
.writing-message p { margin: 0; padding: 8px 10px; border: 1px solid var(--nb-line-2); border-radius: 4px; background: var(--nb-bg-2); color: var(--nb-t1); font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; white-space: pre-wrap; }
.writing-message.user p { border: 1px solid var(--nb-line-accent); border-radius: 4px; background: var(--nb-accent-soft); color: var(--nb-t1); }
.writing-note { margin: 0; color: var(--nb-t3); font-size: 12px; }
.writing-compose { padding: 10px 0 0; border-top: none; }
.story-plan { padding: 10px; border: 1px solid var(--nb-line-2); border-radius: 4px; background: var(--nb-bg-3); }
.story-plan-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: var(--nb-t1); font-size: 12px; }
.story-plan-heading button { border: 0; background: transparent; color: var(--nb-t2); cursor: pointer; font-size: 11px; }
.story-plan-status { margin: 6px 0; color: var(--nb-t3); font-size: 11px; }
.story-plan-content { display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow: auto; margin: 8px 0; }
.story-plan-content label { display: flex; flex-direction: column; gap: 4px; color: var(--nb-t2); font-size: 11px; }
.story-plan-content textarea, .story-plan-content input, .writing-mode select { width: 100%; box-sizing: border-box; padding: 7px 8px; border: 1px solid var(--nb-line-2); border-radius: 4px; background: var(--nb-bg-inset); color: var(--nb-t1); font: inherit; line-height: 1.5; }
.story-plan-content textarea { resize: vertical; }
.story-plan-content p { margin: 0; color: var(--nb-t3); font-size: 11px; line-height: 1.5; }
.story-plan-confirm { width: 100%; padding: 8px; border: none; border-radius: 6px; background: var(--nb-accent); color: var(--nb-accent-ink); cursor: pointer; font-size: 12px; font-weight: 650; }
.story-plan-confirm:hover:not(:disabled) { background: #67e4fb; }
.story-plan-confirm:disabled { opacity: .5; cursor: default; }
.story-plan-save { align-self: flex-start; padding: 5px 8px; border: 1px solid var(--nb-line-2); border-radius: 4px; background: var(--nb-bg-2); color: var(--nb-t1); cursor: pointer; font-size: 11px; }
.writing-mode { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; color: var(--nb-t2); font-size: 11px; }
.writing-mode span { flex-shrink: 0; }
.writing-mode select { height: 32px; padding: 0 8px; background: var(--nb-bg-inset); color: var(--nb-t1); }
.writing-options { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
.writing-options label { display: flex; min-width: 0; flex-direction: column; gap: 4px; color: var(--nb-t2); font-size: 11px; }
.writing-options select { width: 100%; min-width: 0; height: 32px; padding: 0 8px; border: 1px solid var(--nb-line-2); border-radius: 4px; background: var(--nb-bg-inset); color: var(--nb-t1); font-size: 11px; }
.writing-input { display: block; width: 100%; min-height: 78px; box-sizing: border-box; resize: vertical; padding: 8px 10px; border: 1px solid var(--nb-line-2); border-radius: 4px; outline: none; background: var(--nb-bg-inset); color: var(--nb-t1); font: inherit; font-size: 12px; line-height: 1.6; }
.writing-input:focus { background: var(--nb-bg-2); }
.writing-input::placeholder { color: var(--nb-t4); }
.writing-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
.writing-actions > span { color: var(--nb-t3); font-size: 10px; }
.writing-send { padding: 7px 12px; border: 0; border-radius: 6px; background: var(--nb-accent); color: var(--nb-accent-ink); font-size: 12px; font-weight: 650; cursor: pointer; }
.writing-send:hover { background: #67e4fb; }
.writing-send:disabled { opacity: .5; cursor: default; }
.writing-send.cancel { background: var(--nb-bg-3); color: var(--nb-t1); border: 1px solid var(--nb-line-2); }
.writing-pulse { display: inline-block; width: 6px; height: 6px; margin-right: 4px; border-radius: 50%; background: var(--nb-t2); animation: writing-pulse 1s ease-in-out infinite alternate; }
@keyframes writing-pulse { to { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .writing-pulse { animation: none; } }
.ep-item-title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ep-main {
  min-height: 0;
  min-width: 0;
  flex: 1;
}
.ep-main :deep(.glass-card-root) {
  height: 100%;
  min-height: 0;
  border: none;
  border-radius: 4px;
  box-shadow: none;
  background: var(--nb-bg-0);
}
.episode-editor {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
}
.episode-tools {
  display: flex;
  gap: 8px;
  align-items: center;
}
.ep-title-input {
  flex: 1;
  min-width: 0;
  background: var(--nb-void);
  border: none;
  border-radius: 4px;
  padding: 8px 10px;
  color: var(--color-text-1);
  font-size: 14px;
}
.episode-move {
  display: flex;
  gap: 4px;
}
.episode-move button {
  height: 32px;
  padding: 0 8px;
  border: none;
  border-radius: 4px;
  background: var(--nb-void);
  color: var(--color-text-2);
  cursor: pointer;
}
.episode-move button.danger {
  color: #c4a0a0;
}
.episode-body-wrap {
  position: relative;
  flex: 1;
  min-height: 280px;
  display: flex;
  overflow: hidden;
  border-radius: 10px;
  background: var(--nb-void);
  box-shadow: inset 0 0 0 1px var(--nb-line-2);
}
.script-paint,
.episode-body {
  position: absolute;
  inset: 0;
  margin: 0;
  width: 100%;
  height: 100%;
  padding: 18px 22px 48px;
  border: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  background: transparent;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 26px;
  letter-spacing: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  tab-size: 2;
}
.script-paint {
  color: var(--nb-t2);
  pointer-events: none;
  z-index: 0;
}
.script-paint.empty { color: var(--nb-t4); }
.script-paint :deep(.sp-h1) { color: var(--nb-t1); font-weight: 650; }
.script-paint :deep(.sp-h2) { color: var(--nb-accent); font-weight: 650; }
.script-paint :deep(.sp-act) { color: var(--nb-t2); }
.script-paint :deep(.sp-say) { color: var(--nb-t1); }
.script-paint :deep(.sp-colon) { color: var(--nb-t3); }
.script-paint :deep(.sp-paren) { color: var(--nb-t4); }
.script-paint :deep(.sp-note),
.script-paint :deep(.sp-cast) { color: var(--nb-t4); }
.script-paint :deep(.sp-nar) { color: var(--nb-ai); font-style: italic; }
.episode-body {
  z-index: 1;
  resize: none;
  color: transparent;
  caret-color: var(--nb-accent);
  outline: none;
}
.episode-body:focus,
.episode-body:focus-visible {
  outline: none;
}
.episode-body::selection {
  background: rgba(53, 214, 247, 0.28);
  color: transparent;
}
.episode-writing-overlay {
  position: absolute;
  inset: 1px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border-radius: 4px;
  background: rgba(18, 18, 20, 0.9);
  color: var(--color-text-1);
  font-size: 13px;
}
.episode-writing-overlay > span:not(.episode-writing-spinner) { color: var(--color-text-3); font-size: 12px; }
.episode-writing-spinner {
  width: 30px;
  height: 30px;
  border: 2px solid rgba(255, 255, 255, 0.12);
  border-top-color: #c8c8cc;
  border-radius: 50%;
  animation: episode-writing-spin 0.85s linear infinite;
}
@keyframes episode-writing-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .episode-writing-spinner { animation: none; } }
.ai-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}
.llm-select,
.reference-select,
.ai-hint {
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text-1);
  height: 34px;
  padding: 0 10px;
  font-size: 12px;
}
.llm-select {
  max-width: 220px;
}
.reference-select-label {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  color: var(--color-text-3);
  font-size: 12px;
}
.reference-select { max-width: 160px; }
.ai-hint {
  flex: 1;
  min-width: 0;
}

.side {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  position: sticky;
  top: 0;
}
.side-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.search {
  flex: 1;
  min-width: 0;
  background: var(--nb-bg-2);
  border: none;
  border-radius: 4px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--color-text-1);
  outline: none;
}
.search:focus {
  background: var(--nb-bg-3);
}
.count {
  font-size: 11px;
  color: var(--color-text-4);
  flex-shrink: 0;
}
.ep-side .list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
}
.script-item {
  text-align: left;
  padding: 10px;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  background: var(--color-bg-2);
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: all var(--duration-fast);
}
.script-item:hover {
  border-color: var(--color-border-strong);
}
.script-item.active {
  border-color: rgba(126, 180, 255, 0.5);
  background: var(--grad-primary-soft);
}
.si-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.si-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-3);
}
.si-time {
  font-size: 10px;
  color: var(--color-text-4);
}
.side-foot {
  font-size: 11px;
  color: #9a9aa1;
  padding: 7px 8px;
  border-radius: 4px;
  border: none;
  background: transparent;
  text-align: left;
}
.side-foot:hover {
  color: #eee;
  background: var(--nb-bg-3);
}

.editor-card {
  min-height: 520px;
  display: flex;
  flex-direction: column;
}
.center {
  align-items: center;
  justify-content: center;
}
.ed-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 12px 16px 8px;
  border-bottom: none;
  flex-wrap: wrap;
}
.title-input {
  flex: 1;
  min-width: 200px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  font-size: 16px;
  font-weight: 650;
  color: var(--color-text-1);
  outline: none;
}
.title-input:hover {
  background: var(--color-fill);
}
.title-input:focus {
  border-color: transparent;
  background: var(--nb-void);
}
.ed-meta {
  display: flex;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-4);
}
.unsaved {
  color: var(--color-warning);
}
.ed-actions {
  display: flex;
  gap: 6px;
}
.mini-btn {
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 4px;
  border: none;
  color: #b7b7bc;
  background: transparent;
  transition: background var(--duration-fast);
}
.mini-btn:hover:not(:disabled) {
  color: #f2f2f3;
  background: var(--nb-bg-4);
}
.mini-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.mini-btn.primary {
  background: var(--nb-bg-4);
  color: #f2f2f3;
}
.mini-btn.danger:hover {
  color: #e4c4c4;
  background: #2a2222;
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 0 var(--space-5);
  border-bottom: 1px solid var(--color-border);
}
.tabs button {
  font-size: 12px;
  padding: 8px 12px;
  color: var(--color-text-3);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.tabs button:hover {
  color: var(--color-text-1);
}
.tabs button.on {
  color: var(--color-accent);
  border-bottom-color: var(--color-accent);
}

.ed-body {
  flex: 1;
  min-height: 380px;
  padding: var(--space-4) var(--space-5);
  overflow-y: auto;
}

.ep-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.ep-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-2);
  overflow: hidden;
  transition: border-color var(--duration-fast);
}
.ep-card.open {
  border-color: rgba(126, 180, 255, 0.4);
}
.ep-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 10px;
  cursor: pointer;
}
.ep-no {
  grid-row: 1 / span 2;
  align-self: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 3px;
  background: var(--nb-bg-4);
  color: #c8c8cc;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ep-title {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 3px 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-1);
  outline: none;
}
.ep-title:hover {
  background: var(--color-fill);
}
.ep-title:focus {
  border-color: var(--color-accent);
  background: var(--color-bg-1);
}
.ep-words {
  grid-column: 2;
  white-space: nowrap;
  font-size: 11px;
  line-height: 1.2;
  color: var(--color-text-4);
}
.ep-tools {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.ep-tools button {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--color-text-3);
}
.ep-tools button:hover:not(:disabled) {
  background: var(--color-fill);
  color: var(--color-text-1);
}
.ep-tools button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.ep-tools button.danger:hover {
  color: var(--color-error);
  background: rgba(248, 113, 113, 0.12);
}
.ep-body {
  width: 100%;
  min-height: 220px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-1);
  color: var(--color-text-2);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.75;
  padding: var(--space-3);
  border: none;
  outline: none;
  resize: vertical;
}
.add-ep {
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  padding: 12px;
  font-size: 12px;
  color: var(--color-text-3);
  transition: all var(--duration-fast);
}
.add-ep:hover {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: var(--grad-primary-soft);
}

.md-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: 100%;
}
.md-editor {
  flex: 1;
  min-height: 420px;
  width: 100%;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-2);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.75;
  padding: var(--space-4);
  outline: none;
  resize: vertical;
}
.md-editor:focus {
  border-color: var(--color-accent);
}
.md-foot {
  display: flex;
  gap: var(--space-2);
}

.preview {
  color: var(--color-text-2);
  font-size: 13.5px;
  line-height: 1.8;
  max-width: 760px;
}
.preview :deep(h1) {
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text-1);
  margin: 0 0 16px;
}
.preview :deep(h2) {
  font-size: 17px;
  font-weight: 650;
  color: var(--color-text-1);
  margin: 28px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--color-border);
}
.preview :deep(h3) {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-1);
  margin: 20px 0 8px;
}
.preview :deep(p) {
  margin: 0 0 12px;
}
.preview :deep(ul),
.preview :deep(ol) {
  margin: 0 0 12px;
  padding-left: 20px;
}
.preview :deep(li) {
  margin-bottom: 4px;
}
.preview :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 20px 0;
}
.preview :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--color-fill);
  padding: 1px 5px;
  border-radius: 4px;
}
.preview :deep(strong) {
  color: var(--color-text-1);
}

.ed-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 8px 16px 12px;
  border-top: none;
}
.ed-foot :deep(.grad-btn) {
  border-radius: 4px;
  box-shadow: none;
  background: #3a3a40;
}
.ed-foot :deep(.grad-btn:hover:not(:disabled)) {
  background: #48484f;
}
.foot-tip {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-4);
}

.empty-mini {
  grid-column: 1 / -1;
  text-align: left;
  color: #8d8d93;
  font-size: 13px;
  padding: 8px 2px 0;
  border: none;
  background: transparent;
  line-height: 1.7;
}

.blank {
  text-align: center;
  padding: var(--space-8);
}
.blank-icon {
  font-size: 40px;
  opacity: 0.5;
  margin-bottom: var(--space-3);
}
.blank-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-1);
  margin-bottom: 6px;
}
.blank-desc {
  font-size: 12.5px;
  color: var(--color-text-3);
  max-width: 420px;
  margin: 0 auto var(--space-4);
  line-height: 1.7;
}
.blank-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: center;
}

@media (max-width: 1080px) {
  .ai-bar { flex-wrap: wrap; }
  .ai-hint { flex: 1 1 220px; }
  .body {
    grid-template-columns: 1fr;
  }
  .side {
    position: static;
  }
}
.sc-page { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.sc-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 24px;
  padding: 22px 28px 16px; border-bottom: 1px solid var(--nb-line-2);
  background: linear-gradient(180deg, rgba(255,255,255,.02), transparent);
}
.sc-head-copy { flex: 1; min-width: 0; }
.sc-kicker {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--nb-t3);
}
.sc-kicker::before { content: ""; width: 14px; height: 1px; background: var(--nb-line-accent); }
.sc-h1 {
  display: block; width: min(640px, 100%); margin: 8px 0 6px; padding: 0;
  border: 0; background: transparent; color: var(--nb-t1);
  font-size: 26px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.15;
}
.sc-head-copy p { margin: 0; max-width: 640px; color: var(--nb-t3); font-size: 12px; line-height: 1.6; }
.sc-head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.savechip { display: inline-flex; align-items: center; gap: 6px; color: var(--nb-t3); font-size: 11px; }
.savechip i { width: 5px; height: 5px; border-radius: 50%; background: var(--nb-success); box-shadow: 0 0 6px rgba(61,217,160,.7); }
.savechip.dirty i { background: var(--nb-warning); box-shadow: 0 0 6px rgba(255,180,84,.7); }
.nb-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--nb-line-2);
  background: var(--nb-bg-3); color: var(--nb-t1); font-size: 12px; cursor: pointer;
}
.nb-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.nb-btn:hover { background: var(--nb-bg-4); }
.nb-btn.primary { background: var(--nb-accent); border-color: var(--nb-accent); color: var(--nb-accent-ink); font-weight: 650; }
.nb-btn.primary:hover { background: #4ce0ff; box-shadow: 0 0 20px var(--nb-accent-glow); }
.nb-btn.ghost { background: transparent; border-color: transparent; color: var(--nb-t2); }
.nb-btn.sm { height: 26px; padding: 0 10px; border-radius: 6px; font-size: 11px; }
.nb-btn.danger { background: var(--nb-danger-soft); border-color: rgba(255,92,108,.32); color: var(--nb-danger); }
.nb-btn.block { width: 100%; }
.nb-btn:disabled { opacity: .4; cursor: default; }
.sc-cols { flex: 1; min-height: 0; display: grid; grid-template-columns: 248px minmax(0, 1fr) 330px; }
.sc-lib, .sc-ai { min-height: 0; display: flex; flex-direction: column; background: var(--nb-bg-1); }
.sc-lib { border-right: 1px solid var(--nb-line-2); }
.sc-ai { border-left: 1px solid var(--nb-line-2); }
.sc-lib-head, .sc-ai-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 12px 14px; border-bottom: 1px solid var(--nb-line-1);
}
.sc-panel-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; }
.sc-panel-title i { width: 3px; height: 13px; border-radius: 2px; background: var(--nb-accent); }
.sc-panel-title.ai i { background: var(--nb-ai); }
.sc-badge { height: 20px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--nb-ai-line); background: var(--nb-ai-soft); color: var(--nb-ai); font-size: 10px; display: inline-flex; align-items: center; }
.sc-icon { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 6px; color: var(--nb-t3); }
.sc-icon svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.sc-icon:hover { background: var(--nb-bg-3); color: var(--nb-t1); }
.sc-lib-search { padding: 10px 12px 4px; }
.sc-lib-search input, .writing-options select, .writing-mode select, .writing-input, .story-plan-content textarea, .story-plan-content input {
  width: 100%; box-sizing: border-box; border: 1px solid var(--nb-line-2); border-radius: 10px;
  background: var(--nb-bg-inset); color: var(--nb-t1);
}
.sc-lib-search input { height: 32px; padding: 0 12px; }
.sc-lib-search input:focus, .writing-input:focus { outline: none; border-color: var(--nb-accent); box-shadow: 0 0 0 3px var(--nb-accent-soft); }
.sc-lib-body { flex: 1; overflow: auto; padding: 8px; }
.sc-sec-t { padding: 12px 8px 6px; font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--nb-t4); }
.sc-ep, .sc-other, .sc-kid {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  border: 0; background: transparent; color: var(--nb-t2); cursor: pointer; border-radius: 6px;
}
.sc-ep, .sc-other { padding: 7px 8px; font-size: 12px; }
.sc-ep svg { width: 12px; height: 12px; fill: none; stroke: var(--nb-t4); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.sc-ep span, .sc-other span, .sc-kid span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-ep b, .sc-other b { font-weight: 500; font-family: var(--font-mono); font-size: 10px; color: var(--nb-t4); }
.sc-ep:hover, .sc-other:hover, .sc-kid:hover { background: var(--nb-bg-2); color: var(--nb-t1); }
.sc-ep.on { background: var(--nb-accent-soft); color: var(--nb-accent); }
.sc-ep.on svg { stroke: var(--nb-accent); }
.sc-kid { margin-left: 16px; width: calc(100% - 16px); padding: 6px 8px; border-left: 1px solid var(--nb-line-2); border-radius: 0 6px 6px 0; font-size: 11px; color: var(--nb-t3); }
.sc-lib-foot { border-top: 1px solid var(--nb-line-1); padding: 12px; display: grid; gap: 8px; }
.sc-lib-meta { display: flex; justify-content: space-between; color: var(--nb-t4); font-family: var(--font-mono); font-size: 10px; }
.sc-danger-text { border: 0; background: transparent; color: var(--nb-danger); cursor: pointer; font-size: 10px; }
.sc-mid { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--nb-bg-0); }
.sc-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--nb-line-2); background: var(--nb-bg-1); }
.sc-seg { display: inline-flex; padding: 2px; gap: 2px; background: var(--nb-bg-inset); border: 1px solid var(--nb-line-2); border-radius: 10px; }
.sc-seg button { height: 26px; padding: 0 12px; border: 0; border-radius: 6px; background: transparent; color: var(--nb-t3); font-size: 11px; cursor: pointer; }
.sc-seg button.on { background: var(--nb-accent-soft); color: var(--nb-accent); }
.sc-vdiv { width: 1px; height: 16px; background: var(--nb-line-2); }
.sc-toolbar-meta { margin-left: auto; color: var(--nb-t4); font-family: var(--font-mono); font-size: 11px; }
.sc-mid .episode-editor { padding: 0; gap: 0; }
.sc-mid .episode-body-wrap { border-radius: 0; box-shadow: none; background: transparent; }
.sc-mid .episode-body-wrap.preview .episode-body { pointer-events: none; }
.sc-status {
  display: flex; gap: 18px; padding: 8px 16px; border-top: 1px solid var(--nb-line-2);
  background: var(--nb-bg-1); color: var(--nb-t4); font-family: var(--font-mono); font-size: 11px;
}
.sc-ai .writing-history { padding: 14px; }
.sc-ai .writing-compose { padding: 12px; border-top: 1px solid var(--nb-line-1); }
.sc-acts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
.sc-acts button {
  display: grid; gap: 3px; justify-items: start; text-align: left; padding: 8px 10px;
  border: 1px solid var(--nb-line-2); border-radius: 10px; background: var(--nb-bg-2); color: var(--nb-t1); cursor: pointer;
}
.sc-acts button:hover { border-color: var(--nb-ai-line); background: var(--nb-ai-soft); }
.sc-acts b { font-size: 12px; }
.sc-acts span { font-size: 10px; color: var(--nb-t4); }
.sc-ai .writing-send { border-radius: 8px; }

@media (max-width: 760px) {
  .page.detail { height: auto; overflow: visible; }
  .workspace { display: flex; flex-direction: column; }
  .pane-resizer { display: none; }
  .ep-side,
  .writing-agent { width: auto !important; max-height: none; padding: 0; }
  .ep-side { max-height: 200px; }
  .ep-main :deep(.glass-card-root) { min-height: 500px; }
  .writing-agent { min-height: 440px; }
}

</style>
