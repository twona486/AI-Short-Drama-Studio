<script setup lang="ts">
import { t as localized } from '@/i18n'
import { confirmAction } from '@/utils/confirmAction'
import { t as translate } from '@/i18n'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Handle, Position, useVueFlow } from '@vue-flow/core'
import { useProjectStore, useScriptsStore, useSettingsStore, useToastStore } from '@/stores'
import { llmChoiceKey, llmModelGroups, parseLlmChoiceKey } from '@/stores/settings'
import { runScriptNode } from '@/services/canvas/runner'
import { isNodeRunning } from '@/services/canvas/jobs'
import {
  applyProjectPlayMarkdown,
  composeProjectPlayMarkdown,
  scriptFromImportedPlay
} from '@/utils/scriptMarkdown'
import { pickPlayMarkdownFile } from '@/utils/pickPlayFile'
import { markdownToHtml } from '@/utils/markdown'
import { parseScriptDoc, serializeScriptDoc, type ParsedScriptDoc } from '@/utils/scriptEpisodes'
import { needsPlayReview } from '@/services/canvas/playGate'
import { type ExtractStage } from '@/services/canvas/pipeline'
import { isPlayReady } from '@/services/ai'
import { friendlyAiError, shouldToastAiError } from '@/services/ai/abort'
import NodeBusyOverlay from '@/components/canvas/NodeBusyOverlay.vue'
import NodeLinkPlus from '@/components/canvas/NodeLinkPlus.vue'

const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    label?: string
    width?: number
    height?: number
    nodeType?: string
  }
}>()

const MIN_W = 320
const MIN_H = 360

const project = useProjectStore()
const scripts = useScriptsStore()
const settings = useSettingsStore()
const toast = useToastStore()
const { getViewport, findNode, removeSelectedNodes } = useVueFlow()
const panelOpen = ref(false)
const libraryOpen = ref(false)
const libraryLoading = ref(false)
const librarySelected = ref('')
const libraryEpisodes = ref<ParsedScriptDoc['episodes']>([])
const libraryEpisodeIndex = ref<number | null>(null)
let libraryRequestId = 0

async function openScriptLibrary(ev?: Event) {
  ev?.stopPropagation()
  if (generating.value) return
  libraryOpen.value = true
  libraryLoading.value = true
  librarySelected.value = ''
  libraryEpisodes.value = []
  libraryEpisodeIndex.value = null
  ++libraryRequestId
  try {
    await scripts.refresh()
  } catch (error: any) {
    toast.error(error?.message || localized('mediaNodes.scriptReadFailed'))
  } finally {
    libraryLoading.value = false
  }
}

async function selectLibraryScript(id: string) {
  if (libraryLoading.value) return
  const requestId = ++libraryRequestId
  librarySelected.value = id
  libraryEpisodes.value = []
  libraryEpisodeIndex.value = null
  libraryLoading.value = true
  try {
    const content = await scripts.readContent(id, true)
    if (requestId !== libraryRequestId || !libraryOpen.value) return
    libraryEpisodes.value = parseScriptDoc(content).episodes
  } catch (error: any) {
    if (requestId === libraryRequestId) toast.error(error?.message || localized('mediaNodes.episodeReadFailed'))
  } finally {
    if (requestId === libraryRequestId) libraryLoading.value = false
  }
}

async function useLibraryScript() {
  const doc = scripts.docs.find((item) => item.id === librarySelected.value)
  const index = libraryEpisodeIndex.value
  if (!doc || index === null || libraryLoading.value) return
  const episode = libraryEpisodes.value[index]
  if (!episode?.content.trim()) {
    toast.warn(localized('mediaNodes.noEpisodeContent'))
    return
  }
  libraryLoading.value = true
  try {
    const title = `${doc.title} · ${episode.title}`
    const content = serializeScriptDoc({ title, preamble: '', episodes: [episode] })
    if (await applyImportedMarkdown(content, `${title}.md`)) libraryOpen.value = false
  } catch (error: any) {
    toast.error(error?.message || localized('mediaNodes.couldNotReadScript'))
  } finally {
    libraryLoading.value = false
  }
}

watch(
  () => props.selected,
  (on) => {
    panelOpen.value = Boolean(on)
  },
  { immediate: true }
)

const llmGroups = computed(() => llmModelGroups(settings.config.llms ?? []))
const llmChoice = computed({
  get() {
    const id = settings.config.activeLlmId
    const model = settings.config.llm.model
    return id && model ? llmChoiceKey(id, model) : ''
  },
  set(v: string) {
    const parsed = parseLlmChoiceKey(v)
    if (parsed) settings.selectLlmModel(parsed.profileId, parsed.model)
  }
})
const llmModel = computed(() => settings.config.llm.model)

