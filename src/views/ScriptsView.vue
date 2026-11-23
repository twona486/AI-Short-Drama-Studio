<script setup lang="ts">
import { confirmAction } from '@/utils/confirmAction'
import { t as translate } from '@/i18n'
/**
 * 剧本管理
 *
 * 左侧剧本列表（本地 Markdown 档案），右侧编辑器：
 * - 按集编辑：改标题、改正文、增删排序
 * - Markdown 全文 / 预览：直接改整份 md
 * 每份剧本都会落到 保存目录/_scripts/<id>.md，可在资源库里复用。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useScriptsStore, useSettingsStore, useToastStore } from '@/stores'
import { llmModelGroups } from '@/stores/settings'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import Tag from '@/components/common/Tag.vue'
import { pickPlayMarkdownFile } from '@/utils/pickPlayFile'
import { markdownToHtml } from '@/utils/markdown'
import { parseScriptDoc, toEpisodes, updateEpisode } from '@/utils/scriptEpisodes'
import { VISUAL_STYLE_LABEL } from '@/utils/visualStyle'
import { generatePlay } from '@/services/ai'
import type { ScriptEpisode, VisualStyle } from '@/types'

type EditorTab = 'episodes' | 'markdown' | 'preview'

const router = useRouter()
const scripts = useScriptsStore()
const project = useProjectStore()
const settings = useSettingsStore()
const toast = useToastStore()

const keyword = ref('')
const activeId = ref('')
const activeTab = ref<EditorTab>('episodes')
const markdown = ref('')
const dirty = ref(false)
const saving = ref(false)
const activeEpisodeIndex = ref(0)
const titleEditing = ref('')
/** 当前展开那一集的编辑草稿（避免边打字边被 Markdown 规范化打断） */
const draft = ref<{ index: number; title: string; content: string } | null>(null)

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

/** 把某一集读进草稿 */
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

async function select(id: string) {
  if (id === activeId.value) return
  if (dirty.value && !(await confirmDiscard())) return
  flushDraft()
  activeId.value = id
  await loadContent(id)
}

function confirmDiscard() {
  return confirmAction(translate('scripts.unsavedConfirm'))
}

function markDirty() {
  dirty.value = true
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 草稿改动后 0.8 秒写回 Markdown 并落盘 */
function scheduleFlush() {
  dirty.value = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushDraft, 800)
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

/** 改某一集的标题：写草稿，延迟回流到 Markdown */
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
  await loadContent(doc.id, true)
  activeTab.value = 'episodes'
  toast.success(translate('scripts.created'))
}

/* ── AI 写剧本：直接在这里提要求，写完自动入库 ── */
const llmGroups = computed(() => llmModelGroups(settings.config.llms ?? []))
const llmModel = computed(() => settings.config.llm.model)
const genOpen = ref(false)
const genTopic = ref('')
const genBrief = ref('')
const genStyle = ref<VisualStyle>('cinematic')
const genDuration = ref(0)
const generating = ref(false)
const genProgress = ref('')
let genAbort: AbortController | null = null

const styleOptions = (Object.keys(VISUAL_STYLE_LABEL) as VisualStyle[]).map((key) => ({
  value: key,
  label: VISUAL_STYLE_LABEL[key]
}))

/* 目标成片时长：直接决定剧本规模和后面拆多少镜 */
const durationOptions = [30, 40, 60, 90, 120, 180]
const durationScenes = (sec: number) => Math.max(2, Math.min(6, Math.round(sec / 15)))
const durationChars = (sec: number) => Math.max(400, Math.round(sec * 18))
const durationShots = (sec: number) => Math.max(1, Math.ceil(sec / 8))

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

function openGenerate() {
  genOpen.value = true
  genProgress.value = ''
}

function closeGenerate() {
  if (generating.value) return
  genOpen.value = false
}

