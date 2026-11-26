<script setup lang="ts">
import { t as translate } from '@/i18n'

import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useToastStore, useAssetsStore, useSettingsStore } from '@/stores'
import { parseSRT, renderCaptionPng, toSRT } from '@/services/ffmpeg'
import { openAiShotSpeech } from '@/services/ai/shotSpeech'
import { isOpenAiTts, OPENAI_TTS_VOICES } from '@/services/ai/openAiTts'
import { generateSpeech, TTS_VOICES } from '@/services/ai'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import Tag from '@/components/common/Tag.vue'
import TtsModelSelect from '@/components/settings/TtsModelSelect.vue'
import type { CaptionStyle, Shot, ShotAudioMode } from '@/types'
import { ensureTimelineFromShots } from '@/utils/timeline'
import { buildTimelineCaptionCues, clipCaptionDuration } from '@/utils/timeline'
import { effectiveShotAudioMode, isDigitalHumanSpeechProject, isLipSyncShot, shotLipSyncDuration, shotPlaybackDuration } from '@/utils/shot'

const router = useRouter()
const project = useProjectStore()
const toast = useToastStore()
const assets = useAssetsStore()
const settings = useSettingsStore()
const openAi = computed(() => isOpenAiTts(settings.config.tts))
const voices = computed(() => openAi.value
  ? OPENAI_TTS_VOICES.map((id) => ({ id, label: id }))
  : TTS_VOICES)

const srtText = ref('')
const audioUrls = ref<Record<string, string>>({})
const generating = ref<Set<string>>(new Set())
const generatingAll = ref(false)
const showSrt = ref(false)

const isDigitalHuman = computed(() => isDigitalHumanSpeechProject(project.current))

onMounted(async () => {
  if (project.current?.captionSrt?.trim()) {
    srtText.value = project.current.captionSrt
  } else {
    buildFromTimeline()
  }
  if (!isDigitalHuman.value) await loadAudios()
  nextTick(() => drawPreview())
})

const timeline = computed(() => project.current?.timeline ?? [])
const shots = computed(() => project.current?.shots ?? [])
const style = computed<CaptionStyle>(() => project.current?.settings.captionStyle!)
const burnCaptions = computed({
  get: () => project.current?.settings.burnCaptions !== false,
  set: (v: boolean) => project.setSettings({ burnCaptions: v })
})
const captionHighlight = computed({
  get: () => project.current?.settings.captionHighlight === true,
  set: (v: boolean) => {
    project.setSettings({ captionHighlight: v })
    nextTick(() => drawPreview())
  }
})
const highlightColor = computed({
  get: () => project.current?.settings.captionHighlightColor || '#ffd84d',
  set: (v: string) => {
    project.setSettings({ captionHighlightColor: v })
    nextTick(() => drawPreview())
  }
})
const highlightScale = computed({
  get: () => project.current?.settings.captionHighlightScale ?? 1.2,
  set: (v: number) => {
    project.setSettings({ captionHighlightScale: v })
    nextTick(() => drawPreview())
  }
})
const ttsVoice = computed({
  get: () => {
    const v = project.current?.settings.ttsVoice
    return voices.value.some((x) => x.id === v) ? v! : openAi.value ? '' : 'longanhuan_v3.6'
  },
  set: (v: string) => project.setSettings({ ttsVoice: v })
})

const lines = computed(() => {
  const clips = timeline.value.filter((c) => c.enabled)
  if (clips.length > 0) {
    return clips.map((c, i) => {
      const shot = shots.value.find((s) => s.id === c.shotId)
      return {
        key: c.id,
        shotId: c.shotId,
        index: (shot?.index ?? i) + 1,
        title: shot?.title || translate('caption.clipNumber', { p0: i + 1 }),
        start: c.startTime,
        duration: project.current ? clipCaptionDuration(project.current, c) : c.duration,
        text: shot?.voiceover ?? '',
        audioAssetId: shot?.audioAssetId,
        shot
      }
    })
  }
  let t = 0
  return shots.value.map((shot) => {
    const start = t
    const duration = shotPlaybackDuration(shot)
    t += duration
    return {
      key: shot.id,
      shotId: shot.id,
      index: shot.index + 1,
      title: shot.title,
      start,
      duration,
      text: shot.voiceover,
      audioAssetId: shot.audioAssetId,
      shot
    }
  })
})