function patchTopic(v: string) {
  if (!project.current?.script) return
  project.setScript({ ...project.current.script, topic: v })
  project.applyPlayTitle(v)
}

function patchDraftBrief(v: string) {
  if (!project.current?.script) return
  project.setScript({ ...project.current.script, content: v })
}

const nodeMeta = computed(() => project.current?.canvas?.nodes.find((n) => n.id === props.id))
const width = computed(() => nodeMeta.value?.data.width || props.data.width || 460)
const height = computed(() => nodeMeta.value?.data.height || props.data.height || 720)
const generating = computed(() => isNodeRunning(props.id))
const status = computed(() => nodeMeta.value?.status ?? 'idle')
const waitingReview = computed(() => needsPlayReview(project.current))
const approved = computed(() => Boolean(project.current?.shots.length) && !waitingReview.value)
const playReady = computed(() => isPlayReady(project.current?.script))
const playLabel = computed(() => (playReady.value ? translate('scriptDocNode.rewriteScript') : translate('scriptDocNode.writeScript')))
const canExtractShots = computed(
  () => Boolean((project.current?.subjects ?? []).length && (project.current?.scenes ?? []).length)
)

const editing = ref(false)
const draft = ref('')
const dirty = ref(false)
const continueHint = ref('')

/* 빈 대본에서 가져오기 또는 생성 선택 */
const emptyState = computed(
  () => !editing.value && !(project.current?.script?.content || '').trim()
)
const emptyMode = ref<'pick' | 'gen'>('pick')
const genTopic = ref('')
const genBrief = ref('')

watch(emptyState, (empty) => {
  if (empty) emptyMode.value = 'pick'
})

async function submitGenerate(ev: Event) {
  ev.stopPropagation()
  if (generating.value) return
  const topic = genTopic.value.trim()
  const brief = genBrief.value.trim()
  if (!topic && !brief) {
    toast.warn(translate('common.enterRequirements'))
    return
  }
  const p = project.current
  if (!p) return
  const base = p.script
  project.setScript({
    ...base,
    id: base?.id ?? `s_${Date.now().toString(36)}`,
    topic: topic || base?.topic || p.name || translate('common.scripts'),
    content: brief,
    keywords: base?.keywords ?? [],
    style: base?.style ?? 'cinematic',
    aspectRatio: base?.aspectRatio ?? p.settings?.aspectRatio ?? '16:9',
    shotDuration: base?.shotDuration ?? p.settings?.defaultShotDuration ?? 5,
    playReady: false,
    createdAt: base?.createdAt ?? Date.now()
  })
  if (topic) project.applyPlayTitle(topic)
  await project.save()
  await generateThis(ev, 'play')
}

const markdown = computed(() => {
  if (!project.current) return translate('scriptDocNode.noProjectMarkdown')
  return composeProjectPlayMarkdown(project.current)
})
const html = computed(() => markdownToHtml(markdown.value))

watch(markdown, (md) => {
  if (!editing.value) {
    draft.value = md
    dirty.value = false
  }
})

function startEdit(ev?: Event) {
  ev?.stopPropagation()
  draft.value = markdown.value
  dirty.value = false
  editing.value = true
}

function cancelEdit(ev?: Event) {
  ev?.stopPropagation()
  editing.value = false
  dirty.value = false
  draft.value = markdown.value
}

async function saveEdit(ev?: Event) {
  ev?.stopPropagation()
  if (!project.current) return
  try {
    const clone = JSON.parse(JSON.stringify(project.current)) as typeof project.current
    if (!clone) return
    applyProjectPlayMarkdown(clone, draft.value)
    if (clone.script) {
      project.setScript({
        ...clone.script,
        playReady: Boolean(clone.script.content?.trim())
      })
    }
    if (clone.subjects) project.setSubjects(clone.subjects)
    if (clone.scenes) project.setScenes(clone.scenes)
    if (clone.shots) project.setShots(clone.shots)
    // 수정된 대본은 기존 승인 상태를 해제해 다시 확인할 수 있도록 한다.
    if (project.current.playApproved) {
      project.setPlayApproved(false)
    }
    await project.save()
    editing.value = false
    dirty.value = false
    toast.success(translate('scriptDocNode.saved'))
  } catch (e: any) {
    toast.error(translate('scriptDocNode.saveFailed', { error: (e?.message || String(e)) }))
  }
}

async function approvePlay(ev: Event) {
  ev.stopPropagation()
  if (editing.value && dirty.value) {
    await saveEdit()
  }
  project.setPlayApproved(true)
  await project.save()
}