async function submitGenerate() {
  if (generating.value) return
  const topic = genTopic.value.trim()
  const brief = genBrief.value.trim()
  if (!topic && !brief) {
    toast.warn(translate('scripts.needDirection'))
    return
  }
  if (!llmModel.value) {
    toast.warn(translate('scripts.needModel'))
    return
  }
  generating.value = true
  genProgress.value = translate('scripts.generating')
  genAbort = new AbortController()
  try {
    const run = await generatePlay(
      {
        topic: topic || translate('scripts.untitledName'),
        content: brief,
        style: genStyle.value,
        shotDuration: 5,
        aspectRatio: '16:9',
        targetDurationSec: genDuration.value || undefined,
        playMode: 'write',
        model: llmModel.value
      },
      (msg) => {
        genProgress.value = msg
      },
      genAbort.signal
    )
    if (!run.result.playMarkdown?.trim()) throw new Error(translate('scripts.noGeneratedContent'))
    genProgress.value = translate('scripts.savingLocally')
    const title = (run.result.topic || topic || translate('scripts.aiScript')).trim()
    const doc = await scripts.create({
      title,
      markdown: run.result.playMarkdown,
      source: 'ai-generated'
    })
    activeId.value = doc.id
    titleEditing.value = doc.title
    await loadContent(doc.id, true)
    activeTab.value = 'episodes'
    genOpen.value = false
    genTopic.value = ''
    genBrief.value = ''
    toast.success(translate('scripts.generated', { p0: doc.title }))
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    if (genAbort?.signal.aborted) toast.warn(translate('scripts.cancelled'))
    else toast.error(msg.startsWith(translate('common.writeScript')) ? msg : translate('scripts.writeFailed', { p0: msg }))
  } finally {
    generating.value = false
    genAbort = null
  }
}

function cancelGenerate() {
  genAbort?.abort()
}

