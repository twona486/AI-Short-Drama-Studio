<script setup lang="ts">
import { t as translate } from '@/i18n'

import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useAssetsStore, useToastStore } from '@/stores'
import { exportVideo, parseSRT, buildCuesFromClips, probeMedia, trimTimelineBySpeech } from '@/services/ffmpeg'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import Tag from '@/components/common/Tag.vue'
import ProgressRing from '@/components/common/ProgressRing.vue'
import { canBuildExport, ensureTimelineFromShots, timelineClipAssetId } from '@/utils/timeline'
import { effectiveShotAudioMode, isDigitalHumanSpeechProject, needsExternalTts } from '@/utils/shot'

const router = useRouter()
const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()

const format = ref<'mp4' | 'webm'>('mp4')
const isDigitalHuman = computed(() => isDigitalHumanSpeechProject(project.current))
const burnCaptions = computed({
  get: () => project.current?.settings.burnCaptions !== false,
  set: (v: boolean) => project.setSettings({ burnCaptions: v })
})
const captionHighlight = computed({
  get: () => project.current?.settings.captionHighlight === true,
  set: (v: boolean) => project.setSettings({ captionHighlight: v })
})
const keepAmbientAudio = computed({
  get: () => project.current?.settings.keepAmbientAudio !== false,
  set: (v: boolean) => project.setSettings({ keepAmbientAudio: v })
})

const ambientVolume = computed({
  get: () => project.current?.settings.originalVolume ?? 0.55,
  set: (v: number) => project.setSettings({ originalVolume: v })
})
const exporting = ref(false)
const progress = ref(0)
const progressMsg = ref('')
const resultUrl = ref<string | null>(null)
const resultSize = ref(0)

const isSpeech = computed(() => project.current?.pipelineMode === 'smart-speech')

onMounted(async () => {
  await assets.refresh()
  ensureExportTimeline()
})

/** 画布模式下往往没走过「剪辑」页，时间线为空会导致导出按钮灰掉——自动从分镜补齐 */
function ensureExportTimeline(silent = false) {
  if (!project.current) return false
  const { built, clips } = ensureTimelineFromShots(project.current)
  if (built) {
    project.setTimeline(clips)
    if (!silent) {
      toast.info(translate('export.timelineBuilt', { p0: clips.length }), 4000)
    }
    return true
  }
  return project.current.timeline.some((c) => c.enabled)
}

const timeline = computed(() => project.current?.timeline ?? [])
const shots = computed(() => project.current?.shots ?? [])
const totalDuration = computed(() =>
  timeline.value
    .filter((c) => c.enabled)
    .reduce((s, c) => s + c.duration, 0)
    .toFixed(1)
)

const canExport = computed(() => {
  return !!project.current && canBuildExport(project.current) && !exporting.value
})