async function applyImportedMarkdown(text: string, filename: string) {
  if (!project.current) return false
  const existing = (project.current.script?.content || '').trim()
  if (existing && !confirm(localized('mediaNodes.replaceCurrentScript'))) return false
  try {
    const script = scriptFromImportedPlay(project.current, text, filename)
    project.setScript(script)
    project.applyPlayTitle(script.topic)
    if (project.current.pipelineMode !== 'img2video') project.setPlayApproved(false)
    await project.save()
    editing.value = false
    dirty.value = false
    toast.success(translate('common.importedNamed', { p0: script.topic }))
    return true
  } catch (e: any) {
    toast.error(e?.message || translate('common.importFailed'))
    return false
  }
}

async function importMarkdown(ev?: Event) {
  ev?.stopPropagation()
  if (generating.value) return
  try {
    const picked = await pickPlayMarkdownFile()
    if (!picked) return
    await applyImportedMarkdown(picked.text, picked.filename)
  } catch (e: any) {
    toast.error(e?.message || translate('common.importFailed'))
  }
}

function onPlayDragOver(ev: DragEvent) {
  if (![...ev.dataTransfer?.types ?? []].includes('Files')) return
  ev.preventDefault()
  ev.stopPropagation()
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
}

async function onPlayDrop(ev: DragEvent) {
  ev.preventDefault()
  ev.stopPropagation()
  const file = [...(ev.dataTransfer?.files ?? [])].find((item) =>
    /\.(md|markdown|txt)$/i.test(item.name) || item.type.includes('markdown') || item.type === 'text/plain'
  )
  if (!file) {
    toast.warn(translate('scriptDocNode.dropFiles'))
    return
  }
  await applyImportedMarkdown(await file.text(), file.name)
}

const live = ref<{ w: number; h: number } | null>(null)

function patchSize(w: number, h: number) {
  const canvas = project.current?.canvas
  if (!canvas) return
  const nodes = canvas.nodes.map((n) =>
    n.id === props.id ? { ...n, data: { ...n.data, width: w, height: h } } : n
  )
  project.setCanvas({ ...canvas, nodes })
}

let dragging: {
  kind: 'se' | 'e' | 's'
  sx: number
  sy: number
  sw: number
  sh: number
} | null = null

function flowEl() {
  return document.querySelector(`.vue-flow__node[data-id="${props.id}"]`) as HTMLElement | null
}

function applyBox(w: number, h: number) {
  live.value = { w, h }
  const el = flowEl()
  if (el) {
    el.style.width = `${w}px`
    el.style.height = `${h}px`
  }
}

function onResizeStart(kind: 'se' | 'e' | 's', e: PointerEvent) {
  e.preventDefault()
  e.stopPropagation()
  dragging = {
    kind,
    sx: e.clientX,
    sy: e.clientY,
    sw: width.value,
    sh: height.value
  }
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeEnd)
}

function onResizeMove(e: PointerEvent) {
  if (!dragging) return
  const zoom = getViewport().zoom || 1
  const dx = (e.clientX - dragging.sx) / zoom
  const dy = (e.clientY - dragging.sy) / zoom
  const w = dragging.kind === 's' ? dragging.sw : Math.max(MIN_W, dragging.sw + dx)
  const h = dragging.kind === 'e' ? dragging.sh : Math.max(MIN_H, dragging.sh + dy)
  applyBox(w, h)
}

function onResizeEnd() {
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
  if (live.value) patchSize(Math.round(live.value.w), Math.round(live.value.h))
  live.value = null
  dragging = null
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
})

function dismissPanel() {
  panelOpen.value = false
  const n = findNode(props.id)
  if (n) removeSelectedNodes([n])
}

async function generateThis(ev: Event, kind: 'play' | 'extract' | 'continue' = 'play', stage?: ExtractStage) {
  ev.stopPropagation()
  if (generating.value) return
  if (editing.value) {
    toast.warn(translate('scriptDocNode.endEditing'))
    return
  }
  if (kind === 'extract' && !playReady.value && !(project.current?.script?.content || '').trim()) {
    toast.warn(translate('scriptDocNode.needScriptToExtract'))
    return
  }
  if (kind === 'extract' && stage === 'shots' && !canExtractShots.value) {
    toast.warn(translate('common.extractBeforeShots'))
    return
  }
  if (kind === 'continue' && !playReady.value) {
    toast.warn(translate('scriptDocNode.needScriptToContinue'))
    return
  }
  dismissPanel()
  try {
    await runScriptNode(kind, undefined, undefined, llmModel.value, continueHint.value, stage)
  } catch (e) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e))
  }
}
</script>

