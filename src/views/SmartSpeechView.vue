<script setup lang="ts">
import { t as translate } from '@/i18n'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import { useAssetsStore, useProjectStore, useToastStore } from '@/stores'
import {
  cloneVoiceFromSample,
  generateVideo,
  synthesizeClonedSpeech,
  DIGITAL_HUMAN_VISUAL_LOCK,
  DIGITAL_HUMAN_AESTHETIC,
  DIGITAL_HUMAN_AUDIO_DESCRIPTION,
  DIGITAL_HUMAN_SPEAKER_HINT,
  DIGITAL_HUMAN_SPEAKER_NAME,
  DIGITAL_HUMAN_SCENE_NAME,
  DIGITAL_HUMAN_SCENE_DESCRIPTION,
  DIGITAL_HUMAN_SCENE_ANCHOR,
  DIGITAL_HUMAN_IMAGE_ASSIGNMENT
} from '@/services/ai'
import { detectSpeechWindow, toDigitalHumanWav } from '@/services/ffmpeg'
import type { SpeechWindow } from '@/services/ffmpeg'
import {
  DIGITAL_HUMAN_CONCURRENCY,
  durationFromSpeechText,
  planDigitalSpeechShots,
  runPool
} from '@/utils/digitalSpeech'
import type {
  AspectRatio,
  SpeechWorkflow,
  SpeechWorkflowMode,
  SpeechWorkflowOptions,
  TimelineClip,
  Shot
} from '@/types'
import { isDigitalHumanSpeechProject } from '@/utils/shot'
import { pickLocalFiles } from '@/utils/pickLocalFiles'

const route = useRoute()
const router = useRouter()
const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()

const mode = ref<SpeechWorkflowMode>('digital-human')
const name = ref('')
const script = ref('')
const aspectRatio = ref<AspectRatio>('9:16')
const imageFile = ref<File | null>(null)
const audioFile = ref<File | null>(null)
const videoFiles = ref<File[]>([])
const referenceFiles = ref<File[]>([])
const imageUrl = ref('')
const audioUrl = ref('')
const videoUrls = ref<string[]>([])
const referenceUrls = ref<string[]>([])
const saving = ref(false)
const building = ref(false)
const generationController = ref<AbortController | null>(null)
const generatedPreviews = ref<Array<{ id: string; index: number; url: string }>>([])
let previewTick = 0
const creatingNew = computed(() => String(route.query.new || '') === '1')
const showWorkspace = computed(() => {
  if (creatingNew.value) return false
  const p = project.current
  return Boolean(p && (p.pipelineMode === 'smart-speech' || p.speechWorkflow))
})
function normalizeDigitalHumanProject() {
  const p = project.current
  if (!p || !isDigitalHumanSpeechProject(p) || !p.speechWorkflow) return
  let changed = false
  const flow = p.speechWorkflow
  if (!flow.options.captions || !flow.options.keywordCallouts) {
    p.speechWorkflow = {
      ...flow,
      options: {
        ...flow.options,
        captions: true,
        keywordCallouts: true
      },
      updatedAt: Date.now()
    }
    changed = true
  }
  if (p.settings.burnCaptions === false || !p.settings.captionHighlight) {
    project.setSettings({ burnCaptions: true, captionHighlight: true })
    changed = true
  }
  const spoken = p.shots.map((shot) => shot.voiceover || '').join('')
  const duration = p.timeline.reduce((sum, clip) => sum + clip.duration, 0)
  if (!p.captionSrt?.trim() && spoken.trim() && duration > 0) {
    project.setCaptionSrt(approximateSrt(spoken, duration))
    changed = true
  }
  const shots = p.shots.map((shot) =>
    shot.audioMode === 'h3-dialogue' ? shot : { ...shot, audioMode: 'h3-dialogue' as const }
  )
  if (shots.some((shot, index) => shot !== p.shots[index])) {
    project.setShots(shots)
    changed = true
  }
  if (changed) void project.save()
}

watch(
  () => [showWorkspace.value, project.current?.id, project.current?.speechWorkflow?.mode] as const,
  ([show]) => {
    if (show) normalizeDigitalHumanProject()
  },
  { immediate: true }
)

const options = ref<SpeechWorkflowOptions>({
  removePauses: true,
  removeStumbles: true,
  beauty: false,
  captions: true,
  titles: false,
  keywordCallouts: true,
  soundEffects: false,
  bgm: false,
  aigcInserts: false
})

const modes: Array<{
  id: SpeechWorkflowMode
  eyebrow: string
  title: string
  desc: string
  input: string
}> = [
  {
    id: 'digital-human',
    get eyebrow() { return translate('smartSpeech.digitalEyebrow') },
    get title() { return translate('smartSpeech.digitalHuman') },
    get desc() { return translate('smartSpeech.digitalUploadHint') },
    get input() { return translate('smartSpeech.digitalInputList') }
  },
  {
    id: 'human-edit',
    get eyebrow() { return translate('smartSpeech.liveEyebrow') },
    get title() { return translate('smartSpeech.smartTrim') },
    get desc() { return translate('smartSpeech.automationHint') },
    get input() { return translate('smartSpeech.liveInputList') }
  },
  {
    id: 'human-aigc',
    get eyebrow() { return translate('smartSpeech.mixedEyebrow') },
    get title() { return translate('smartSpeech.aigcMix') },
    get desc() { return translate('smartSpeech.aigcHint') },
    get input() { return translate('smartSpeech.mixedInputList') }
  }
]

const currentFlow = computed(() => project.current?.speechWorkflow)

watch(
  () => project.current?.id,
  async (id) => {
    if (!id) return
    await assets.refresh()
  },
  { immediate: true }
)

const completedVideoCount = computed(
  () => currentFlow.value?.generatedVideoAssetIds?.filter(Boolean).length || 0
)
const totalDigitalSegments = computed(() =>
  currentFlow.value?.mode === 'digital-human'
    ? planDigitalSpeechShots(project.current?.script?.content || '').length
    : 0
)

watch(
  () => (currentFlow.value?.generatedVideoAssetIds || []).join('|'),
  async () => {
    const tick = ++previewTick
    const ids = currentFlow.value?.generatedVideoAssetIds || []
    const next: Array<{ id: string; index: number; url: string }> = []
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index]
      if (!id) continue
      const url = await assets.getUrl(id)
      if (url) next.push({ id, index, url })
    }
    if (tick !== previewTick) return
    generatedPreviews.value = next
  },
  { immediate: true }
)

const selectedMode = computed(() => modes.find((item) => item.id === mode.value)!)

const canCreate = computed(() => {
  if (!name.value.trim() || !script.value.trim()) return false
  if (mode.value === 'digital-human') return !!imageFile.value && !!audioFile.value
  return videoFiles.value.length > 0
})

const stageIndex = computed(() => {
  const stage = currentFlow.value?.stage
  if (stage === 'complete') return 4
  if (stage === 'quality-check') return 3
  if (stage === 'packaging') return 2
  if (stage === 'editing') return 1
  return 0
})

function revoke(url: string) {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}

function replaceUrl(previous: string, file?: File) {
  revoke(previous)
  return file ? URL.createObjectURL(file) : ''
}

async function chooseImage() {
  try {
    const file = (await pickLocalFiles({ kind: 'image', multiple: false }))[0]
    if (!file || !file.type.startsWith('image/')) return
    imageFile.value = file
    imageUrl.value = replaceUrl(imageUrl.value, file)
  } catch (err: any) {
    toast.error(err?.message || translate('common.imageReadFailed'))
  }
}