const voicedCount = computed(
  () => lines.value.filter((l) => {
    if (!l.shot || !l.text.trim()) return false
    const mode = effectiveShotAudioMode(l.shot)
    return shotLipSyncDuration(l.shot) !== undefined || mode === 'h3-dialogue' || mode === 'h3-voiceover' || (mode === 'tts' && Boolean(l.audioAssetId))
  }).length
)
const pendingVoice = computed(
  () => lines.value.filter((l) => l.shot && !isLipSyncShot(l.shot) && effectiveShotAudioMode(l.shot) === 'tts' && l.text.trim() && !l.audioAssetId).length
)

const cues = computed(() => {
  if (!srtText.value.trim()) return []
  try {
    return parseSRT(srtText.value)
  } catch {
    return []
  }
})

watch(srtText, (v) => {
  project.setCaptionSrt(v)
})

async function loadAudios() {
  for (const s of shots.value) {
    if (s.audioAssetId) {
      const url = await assets.getUrl(s.audioAssetId)
      if (url) audioUrls.value[s.id] = url
    }
  }
}

function formatClock(sec: number) {
  const m = Math.floor(Math.max(0, sec) / 60)
  const s = Math.floor(Math.max(0, sec) % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function rebuildSrtFromLines() {
  const next = lines.value.map((l, i) => ({
    id: i + 1,
    start: l.start,
    end: l.start + l.duration,
    text: l.text.trim()
  }))
  srtText.value = toSRT(next)
  project.setCaptionSrt(srtText.value)
  nextTick(() => drawPreview())
}

function updateLineText(shotId: string, text: string) {
  project.updateShot(shotId, { voiceover: text })
  rebuildSrtFromLines()
}

function changeAudioMode(shot: Shot, mode: ShotAudioMode) {
  if (effectiveShotAudioMode(shot) === mode) return
  const hadVideo = Boolean(shot.videoAssetId)
  project.setShotAudioMode(shot.id, mode)
  if (hadVideo) toast.info(translate('caption.modeChanged', { p0: shot.index + 1 }), 6000)
}

function isStale(shot: Shot | undefined) {
  if (!shot?.audioAssetId) return false
  const meta = assets.getMeta(shot.audioAssetId)
  if (!meta?.prompt) return false
  return meta.prompt.trim() !== (shot.voiceover || '').trim()
}

async function saveVoiceover(shot: Shot, blob: Blob, mimeType: string, text: string) {
  const typed = blob.type.startsWith('audio/') ? blob : new Blob([blob], { type: mimeType || 'audio/mpeg' })
  const asset = await assets.add(typed, 'audio', 'ai-generated', {
    filename: `vo_${shot.index + 1}_${Date.now().toString(36)}`,
    prompt: text,
    projectId: project.current?.id,
    shotId: shot.id
  })
  project.assignShotAudio(shot.id, asset.id)
  await project.save()
  const url = await assets.getUrl(asset.id)
  if (url) audioUrls.value[shot.id] = url
}

async function generateLine(shotId: string) {
  if (isDigitalHuman.value) {
    toast.info(translate('caption.digitalSpeechHint'))
    return
  }
  const shot = shots.value.find((s) => s.id === shotId)
  if (!shot || isLipSyncShot(shot)) return
  const text = shot.voiceover.trim()
  if (!text) {
    toast.warn(translate('caption.clipMissingDialogue', { p0: shot.index + 1 }))
    return
  }
  if (effectiveShotAudioMode(shot) !== 'tts') {
    const hadVideo = Boolean(shot.videoAssetId)
    project.setShotAudioMode(shot.id, 'tts')
    if (hadVideo) toast.info(translate('caption.ttsChanged', { p0: shot.index + 1 }), 6000)
  }
  generating.value.add(shotId)
  try {
    const speech = openAi.value && project.current ? openAiShotSpeech(shot, project.current) : { text, voice: ttsVoice.value }
    const result = await generateSpeech(speech)
    await saveVoiceover(shot, result.blob, result.mimeType, text)
    toast.success(translate('caption.clipVoiceReady', { p0: shot.index + 1 }))
  } catch (e: any) {
    toast.error(translate('caption.clipVoiceFailed', { p0: shot.index + 1, p1: e.message }), 8000)
  } finally {
    generating.value.delete(shotId)
  }
}

async function generateAllVoices() {
  if (isDigitalHuman.value) {
    toast.info(translate('caption.digitalSpeechHint'))
    return
  }
  const todo = lines.value.filter((l) => l.shot && !isLipSyncShot(l.shot) && l.text.trim())
  if (todo.length === 0) {
    toast.warn(translate('caption.noDialogueToVoice'))
    return
  }
  generatingAll.value = true
  let ok = 0
  try {
    const seen = new Set<string>()
    for (const line of todo) {
      if (seen.has(line.shotId)) continue
      seen.add(line.shotId)
      await generateLine(line.shotId)
      if (shots.value.find((s) => s.id === line.shotId)?.audioAssetId) ok++
    }
    toast.success(translate('caption.voicesGenerated', { p0: ok }))
  } finally {
    generatingAll.value = false
  }
}

function buildFromTimeline() {
  if (!project.current) return
  const parsed = buildTimelineCaptionCues(project.current)
  srtText.value = toSRT(parsed)
  project.setCaptionSrt(srtText.value)
  const empty = parsed.filter((c) => !c.text.trim()).length
  if (parsed.length === 0) {
    toast.warn(translate('caption.emptySrt'))
  } else if (empty === parsed.length) {
    toast.warn(translate('caption.dialogueEmpty'))
  }
}

function importSRT() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.srt,.vtt'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    const text = await file.text()
    srtText.value = text
    const parsed = parseSRT(text)
    parsed.forEach((cue, i) => {
      const line = lines.value[i]
      if (line?.shotId) project.updateShot(line.shotId, { voiceover: cue.text })
    })
    toast.success(translate('caption.imported', { p0: file.name }))
  }
  input.click()
}