<template>
  <div class="sdoc" :class="[`st-${status}`, { editing, on: selected && panelOpen, busy: generating }]">
    <NodeLinkPlus :node-id="id" />
    <div
      class="sdoc-card"
      @dragover="onPlayDragOver"
      @drop="onPlayDrop"
    >
    <div class="sdoc-head">
      <div class="sdoc-titles">
        <span class="sdoc-k">{{ $t('common.completeScript') }}</span>
        <strong>{{ project.current?.script?.topic || project.current?.name || $t('common.scripts') }}</strong>
      </div>
      <div class="sdoc-actions nodrag">
        <template v-if="editing">
          <button type="button" class="sdoc-btn ghost" @click="cancelEdit" @mousedown.stop>{{ $t('common.cancel') }}</button>
          <button type="button" class="sdoc-btn primary" @click="saveEdit" @mousedown.stop>
            {{ $t('common.save') }}{{ dirty ? '*' : '' }}
          </button>
        </template>
        <template v-else-if="!emptyState">
          <button type="button" class="sdoc-btn" :disabled="generating" @click="openScriptLibrary" @mousedown.stop>
            {{ $t('common.scriptLibrary') }}
          </button>
          <button type="button" class="sdoc-btn" :disabled="generating" @click="importMarkdown" @mousedown.stop>
            {{ $t('common.import') }}
          </button>
          <button
            v-if="playReady"
            type="button"
            class="sdoc-btn"
            :disabled="generating"
            @click="generateThis($event, 'continue')"
            @mousedown.stop
          >
            {{ $t('common.continueWriting') }}
          </button>
          <button type="button" class="sdoc-btn" @click="startEdit" @mousedown.stop>{{ $t('common.editWithIcon') }}</button>
        </template>
      </div>
    </div>

    <textarea
      v-if="editing"
      v-model="draft"
      class="sdoc-edit nowheel nodrag"
      spellcheck="false"
      @input="dirty = true"
      @mousedown.stop
    />
    <div v-else-if="emptyState" class="sdoc-empty nowheel nodrag" @mousedown.stop>
      <template v-if="emptyMode === 'pick'">
        <p class="empty-title">{{ $t('scriptDocNode.noScript') }}</p>
        <div class="empty-cards">
          <button type="button" class="empty-card" :disabled="generating" @click="openScriptLibrary">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h11a2 2 0 0 1 2 2v13H6.5A2.5 2.5 0 0 1 4 17V6a1 1 0 0 1 1-1.5Z" /><path d="M4 17a2.5 2.5 0 0 1 2.5-2.5H18M8 8h6M8 11h6" /></svg>
            <strong>{{ $t('mediaNodes.chooseScript') }}</strong>
            <span>{{ $t('mediaNodes.chooseScriptHint') }}</span>
          </button>
          <button type="button" class="empty-card" :disabled="generating" @click="importMarkdown">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4.5V16M7.5 11 12 15.5 16.5 11" />
              <path d="M4.5 16.5v2.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
            </svg>
            <strong>{{ $t('scriptDocNode.import') }}</strong>
            <span>{{ $t('scriptDocNode.dropHint') }}</span>
          </button>
          <button type="button" class="empty-card accent" :disabled="generating" @click="emptyMode = 'gen'">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3.5 13.8 9 19.5 10.8 13.8 12.6 12 18.5 10.2 12.6 4.5 10.8 10.2 9 12 3.5Z" />
              <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
            </svg>
            <strong>{{ $t('scriptDocNode.generateAi') }}</strong>
            <span>{{ $t('scriptDocNode.writeHint') }}</span>
          </button>
        </div>
      </template>
      <template v-else>
        <div class="gen-form">
          <label>{{ $t('scriptDocNode.requirements') }}</label>
          <textarea
            v-model="genTopic"
            rows="3"
            :placeholder="$t('scriptDocNode.promptExample')"
          />
          <label>{{ $t('scriptDocNode.baseContent') }}</label>
          <textarea
            v-model="genBrief"
            rows="5"
            :placeholder="$t('scriptDocNode.productionOutlineHint')"
          />
          <div class="gen-foot">
            <label class="model-pick">
              <span>LLM</span>
              <select v-model="llmChoice">
                <option v-if="!llmGroups.some((g) => g.models.length)" value="">{{ $t('common.noModel') }}</option>
                <optgroup v-for="g in llmGroups" :key="g.id" :label="g.name">
                  <option v-for="m in g.models" :key="`${g.id}::${m}`" :value="`${g.id}::${m}`">{{ m }}</option>
                </optgroup>
              </select>
            </label>
            <button type="button" class="ghost" :disabled="generating" @click="emptyMode = 'pick'">{{ $t('common.back') }}</button>
            <button
              type="button"
              class="primary"
              :disabled="generating || !llmModel || (!genTopic.trim() && !genBrief.trim())"
              @click="submitGenerate"
            >
              {{ $t('scriptDocNode.generate') }}
            </button>
          </div>
        </div>
      </template>
    </div>
    <div v-else class="sdoc-md nowheel nodrag" v-html="html" />

    <Teleport to="body">
      <div v-if="libraryOpen" class="script-library-backdrop" @click.self="libraryOpen = false" @keydown.esc="libraryOpen = false">
        <section class="script-library-dialog" role="dialog" aria-modal="true" aria-labelledby="script-library-title" @mousedown.stop @click.stop>
          <header class="script-library-head">
            <div><strong id="script-library-title">{{ $t('mediaNodes.chooseScript') }}</strong><p>{{ $t('mediaNodes.chooseEpisodeHint') }}</p></div>
            <button type="button" class="sdoc-btn" :aria-label="$t('common.close')" @click="libraryOpen = false">✕</button>
          </header>
          <p v-if="libraryLoading" class="script-library-empty">{{ $t('mediaNodes.readingScripts') }}</p>
          <p v-else-if="!scripts.docs.length" class="script-library-empty">{{ $t('mediaNodes.emptyLibrary') }}</p>
          <div v-else class="script-library-list">
            <button v-for="doc in scripts.docs" :key="doc.id" type="button" class="script-library-item" :class="{ on: librarySelected === doc.id }" @click="selectLibraryScript(doc.id)">
              <strong>{{ doc.title }}</strong><span>{{ $t('scriptDesk.counts', { episodes: doc.episodeCount, words: doc.totalWords }) }}</span>
            </button>
          </div>
          <div v-if="librarySelected && !libraryLoading && libraryEpisodes.length" class="script-library-episodes">
            <strong>{{ $t('mediaNodes.chooseEpisode') }}</strong>
            <div class="script-library-episode-list">
              <button v-for="(episode, index) in libraryEpisodes" :key="index" type="button" class="script-library-item" :class="{ on: libraryEpisodeIndex === index }" :disabled="!episode.content.trim()" @click="libraryEpisodeIndex = index">
                <strong>{{ episode.title || $t('scriptDesk.episodesOnly', { count: index + 1 }) }}</strong><span>{{ episode.content.trim() ? $t('scriptDesk.characters', { count: episode.content.replace(/\s/g, '').length }) : $t('mediaNodes.noBody') }}</span>
              </button>
            </div>
          </div>
          <footer class="script-library-foot">
            <button type="button" class="sdoc-btn" @click="libraryOpen = false">{{ $t('common.cancel') }}</button>
            <button type="button" class="sdoc-btn primary" :disabled="libraryEpisodeIndex === null || libraryLoading" @click="useLibraryScript">{{ $t('mediaNodes.useEpisode') }}</button>
          </footer>
        </section>
      </div>
    </Teleport>

    <transition name="float-down">
      <div
        v-if="selected && panelOpen && !editing && !emptyState"
        class="prompt nodrag nowheel"
        @mousedown.stop
        @click.stop
      >
        <div class="prompt-fields">
          <label>{{ $t('scriptDocNode.topic') }}</label>
          <textarea
            rows="4"
            :value="project.current?.script?.topic || ''"
            :placeholder="$t('scriptDocNode.topicHint')"
            @input="patchTopic(($event.target as HTMLTextAreaElement).value)"
          />
          <template v-if="!playReady">
            <label>{{ $t('scriptDocNode.draft') }}</label>
            <textarea
              rows="3"
              :value="project.current?.script?.content || ''"
              :placeholder="$t('scriptDocNode.outlineHint')"
              @input="patchDraftBrief(($event.target as HTMLTextAreaElement).value)"
            />
          </template>
          <p v-else class="prompt-hint">{{ $t('scriptDocNode.scriptGuide') }}</p>
          <template v-if="playReady">
            <label>{{ $t('common.continueDirection') }}</label>
            <textarea
              rows="3"
              :value="continueHint"
              :placeholder="$t('scriptDocNode.continueExample')"
              @input="continueHint = ($event.target as HTMLTextAreaElement).value"
            />
          </template>
        </div>
        <div class="prompt-foot">
          <label class="model-pick">
            <span>LLM</span>
            <select v-model="llmChoice">
              <option v-if="!llmGroups.some((g) => g.models.length)" value="">{{ $t('common.noModel') }}</option>
              <optgroup v-for="g in llmGroups" :key="g.id" :label="g.name">
                <option v-for="m in g.models" :key="`${g.id}::${m}`" :value="`${g.id}::${m}`">{{ m }}</option>
              </optgroup>
            </select>
          </label>
          <button type="button" class="ghost" :disabled="generating" @click="importMarkdown">
            {{ $t('scriptDocNode.importMd') }}
          </button>
          <button
            type="button"
            class="ghost"
            :disabled="generating || (!playReady && !(project.current?.script?.content || '').trim())"
            @click="generateThis($event, 'extract', 'subjects')"
          >
            {{ $t('common.extractCharacters') }}
          </button>
          <button
            type="button"
            class="ghost"
            :disabled="generating || (!playReady && !(project.current?.script?.content || '').trim())"
            @click="generateThis($event, 'extract', 'scenes')"
          >
            {{ $t('common.extractScenes') }}
          </button>
          <button
            type="button"
            class="ghost"
            :disabled="generating || !canExtractShots"
            @click="generateThis($event, 'extract', 'shots')"
          >
            {{ $t('common.extractStoryboard') }}
          </button>
          <button
            v-if="playReady"
            type="button"
            class="ghost"
            :disabled="generating || !llmModel"
            :title="playLabel"
            @click="generateThis($event, 'play')"
          >
            {{ $t('common.rewrite') }}
          </button>
          <button
            type="button"
            class="go"
            :disabled="generating || !llmModel"
            :title="playReady ? $t('common.continueScript') : playLabel"
            @click="generateThis($event, playReady ? 'continue' : 'play')"
          >
            ↑
          </button>
        </div>
      </div>
    </transition>

    <div v-if="!playReady && !emptyState && !editing" class="sdoc-gate nodrag">
      <span>{{ $t('scriptDocNode.draftHint') }}</span>
      <button type="button" :disabled="generating || !llmModel" @click="generateThis($event, 'play')" @mousedown.stop>
        {{ $t('scriptDocNode.generateFull') }}
      </button>
    </div>
    <div v-else-if="playReady && !project.current?.shots.length && !editing" class="sdoc-gate nodrag">
      <span>{{ $t('scriptDocNode.extractionHint') }}</span>
      <div class="sdoc-extracts">
        <button type="button" :disabled="generating" @click="generateThis($event, 'extract', 'subjects')" @mousedown.stop>
          {{ $t('common.extractCharacters') }}
        </button>
        <button type="button" :disabled="generating" @click="generateThis($event, 'extract', 'scenes')" @mousedown.stop>
          {{ $t('common.extractScenes') }}
        </button>
        <button
          type="button"
          :disabled="generating || !canExtractShots"
          :title="canExtractShots ? $t('scriptDocNode.makeStoryboard') : $t('scriptDocNode.extractFirst')"
          @click="generateThis($event, 'extract', 'shots')"
          @mousedown.stop
        >
          {{ $t('common.extractStoryboard') }}
        </button>
      </div>
    </div>
    <div v-else-if="waitingReview && !editing" class="sdoc-gate nodrag">
      <span>{{ $t('scriptDocNode.needApproval') }}</span>
      <button type="button" @click="approvePlay" @mousedown.stop>{{ $t('scriptDocNode.approve') }}</button>
    </div>
    <div v-else-if="approved && !editing" class="sdoc-ok nodrag">
      {{ $t('scriptDocNode.approvedHint') }}
    </div>
    <p v-if="nodeMeta?.error" class="sdoc-err">{{ nodeMeta.error }}</p>
    <NodeBusyOverlay v-if="generating" :label="$t('common.generating')" />
    <Handle id="out" type="source" :position="Position.Right" class="hndl" />
    <div class="rz rz-e nodrag nopan" :title="$t('scriptDocNode.resizeHorizontally')" @pointerdown="onResizeStart('e', $event)" />
    <div class="rz rz-s nodrag nopan" :title="$t('scriptDocNode.resizeVertically')" @pointerdown="onResizeStart('s', $event)" />
    <div class="rz rz-se nodrag nopan" :title="$t('scriptDocNode.resize')" @pointerdown="onResizeStart('se', $event)" />
    </div>

  </div>