async function importScript() {
  const picked = await pickPlayMarkdownFile()
  if (!picked) return
  try {
    const doc = await scripts.importMarkdown(picked.text, picked.filename)
    activeId.value = doc.id
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
  dirty.value = false
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
  <div class="page">
    <header class="page-head">
      <div>
        <div class="kicker">{{ $t('scripts.manage') }}</div>
        <h1>{{ $t('scripts.localLibrary') }}</h1>
        <p>
          {{ $t('scripts.libraryHint') }}
        </p>
      </div>
      <div class="head-actions">
        <GradientButton icon="✨" @click="openGenerate">{{ $t('scripts.aiWrite') }}</GradientButton>
        <GradientButton type="ghost" @click="router.push('/drafts')">{{ $t('common.resourceLibrary') }}</GradientButton>
        <GradientButton type="secondary" icon="📥" @click="importScript">{{ $t('common.importMarkdown') }}</GradientButton>
        <GradientButton type="secondary" icon="＋" @click="createScript">{{ $t('common.newScript') }}</GradientButton>
      </div>
    </header>

    <div class="body">
      <!-- 列表 -->
      <aside class="side">
        <div class="side-head">
          <input v-model="keyword" class="search" :placeholder="$t('scripts.search')" />
          <span class="count">{{ filteredDocs.length }} {{ $t('scripts.count') }}</span>
        </div>
        <div class="list">
          <div v-if="!filteredDocs.length" class="empty-mini">
            {{ $t('scripts.emptyLibraryHint') }}
          </div>
          <button
            v-for="d in filteredDocs"
            :key="d.id"
            class="script-item"
            :class="{ active: d.id === activeId }"
            @click="select(d.id)"
          >
            <div class="si-title">{{ d.title }}</div>
            <div class="si-meta">
              <Tag size="sm">{{ sourceLabel(d.source) }}</Tag>
              {{ d.episodeCount }} {{ $t('common.chapterUnitSeparator') }} {{ d.totalWords }} {{ $t('common.characters') }}
            </div>
            <div class="si-time">{{ fmtTime(d.updatedAt) }}</div>
          </button>
        </div>
        <button v-if="scripts.docs.length" class="side-foot" @click="scripts.openFolder()">
          {{ $t('scripts.openFolder') }}
        </button>
      </aside>

      <!-- 编辑区 -->
      <section class="editor">
        <GlassCard v-if="activeDoc" padding="none" class="editor-card">
          <div class="ed-head">
            <input
              v-model="titleEditing"
              class="title-input"
              @change="commitTitle"
              @keydown.enter.prevent="commitTitle"
            />
            <div class="ed-meta">
              <span>{{ episodes.length }} {{ $t('common.chapterUnit') }}</span>
              <span>·</span>
              <span>{{ totalWords }} {{ $t('common.characters') }}</span>
              <span>·</span>
              <span v-if="saving">{{ $t('common.saving') }}</span>
              <span v-else-if="dirty" class="unsaved">{{ $t('common.unsaved') }}</span>
              <span v-else>{{ $t('scripts.savedAt') }} {{ fmtTime(activeDoc.updatedAt) }}</span>
            </div>
            <div class="ed-actions">
              <button class="mini-btn" @click="downloadActive">{{ $t('scripts.exportMd') }}</button>
              <button class="mini-btn" @click="revealActive">{{ $t('scripts.openFile') }}</button>
              <button v-if="dirty" class="mini-btn primary" @click="saveNow">{{ $t('common.save') }}</button>
              <button class="mini-btn danger" @click="removeActive">{{ $t('common.delete') }}</button>
            </div>
          </div>

          <div class="tabs">
            <button :class="{ on: activeTab === 'episodes' }" @click="activeTab = 'episodes'">
              {{ $t('scripts.editEpisodes') }}
            </button>
            <button :class="{ on: activeTab === 'markdown' }" @click="activeTab = 'markdown'">
              {{ $t('scripts.markdownFull') }}
            </button>
            <button :class="{ on: activeTab === 'preview' }" @click="activeTab = 'preview'">
              {{ $t('common.preview') }}
            </button>
          </div>

          <div class="ed-body">
            <!-- 按集编辑 -->
            <div v-if="activeTab === 'episodes'" class="ep-list">
              <div
                v-for="(ep, i) in episodes"
                :id="`ep-${i}`"
                :key="ep.id"
                class="ep-card"
                :class="{ open: activeEpisodeIndex === i }"
              >
                <div class="ep-head" @click="openEpisode(i)">
                  <span class="ep-no">{{ i + 1 }}</span>
                  <input
                    class="ep-title"
                    :value="draft && draft.index === i ? draft.title : ep.title"
                    @input="onTitleInput(i, $event)"
                    @click.stop
                  />
                  <span class="ep-words">{{ ep.wordCount }} {{ $t('common.characters') }}</span>
                  <div class="ep-tools" @click.stop>
                    <button :title="$t('common.moveUp')" :disabled="i === 0" @click="moveEpisode(i, -1)">↑</button>
                    <button
                      :title="$t('common.moveDown')"
                      :disabled="i === episodes.length - 1"
                      @click="moveEpisode(i, 1)"
                    >
                      ↓
                    </button>
                    <button :title="$t('scripts.insertEpisode')" @click="insertEpisodeAfter(i)">＋</button>
                    <button :title="$t('scripts.deleteEpisode')" class="danger" @click="removeEpisode(i)">✕</button>
                  </div>
                </div>
                <textarea
                  v-if="draft && draft.index === i"
                  v-model="draft.content"
                  class="ep-body"
                  :placeholder="$t('scripts.episodePlaceholder')"
                  @input="scheduleFlush"
                />
              </div>
              <button class="add-ep" @click="addEpisode">{{ $t('scripts.newEpisode') }}</button>
            </div>

            <!-- 全文 -->
            <div v-else-if="activeTab === 'markdown'" class="md-wrap">
              <textarea
                v-model="markdown"
                class="md-editor"
                spellcheck="false"
                @input="markDirty"
              />
              <div class="md-foot">
                <button class="mini-btn" @click="saveNow">{{ $t('scripts.saveChanges') }}</button>
                <button class="mini-btn" @click="reloadFromDisk">{{ $t('scripts.reloadDisk') }}</button>
                <button class="mini-btn" @click="copyMarkdown">{{ $t('scripts.copyFull') }}</button>
              </div>
            </div>

            <!-- 预览 -->
            <div v-else class="preview" v-html="previewHtml" />
          </div>

          <div class="ed-foot">
            <span class="foot-tip">{{ $t('scripts.filePath') }}{{ activeDoc.filename }}</span>
            <GradientButton size="sm" type="primary" icon="→" @click="applyToProject">
              {{ $t('scripts.sendToProject') }}
            </GradientButton>
          </div>
        </GlassCard>

        <GlassCard v-else padding="lg" class="editor-card center">
          <div class="blank">
            <div class="blank-icon">📜</div>
            <div class="blank-title">{{ $t('scripts.emptyLibrary') }}</div>
            <div class="blank-desc">
              {{ $t('scripts.startHint') }}
            </div>
            <div class="blank-actions">
              <GradientButton icon="✨" @click="openGenerate">{{ $t('scripts.writeWithAi') }}</GradientButton>
              <GradientButton type="secondary" @click="createScript">{{ $t('scripts.createBlank') }}</GradientButton>
              <GradientButton type="ghost" @click="router.push('/studio')">{{ $t('scripts.openCanvas') }}</GradientButton>
            </div>
          </div>
        </GlassCard>
      </section>
    </div>

    <!-- AI 写剧本弹窗 -->
    <teleport to="body">
      <div v-if="genOpen" class="gen-mask" @click.self="closeGenerate">
        <div class="gen-modal">
          <div class="gen-head">
            <strong>{{ $t('scripts.aiWriteIcon') }}</strong>
            <button class="gen-close" :disabled="generating" :title="$t('common.close')" @click="closeGenerate">
              ✕
            </button>
          </div>
          <div class="gen-form">
            <label class="gen-label">{{ $t('scripts.subject') }}</label>
            <input
              v-model="genTopic"
              class="gen-input"
              :placeholder="$t('scripts.topicExample')"
              :disabled="generating"
            />
            <label class="gen-label">{{ $t('scripts.outline') }} <em>{{ $t('common.optional') }}</em></label>
            <textarea
              v-model="genBrief"
              class="gen-textarea"
              rows="5"
              :placeholder="$t('scripts.outlinePlaceholder')"
              :disabled="generating"
            />
            <div class="gen-row">
              <div class="gen-field">
                <label class="gen-label">{{ $t('common.targetDuration') }}</label>
                <select v-model.number="genDuration" class="gen-input" :disabled="generating">
                  <option :value="0">{{ $t('common.unlimitedDuration') }}</option>
                  <option v-for="s in durationOptions" :key="s" :value="s">{{ s }} {{ $t('common.seconds') }}</option>
                </select>
                <p class="gen-hint">
                  {{
                    genDuration
                      ? $t('scripts.budget', { p0: genDuration, p1: durationScenes(genDuration), p2: durationChars(genDuration), p3: durationShots(genDuration) })
                      : $t('scripts.unlimitedHint')
                  }}
                </p>
              </div>
              <div class="gen-field">
                <label class="gen-label">{{ $t('scripts.visualStyle') }}</label>
                <select v-model="genStyle" class="gen-input" :disabled="generating">
                  <option v-for="s in styleOptions" :key="s.value" :value="s.value">
                    {{ s.label }}
                  </option>
                </select>
              </div>
              <div class="gen-field">
                <label class="gen-label">{{ $t('common.model') }}</label>
                <select v-model="genChoice" class="gen-input" :disabled="generating">
                  <option v-if="!llmGroups.some((g) => g.models.length)" value="">
                    {{ $t('common.noModel') }}
                  </option>
                  <optgroup v-for="g in llmGroups" :key="g.id" :label="g.name">
                    <option v-for="m in g.models" :key="`${g.id}::${m}`" :value="`${g.id}::${m}`">
                      {{ m }}
                    </option>
                  </optgroup>
                </select>
              </div>
            </div>
            <p v-if="generating" class="gen-progress">{{ genProgress }}</p>
          </div>
          <div class="gen-foot">
            <button v-if="generating" class="mini-btn danger" @click="cancelGenerate">
              {{ $t('scripts.cancelGeneration') }}
            </button>
            <button v-else class="mini-btn" @click="closeGenerate">{{ $t('scripts.deferWriting') }}</button>
            <button
              class="mini-btn primary"
              :disabled="generating || !llmModel || (!genTopic.trim() && !genBrief.trim())"
              @click="submitGenerate"
            >
              {{ generating ? $t('scripts.writing') : $t('scripts.startWriting') }}
            </button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.page {
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-height: 100%;
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
  gap: var(--space-2);
  flex-wrap: wrap;
}

.body {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: var(--space-4);
  align-items: start;
  min-height: 0;
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
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-text-1);
  outline: none;
}
.search:focus {
  border-color: var(--color-accent);
}
.count {
  font-size: 11px;
  color: var(--color-text-4);
  flex-shrink: 0;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: calc(100vh - 260px);
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
  color: var(--color-text-3);
  padding: 6px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
}
.side-foot:hover {
  color: var(--color-text-1);
  background: var(--color-fill);
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
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);
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
  border-color: var(--color-accent);
  background: var(--color-bg-2);
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
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  color: var(--color-text-2);
  background: transparent;
  transition: all var(--duration-fast);
}
.mini-btn:hover:not(:disabled) {
  color: var(--color-text-1);
  border-color: var(--color-border-strong);
  background: var(--color-fill);
}
.mini-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.mini-btn.primary {
  border-color: rgba(126, 180, 255, 0.4);
  background: var(--grad-primary-soft);
  color: #b9cbff;
}
.mini-btn.danger:hover {
  color: var(--color-error);
  border-color: rgba(248, 113, 113, 0.4);
  background: rgba(248, 113, 113, 0.1);
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
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border-radius: 6px;
  background: var(--grad-primary-soft);
  color: var(--color-accent);
  font-size: 11px;
  font-weight: 700;
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
  font-size: 11px;
  color: var(--color-text-4);
  flex-shrink: 0;
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
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--color-border);
}
.foot-tip {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-4);
}