async function doExport() {
  if (!project.current || !canExport.value) return
  ensureExportTimeline(true)
  if (!timeline.value.some((c) => c.enabled)) {
    toast.warn(translate('export.noClips'))
    return
  }

  exporting.value = true
  progress.value = 0
  progressMsg.value = translate('export.preparingAssets')
  resultUrl.value = null

  try {
    const mediaMap = new Map<string, { blob: Blob; kind: 'video' | 'image' }>()
    for (const clip of timeline.value) {
      if (mediaMap.has(clip.shotId)) continue
      const shot = shots.value.find((s) => s.id === clip.shotId)
      const assetId = project.current ? timelineClipAssetId(project.current, clip) : undefined
      if (!assetId) continue
      const blob = await assets.getBlob(assetId)
      if (!blob) continue
      mediaMap.set(clip.shotId, {
        blob,
        kind: (assets.getMeta(assetId)?.kind || (shot?.videoAssetId ? 'video' : 'image')) as 'video' | 'image'
      })
    }

    if (mediaMap.size === 0) {
      toast.error(translate('export.noAssets'))
      exporting.value = false
      return
    }

    let workingTimeline = timeline.value.filter((c) => c.enabled)
    if (isDigitalHuman.value && project.current.speechWorkflow?.options.removePauses !== false) {
      progressMsg.value = translate('export.trimming')
      workingTimeline = await trimTimelineBySpeech(
        workingTimeline,
        async (shotId) => mediaMap.get(shotId)?.blob
      )
      project.setTimeline(workingTimeline)
      for (const clip of workingTimeline) {
        const shot = shots.value.find((s) => s.id === clip.shotId)
        if (shot && Math.abs((shot.duration || 0) - clip.duration) > 0.05) {
          project.updateShot(shot.id, { duration: clip.duration })
        }
      }
    }

    const voiceoverMap = new Map<string, string>()
    for (const clip of workingTimeline) {
      const shot = shots.value.find((s) => s.id === clip.shotId)
      voiceoverMap.set(clip.shotId, shot?.voiceover ?? '')
    }

    const baseCaptionCues = (() => {
      if (isDigitalHuman.value) {
        return buildCuesFromClips(
          workingTimeline.map((c) => ({
            startTime: c.startTime,
            duration: c.duration,
            text: shots.value.find((s) => s.id === c.shotId)?.voiceover ?? ''
          }))
        ).filter((c) => c.text.trim())
      }
      const srt = project.current!.captionSrt?.trim()
      if (srt) return parseSRT(srt).filter((c) => c.text.trim())
      return buildCuesFromClips(
        workingTimeline.map((c) => ({
          startTime: c.startTime,
          duration: c.duration,
          text: shots.value.find((s) => s.id === c.shotId)?.voiceover ?? ''
        }))
      ).filter((c) => c.text.trim())
    })()
    const captionCues = [
      ...baseCaptionCues,
      ...(project.current.textOverlays || []).map((item, index) => ({
        id: baseCaptionCues.length + index + 1,
        start: item.startTime,
        end: item.startTime + item.duration,
        text: item.text,
        style: {
          fontFamily: item.fontFamily,
          fontSizeRatio: item.fontSizeRatio,
          color: item.color,
          position: item.position,
          xRatio: item.xRatio,
          yRatio: item.yRatio,
          bold: item.bold
        }
      }))
    ].sort((a, b) => a.start - b.start)

    if (burnCaptions.value && captionCues.length === 0) {
      toast.warn(translate('export.noCaptions'))
    }

    let bgmBlob: Blob | undefined
    if (!isSpeech.value && project.current.bgmAssetId) {
      bgmBlob = await assets.getBlob(project.current.bgmAssetId)
    }

    const digitalHuman = isDigitalHuman.value
    const voiceoverAudioMap = new Map<string, Blob>()
    const sourceAudioMap = new Map<string, boolean>()
    let missingVo = 0
    for (const clip of workingTimeline) {
      if (!clip.enabled || voiceoverAudioMap.has(clip.shotId)) continue
      const shot = shots.value.find((s) => s.id === clip.shotId)
      if (!shot) continue
      const audioMode = effectiveShotAudioMode(shot)
      sourceAudioMap.set(
        clip.shotId,
        isSpeech.value ||
          audioMode === 'h3-dialogue' ||
          audioMode === 'h3-voiceover' ||
          keepAmbientAudio.value
      )
      if (digitalHuman || !needsExternalTts(shot, project.current)) continue
      if (!shot.audioAssetId) {
        missingVo++
        continue
      }
      const blob = await assets.getBlob(shot.audioAssetId)
      if (blob) voiceoverAudioMap.set(clip.shotId, blob)
    }
    if (missingVo > 0 && !digitalHuman) {
      toast.warn(translate('export.missingVoice', { p0: missingVo }))
    }

    let width = project.current.settings.width
    let height = project.current.settings.height
    if (isSpeech.value) {
      for (const media of mediaMap.values()) {
        if (media.kind !== 'video') continue
        const info = await probeMedia(media.blob).catch(() => ({ width: 0, height: 0 }))
        if ((info.width || 0) >= 16 && (info.height || 0) >= 16) {
          width = info.width % 2 === 0 ? info.width : info.width - 1
          height = info.height % 2 === 0 ? info.height : info.height - 1
          break
        }
      }
    }
    const exportTimeline = isSpeech.value
      ? workingTimeline.map((clip) => ({
          ...clip,
          transitionIn: 'none' as const,
          transitionDuration: 0
        }))
      : workingTimeline

    const blob = await exportVideo({
      timeline: exportTimeline,
      mediaMap,
      voiceoverMap,
      width,
      height,
      fps: project.current.settings.fps,
      captionStyle: project.current.settings.captionStyle,
      burnCaptions: burnCaptions.value,
      captionCues,
      captionBg: project.current.settings.captionBg,
      captionHighlight: project.current.settings.captionHighlight,
      captionHighlightColor: project.current.settings.captionHighlightColor,
      captionHighlightScale: project.current.settings.captionHighlightScale,
      bgm: bgmBlob,
      bgmVolume: project.current.settings.bgmVolume,
      bgmStartTime: project.current.bgmClip?.startTime,
      bgmSourceIn: project.current.bgmClip?.sourceIn,
      bgmDuration: project.current.bgmClip?.duration,
      originalVolume: isSpeech.value ? 1 : ambientVolume.value,
      keepAmbientAudio: isSpeech.value ? true : keepAmbientAudio.value,
      sourceAudioMap,
      voiceoverAudioMap,
      format: format.value,
      onProgress: (msg) => {
        progressMsg.value = msg
        // 模拟进度（FFmpeg 不直接给百分比）
        progress.value = Math.min(0.95, progress.value + 0.05)
      }
    })

    resultUrl.value = URL.createObjectURL(blob)
    resultSize.value = blob.size
    progress.value = 1
    progressMsg.value = translate('export.completed')
    toast.success(translate('export.fileSize', { p0: formatSize(blob.size) }))
  } catch (e: unknown) {
    console.error('[ExportView] 导出失败:', e)
    const msg = e instanceof Error ? e.message : String(e)
    const displayMsg = msg.length > 600 ? msg.slice(0, 600) + '...' : msg
    toast.error(translate('export.failed', { error: displayMsg }), 15000)
    progressMsg.value = translate('export.failurePrefix', { error: (msg.split('\n')[0] ?? msg).slice(0, 200) })
  } finally {
    exporting.value = false
  }
}