</template>

<style scoped>
.script-library-backdrop {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.6);
}
.script-library-dialog {
  width: min(520px, 100%);
  max-height: min(650px, 85vh);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-bg-1);
  color: var(--color-text-1);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
}
.script-library-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 20px; }
.script-library-head p { margin: 6px 0 0; font-size: 12px; color: var(--color-text-3); }
.script-library-empty { margin: 0; padding: 30px 20px; color: var(--color-text-3); font-size: 13px; }
.script-library-list { overflow: auto; padding: 0 12px; min-height: 0; }
.script-library-episodes { padding: 12px 12px 0; border-top: 1px solid var(--color-border); min-height: 0; display: flex; flex-direction: column; gap: 6px; }
.script-library-episodes > strong { padding: 0 12px; color: var(--color-text-2); font-size: 12px; }
.script-library-episode-list { overflow: auto; min-height: 0; }
.script-library-item { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; width: 100%; padding: 12px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--color-text-1); text-align: left; cursor: pointer; }
.script-library-item:disabled { opacity: 0.45; cursor: not-allowed; }
.script-library-item:hover, .script-library-item.on { background: var(--color-fill); border-color: var(--color-border); }
.script-library-item.on { border-color: var(--color-accent); }
.script-library-item span { color: var(--color-text-3); font-size: 12px; }
.script-library-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 20px; border-top: 1px solid var(--color-border); }
.script-library-foot button:disabled { opacity: 0.5; cursor: default; }
.sdoc {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: visible;
  color: var(--color-text-1);
}
.sdoc.on {
  z-index: 4;
}
.sdoc.st-running,
.sdoc.busy {
  z-index: 5;
}
.sdoc-card {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--nb-bg-2) 62%, transparent);
  border: 1px solid var(--color-node-border);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: var(--shadow-node);
  position: relative;
}
.sdoc.editing .sdoc-card {
  border-color: var(--color-accent);
}
.sdoc.on .sdoc-card {
  border-color: var(--color-text-1);
  box-shadow: 0 0 0 1px var(--color-text-1), var(--shadow-md);
}
.sdoc.st-running .sdoc-card,
.sdoc.busy .sdoc-card {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px rgba(126, 180, 255, 0.28);
  animation: node-busy 1.35s ease-in-out infinite;
}
@keyframes node-busy {
  0%,
  100% {
    box-shadow: 0 0 0 2px rgba(126, 180, 255, 0.22);
  }
  50% {
    box-shadow: 0 0 0 3px rgba(126, 180, 255, 0.4);
  }
}
.sdoc.st-failed .sdoc-card {
  border-color: var(--color-error);
}
.sdoc-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--color-border);
  background: transparent;
  flex-shrink: 0;
  cursor: grab;
}
.sdoc-titles {
  display: flex;
  flex-direction: column;
  flex: 1 1 80px;
  gap: 2px;
  min-width: 0;
}
.sdoc-k {
  font-size: 10px;
  color: var(--color-text-4);
  letter-spacing: 0.06em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sdoc-titles strong {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sdoc-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: 100%;
}
.sdoc-btn {
  flex-shrink: 0;
  font-size: 11px;
  padding: 5px 10px;
  border-radius: 8px;
  background: var(--color-bg-3);
  color: var(--color-text-2);
  border: none;
  cursor: pointer;
}
.sdoc-btn:hover {
  background: var(--color-accent);
  color: #fff;
}
.sdoc-btn.primary {
  background: var(--color-accent);
  color: #fff;
}
.sdoc-btn.ghost {
  background: transparent;
  border: 1px solid var(--color-border);
}
.sdoc-md,
.sdoc-edit {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px 16px 20px;
  cursor: text;
}
.sdoc-edit {
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text-1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
}
.sdoc-md :deep(h1) {
  margin: 0 0 14px;
  font-size: 22px;
  font-weight: 800;
  line-height: 1.3;
  color: var(--color-text-1);
}
.sdoc-md :deep(h2) {
  margin: 20px 0 8px;
  padding-bottom: 6px;
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text-1);
  border-bottom: 1px solid var(--color-border);
}
.sdoc-md :deep(h3) {
  margin: 14px 0 6px;
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text-2);
}
.sdoc-md :deep(p) {
  margin: 0 0 10px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--color-text-2);
}
.sdoc-md :deep(ul),
.sdoc-md :deep(ol) {
  margin: 0 0 10px;
  padding-left: 1.2em;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--color-text-2);
}
.sdoc-md :deep(li) {
  margin: 3px 0;
}
.sdoc-md :deep(strong) {
  color: var(--color-text-1);
  font-weight: 700;
}
.sdoc-md :deep(em) {
  color: var(--color-text-3);
}
.sdoc-md :deep(code) {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--color-bg-3);
}
.sdoc-md :deep(hr) {
  border: none;
  border-top: 1px dashed var(--color-border);
  margin: 12px 0;
}
.sdoc-err {
  margin: 0;
  padding: 6px 14px 10px;
  font-size: 11px;
  color: var(--color-error);
}