function exportSRT() {
  if (!srtText.value.trim()) {
    toast.warn(translate('caption.noCaptions'))
    return
  }
  const blob = new Blob([srtText.value], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${project.current?.name ?? 'captions'}.srt`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function updateStyle(patch: Partial<CaptionStyle>) {
  if (!project.current) return
  project.setSettings({
    captionStyle: { ...project.current.settings.captionStyle, ...patch }
  })
  nextTick(() => drawPreview())
}

const previewCanvas = ref<HTMLCanvasElement | null>(null)
let previewSequence = 0

async function drawPreview() {
  if (!previewCanvas.value) return
  const sequence = ++previewSequence
  const canvas = previewCanvas.value
  const ctx = canvas.getContext('2d')!
  const w = canvas.width
  const h = canvas.height

  ctx.fillStyle = '#1a1a1e'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#121214'
  ctx.fillRect(20, 20, w - 40, h - 40)

  const text =
    lines.value.find((l) => l.text.trim())?.text ||
    srtText.value.split('\n').find((l) => l && !/^\d+$/.test(l) && !l.includes('-->')) ||
    translate('caption.previewText')
  const overlay = await renderCaptionPng(
    text,
    style.value,
    w,
    h,
    !!project.current?.settings.captionBg,
    {
      enabled: captionHighlight.value,
      color: highlightColor.value,
      scale: highlightScale.value
    }
  )
  if (sequence !== previewSequence || overlay.size === 0) return
  const bitmap = await createImageBitmap(overlay)
  if (sequence === previewSequence) ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
}

function next() {
  if (project.current) {
    const { built, clips } = ensureTimelineFromShots(project.current)
    if (built) project.setTimeline(clips)
  }
  project.setCaptionSrt(srtText.value)
  if (!isDigitalHuman.value && pendingVoice.value > 0) {
    toast.warn(translate('caption.missingVoice', { p0: pendingVoice.value }))
  }
  router.push('/export')
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>{{ $t('caption.textPanel') }}</h1>
        <p v-if="isDigitalHuman">{{ $t('caption.importedAudioHint') }}</p>
        <p v-else>{{ $t('caption.workflowHint') }}</p>
        <p v-if="openAi && !isDigitalHuman">{{ $t('openAiTts.generatedVoiceHint') }}</p>
      </div>
      <div class="head-actions">
        <template v-if="!isDigitalHuman">
          <label class="voice-pick">
            <TtsModelSelect />
          </label>
          <label class="voice-pick">
            <span>{{ $t('common.voice') }}</span>
            <select v-model="ttsVoice" class="input" style="width: auto; min-width: 160px;">
              <option v-if="openAi" value="">{{ $t('openAiTts.connectionVoice') }}</option>
              <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.label }}</option>
            </select>
          </label>
        </template>
        <GradientButton type="ghost" @click="router.push('/edit')">{{ $t('common.previousStep') }}</GradientButton>
        <GradientButton
          v-if="!isDigitalHuman"
          icon="🎙"
          :loading="generatingAll"
          :disabled="generatingAll || lines.every((l) => !l.text.trim())"
          @click="generateAllVoices"
        >
          {{ generatingAll ? $t('caption.generating') : $t('caption.generateAllTts') }}
        </GradientButton>
        <GradientButton icon="→" @click="next">{{ $t('caption.next') }}</GradientButton>
      </div>
    </header>

    <div class="layout">
      <main class="left">
        <GlassCard v-if="isDigitalHuman" padding="md">
          <div class="card-head">
            <h3>{{ $t('caption.text') }}</h3>
            <div class="head-tools">
              <button class="mini-btn" @click="buildFromTimeline">{{ $t('caption.syncStoryboard') }}</button>
            </div>
          </div>
          <p class="cue-hint">{{ $t('caption.embeddedAudioHint') }}</p>
          <p v-if="lines.length === 0" class="cue-hint">{{ $t('caption.empty') }}</p>
          <div v-else class="line-list">
            <div v-for="line in lines" :key="line.key" class="line-card">
              <div class="line-head">
                <div class="shot-num">{{ line.index }}</div>
                <div class="line-meta">
                  <div class="line-title">{{ line.title }}</div>
                  <div class="line-time">{{ formatClock(line.start) }} · {{ line.duration }}s</div>
                </div>
              </div>
              <textarea
                class="line-text"
                rows="3"
                :value="line.text"
                :placeholder="$t('caption.burnPlaceholder')"
                @input="updateLineText(line.shotId, ($event.target as HTMLTextAreaElement).value)"
              />
            </div>
          </div>
        </GlassCard>
        <GlassCard v-else padding="md">
          <div class="card-head">
            <h3>{{ $t('caption.voiceoverPanel') }}</h3>
            <div class="head-tools">
              <Tag size="sm" type="success">{{ $t('caption.voiced') }} {{ voicedCount }}/{{ lines.length }}</Tag>
              <button class="mini-btn" @click="buildFromTimeline">{{ $t('caption.syncStoryboard') }}</button>
            </div>
          </div>
          <p v-if="lines.length === 0" class="cue-hint">{{ $t('caption.empty') }}</p>
          <div v-else class="line-list">
            <div v-for="line in lines" :key="line.key" class="line-card">
              <div class="line-head">
                <div class="shot-num">{{ line.index }}</div>
                <div class="line-meta">
                  <div class="line-title">{{ line.title }}</div>
                  <div class="line-time">{{ formatClock(line.start) }} · {{ line.duration }}s</div>
                </div>
                <Tag v-if="line.shot && isLipSyncShot(line.shot)" :type="shotLipSyncDuration(line.shot) !== undefined ? 'success' : 'warning'" size="sm">
                  {{ $t(shotLipSyncDuration(line.shot) !== undefined ? 'lipSync.embedded' : 'lipSync.pending') }}
                </Tag>
                <Tag v-else-if="line.shot && effectiveShotAudioMode(line.shot) === 'h3-dialogue'" type="success" size="sm">{{ $t('caption.h3Dialogue') }}</Tag>
                <Tag v-else-if="line.shot && effectiveShotAudioMode(line.shot) === 'h3-voiceover'" type="success" size="sm">{{ $t('caption.h3Voiceover') }}</Tag>
                <Tag v-else-if="line.shot && effectiveShotAudioMode(line.shot) === 'none'" size="sm">{{ $t('common.noNarration') }}</Tag>
                <Tag v-else-if="line.audioAssetId && !isStale(line.shot)" type="success" size="sm">{{ $t('caption.ttsReady') }}</Tag>
                <Tag v-else-if="isStale(line.shot)" type="warning" size="sm">{{ $t('caption.ttsModified') }}</Tag>
                <Tag v-else-if="line.text.trim()" size="sm">{{ $t('caption.ttsPending') }}</Tag>
                <Tag v-else type="error" size="sm">{{ $t('caption.noDialogue') }}</Tag>
              </div>
              <textarea
                class="line-text"
                rows="3"
                :value="line.text"
                :placeholder="$t('caption.dialoguePlaceholder')"
                @input="updateLineText(line.shotId, ($event.target as HTMLTextAreaElement).value)"
              />
              <label class="voice-pick">
                <span>{{ $t('caption.voiceMode') }}</span>
                <select
                  class="input"
                  :value="line.shot ? effectiveShotAudioMode(line.shot) : 'none'"
                  @change="line.shot && changeAudioMode(line.shot, ($event.target as HTMLSelectElement).value as ShotAudioMode)"
                >
                  <option value="h3-dialogue" :disabled="line.shot && !project.shotSupportsVideoVoice(line.shot)">{{ $t('common.h3Dialogue') }}</option>
                  <option value="h3-voiceover" :disabled="line.shot && !project.shotSupportsVideoVoice(line.shot)">{{ $t('caption.h3Offscreen') }}</option>
                  <option value="ltx-lip-sync" :disabled="!line.shot || !project.shotSupportsLipSync(line.shot)">{{ $t('lipSync.mode') }}</option>
                  <option value="tts">{{ $t('common.postTts') }}</option>
                  <option value="none">{{ $t('common.noNarration') }}</option>
                </select>
              </label>
              <p v-if="line.shot && !project.shotSupportsVideoVoice(line.shot)">{{ $t('common.videoVoiceUnsupported') }}</p>
              <audio v-if="audioUrls[line.shotId]" class="vo-player" :src="audioUrls[line.shotId]" controls />
              <div class="line-actions">
                <GradientButton
                  size="sm"
                  :loading="generating.has(line.shotId)"
                  :disabled="!line.text.trim() || generating.has(line.shotId) || Boolean(line.shot && isLipSyncShot(line.shot))"
                  @click="generateLine(line.shotId)"
                >
                  {{ line.audioAssetId ? $t('caption.regenerateVoice') : $t('caption.generateVoice') }}
                </GradientButton>
              </div>
            </div>
          </div>
        </GlassCard>

        <GlassCard padding="md">
          <div class="card-head">
            <h3>{{ $t('caption.srtPanel') }}</h3>
            <div class="head-tools">
              <label class="check">
                <input v-model="burnCaptions" type="checkbox" />
                <span>{{ $t('caption.burn') }}</span>
              </label>
              <label class="check">
                <input v-model="captionHighlight" type="checkbox" />
                <span>{{ $t('common.autoDelineate') }}</span>
              </label>
              <button class="mini-btn" @click="showSrt = !showSrt">{{ showSrt ? $t('common.collapse') : $t('caption.expandEdit') }}</button>
              <button class="mini-btn" @click="importSRT">{{ $t('common.import') }}</button>
              <button class="mini-btn" @click="exportSRT">{{ $t('common.export') }}</button>
            </div>
          </div>
          <textarea
            v-show="showSrt"
            v-model="srtText"
            class="srt-area"
            rows="14"
            :placeholder="$t('caption.srtHint')"
            @input="drawPreview"
          />
          <div class="cue-info">
            <Tag size="sm" type="accent">{{ cues.length }} {{ $t('caption.captionCount') }}</Tag>
            <span class="cue-hint">{{ $t('caption.syncSrt') }}</span>
          </div>
        </GlassCard>
      </main>

      <aside class="right">
        <GlassCard padding="md">
          <h3>{{ $t('caption.previewPanel') }}</h3>
          <canvas
            ref="previewCanvas"
            width="640"
            height="360"
            class="preview-canvas"
            @load="drawPreview"
          />
          <button class="refresh-btn" @click="drawPreview">{{ $t('caption.refresh') }}</button>
        </GlassCard>

        <GlassCard padding="md">
          <h3>{{ $t('caption.fontStyle') }}</h3>
          <label class="field">
            <span>{{ $t('common.font') }}</span>
            <select
              :value="style.fontFamily"
              @change="updateStyle({ fontFamily: ($event.target as HTMLSelectElement).value })"
              class="input"
            >
              <option value="Noto Sans CJK SC">{{ $t('caption.sourceHanSans') }}</option>
              <option value="Noto Serif CJK SC">{{ $t('caption.sourceHanSerif') }}</option>
              <option value="sans-serif">{{ $t('caption.sansSerif') }}</option>
              <option value="serif">{{ $t('caption.serif') }}</option>
              <option value="monospace">{{ $t('caption.monospace') }}</option>
            </select>
          </label>

          <label class="field">
            <span>{{ $t('caption.fontSize') }}</span>
            <div class="row">
              <input
                type="range"
                min="0.02"
                max="0.12"
                step="0.005"
                :value="style.fontSizeRatio"
                @input="updateStyle({ fontSizeRatio: Number(($event.target as HTMLInputElement).value) })"
                class="range"
              />
              <span class="num-text">{{ Math.round(style.fontSizeRatio * 100) }}%</span>
            </div>
          </label>

          <label class="field row-field">
            <span>{{ $t('common.color') }}</span>
            <input
              type="color"
              :value="style.color"
              @change="updateStyle({ color: ($event.target as HTMLInputElement).value })"
              class="color"
            />
            <input
              type="text"
              :value="style.color"
              @change="updateStyle({ color: ($event.target as HTMLInputElement).value })"
              class="input small"
            />
          </label>

          <label class="field row-field">
            <span>{{ $t('caption.keyword') }}</span>
            <input v-model="highlightColor" type="color" class="color" :disabled="!captionHighlight" />
            <input
              v-model="highlightColor"
              type="text"
              class="input small"
              :disabled="!captionHighlight"
            />
          </label>

          <label class="field">
            <span>{{ $t('caption.enlargeKeywords') }}</span>
            <div class="row">
              <input
                v-model.number="highlightScale"
                type="range"
                min="1.05"
                max="1.5"
                step="0.05"
                class="range"
                :disabled="!captionHighlight"
              />
              <span class="num-text">{{ Math.round(highlightScale * 100) }}%</span>
            </div>
          </label>

          <label class="field">
            <span>{{ $t('caption.strokeWidth') }}</span>
            <div class="row">
              <input
                type="range"
                min="0"
                max="8"
                step="1"
                :value="style.strokeWidth"
                @input="updateStyle({ strokeWidth: Number(($event.target as HTMLInputElement).value) })"
                class="range"
              />
              <span class="num-text">{{ style.strokeWidth }}px</span>
            </div>
          </label>

          <label class="field row-field">
            <span>{{ $t('caption.strokeColor') }}</span>
            <input
              type="color"
              :value="style.strokeColor"
              @change="updateStyle({ strokeColor: ($event.target as HTMLInputElement).value })"
              class="color"
            />
            <input
              type="checkbox"
              :checked="style.bold"
              @change="updateStyle({ bold: ($event.target as HTMLInputElement).checked })"
            />
            <span>{{ $t('caption.bold') }}</span>
          </label>
        </GlassCard>

        <GlassCard padding="md">
          <h3>{{ $t('caption.position') }}</h3>
          <div class="position-grid">
            <button
              v-for="p in ['top', 'center', 'bottom'] as const"
              :key="p"
              class="pos-pick"
              :class="{ active: style.position === p }"
              @click="updateStyle({ position: p })"
            >
              <div class="pos-icon" :data-pos="p">
                <div class="pos-line" />
              </div>
              <span>{{ { top: $t('common.top'), center: $t('common.center'), bottom: $t('common.bottom') }[p] }}</span>
            </button>
          </div>

          <label class="field" style="margin-top: 12px">
            <span>{{ $t('caption.background') }}</span>
            <div class="row">
              <input
                type="checkbox"
                :checked="project.current?.settings.captionBg"
                @change="project.current && project.setSettings({ captionBg: ($event.target as HTMLInputElement).checked })"
              />
              <span>{{ $t('caption.backgroundHint') }}</span>
            </div>
          </label>
        </GlassCard>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--space-6);
  max-width: 1400px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--space-5);
  gap: var(--space-4);
  flex-wrap: wrap;
}
.page-head h1 {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 var(--space-1);
}
.page-head p {
  font-size: 13px;
  color: var(--color-text-3);
  margin: 0;
}
.head-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.layout {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: var(--space-4);
}
.left, .right {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-3);
}
.card-head h3 {
  font-size: 13px;
  margin: 0;
  font-weight: 600;
}
.head-tools {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.voice-pick {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-3);
}
.line-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.line-card {
  padding: 10px 12px;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.line-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.shot-num {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  background: var(--grad-primary);
  color: white;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.line-meta {
  flex: 1;
  min-width: 0;
}
.line-title {
  font-size: 13px;
  font-weight: 600;
}
.line-time {
  font-size: 11px;
  color: var(--color-text-4);
}
.line-text {
  width: 100%;
  resize: vertical;
  min-height: 64px;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-1);
  font-size: 13px;
  line-height: 1.55;
  padding: 8px;
  font-family: inherit;
}
.line-text:focus {
  outline: none;
  border-color: var(--color-accent);
}
.vo-player {
  width: 100%;
  margin-top: 8px;
  height: 32px;
}
.line-actions {
  margin-top: 8px;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-2);
}
.mini-btn {
  font-size: 11px;
  color: var(--color-accent-2);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}
.mini-btn:hover {
  background: var(--grad-primary-soft);
}
.srt-area {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--color-text-1);
  outline: none;
  resize: vertical;
  line-height: 1.6;
}
.srt-area:focus {
  border-color: var(--color-accent);
}
.cue-info {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.cue-hint {
  font-size: 11px;
  color: var(--color-text-4);
}

.right h3 {
  font-size: 13px;
  margin: 0 0 var(--space-3);
  font-weight: 600;
}
.preview-canvas {
  width: 100%;
  height: auto;
  border-radius: var(--radius-md);
  display: block;
  background: #000;
}
.refresh-btn {
  margin-top: var(--space-2);
  font-size: 11px;
  color: var(--color-text-3);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}
.refresh-btn:hover {
  background: var(--color-fill);
  color: var(--color-text-1);
}

.field {
  margin-bottom: var(--space-3);
}
.field > span {
  display: block;
  font-size: 11px;
  color: var(--color-text-3);
  margin-bottom: 4px;
  font-weight: 500;
}
.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.row-field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.row-field > span:first-child {
  flex: 0 0 50px;
  margin-bottom: 0;
}
.input {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-text-1);
  outline: none;
}
.input.small {
  width: 80px;
  flex: 1;
}
.range {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  background: var(--color-bg-2);
  border-radius: var(--radius-full);
  outline: none;
}
.range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--grad-primary);
  cursor: pointer;
}
.range::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--grad-primary);
  cursor: pointer;
  border: none;
}
.num-text {
  width: 50px;
  font-size: 11px;
  text-align: right;
  color: var(--color-text-2);
  font-variant-numeric: tabular-nums;
}
.color {
  width: 36px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  cursor: pointer;
}

.position-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
}
.pos-pick {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--color-text-2);
  transition: all var(--duration-fast);
}
.pos-pick:hover {
  border-color: var(--color-border-strong);
}
.pos-pick.active {
  background: var(--grad-primary-soft);
  border-color: var(--color-accent);
  color: var(--color-text-1);
}
.pos-icon {
  width: 32px;
  height: 24px;
  background: var(--color-fill);
  border-radius: 2px;
  position: relative;
}
.pos-line {
  position: absolute;
  left: 4px;
  right: 4px;
  height: 2px;
  background: var(--color-text-2);
}
.pos-icon[data-pos='top'] .pos-line { top: 4px; }
.pos-icon[data-pos='center'] .pos-line { top: 50%; transform: translateY(-50%); }
.pos-icon[data-pos='bottom'] .pos-line { bottom: 4px; }
</style>