.empty-mini {
  text-align: center;
  color: var(--color-text-4);
  font-size: 12px;
  padding: var(--space-6) var(--space-3);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
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
  .body {
    grid-template-columns: 1fr;
  }
  .side {
    position: static;
  }
  .list {
    max-height: 220px;
  }
}

/* ── AI 写剧本弹窗 ── */
.gen-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(8, 10, 18, 0.55);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
}
.gen-modal {
  width: min(600px, 94vw);
  max-height: 88vh;
  overflow-y: auto;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
}
.gen-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--color-border);
}
.gen-head strong {
  font-size: 15px;
  color: var(--color-text-1);
}
.gen-close {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-3);
  cursor: pointer;
  font-size: 13px;
}
.gen-close:hover:not(:disabled) {
  background: var(--color-bg-2);
  color: var(--color-text-1);
}
.gen-close:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.gen-form {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.gen-label {
  font-size: 12px;
  color: var(--color-text-2);
  display: block;
}
.gen-label em {
  font-style: normal;
  color: var(--color-text-4);
}
.gen-input,
.gen-textarea {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-size: 13px;
  color: var(--color-text-1);
  outline: none;
  font-family: inherit;
  resize: vertical;
}
.gen-input:focus,
.gen-textarea:focus {
  border-color: var(--color-accent);
}
.gen-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  margin-top: 4px;
}
.gen-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.gen-hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-3, #8a93a6);
  line-height: 1.45;
}
.gen-progress {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--color-accent, #7eb4ff);
  line-height: 1.5;
}
.gen-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: 12px 18px;
  border-top: 1px solid var(--color-border);
}
@media (max-width: 640px) {
  .gen-row {
    grid-template-columns: 1fr;
  }
}
</style>