/* 빈 대본 가져오기 및 생성 */
.sdoc-empty {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px 22px;
}
.empty-title {
  margin: 0 0 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-3);
  letter-spacing: 0.02em;
}
.empty-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  width: 100%;
  max-width: 380px;
}
.empty-card:first-child { grid-column: 1 / -1; }
.empty-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 16px 14px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--duration-fast), background var(--duration-fast);
}
.empty-card:hover:not(:disabled) {
  border-color: rgba(126, 180, 255, 0.45);
  background: rgba(126, 180, 255, 0.06);
}
.empty-card:disabled {
  opacity: 0.5;
  cursor: default;
}
.empty-card svg {
  width: 22px;
  height: 22px;
  fill: none;
  stroke: var(--color-text-3);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.empty-card strong {
  font-size: 13px;
  font-weight: 680;
  color: var(--color-text-1);
}
.empty-card span {
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-4);
}
.empty-card.accent {
  border-color: rgba(126, 180, 255, 0.35);
  background: linear-gradient(160deg, rgba(126, 180, 255, 0.1), rgba(167, 139, 250, 0.08));
}
.empty-card.accent svg {
  stroke: #9db8ff;
}
.gen-form {
  width: 100%;
  max-width: 400px;
  display: flex;
  flex-direction: column;
}
.gen-form > label {
  display: block;
  margin: 0 0 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-3);
}
.gen-form textarea {
  width: 100%;
  margin: 0 0 12px;
  padding: 9px 11px;
  resize: vertical;
  border: 1px solid var(--color-border);
  outline: none;
  border-radius: 9px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  font-size: 12.5px;
  line-height: 1.6;
  font-family: inherit;
}
.gen-form textarea:focus {
  border-color: rgba(126, 180, 255, 0.55);
}
.gen-foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.gen-foot .ghost,
.gen-foot .primary {
  flex-shrink: 0;
  margin: 0;
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.gen-foot .ghost {
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-2);
}
.gen-foot .primary {
  border: 1px solid rgba(126, 180, 255, 0.6);
  background: rgba(126, 180, 255, 0.18);
  color: #cfe0ff;
}
.gen-foot .primary:hover:not(:disabled) {
  background: rgba(126, 180, 255, 0.28);
}
.gen-foot .ghost:disabled,
.gen-foot .primary:disabled {
  opacity: 0.45;
  cursor: default;
}
.sdoc-gate {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 14px;
  background: rgba(245, 158, 11, 0.12);
  border-top: 1px solid rgba(251, 191, 36, 0.35);
  flex-shrink: 0;
}
.sdoc-gate span {
  font-size: 12px;
  color: var(--color-warning);
  line-height: 1.4;
}
.sdoc-gate button {
  flex-shrink: 0;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 8px;
  background: #f59e0b;
  color: #111;
  font-weight: 700;
}
.sdoc-extracts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 100%;
}
.sdoc-extracts button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.sdoc-ok {
  padding: 8px 14px;
  font-size: 11px;
  color: var(--color-success);
  border-top: 1px solid rgba(16, 185, 129, 0.25);
  flex-shrink: 0;
}
.hndl {
  width: 8px;
  height: 8px;
  background: var(--color-accent);
  border: 1px solid #fff;
}
.rz {
  position: absolute;
  z-index: 4;
}
.rz-e {
  top: 28px;
  right: 0;
  width: 8px;
  height: calc(100% - 36px);
  cursor: ew-resize;
}
.rz-s {
  left: 0;
  bottom: 0;
  width: calc(100% - 14px);
  height: 8px;
  cursor: ns-resize;
}
.rz-se {
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
}
.rz-se::after {
  content: '';
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--color-text-3);
  border-bottom: 2px solid var(--color-text-3);
}
.prompt {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  max-height: 60%;
  margin: 0 12px 10px;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 10px 12px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
}
.prompt-fields {
  min-height: 0;
  overflow: auto;
}
.prompt-fields > label {
  display: block;
  margin: 0 0 4px;
  font-size: 10px;
  color: var(--color-text-4);
}
.prompt textarea {
  width: 100%;
  min-height: 72px;
  margin: 0 0 8px;
  resize: vertical;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text-1);
  font-size: 12px;
  line-height: 1.5;
  font-family: inherit;
}
.prompt-hint {
  margin: 0 0 8px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--color-text-4);
}
.prompt-foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  flex-shrink: 0;
  gap: 8px;
  margin-top: 2px;
}
.model-pick {
  flex: 0 0 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
}
.model-pick span {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--color-text-4);
}
.model-pick select {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 26px 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background-color: var(--color-bg-1);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path fill='%23ececef' d='M1.2 1.2L6 6l4.8-4.8' stroke='%23ececef' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 10px;
  color: var(--color-text-1);
  font-size: 11px;
  appearance: none;
}
.prompt-foot .ghost {
  flex-shrink: 0;
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-2);
  font-size: 11px;
  cursor: pointer;
}
.prompt-foot .ghost:disabled,
.prompt-foot .go:disabled {
  opacity: 0.4;
  cursor: default;
}
.prompt-foot .go {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: #ececef;
  color: #111;
  font-size: 16px;
  cursor: pointer;
}
.float-down-enter-active,
.float-down-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.float-down-enter-from,
.float-down-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