function download() {
  if (!resultUrl.value) return
  const a = document.createElement('a')
  a.href = resultUrl.value
  a.download = `${project.current?.name ?? 'export'}.${format.value}`
  a.click()
}

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

const segmentSummary = computed(() => {
  return timeline.value
    .filter((c) => c.enabled)
    .map((c) => {
      const shot = shots.value.find((s) => s.id === c.shotId)
      return {
        index: shot?.index ?? 0,
        title: shot?.title ?? '?',
        duration: c.duration,
        hasVideo: !!shot?.videoAssetId,
        hasImage: !!shot?.imageAssetId
      }
    })
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>{{ $t('export.heading') }}</h1>
        <p v-if="isDigitalHuman">{{ $t('export.smartSpeechHint') }}</p>
        <p v-else>{{ $t('export.subtitleHint') }}</p>
      </div>
      <div class="head-actions">
        <GradientButton type="ghost" @click="router.push('/caption')">{{ $t('common.previousStep') }}</GradientButton>
        <GradientButton
          v-if="!resultUrl"
          icon="🚀"
          :loading="exporting"
          :disabled="!canExport"
          @click="doExport"
        >
          {{ exporting ? $t('export.exporting') : $t('export.start') }}
        </GradientButton>
        <GradientButton
          v-else
          icon="📥"
          @click="download"
        >{{ $t('export.download') }}</GradientButton>
      </div>
    </header>

    <div class="layout">
      <main class="left">
        <GlassCard padding="md" v-if="!exporting && !resultUrl">
          <h3>{{ $t('export.settings') }}</h3>

          <div class="field">
            <span>{{ $t('export.videoFormat') }}</span>
            <div class="format-grid">
              <button
                class="format"
                :class="{ active: format === 'mp4' }"
                @click="format = 'mp4'"
              >
                <div class="format-name">MP4</div>
                <div class="format-desc">{{ $t('export.h264') }}</div>
              </button>
              <button
                class="format"
                :class="{ active: format === 'webm' }"
                @click="format = 'webm'"
              >
                <div class="format-name">WebM</div>
                <div class="format-desc">{{ $t('export.vp9') }}</div>
              </button>
            </div>
          </div>

          <div class="field">
            <span>{{ $t('common.caption') }}</span>
            <label class="check">
              <input v-model="burnCaptions" type="checkbox" />
              <span>{{ $t('export.burnHint') }}</span>
            </label>
            <label class="check">
              <input v-model="captionHighlight" type="checkbox" :disabled="!burnCaptions" />
              <span>{{ $t('common.autoDelineate') }}</span>
            </label>
          </div>

          <div v-if="!isSpeech" class="field">
            <span>{{ $t('export.ambient') }}</span>
            <div class="format-grid">
              <button
                class="format"
                :class="{ active: keepAmbientAudio }"
                @click="keepAmbientAudio = true"
              >
                <div class="format-name">{{ $t('export.keepAudio') }}</div>
                <div class="format-desc">{{ $t('export.keepAmbientHint') }}</div>
              </button>
              <button
                class="format"
                :class="{ active: !keepAmbientAudio }"
                @click="keepAmbientAudio = false"
              >
                <div class="format-name">{{ $t('export.muteAudio') }}</div>
                <div class="format-desc">{{ $t('export.muteOption') }}</div>
              </button>
            </div>
            <div v-if="keepAmbientAudio" class="ambient-vol">
              <span class="hint">{{ $t('export.ambientVolume') }}</span>
              <input
                v-model.number="ambientVolume"
                type="range"
                min="0.1"
                max="1"
                step="0.05"
              />
              <span class="hint">{{ Math.round(ambientVolume * 100) }}%</span>
            </div>
            <p class="hint" style="margin-top: 6px;">
              {{
                keepAmbientAudio
                  ? $t('export.keepHint')
                  : $t('export.muteHint')
              }}
            </p>
          </div>
        </GlassCard>

        <GlassCard padding="md" v-if="exporting">
          <div class="exporting">
            <ProgressRing :progress="progress" :size="100" :stroke-width="6" show-label />
            <div class="exporting-msg">{{ progressMsg }}</div>
            <p class="hint">{{ $t('export.processing') }}</p>
          </div>
        </GlassCard>

        <GlassCard padding="md" v-if="resultUrl">
          <div class="result">
            <h3>{{ $t('export.complete') }}</h3>
            <video
              :src="resultUrl"
              controls
              autoplay
              class="result-video"
            />
            <div class="result-meta">
              <Tag type="success" size="sm">{{ format.toUpperCase() }}</Tag>
              <span class="result-size">{{ formatSize(resultSize) }}</span>
              <span class="result-duration">{{ totalDuration }}s</span>
            </div>
            <div class="result-actions">
              <GradientButton icon="📥" @click="download">{{ $t('export.download') }}</GradientButton>
              <GradientButton type="ghost" @click="resultUrl = null">{{ $t('export.exportAgain') }}</GradientButton>
            </div>
          </div>
        </GlassCard>

        <GlassCard padding="md" v-if="!exporting && !resultUrl">
          <h3>{{ $t('export.timelinePreview') }}</h3>
          <div v-if="segmentSummary.length === 0" class="empty">
            <p>{{ $t('export.empty') }}</p>
            <p class="hint" style="margin: 8px 0;">
              {{ $t('export.noClipsHint') }}
            </p>
            <GradientButton size="sm" type="secondary" @click="ensureExportTimeline()">
              {{ $t('export.rebuildTimeline') }}
            </GradientButton>
          </div>
          <div v-else class="seg-list">
            <div v-for="seg in segmentSummary" :key="seg.index" class="seg">
              <div class="seg-num">{{ seg.index + 1 }}</div>
              <div class="seg-info">
                <div class="seg-title">{{ seg.title }}</div>
                <div class="seg-meta">
                  <Tag size="sm" :type="seg.hasVideo ? 'success' : 'info'">
                    {{ seg.hasVideo ? $t('export.videoCount') : $t('export.imageCount') }}
                  </Tag>
                  <span>{{ seg.duration }}s</span>
                </div>
              </div>
            </div>
          </div>
        </GlassCard>
      </main>

      <aside class="right">
        <GlassCard padding="md">
          <h3>{{ $t('export.manifest') }}</h3>
          <div class="kv">
            <span>{{ $t('export.totalClips') }}</span><b>{{ segmentSummary.length }}</b>
          </div>
          <div class="kv">
            <span>{{ $t('common.totalLength') }}</span><b>{{ totalDuration }}s</b>
          </div>
          <div class="kv">
            <span>{{ $t('common.resolutionLabel') }}</span>
            <b>{{ project.current?.settings.width }}×{{ project.current?.settings.height }}</b>
          </div>
          <div class="kv">
            <span>{{ $t('common.frameRate') }}</span><b>{{ project.current?.settings.fps }}fps</b>
          </div>
          <div class="kv">
            <span>{{ $t('export.outputFormat') }}</span><b>{{ format.toUpperCase() }}</b>
          </div>
          <div class="kv">
            <span>{{ $t('common.caption') }}</span>
            <Tag :type="burnCaptions ? 'success' : 'default'" size="sm">
              {{ burnCaptions ? (project.current?.settings.captionHighlight ? $t('export.burnKeywords') : $t('export.burn')) : $t('export.noBurn') }}
            </Tag>
          </div>
        </GlassCard>

        <GlassCard padding="md">
          <h3>{{ $t('export.performance') }}</h3>
          <ul class="tips">
            <li>{{ $t('export.firstRun') }}</li>
            <li>{{ $t('export.performanceEstimate') }}</li>
            <li>{{ $t('export.longVideoHint') }}</li>
            <li>{{ $t('export.qualityHint') }}</li>
          </ul>
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
  grid-template-columns: 1fr 300px;
  gap: var(--space-4);
}
.left, .right {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
h3 {
  font-size: 13px;
  margin: 0 0 var(--space-3);
  font-weight: 600;
}

.field {
  margin-bottom: var(--space-4);
}
.field > span {
  display: block;
  font-size: 12px;
  color: var(--color-text-3);
  margin-bottom: 6px;
  font-weight: 500;
}
.format-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2);
}
.format {
  text-align: left;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  transition: all var(--duration-fast);
}
.format:hover {
  border-color: var(--color-border-strong);
}
.format.active {
  background: var(--grad-primary-soft);
  border-color: var(--color-accent);
}
.format-name {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 2px;
}
.format-desc {
  font-size: 11px;
  color: var(--color-text-3);
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-2);
  cursor: pointer;
}
.ambient-vol {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.ambient-vol input[type='range'] {
  flex: 1;
}
.input {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  font-size: 12px;
  color: var(--color-text-1);
  font-family: inherit;
}
.hint {
  font-size: 11px;
  color: var(--color-text-4);
  margin: 6px 0 0;
}

.exporting {
  text-align: center;
  padding: var(--space-8) 0;
}
.exporting-msg {
  font-size: 14px;
  color: var(--color-text-1);
  margin: var(--space-3) 0;
  font-weight: 500;
}

.result h3 {
  margin-bottom: var(--space-3);
}
.result-video {
  width: 100%;
  max-height: 60vh;
  background: #000;
  border-radius: var(--radius-md);
}
.result-meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
  font-size: 12px;
  color: var(--color-text-3);
}
.result-size, .result-duration {
  font-variant-numeric: tabular-nums;
}
.result-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.empty {
  text-align: center;
  color: var(--color-text-4);
  padding: var(--space-6);
}
.seg-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 400px;
  overflow-y: auto;
}
.seg {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 8px;
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
}
.seg-num {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  background: var(--grad-primary);
  color: white;
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.seg-info {
  flex: 1;
  min-width: 0;
}
.seg-title {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.seg-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--color-text-4);
  margin-top: 2px;
}

.kv {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  margin-bottom: 6px;
  color: var(--color-text-3);
}
.kv b {
  color: var(--color-text-1);
  font-weight: 600;
}
.tips {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--color-text-3);
  line-height: 1.7;
}
.tips li {
  margin-bottom: 4px;
}
</style>