async function chooseAudio() {
  try {
    const file = (await pickLocalFiles({ kind: 'audio', multiple: false }))[0]
    if (!file) return
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|aac)$/i.test(file.name)) {
      toast.warn(translate('smartSpeech.audioFormats'))
      return
    }
    audioFile.value = file
    audioUrl.value = replaceUrl(audioUrl.value, file)
  } catch (err: any) {
    toast.error(err?.message || translate('smartSpeech.audioReadFailed'))
  }
}

async function chooseVideos() {
  try {
    const files = (await pickLocalFiles({ kind: 'video', multiple: true })).filter(
      (file) => file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/i.test(file.name)
    )
    videoUrls.value.forEach(revoke)
    videoFiles.value = files.slice(0, 8)
    videoUrls.value = videoFiles.value.map((file) => URL.createObjectURL(file))
  } catch (err: any) {
    toast.error(err?.message || translate('smartSpeech.videoReadFailed'))
  }
}

async function chooseReferences() {
  try {
    const files = (await pickLocalFiles({ kind: 'image', multiple: true })).filter((file) =>
      file.type.startsWith('image/')
    )
    const room = Math.max(0, 8 - referenceFiles.value.length)
    const next = files.slice(0, room)
    referenceFiles.value = [...referenceFiles.value, ...next]
    referenceUrls.value = [...referenceUrls.value, ...next.map((file) => URL.createObjectURL(file))]
  } catch (err: any) {
    toast.error(err?.message || translate('common.referenceReadFailed'))
  }
}

function removeReference(index: number) {
  revoke(referenceUrls.value[index])
  referenceFiles.value = referenceFiles.value.filter((_, i) => i !== index)
  referenceUrls.value = referenceUrls.value.filter((_, i) => i !== index)
}

function setMode(next: SpeechWorkflowMode) {
  mode.value = next
  options.value.aigcInserts = next === 'human-aigc'
  if (next === 'digital-human') {
    options.value.beauty = false
    options.value.captions = true
    options.value.titles = false
    options.value.keywordCallouts = true
    options.value.soundEffects = false
    options.value.bgm = false
    options.value.removePauses = true
  } else {
    options.value.beauty = true
    options.value.captions = true
    options.value.titles = true
    options.value.keywordCallouts = true
    options.value.soundEffects = true
  }
}

function sizeForAspect(ar: AspectRatio) {
  if (ar === '16:9') return { width: 1920, height: 1080 }
  if (ar === '1:1') return { width: 1080, height: 1080 }
  return { width: 1080, height: 1920 }
}

async function saveFile(file: File, kind: 'image' | 'audio' | 'video', projectId: string) {
  return assets.add(file, kind, 'uploaded', { filename: file.name, projectId })
}

async function createSpeechProject() {
  if (!canCreate.value || saving.value) return
  saving.value = true
  let created = false
  try {
    const p = await project.createNamed(name.value.trim())
    created = true
    const now = Date.now()
    const size = sizeForAspect(aspectRatio.value)
    p.pipelineMode = 'smart-speech'
    p.speechWorkflow = {
      mode: mode.value,
      stage: 'ready',
      videoAssetIds: [],
      referenceAssetIds: [],
      options: { ...options.value },
      progress: translate('smartSpeech.savingAssets'),
      createdAt: now,
      updatedAt: now
    }
    p.script = {
      id: `s_${now.toString(36)}`,
      topic: name.value.trim(),
      content: script.value.trim(),
      keywords: [],
      style: 'photorealistic',
      aspectRatio: aspectRatio.value,
      shotDuration: 5,
      playReady: true,
      createdAt: now
    }
    p.settings = {
      ...p.settings,
      aspectRatio: aspectRatio.value,
      width: size.width,
      height: size.height,
      burnCaptions: options.value.captions,
      captionHighlight: options.value.captions && options.value.keywordCallouts,
      captionHighlightColor: '#ffd84d',
      captionHighlightScale: 1.2,
      bgmVolume: 0,
      keepAmbientAudio: true
    }

    let imageAssetId: string | undefined
    let audioAssetId: string | undefined
    const videoAssetIds: string[] = []
    const referenceAssetIds: string[] = []

    if (imageFile.value) imageAssetId = (await saveFile(imageFile.value, 'image', p.id)).id
    if (audioFile.value) audioAssetId = (await saveFile(audioFile.value, 'audio', p.id)).id
    for (const file of videoFiles.value) {
      videoAssetIds.push((await saveFile(file, 'video', p.id)).id)
    }
    for (const file of referenceFiles.value) {
      referenceAssetIds.push((await saveFile(file, 'image', p.id)).id)
    }

    p.speechWorkflow = {
      mode: mode.value,
      stage: 'ready',
      imageAssetId,
      voiceSampleAssetId: audioAssetId,
      videoAssetIds,
      referenceAssetIds,
      options: { ...options.value },
      progress: mode.value === 'digital-human'
        ? translate('smartSpeech.sampleSaved', { p0: planDigitalSpeechShots(script.value).length })
        : translate('smartSpeech.inputsSaved'),
      createdAt: now,
      updatedAt: now
    }
    project.setScript(p.script)
    project.setSettings(p.settings)
    await project.save()
    await router.replace({ name: 'smart-speech' })
    toast.success(translate('smartSpeech.created'))
  } catch (error: any) {
    toast.error(error?.message || translate('smartSpeech.createFailed'))
    if (created && project.current?.speechWorkflow) {
      await router.replace({ name: 'smart-speech' }).catch(() => undefined)
    }
  } finally {
    saving.value = false
  }
}

function srtTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const rest = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rest).padStart(3, '0')}`
}

function captionPhrases(text: string) {
  const sentences = text
    .replace(/\s+/g, '')
    .split(/(?<=[，。！？；：])/)
    .map((part) => part.trim())
    .filter(Boolean)
  const phrases: string[] = []
  for (const sentence of sentences) {
    if (sentence.length <= 22) phrases.push(sentence)
    else {
      for (let i = 0; i < sentence.length; i += 18) phrases.push(sentence.slice(i, i + 18))
    }
  }
  return phrases.length ? phrases : [text.trim()]
}

function approximateSrt(text: string, duration: number) {
  const phrases = captionPhrases(text)
  const weights = phrases.map((item) => Math.max(1, item.replace(/[，。！？；：]/g, '').length))
  const total = weights.reduce((sum, item) => sum + item, 0)
  let cursor = 0
  return phrases
    .map((phrase, index) => {
      const partDuration = index === phrases.length - 1 ? duration - cursor : duration * (weights[index] / total)
      const end = Math.min(duration, cursor + Math.max(0.6, partDuration))
      const cue = `${index + 1}\n${srtTime(cursor)} --> ${srtTime(end)}\n${phrase}`
      cursor = end
      return cue
    })
    .join('\n\n')
}

function writeFlow(flow: SpeechWorkflow) {
  const p = project.current
  if (!p) return
  p.pipelineMode = 'smart-speech'
  p.speechWorkflow = { ...flow, updatedAt: Date.now() }
}

async function buildBaseline() {
  if (building.value) {
    toast.info(translate('common.pleaseWait'))
    return
  }
  const p = project.current
  if (!p) {
    toast.warn(translate('smartSpeech.noProject'))
    return
  }
  const flow = p.speechWorkflow
  if (!flow) {
    toast.warn(translate('smartSpeech.assetsLost'))
    return
  }
  building.value = true
  writeFlow({
    ...flow,
    progress: flow.mode === 'digital-human' ? translate('smartSpeech.voiceCloneStarting') : translate('smartSpeech.baseGenerating'),
    error: undefined
  })
  generationController.value = new AbortController()
  try {
    await assets.refresh()
    const digital = flow.mode === 'digital-human'
    if (digital) {
      await buildDigitalHumanVideo(p, flow, generationController.value.signal)
      return
    }
    const primaryId =
      flow.videoAssetIds?.[0] ||
      assets.all.find((item) => item.kind === 'video' && item.projectId === p.id)?.id
    if (!primaryId) throw new Error(translate('smartSpeech.missingVideo'))
    const primary = assets.getMeta(primaryId)
    const audio = flow.audioAssetId ? assets.getMeta(flow.audioAssetId) : undefined
    const duration = Math.max(
      1,
      digital && audio?.kind === 'audio'
        ? audio.duration || 8
        : primary?.kind === 'video'
          ? primary.duration || 8
          : 8
    )
    const shotId = `speech_${Date.now().toString(36)}`
    const shot: Shot = {
      id: shotId,
      index: 0,
      title: digital ? translate('smartSpeech.digitalMainShot') : translate('smartSpeech.liveMainShot'),
      visualPrompt: digital
        ? '保持上传人物形象、机位和背景稳定，人物自然面向镜头口播。'
        : '保留真人原片，后续根据逐字识别结果完成卡顿和气口清理。',
      audioDescription: '清晰人声，背景音乐不盖过口播。',
      voiceover: p.script?.content || '',
      audioMode: digital ? 'h3-dialogue' : 'none',
      duration,
      cameraMovement: 'static',
      imageAssetId: digital ? primaryId : undefined,
      videoAssetId: digital ? undefined : primaryId,
      audioAssetId: digital ? flow.audioAssetId : undefined,
      referenceAssetIds: flow.referenceAssetIds,
      status: digital ? 'image-generated' : 'video-generated'
    }
    const clip: TimelineClip = {
      id: `clip_${Date.now().toString(36)}`,
      shotId,
      startTime: 0,
      duration,
      sourceIn: 0,
      transitionIn: 'none',
      transitionDuration: 0,
      speed: 1,
      volume: 1,
      enabled: true
    }
    project.setShots([shot])
    project.setTimeline([clip])
    if (flow.options?.captions && p.script?.content) {
      project.setCaptionSrt(approximateSrt(p.script.content, duration))
    }
    p.speechWorkflow = {
      ...flow,
      stage: 'editing',
      progress: digital
        ? translate('smartSpeech.baseTrackDigital')
        : translate('smartSpeech.baseTrackLive'),
      updatedAt: Date.now()
    }
    await project.save()
    toast.success(translate('smartSpeech.baseProjectGenerated'))
  } catch (error: any) {
    const cancelled = generationController.value?.signal.aborted
    const remoteTaskFinishedWithoutVideo = /生成失败|任务完成但没有视频|任务已过期|status.*failed/i.test(
      error?.message || ''
    )
    if (p.speechWorkflow) {
      p.speechWorkflow = {
        ...p.speechWorkflow,
        stage: cancelled ? 'ready' : 'failed',
        progress: cancelled
          ? translate('smartSpeech.pausedSaved', { p0: p.speechWorkflow.generatedVideoAssetIds?.length || 0 })
          : p.speechWorkflow.progress,
        activeVideoTaskId: remoteTaskFinishedWithoutVideo ? undefined : p.speechWorkflow.activeVideoTaskId,
        activeVideoTaskSegmentIndex: remoteTaskFinishedWithoutVideo
          ? undefined
          : p.speechWorkflow.activeVideoTaskSegmentIndex,
        error: cancelled ? undefined : error?.message || String(error),
        updatedAt: Date.now()
      }
      await project.save().catch(() => undefined)
    }
    if (cancelled) toast.info(translate('smartSpeech.paused'))
    else toast.error(error?.message || translate('smartSpeech.baseFailed'))
  } finally {
    building.value = false
    generationController.value = null
  }
}

function cancelGeneration() {
  generationController.value?.abort()
}

async function updateFlowProgress(message: string) {
  const p = project.current
  if (!p?.speechWorkflow) return
  p.speechWorkflow = { ...p.speechWorkflow, progress: message, updatedAt: Date.now() }
  await project.save()
}

async function buildDigitalHumanVideo(
  p: NonNullable<typeof project.current>,
  flow: NonNullable<typeof currentFlow.value>,
  signal: AbortSignal
) {
  const imageId = flow.imageAssetId
  const sampleId = flow.voiceSampleAssetId || flow.audioAssetId
  if (!imageId || !sampleId) throw new Error(translate('smartSpeech.missingPortraitOrVoice'))
  const personImageId: string = imageId
  const imageBlob = await assets.getBlob(imageId)
  const sampleBlob = await assets.getBlob(sampleId)
  if (!imageBlob || !sampleBlob) throw new Error(translate('smartSpeech.digitalReadFailed'))
  const planned = planDigitalSpeechShots(p.script?.content || '')
  if (!planned.length) throw new Error(translate('smartSpeech.noScript'))
  const cloned = flow.clonedVoiceId
    ? { voiceId: flow.clonedVoiceId, model: flow.clonedVoiceModel || 'qwen3-tts-vc-2026-01-22' }
    : await (async () => {
        await updateFlowProgress(translate('smartSpeech.cloningSample'))
        return cloneVoiceFromSample(sampleBlob, `aicut${p.id.replace(/[^a-z0-9]/gi, '').slice(-8)}`, signal)
      })()
  if (!p.speechWorkflow) throw new Error(translate('smartSpeech.stateLost'))
  p.speechWorkflow = {
    ...p.speechWorkflow,
    clonedVoiceId: cloned.voiceId,
    clonedVoiceModel: cloned.model,
    progress: translate('smartSpeech.voiceCloned', { p0: planned.length }),
    updatedAt: Date.now()
  }
  await project.save()
  await updateFlowProgress(translate('smartSpeech.synthesizing', { p0: planned.length }))

  const parts = planned.map((item) => item.text)
  const existingVideos = [...(flow.generatedVideoAssetIds || [])]
  const existingSpeech = [...(flow.generatedSpeechAssetIds || [])]
  const videoIds: Array<string | undefined> = Array.from(
    { length: parts.length },
    (_, i) => existingVideos[i] || undefined
  )
  const speechIds: Array<string | undefined> = Array.from(
    { length: parts.length },
    (_, i) => existingSpeech[i] || undefined
  )
  const slotAssetIds = (ids: Array<string | undefined>): string[] =>
    ids.map((id) => id || '')
  const speechBlobs = new Map<number, Blob>()
  const speechDurations = new Map<number, number>()
  const speechWindows = new Map<string, SpeechWindow>()
  const trimPauses = flow.options?.removePauses !== false
  const shotIds = parts.map((_, index) => {
    const videoId = videoIds[index]
    const speechId = speechIds[index]
    const videoAsset = videoId ? assets.getMeta(videoId) : undefined
    const speechAsset = speechId ? assets.getMeta(speechId) : undefined
    return videoAsset?.shotId || speechAsset?.shotId || `speech_${Date.now().toString(36)}_${index}`
  })

  function isComplete(index: number) {
    const videoId = videoIds[index]
    const speechId = speechIds[index]
    const videoAsset = videoId ? assets.getMeta(videoId) : undefined
    const speechAsset = speechId ? assets.getMeta(speechId) : undefined
    return videoAsset?.kind === 'video' && speechAsset?.kind === 'audio'
  }

  async function measureSpeechWindow(videoId: string) {
    if (!trimPauses || speechWindows.has(videoId)) return
    const blob = await assets.getBlob(videoId)
    if (!blob) return
    try {
      speechWindows.set(videoId, await detectSpeechWindow(blob))
    } catch {
      /* 切气口失败时仍用整段，避免挡住生成 */
    }
  }

  function rebuildTimeline() {
    const shots = []
    const timeline = []
    let cursor = 0
    const spoken = []
    for (let index = 0; index < parts.length; index++) {
      if (!isComplete(index)) continue
      const videoId = videoIds[index]
      const speechId = speechIds[index]
      if (!videoId || !speechId) continue
      const videoAsset = assets.getMeta(videoId)
      const speechAsset = assets.getMeta(speechId)
      if (!videoAsset || !speechAsset || videoAsset.kind !== 'video' || speechAsset.kind !== 'audio') continue
      const win = speechWindows.get(videoAsset.id)
      const full = Math.max(
        0.1,
        videoAsset.duration || speechDurations.get(index) || speechAsset.duration || 8
      )
      const sourceIn = win?.sourceIn ?? 0
      const duration = Math.max(0.1, win?.duration ?? full)
      const shotId = shotIds[index]
      const text = parts[index]
      if (!shotId || !text) continue
      shots.push(makeDigitalShot(index, shotId, text, duration, personImageId, videoAsset.id, speechAsset.id))
      timeline.push(makeDigitalClip(index, shotId, cursor, duration, sourceIn))
      spoken.push(text)
      cursor += duration
    }
    project.setShots(shots)
    project.setTimeline(timeline)
    if (flow.options.captions && spoken.length) {
      project.setCaptionSrt(approximateSrt(spoken.join(''), cursor))
    }
  }

  let persistChain = Promise.resolve()
  const persistFlow = (
    patch: Record<string, unknown> | ((flow: NonNullable<typeof p.speechWorkflow>) => Record<string, unknown>),
    progress: string
  ) => {
    const write = async () => {
      if (!p.speechWorkflow) return
      const next = typeof patch === 'function' ? patch(p.speechWorkflow) : patch
      p.speechWorkflow = { ...p.speechWorkflow, ...next, progress, updatedAt: Date.now() }
      await project.save()
    }
    persistChain = persistChain.then(write, write)
    return persistChain
  }

  const restored = parts.filter((_, index) => isComplete(index)).length
  if (restored) {
    for (let index = 0; index < parts.length; index++) {
      const videoId = videoIds[index]
      if (isComplete(index) && videoId) await measureSpeechWindow(videoId)
    }
    rebuildTimeline()
    await updateFlowProgress(translate('smartSpeech.restored', { p0: restored, p1: parts.length }))
  }

  for (let index = 0; index < parts.length; index++) {
    if (signal.aborted) throw new DOMException(translate('smartSpeech.cancelled'), 'AbortError')
    const existingSpeechId = speechIds[index]
    if (isComplete(index) && existingSpeechId) {
      const blob = await assets.getBlob(existingSpeechId)
      if (blob) {
        const prepared = await toDigitalHumanWav(blob)
        speechBlobs.set(index, prepared.blob)
        speechDurations.set(index, prepared.duration)
      }
      continue
    }
    const shotId = shotIds[index]
    const text = parts[index]
    await updateFlowProgress(translate('smartSpeech.speaking', { p0: index + 1, p1: parts.length }))
    const raw = await synthesizeClonedSpeech(text, cloned.voiceId, cloned.model, signal)
    const prepared = await toDigitalHumanWav(raw, (message) =>
      void updateFlowProgress(translate('smartSpeech.segmentProgress', { p0: index + 1, p1: parts.length, p2: message }))
    )
    if (prepared.duration > 15) {
      throw new Error(translate('smartSpeech.audioTooLong', { p0: index + 1, p1: prepared.duration.toFixed(1) }))
    }
    const speechAsset = existingSpeechId
      ? assets.getMeta(existingSpeechId)
      : await assets.add(prepared.blob, 'audio', 'ai-generated', {
          filename: translate('smartSpeech.speechFilename', { p0: String(index + 1).padStart(2, '0') }),
          prompt: text,
          projectId: p.id,
          shotId
        })
    if (!speechAsset || speechAsset.kind !== 'audio') throw new Error(translate('smartSpeech.audioSaveFailed', { p0: index + 1 }))
    speechIds[index] = speechAsset.id
    speechBlobs.set(index, prepared.blob)
    speechDurations.set(index, prepared.duration)
    await persistFlow(
      {
        generatedSpeechAssetIds: slotAssetIds(speechIds),
        pendingSegmentIndex: undefined,
        pendingSpeechAssetId: undefined
      },
      translate('smartSpeech.audioReady', { p0: speechIds.filter(Boolean).length, p1: parts.length })
    )
  }

  for (let index = 0; index < parts.length; index++) {
    const existingVideoId = videoIds[index]
    if (!isComplete(index) || !existingVideoId) continue
    const blob = await assets.getBlob(existingVideoId)
    if (!blob || blob.size < 80_000) videoIds[index] = undefined
  }

  const todo = parts.map((_, index) => index).filter((index) => !isComplete(index))
  const parallel = Math.min(DIGITAL_HUMAN_CONCURRENCY, todo.length)
  if (todo.length) {
    await updateFlowProgress(translate('smartSpeech.submitSync', { p0: parallel, p1: todo.length }))
  }

  const running = new Set<number>()
  const failures: Array<{ index: number; message: string }> = []
  const legacyTaskId = String(flow.error || '').match(/task_id=([^\s]+)/i)?.[1]?.trim()

  await runPool(
    todo,
    DIGITAL_HUMAN_CONCURRENCY,
    async (index) => {
      if (signal.aborted) throw new DOMException(translate('smartSpeech.cancelled'), 'AbortError')
      const speechBlob = speechBlobs.get(index)
      const speechAssetId = speechIds[index]
      const speechDuration = speechDurations.get(index) || planned[index]?.duration || durationFromSpeechText(parts[index])
      if (!speechBlob || !speechAssetId) throw new Error(translate('smartSpeech.audioPending', { p0: index + 1 }))
      running.add(index)
      const resumeTaskId =
        (p.speechWorkflow?.activeVideoTasks || []).find((item) => item.index === index)?.taskId ||
        (p.speechWorkflow?.activeVideoTaskSegmentIndex === index ? p.speechWorkflow.activeVideoTaskId : undefined) ||
        (todo[0] === index ? legacyTaskId : undefined)
      try {
        const generated = await generateVideo(
          {
            imageBlob,
            prompt: DIGITAL_HUMAN_VISUAL_LOCK,
            aesthetic: DIGITAL_HUMAN_AESTHETIC,
            audioDescription: DIGITAL_HUMAN_AUDIO_DESCRIPTION,
            voiceover: parts[index],
            voiceMode: 'dialogue',
            speakerHint: DIGITAL_HUMAN_SPEAKER_HINT,
            speakerName: DIGITAL_HUMAN_SPEAKER_NAME,
            onScreenNames: [DIGITAL_HUMAN_SPEAKER_NAME],
            sceneName: DIGITAL_HUMAN_SCENE_NAME,
            sceneDescription: DIGITAL_HUMAN_SCENE_DESCRIPTION,
            sceneAnchor: DIGITAL_HUMAN_SCENE_ANCHOR,
            shotTitle: 'Locked single-person talking head',
            imageAssignments: [DIGITAL_HUMAN_IMAGE_ASSIGNMENT],
            duration: Math.min(15, Math.max(5, Math.ceil(speechDuration))),
            width: p.settings.width,
            height: p.settings.height,
            aspectRatio: p.settings.aspectRatio,
            cameraMovement: 'static',
            audioBlob: speechBlob,
            audioSync: true,
            promptAsIs: true,
            mode: 'I2VA',
            signal,
            resumeTaskId,
            onTaskSubmitted: async (taskId) => {
              await persistFlow((current) => {
                const activeVideoTasks = [
                  ...(current.activeVideoTasks || []).filter((item) => item.index !== index),
                  { index, taskId }
                ].sort((a, b) => a.index - b.index)
                return {
                  activeVideoTasks,
                  activeVideoTaskId: taskId,
                  activeVideoTaskSegmentIndex: index
                }
              }, translate('smartSpeech.submitted', { p0: videoIds.filter(Boolean).length, p1: parts.length }))
            }
          },
          (message) =>
            void updateFlowProgress(
              translate('smartSpeech.parallelProgress', { p0: videoIds.filter(Boolean).length, p1: parts.length, p2: running.size, p3: index + 1, p4: message })
            )
        )
        const videoAsset = await assets.add(generated.blob, 'video', 'ai-generated', {
          filename: translate('smartSpeech.digitalFilename', { p0: String(index + 1).padStart(2, '0') }),
          prompt: generated.prompt,
          projectId: p.id,
          shotId: shotIds[index]
        })
        videoIds[index] = videoAsset.id
        await measureSpeechWindow(videoAsset.id)
        rebuildTimeline()
        await persistFlow((current) => ({
          generatedVideoAssetIds: slotAssetIds(videoIds),
          generatedSpeechAssetIds: slotAssetIds(speechIds),
          activeVideoTasks: (current.activeVideoTasks || []).filter((item) => item.index !== index),
          activeVideoTaskId: undefined,
          activeVideoTaskSegmentIndex: undefined,
          pendingSegmentIndex: undefined,
          pendingSpeechAssetId: undefined
        }), translate('smartSpeech.parallelCompleted', { p0: videoIds.filter(Boolean).length, p1: parts.length }))
      } catch (error: unknown) {
        const err = error as { name?: string; message?: string }
        if (signal.aborted || err?.name === 'AbortError') throw error
        failures.push({ index, message: err?.message || String(error) })
      } finally {
        running.delete(index)
      }
    },
    signal
  )

  for (let index = 0; index < parts.length; index++) {
    const videoId = videoIds[index]
    if (isComplete(index) && videoId) await measureSpeechWindow(videoId)
  }
  rebuildTimeline()
  const completed = videoIds.filter(Boolean).length
  if (signal.aborted) throw new DOMException(translate('smartSpeech.cancelled'), 'AbortError')
  if (failures.length) {
    throw new Error(translate('smartSpeech.segmentFailed', { p0: failures.map((item) => item.index + 1).join('、'), p1: failures[0].message }))
  }
  if (completed < parts.length) {
    throw new Error(translate('smartSpeech.incomplete', { p0: completed, p1: parts.length }))
  }

  p.speechWorkflow = {
    ...p.speechWorkflow,
    stage: 'editing',
    generatedVideoAssetIds: slotAssetIds(videoIds),
    generatedSpeechAssetIds: slotAssetIds(speechIds),
    activeVideoTasks: [],
    activeVideoTaskId: undefined,
    activeVideoTaskSegmentIndex: undefined,
    progress: translate('smartSpeech.finished', { p0: parts.length }),
    error: undefined,
    updatedAt: Date.now()
  }
  await project.save()
  toast.success(translate('smartSpeech.digitalGenerated'))
}

function makeDigitalShot(
  index: number,
  shotId: string,
  text: string,
  duration: number,
  imageId: string,
  videoId: string,
  speechId: string,
  videoPrompt?: string
): Shot {
  return {
    id: shotId,
    index,
    title: translate('smartSpeech.digitalHumanNumber', { p0: index + 1 }),
    visualPrompt: '保持人物身份、服装、背景和机位稳定，自然面向镜头口播。',
    videoPrompt,
    audioDescription: '克隆音色按台词合成的口播，H3 对口型。',
    voiceover: text,
    audioMode: 'h3-dialogue',
    duration,
    cameraMovement: 'static',
    imageAssetId: imageId,
    videoAssetId: videoId,
    audioAssetId: speechId,
    status: 'video-generated'
  }
}

function makeDigitalClip(
  index: number,
  shotId: string,
  startTime: number,
  duration: number,
  sourceIn = 0
): TimelineClip {
  return {
    id: `clip_${shotId}`,
    shotId,
    startTime,
    duration,
    sourceIn,
    transitionIn: 'none',
    transitionDuration: 0,
    speed: 1,
    volume: 1,
    enabled: true
  }
}

function startNew() {
  router.replace({ name: 'smart-speech', query: { new: '1' } })
}

onBeforeUnmount(() => {
  revoke(imageUrl.value)
  revoke(audioUrl.value)
  videoUrls.value.forEach(revoke)
  referenceUrls.value.forEach(revoke)
})
</script>

<template>
  <main class="speech-page">
    <header class="topbar">
      <button class="back" type="button" @click="router.push('/')">{{ $t('smartSpeech.back') }}</button>
      <div class="brand-block">
        <span class="brand-dot" />
        <div>
          <strong>{{ $t('common.smartSpeech') }}</strong>
          <small>Speech Automation Studio</small>
        </div>
      </div>
      <button v-if="showWorkspace" class="new-task" type="button" @click="startNew">{{ $t('smartSpeech.newProject') }}</button>
      <span v-else class="top-note">{{ mode === 'digital-human' ? $t('smartSpeech.syncJoin') : $t('smartSpeech.automation') }}</span>
    </header>

    <div v-if="!showWorkspace" class="setup-shell">
      <section class="intro">
        <span class="kicker">{{ $t('smartSpeech.tagline') }}</span>
        <h1>{{ $t('smartSpeech.sourceTypeHint') }}</h1>
        <p>{{ $t('smartSpeech.assetsHint') }}</p>
      </section>

      <section class="mode-grid" :aria-label="$t('smartSpeech.type')">
        <button
          v-for="item in modes"
          :key="item.id"
          type="button"
          class="mode-card"
          :class="{ active: mode === item.id }"
          @click="setMode(item.id)"
        >
          <span class="mode-check">{{ mode === item.id ? '✓' : '' }}</span>
          <small>{{ item.eyebrow }}</small>
          <strong>{{ item.title }}</strong>
          <p>{{ item.desc }}</p>
          <em>{{ item.input }}</em>
        </button>
      </section>

      <div class="form-grid">
        <GlassCard padding="lg" class="input-card">
          <div class="section-title">
            <span>01</span>
            <div>
              <h2>{{ $t('smartSpeech.projectScript') }}</h2>
              <p v-if="mode === 'digital-human'">{{ $t('smartSpeech.digitalScriptHint') }}</p>
              <p v-else>{{ $t('smartSpeech.scriptValidation') }}</p>
            </div>
          </div>
          <label class="field">
            <span>{{ $t('smartSpeech.projectName') }}</span>
            <input v-model="name" maxlength="48" :placeholder="$t('smartSpeech.projectNameExample')" />
          </label>
          <label class="field">
            <span>{{ $t('common.narrationText') }}</span>
            <textarea v-model="script" rows="10" :placeholder="$t('smartSpeech.placeholder')" />
            <small>{{ script.replace(/\s/g, '').length }} {{ $t('common.characters') }}</small>
          </label>
          <div class="field">
            <span>{{ $t('smartSpeech.outputRatio') }}</span>
            <div class="ratio-row">
              <button type="button" :class="{ on: aspectRatio === '9:16' }" @click="aspectRatio = '9:16'">{{ $t('smartSpeech.portrait') }}</button>
              <button type="button" :class="{ on: aspectRatio === '16:9' }" @click="aspectRatio = '16:9'">{{ $t('smartSpeech.landscape') }}</button>
              <button type="button" :class="{ on: aspectRatio === '1:1' }" @click="aspectRatio = '1:1'">{{ $t('smartSpeech.square') }}</button>
            </div>
          </div>
        </GlassCard>

        <div class="right-stack">
          <GlassCard padding="lg" class="input-card">
            <div class="section-title">
              <span>02</span>
              <div>
                <h2>{{ selectedMode.title }}{{ $t('smartSpeech.assets') }}</h2>
                <p>{{ selectedMode.input }}</p>
              </div>
            </div>

            <template v-if="mode === 'digital-human'">
              <div class="upload-grid two">
                <div class="upload-box" :class="{ filled: imageFile }" role="button" @click="chooseImage">
                  <img v-if="imageUrl" :src="imageUrl" :alt="$t('smartSpeech.previewPortrait')" />
                  <template v-else>
                    <strong>{{ $t('smartSpeech.uploadPortrait') }}</strong>
                    <span>{{ $t('smartSpeech.portraitHint') }}</span>
                  </template>
                </div>
                <div class="upload-box" :class="{ filled: audioFile }" role="button" @click="chooseAudio">
                  <template v-if="audioFile">
                    <strong>{{ audioFile.name }}</strong>
                    <audio class="audio-preview" :src="audioUrl" controls @click.stop />
                  </template>
                  <template v-else>
                    <strong>{{ $t('smartSpeech.uploadVoice') }}</strong>
                    <span>{{ $t('smartSpeech.voiceSampleHint') }}</span>
                  </template>
                </div>
              </div>
            </template>

            <template v-else>
              <div class="upload-box wide" :class="{ filled: videoFiles.length }" role="button" @click="chooseVideos">
                <template v-if="videoFiles.length">
                  <strong>{{ $t('smartSpeech.selected') }} {{ videoFiles.length }} {{ $t('smartSpeech.videoCount') }}</strong>
                  <span>{{ videoFiles.map((file) => file.name).join('、') }}</span>
                </template>
                <template v-else>
                  <strong>{{ $t('smartSpeech.uploadLiveVideo') }}</strong>
                  <span>{{ $t('smartSpeech.multiTake') }}</span>
                </template>
              </div>
              <div v-if="videoUrls.length" class="video-strip">
                <video v-for="url in videoUrls" :key="url" :src="url" muted controls />
              </div>

              <template v-if="mode === 'human-aigc'">
                <div class="upload-box wide compact" role="button" @click="chooseReferences">
                  <strong>{{ $t('smartSpeech.addReference') }}</strong>
                  <span>{{ $t('smartSpeech.referenceHint') }}</span>
                </div>
                <div v-if="referenceUrls.length" class="reference-strip">
                  <button v-for="(url, index) in referenceUrls" :key="url" type="button" @click="removeReference(index)">
                    <img :src="url" :alt="$t('common.referenceImage')" />
                    <span>×</span>
                  </button>
                </div>
              </template>
            </template>
          </GlassCard>

          <GlassCard padding="lg" class="input-card">
            <div class="section-title compact-title">
              <span>03</span>
              <div>
                <h2>{{ $t('smartSpeech.processProject') }}</h2>
                <p>{{ $t('smartSpeech.adjustLater') }}</p>
              </div>
            </div>
            <div class="option-grid">
              <label><input v-model="options.removePauses" type="checkbox" /> {{ mode === 'digital-human' ? $t('smartSpeech.autoTrim') : $t('smartSpeech.removeLongPauses') }}</label>
              <label v-if="mode !== 'digital-human'"><input v-model="options.removeStumbles" type="checkbox" /> {{ $t('smartSpeech.removeDisfluencies') }}</label>
              <label v-if="mode !== 'digital-human'"><input v-model="options.beauty" type="checkbox" /> {{ $t('smartSpeech.beauty') }}</label>
              <label><input v-model="options.captions" type="checkbox" /> {{ $t('smartSpeech.narrationCaption') }}</label>
              <label v-if="mode !== 'digital-human'"><input v-model="options.titles" type="checkbox" /> {{ $t('smartSpeech.titleAndInfo') }}</label>
              <label><input v-model="options.keywordCallouts" type="checkbox" /> {{ $t('smartSpeech.keywordDecoration') }}</label>
              <label v-if="mode !== 'digital-human'"><input v-model="options.soundEffects" type="checkbox" /> {{ $t('smartSpeech.transitionsSfx') }}</label>
              <p v-if="mode === 'digital-human'" class="option-note">{{ $t('smartSpeech.voiceCloneGuide') }}</p>
              <label v-if="mode === 'human-aigc'"><input v-model="options.aigcInserts" type="checkbox" /> {{ $t('smartSpeech.insertAigc') }}</label>
            </div>
          </GlassCard>
        </div>
      </div>

      <footer class="create-bar">
        <div>
          <strong>{{ selectedMode.title }}</strong>
          <span v-if="!canCreate">{{ $t('smartSpeech.requiredFields') }}</span>
          <span v-else>{{ $t('smartSpeech.assetsReady') }}</span>
        </div>
        <GradientButton size="lg" :loading="saving" :disabled="!canCreate" @click="createSpeechProject">
          {{ $t('smartSpeech.create') }}
        </GradientButton>
      </footer>
    </div>

    <div v-else class="workspace-shell">
      <section class="workspace-head">
        <div>
          <span class="kicker">{{ $t('smartSpeech.workspace') }}</span>
          <h1>{{ project.current?.name }}</h1>
          <p>{{ currentFlow?.progress || $t('smartSpeech.assetsQueued') }}</p>
          <p v-if="currentFlow?.error" class="work-error">{{ currentFlow.error }}</p>
        </div>
        <div class="workspace-actions">
          <GradientButton type="ghost" @click="router.push('/caption')">{{ $t('smartSpeech.captionsAndHighlights') }}</GradientButton>
          <GradientButton type="ghost" @click="router.push('/export')">{{ $t('smartSpeech.export') }}</GradientButton>
          <GradientButton @click="router.push('/edit')">{{ $t('smartSpeech.editing') }}</GradientButton>
        </div>
      </section>

      <section class="stage-line">
        <div v-for="(item, index) in ['assets', 'voice', 'visual', 'export']" :key="item" :class="{ done: stageIndex > index, active: stageIndex === index }">
          <span>{{ stageIndex > index ? '✓' : index + 1 }}</span>
          <strong>{{ $t('smartSpeech.stages.' + item) }}</strong>
        </div>
      </section>

      <div class="workspace-grid">
        <GlassCard padding="lg" class="work-main">
          <div class="work-title">
            <div>
              <span>{{ $t('smartSpeech.currentTask') }}</span>
              <h2>
                {{ currentFlow?.stage === 'editing'
                  ? currentFlow?.mode === 'digital-human'
                    ? $t('smartSpeech.digitalReady')
                    : $t('smartSpeech.baseProjectReady')
                  : currentFlow?.mode === 'digital-human'
                    ? completedVideoCount
                      ? $t('smartSpeech.progress', { p0: completedVideoCount, p1: totalDigitalSegments })
                      : $t('smartSpeech.cloneNarration')
                    : $t('smartSpeech.generateBase') }}
              </h2>
            </div>
            <span class="status-pill">
              {{ building ? $t('common.generating') : currentFlow?.stage === 'editing' ? $t('smartSpeech.editable') : completedVideoCount ? $t('smartSpeech.resumable') : $t('common.pendingGeneration') }}
            </span>
          </div>
          <p class="work-desc">
            <template v-if="currentFlow?.mode === 'digital-human'">
              {{ $t('smartSpeech.splitNarration') }}
            </template>
            <template v-else>
              {{ $t('smartSpeech.timelineHint') }}
            </template>
          </p>
          <div class="deliverable-list">
            <div><span>{{ $t('smartSpeech.primaryAssets') }}</span><strong>{{ currentFlow?.mode === 'digital-human' ? $t('smartSpeech.digitalInput') : $t('smartSpeech.liveVideosCount', { p0: currentFlow?.videoAssetIds?.length || 0 }) }}</strong></div>
            <div v-if="currentFlow?.mode === 'digital-human'"><span>{{ $t('smartSpeech.voice') }}</span><strong>{{ $t('smartSpeech.cloneSynthesis') }}</strong></div>
            <div><span>{{ $t('common.caption') }}</span><strong>{{ currentFlow?.options.captions ? (currentFlow?.options.keywordCallouts ? $t('smartSpeech.burnHighlights') : $t('smartSpeech.generateDraft')) : $t('common.close') }}</strong></div>
            <div v-if="currentFlow?.mode !== 'digital-human'"><span>{{ $t('smartSpeech.packaging') }}</span><strong>{{ currentFlow?.options.titles ? $t('smartSpeech.pendingTitle') : $t('smartSpeech.simpleMode') }}</strong></div>
            <div v-if="currentFlow?.mode !== 'digital-human'"><span>AIGC</span><strong>{{ currentFlow?.options.aigcInserts ? $t('smartSpeech.enableInserts') : $t('smartSpeech.noInsert') }}</strong></div>
          </div>
          <section v-if="currentFlow?.mode === 'digital-human' && generatedPreviews.length" class="generated-section">
            <div class="generated-head">
              <div>
                <strong>{{ $t('common.videoReady') }}</strong>
                <span>{{ $t('smartSpeech.saveEachClip') }}</span>
              </div>
              <em>{{ generatedPreviews.length }} / {{ totalDigitalSegments }}</em>
            </div>
            <div class="generated-strip">
              <article v-for="item in generatedPreviews" :key="item.id">
                <video :src="item.url" controls preload="metadata" />
                <span>{{ $t('smartSpeech.ordinal') }} {{ item.index + 1 }} {{ $t('smartSpeech.savedClipCount') }}</span>
              </article>
            </div>
          </section>
          <div class="work-cta">
            <GradientButton v-if="building" type="ghost" size="lg" @click="cancelGeneration">
              {{ $t('smartSpeech.pause') }}
            </GradientButton>
            <GradientButton
              v-else-if="currentFlow?.stage !== 'editing'"
              size="lg"
              :loading="building"
              @click="buildBaseline"
            >
              {{ currentFlow?.mode === 'digital-human'
                ? completedVideoCount
                  ? $t('smartSpeech.continue', { p0: Math.max(0, totalDigitalSegments - completedVideoCount) })
                  : $t('smartSpeech.cloneNarration')
                : $t('smartSpeech.generateBase') }}
            </GradientButton>
            <GradientButton v-else size="lg" @click="router.push('/edit')">{{ $t('smartSpeech.inspectEdit') }}</GradientButton>
            <span>{{ completedVideoCount ? $t('smartSpeech.keepCompleted') : $t('smartSpeech.preserveSources') }}</span>
          </div>
        </GlassCard>

        <aside class="capability-panel">
          <h2>{{ $t('smartSpeech.automationStatus') }}</h2>
          <div class="capability ready"><span />{{ $t('smartSpeech.persistAssets') }}<strong>{{ $t('smartSpeech.ready') }}</strong></div>
          <div class="capability ready"><span />{{ currentFlow?.mode === 'digital-human' ? $t('smartSpeech.joinClips') : $t('smartSpeech.draftTimeline') }}<strong>{{ $t('smartSpeech.ready') }}</strong></div>
          <div v-if="currentFlow?.mode === 'digital-human'" class="capability ready"><span />{{ $t('smartSpeech.trimBreaths') }}<strong>{{ $t('common.connected') }}</strong></div>
          <div v-else class="capability"><span />{{ $t('smartSpeech.cleanup') }}<strong>{{ $t('smartSpeech.pendingConnection') }}</strong></div>
          <template v-if="currentFlow?.mode === 'digital-human'">
            <div class="capability ready"><span />{{ $t('smartSpeech.cloneVoice') }}<strong>{{ $t('common.connected') }}</strong></div>
            <div class="capability ready"><span />{{ $t('smartSpeech.h3LipSync') }}<strong>{{ $t('common.connected') }}</strong></div>
            <div class="capability"><span />{{ $t('smartSpeech.lipSyncQuality') }}<strong>{{ $t('smartSpeech.pendingEnhancement') }}</strong></div>
          </template>
          <div v-else class="capability"><span />{{ $t('smartSpeech.faceTracking') }}<strong>{{ $t('smartSpeech.pendingConnection') }}</strong></div>
          <div class="capability"><span />{{ $t('smartSpeech.brandTemplate') }}<strong>{{ $t('smartSpeech.pendingConnection') }}</strong></div>
          <div v-if="currentFlow?.mode === 'human-aigc'" class="capability"><span />{{ $t('smartSpeech.aigcOverlay') }}<strong>{{ $t('smartSpeech.pendingConnection') }}</strong></div>
          <div class="capability"><span />{{ $t('smartSpeech.qualityFallback') }}<strong>{{ $t('smartSpeech.pendingConnection') }}</strong></div>
        </aside>
      </div>
    </div>
  </main>
</template>

<style scoped>
.speech-page {
  height: 100%;
  overflow: auto;
  color: var(--color-text-1);
  background: var(--color-bg-0);
}
.topbar {
  height: 68px;
  padding: 0 32px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-1);
  position: sticky;
  top: 0;
  z-index: 20;
}
.back, .new-task {
  width: fit-content;
  color: var(--color-text-2);
  font-size: 13px;
  background: transparent;
}
.back:hover, .new-task:hover { color: var(--color-text-1); }
.new-task { justify-self: end; }
.brand-block { display: flex; gap: 10px; align-items: center; }
.brand-block strong { display: block; font-size: 15px; }
.brand-block small { display: block; color: var(--color-text-3); font-size: 10px; letter-spacing: .12em; margin-top: 2px; }
.brand-dot { width: 10px; height: 24px; border-radius: 8px; background: var(--color-accent); }
.top-note { justify-self: end; color: var(--color-text-3); font-size: 12px; }
.setup-shell, .workspace-shell { max-width: 1240px; margin: 0 auto; padding: 54px 32px 80px; }
.intro { max-width: 720px; margin-bottom: 30px; }
.kicker { display: block; color: var(--color-accent); font-weight: 650; font-size: 12px; letter-spacing: .08em; margin-bottom: 10px; }
.intro h1, .workspace-head h1 { font-size: 32px; line-height: 1.2; margin: 0 0 12px; letter-spacing: -.03em; }
.intro p, .workspace-head p { color: var(--color-text-2); line-height: 1.7; margin: 0; }
.work-error { color: var(--color-error); margin-top: 8px !important; }
.work-error { color: var(--color-error); margin-top: 8px !important; }
.mode-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 22px; }
.mode-card {
  position: relative;
  min-height: 205px;
  padding: 24px;
  text-align: left;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-card);
  color: var(--color-text-1);
  transition: .18s ease;
}
.mode-card:hover { transform: translateY(-2px); border-color: var(--color-border-strong); }
.mode-card.active { border-color: var(--color-accent); background: var(--color-fill); }
.mode-card small { color: var(--color-accent); font-size: 11px; font-weight: 700; }
.mode-card strong { display: block; font-size: 19px; margin: 12px 0 8px; }
.mode-card p { color: var(--color-text-2); font-size: 13px; line-height: 1.6; margin: 0 0 18px; }
.mode-card em { color: var(--color-text-3); font-size: 11px; font-style: normal; }
.mode-check { position: absolute; right: 18px; top: 18px; width: 22px; height: 22px; border: 1px solid var(--color-border-strong); border-radius: 50%; display: grid; place-items: center; color: white; font-size: 12px; }
.mode-card.active .mode-check { background: var(--color-accent); border-color: var(--color-accent); }
.form-grid { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: 18px; align-items: start; }
.right-stack { display: grid; gap: 18px; }
.input-card { overflow: visible; }
.section-title { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 22px; }
.section-title > span { color: var(--color-accent); font: 700 11px/1 monospace; padding-top: 5px; }
.section-title h2, .work-title h2, .capability-panel h2 { font-size: 16px; margin: 0 0 5px; }
.section-title p { color: var(--color-text-3); font-size: 12px; margin: 0; }
.compact-title { margin-bottom: 14px; }
.field { display: block; position: relative; margin-bottom: 18px; }
.field > span { display: block; font-size: 12px; font-weight: 650; margin-bottom: 8px; }
.field input, .field textarea { width: 100%; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-1); color: var(--color-text-1); padding: 11px 12px; resize: vertical; }
.field input:focus, .field textarea:focus { border-color: var(--color-accent); outline: none; }
.field > small { position: absolute; right: 9px; bottom: 8px; color: var(--color-text-3); font-size: 10px; }
.ratio-row { display: flex; gap: 8px; }
.ratio-row button { flex: 1; padding: 9px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-1); color: var(--color-text-2); font-size: 12px; }
.ratio-row button.on { border-color: var(--color-accent); color: var(--color-text-1); background: var(--color-fill); }
.upload-grid.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.upload-box { min-height: 164px; border: 1px dashed var(--color-border-strong); border-radius: var(--radius-md); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; cursor: pointer; overflow: hidden; background: var(--color-bg-1); text-align: center; padding: 14px; }
.upload-box:hover { border-color: var(--color-accent); }
.upload-box img { width: 100%; height: 150px; object-fit: cover; border-radius: var(--radius-sm); }
.upload-box strong { font-size: 13px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.upload-box span { color: var(--color-text-3); font-size: 11px; line-height: 1.5; }
.upload-box.wide { min-height: 116px; }
.upload-box.compact { min-height: 82px; margin-top: 12px; }
.audio-preview { width: 100%; height: 36px; }
.video-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 10px; }
.video-strip video { width: 100%; height: 92px; background: #000; border-radius: var(--radius-sm); object-fit: cover; }
.reference-strip { display: flex; gap: 8px; margin-top: 10px; overflow-x: auto; }
.reference-strip button { position: relative; width: 72px; height: 72px; flex: 0 0 auto; background: transparent; }
.reference-strip img { width: 100%; height: 100%; object-fit: cover; border-radius: var(--radius-sm); }
.reference-strip span { position: absolute; right: 3px; top: 3px; width: 18px; height: 18px; border-radius: 50%; background: rgba(0,0,0,.72); color: #fff; display: grid; place-items: center; }
.option-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; }
.option-grid label { display: flex; gap: 8px; align-items: center; color: var(--color-text-2); font-size: 12px; }
.option-grid input { accent-color: var(--color-accent); }
.option-note { grid-column: 1 / -1; margin: 0; color: var(--color-text-3); font-size: 12px; line-height: 1.6; }
.create-bar { position: sticky; bottom: 16px; margin-top: 20px; padding: 16px 18px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--color-border-strong); border-radius: var(--radius-lg); background: var(--color-bg-1); box-shadow: var(--shadow-lg); }
.create-bar strong { display: block; font-size: 13px; }
.create-bar span { display: block; color: var(--color-text-3); font-size: 11px; margin-top: 3px; }
.workspace-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 34px; }
.workspace-actions { display: flex; gap: 8px; }
.stage-line { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; margin-bottom: 20px; }
.stage-line > div { display: flex; align-items: center; gap: 9px; padding: 14px 16px; background: var(--color-bg-card); border: 1px solid var(--color-border); }
.stage-line > div:first-child { border-radius: var(--radius-md) 0 0 var(--radius-md); }
.stage-line > div:last-child { border-radius: 0 var(--radius-md) var(--radius-md) 0; }
.stage-line span { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--color-border-strong); display: grid; place-items: center; color: var(--color-text-3); font-size: 10px; }
.stage-line strong { font-size: 12px; color: var(--color-text-3); }
.stage-line .active { border-color: var(--color-accent); }
.stage-line .active span, .stage-line .done span { background: var(--color-accent); border-color: var(--color-accent); color: white; }
.stage-line .active strong, .stage-line .done strong { color: var(--color-text-1); }
.workspace-grid { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 18px; align-items: start; }
.work-main { min-height: 420px; }
.work-title { display: flex; justify-content: space-between; align-items: flex-start; }
.work-title > div > span { color: var(--color-text-3); font-size: 11px; }
.work-title h2 { margin-top: 5px; font-size: 22px; }
.status-pill { padding: 5px 9px; border-radius: 999px; color: var(--color-accent); background: var(--color-fill); font-size: 10px; }
.work-desc { color: var(--color-text-2); line-height: 1.75; font-size: 13px; padding: 18px 0; border-bottom: 1px solid var(--color-border); }
.deliverable-list { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 22px 0 30px; }
.deliverable-list > div { padding: 14px; border-radius: var(--radius-md); background: var(--color-bg-1); }
.deliverable-list span { display: block; color: var(--color-text-3); font-size: 10px; margin-bottom: 6px; }
.deliverable-list strong { font-size: 12px; }
.generated-section { margin: -12px 0 26px; padding-top: 18px; border-top: 1px solid var(--color-border); }
.generated-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.generated-head > div { display: flex; flex-direction: column; gap: 4px; }
.generated-head strong { font-size: 13px; }
.generated-head span { color: var(--color-text-3); font-size: 10px; }
.generated-head em { color: var(--color-primary); font-size: 12px; font-style: normal; font-weight: 700; }
.generated-strip { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(132px, 168px); gap: 10px; overflow-x: auto; padding-bottom: 8px; }
.generated-strip article { overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-1); }
.generated-strip video { display: block; width: 100%; aspect-ratio: 9 / 16; max-height: 220px; object-fit: cover; background: #000; }
.generated-strip span { display: block; padding: 8px 9px; color: var(--color-text-2); font-size: 10px; }
.work-cta { display: flex; align-items: center; gap: 14px; }
.work-cta > span { color: var(--color-text-3); font-size: 11px; }
.capability-panel { padding: 22px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-bg-card); }
.capability-panel h2 { margin-bottom: 16px; }
.capability { display: grid; grid-template-columns: 8px 1fr auto; gap: 9px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--color-border); font-size: 11px; color: var(--color-text-2); }
.capability:last-child { border-bottom: 0; }
.capability > span { width: 7px; height: 7px; border-radius: 50%; background: var(--color-text-3); }
.capability strong { color: var(--color-text-3); font-size: 10px; }
.capability.ready > span { background: var(--color-success); }
.capability.ready strong { color: var(--color-success); }
@media (max-width: 900px) {
  .mode-grid, .form-grid, .workspace-grid { grid-template-columns: 1fr; }
  .topbar { grid-template-columns: auto 1fr auto; }
  .brand-block { justify-self: center; }
  .workspace-head { align-items: flex-start; flex-direction: column; }
  .workspace-actions { flex-wrap: wrap; }
}
</style>
