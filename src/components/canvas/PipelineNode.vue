<script setup lang="ts">
import { isOpenAiTts, OPENAI_TTS_VOICES, recommendOpenAiVoice } from '@/services/ai/openAiTts'
import { ltxShotSpeechTooFast } from '@/services/ai/ltxShotPrompt'
import { nearestVideoDuration, videoDurationCapability, shotDurationWarning } from '@/services/ai/videoDuration'
import { isLtxTask, isLtxDesktop } from '@/services/ai/ltxDesktopOptions'
import { isLtxProfile, LTX_DEFAULT_MODEL } from '@/services/ai/ltxOptions'
import { t as translate } from '@/i18n'
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Handle, Position, useVueFlow } from '@vue-flow/core'
import { useAssetsStore, useLibraryStore, useProjectStore, useSettingsStore, useToastStore } from '@/stores'
import { runCanvasNode, stopLtxNodeWait, optimizeShotVideoPrompt, regenerateShotFrame, grabVideoLastFrameNode, canStopDrawThingsNodeWait, stopDrawThingsNodeWait } from '@/services/canvas/runner'
import { DRAW_THINGS_PROVIDER, drawThingsSize } from '@/services/ai/drawThingsOptions'
import { isNodeRunning } from '@/services/canvas/jobs'
import { needsPlayReview } from '@/services/canvas/playGate'
import { cssAspectRatio } from '@/services/canvas/layout'
import { applyShotVideoModel, applyShotVideoProfile } from '@/services/canvas/videoModel'
import { videoRequiresStoryboard } from '@/utils/storyboardGate'
import { stillModeFromNode } from '@/utils/videoStill'
import { inspectCanvasNode, selectCanvasNode } from '@/services/canvas/canvasBridge'
import { openLightbox } from '@/composables/useLightbox'
import ShotRefStrip from '@/components/canvas/ShotRefStrip.vue'
import NodeBusyOverlay from '@/components/canvas/NodeBusyOverlay.vue'
import AssetPicker from '@/components/common/AssetPicker.vue'
import SentMediaPrompts from './SentMediaPrompts.vue'
import ImageModelSelect from '@/components/settings/ImageModelSelect.vue'
import VideoModelSelect from '@/components/settings/VideoModelSelect.vue'
import H3GenModeSelect from '@/components/settings/H3GenModeSelect.vue'
import FramePairSlots from '@/components/canvas/FramePairSlots.vue'
import AspectRatioSeg from '@/components/common/AspectRatioSeg.vue'
import ImageResolutionSeg from '@/components/common/ImageResolutionSeg.vue'
import VideoSettingsPopover from '@/components/canvas/VideoSettingsPopover.vue'
import { pickDocImageResolution, pickDocVideoResolution, videoResolutionChoices, type DocImageResolution } from '@/services/ai/modelOptions'
import CanvasToolbarIcon from '@/components/canvas/CanvasToolbarIcon.vue'
import NodeLinkPlus from '@/components/canvas/NodeLinkPlus.vue'
import { canBuildExport } from '@/utils/timeline'
import { effectiveShotAudioMode, needsExternalTts } from '@/utils/shot'
import { defaultPropSheetPrompt, fillEmptyGeneratePrompt, shotFrameSendPrompt } from '@/utils/nodePrompt'
import { friendlyAiError, shouldToastAiError } from '@/services/ai/abort'
import { clampRect, cropContainedImage, trimVideoBlob, type NormRect } from '@/utils/mediaEdit'
import {
  normalizeH3GenMode,
  normalizeVideoGenModel,


  type AspectRatio,
  type CanvasNodeType,
  type H3VideoGenMode,
  type ID,
  type VideoGenModel,
  type VideoResolution
} from '@/types'

const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    subjectId?: string
    propId?: string
    sceneId?: string
    shotId?: string
    label?: string
    nodeType?: CanvasNodeType
  }
}>()

const type = computed<CanvasNodeType>(() => props.data.nodeType || 'script')

const project = useProjectStore()
const router = useRouter()
const assets = useAssetsStore()
const library = useLibraryStore()
const settings = useSettingsStore()
const drawThings = computed(() => settings.config.image.provider === DRAW_THINGS_PROVIDER)
const toast = useToastStore()
const mediaUrl = ref('')
const videoUrl = ref('')
const videoEl = ref<HTMLVideoElement | null>(null)
const audioEl = ref<HTMLAudioElement | null>(null)
const mediaBox = ref<HTMLElement | null>(null)
const playing = ref(false)
const playbackDuration = ref(0)
const moreOpen = ref(false)
const panelOpen = ref(false)
const pickerOpen = ref(false)
const toolBusy = ref('')
const optimizingPrompt = ref(false)
const cropOn = ref(false)
const trimOn = ref(false)
const crop = ref<NormRect>({ x: 0.08, y: 0.08, w: 0.84, h: 0.84 })
const trimStart = ref(0)
const trimEnd = ref(5)
let drag: { kind: string; x: number; y: number; start: NormRect } | null = null

const nodeMeta = computed(() => project.current?.canvas?.nodes.find((n) => n.id === props.id))
const shot = computed(() =>
  props.data.shotId ? project.current?.shots.find((s) => s.id === props.data.shotId) : undefined
)
const subject = computed(() =>
  props.data.subjectId
    ? (project.current?.subjects ?? []).find((s) => s.id === props.data.subjectId)
    : undefined
)
const propItem = computed(() =>
  props.data.propId
    ? (project.current?.props ?? []).find((item) => item.id === props.data.propId)
    : undefined
)
const scene = computed(() =>
  props.data.sceneId
    ? (project.current?.scenes ?? []).find((s) => s.id === props.data.sceneId)
    : undefined
)

/* 캐릭터 음색 설명과 선택형 참조 오디오 */
const voicePromptText = computed({
  get: () => subject.value?.voicePrompt ?? '',
  set: (v: string) => {
    if (subject.value) project.updateSubject(subject.value.id, { voicePrompt: v })
  }
})
const voiceRefUrl = ref('')
const voiceRefName = ref('')
const voiceRefPlaying = ref(false)
const voiceRefEl = ref<HTMLAudioElement | null>(null)
const voiceFileInput = ref<HTMLInputElement | null>(null)
const voiceUploading = ref(false)

const subjectKindText = computed(() => {
  const k = subject.value?.kind
  if (k === 'person') return translate('pipelineNode.person')
  if (k === 'animal') return translate('pipelineNode.animal')
  if (k === 'other') return translate('pipelineNode.object')
  return ''
})

const voiceSummary = computed(() => {
  const s = subject.value
  if (!s) return ''
  if (s.clonedVoiceId) return translate('pipelineNode.voiceCloned')
  if (s.voiceRefAssetId) return translate('pipelineNode.referenceAudioUploaded')
  const vp = s.voicePrompt?.trim()
  if (vp) return vp.length > 20 ? `${vp.slice(0, 20)}…` : vp
  return translate('pipelineNode.voiceMissing')
})
const voiceConfigured = computed(() => {
  const s = subject.value
  return Boolean(s?.clonedVoiceId || s?.voiceRefAssetId || s?.voicePrompt?.trim())
})

watch(
  () => subject.value?.voiceRefAssetId,
  async (id) => {
    voiceRefPlaying.value = false
    if (!id) {
      voiceRefUrl.value = ''
      voiceRefName.value = ''
      return
    }
    voiceRefUrl.value = (await assets.getUrl(id)) || ''
    voiceRefName.value = assets.getMeta(id)?.filename || translate('pipelineNode.referenceAudio')
  },
  { immediate: true }
)

function pickVoiceRef() {
  voiceFileInput.value?.click()
}

async function onVoiceRefChange(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !subject.value) return
  if (file.size > 10 * 1024 * 1024) {
    toast.error(translate('pipelineNode.audioLimit'))
    return
  }
  voiceUploading.value = true
  try {
    const asset = await assets.add(file, 'audio', 'uploaded', {
      filename: file.name,
      projectId: project.current?.id
    })
    // 샘플이 바뀌면 이전에 복제한 음색을 무효화한다.
    project.updateSubject(subject.value.id, {
      voiceRefAssetId: asset.id,
      clonedVoiceId: undefined,
      clonedVoiceModel: undefined
    })
    await project.save()
    toast.success(translate('pipelineNode.audioUploaded'))
  } catch (e: any) {
    toast.error(e?.message || translate('common.uploadFailed'))
  } finally {
    voiceUploading.value = false
  }
}

function removeVoiceRef() {
  if (!subject.value) return
  project.updateSubject(subject.value.id, {
    voiceRefAssetId: undefined,
    clonedVoiceId: undefined,
    clonedVoiceModel: undefined
  })
}

async function toggleVoiceRefPlay(ev: Event) {
  ev.stopPropagation()
  const a = voiceRefEl.value
  if (!a) return
  if (a.paused) {
    try {
      await a.play()
      voiceRefPlaying.value = true
    } catch {
      /* ignore */
    }
  } else {
    a.pause()
    voiceRefPlaying.value = false
  }
}

const durationLabel = computed(() => {
  const meta = assetId.value ? assets.getMeta(assetId.value) : undefined
  const actual =
    playbackDuration.value ||
    (meta && 'duration' in meta && Number(meta.duration) > 0 ? Number(meta.duration) : 0)
  const d = actual > 0 ? actual : shot.value?.duration
  if (!d || d <= 0) return ''
  return Number.isInteger(d) ? `${d}s` : `${Number(d).toFixed(1)}s`
})

const title = computed(() => {
  if (type.value === 'script') return project.current?.script?.topic || project.current?.name || translate('pipelineNode.script')
  if (subject.value) return subject.value.name
  if (propItem.value) return propItem.value.name
  if (scene.value) return scene.value.name
  if (shot.value) return `${shot.value.index + 1}. ${shot.value.title}`
  if (type.value === 'export') return translate('pipelineNode.compose')
  if (type.value === 'final') return translate('pipelineNode.videoPreview')
  return props.data.label || type.value
})

const kindLabel = computed(() => {
  if (type.value === 'subject') return translate('pipelineNode.fourViews')
  if (type.value === 'prop') return translate('pipelineNode.propView')
  if (type.value === 'sceneProps') return translate('pipelineNode.keyProps')
  if (type.value === 'scene') return translate('pipelineNode.anchorImage')
  if (type.value === 'shotBoard') return translate('pipelineNode.board')
  if (type.value === 'shotImage') return videoRequiresStoryboard(project.current) ? translate('pipelineNode.illustration') : translate('pipelineNode.grid')
  if (type.value === 'shotFrames') return translate('pipelineNode.firstLast')
  if (type.value === 'shotVideo') return translate('pipelineNode.video')
  if (type.value === 'audio') return translate('pipelineNode.narration')
  if (type.value === 'export') return translate('pipelineNode.composite')
  if (type.value === 'final') return translate('pipelineNode.preview')
  return ''
})

const assetId = computed(() => {
  const p = project.current
  if (!p) return undefined
  if (type.value === 'final') return p.finalVideoAssetId
  if (type.value === 'subject') return subject.value?.designSheetAssetId
  if (type.value === 'prop') return propItem.value?.designSheetAssetId
  if (type.value === 'sceneProps') return scene.value?.propSheetAssetId
  if (type.value === 'scene') return scene.value?.plateAssetId
  if (!shot.value) return undefined
  if (type.value === 'shotBoard') return shot.value.boardAssetId
  if (type.value === 'shotImage') return shot.value.imageAssetId
  // 두 결과 중 시작 프레임을 대표 이미지로 표시한다.
  if (type.value === 'shotFrames') return shot.value.firstFrameAssetId || shot.value.lastFrameAssetId
  if (type.value === 'shotVideo') return shot.value.videoAssetId
  if (type.value === 'audio') return shot.value.audioAssetId
  return undefined
})

const mediaAspect = computed(() => {
  const meta = assetId.value ? assets.getMeta(assetId.value) : undefined
  if (type.value !== 'shotFrames' && meta && (meta.kind === 'image' || meta.kind === 'video') && meta.width > 0 && meta.height > 0) {
    return `${meta.width} / ${meta.height}`
  }
  if (type.value === 'subject' || type.value === 'prop' || type.value === 'sceneProps' || type.value === 'scene') {
    return cssAspectRatio('16:9')
  }
  if (type.value === 'audio' || type.value === 'export') return '16 / 10'
  return cssAspectRatio(nodeAspectRatio.value)
})

const status = computed(() => nodeMeta.value?.status ?? 'idle')
const generating = computed(() => isNodeRunning(props.id))
// 시작 프레임과 종료 프레임이 모두 생성되면 완료로 표시한다.
const hasAsset = computed(() =>
  type.value === 'shotFrames'
    ? Boolean(shot.value?.firstFrameAssetId && shot.value?.lastFrameAssetId)
    : Boolean(assetId.value)
)
const gateBlocked = computed(
  () =>
    type.value !== 'script' &&
    type.value !== 'export' &&
    type.value !== 'final' &&
    needsPlayReview(project.current)
)

const isVideoNode = computed(() => type.value === 'shotVideo' || type.value === 'final')
const isFrameNode = computed(() => type.value === 'shotFrames')
const isImageNode = computed(
  () =>
    type.value === 'shotImage' ||
    type.value === 'shotBoard' ||
    type.value === 'subject' ||
    type.value === 'sceneProps' ||
    type.value === 'scene'
)
const videoModel = computed({
  get: () => normalizeVideoGenModel(nodeMeta.value?.data.videoModel ?? settings.config.defaultVideoModel),
  set: (v: VideoGenModel) => applyShotVideoModel(props.id, v)
})
const resolutionChoices = computed(() =>
  videoResolutionChoices({
    model: videoModel.value,
    profile: videoModel.value !== 'h3' && docVideoProfile.value?.provider === 'ltx' || videoModel.value === 'wan-prime' ? null : docVideoProfile.value
  })
)
const videoResolution = computed({
  get: () => {
    const choices = resolutionChoices.value
    if (choices.length) return pickDocVideoResolution(nodeMeta.value?.data.videoResolution ?? project.current?.settings.defaultVideoResolution, choices) || choices[0]
    return '768p' as VideoResolution
  },
  set: (v: VideoResolution) => project.patchCanvasNode(props.id, { videoResolution: v })
})
const docVideoProfile = computed(() => {
  const id = nodeMeta.value?.data.videoProfileId || shot.value?.videoProfileId || settings.config.activeVideoId
  return settings.config.videos.find((item) => item.id === id)
})
const imageResolutionChoices = computed(
  () =>
    settings.config.images.find((item) => item.id === settings.config.activeImageId)?.options?.imageResolutions ||
    []
)
const imageResolution = computed({
  get: () => pickDocImageResolution(nodeMeta.value?.data.imageResolution, imageResolutionChoices.value) || '2k',
  set: (v: DocImageResolution) => project.patchCanvasNode(props.id, { imageResolution: v })
})
const showVideoAudio = computed(() => Boolean(ltxProfile.value) || docVideoProfile.value?.options?.videoAudio === true)
const lastFrameRequired = computed(() => docVideoProfile.value?.options?.lastFrameRequired === true)
const generateAudio = computed({
  get: () => nodeMeta.value?.data.generateAudio ?? Boolean(ltxProfile.value),
  set: (v: boolean) => project.patchCanvasNode(props.id, { generateAudio: v })
})
const nodeAspectRatio = computed({
  get: () => nodeMeta.value?.data.aspectRatio ?? project.current?.settings.aspectRatio ?? '16:9',
  set: (v: AspectRatio) => {
    project.patchCanvasNode(props.id, { aspectRatio: v })
    if (type.value === 'shotVideo' && shot.value) project.invalidateShotAssets(shot.value.id, 'video')
    else if ((type.value === 'shotImage' || type.value === 'shotBoard') && shot.value) {
      project.invalidateShotAssets(shot.value.id, 'image')
    }
  }
})
const h3GenMode = computed({
  get: () => normalizeH3GenMode(shot.value?.h3GenMode),
  set: (v: H3VideoGenMode) => {
    if (shot.value) project.updateShot(shot.value.id, { h3GenMode: v })
  }
})
const firstFrameId = computed({
  get: () => shot.value?.firstFrameAssetId,
  set: (v: ID | undefined) => {
    if (shot.value) project.updateShot(shot.value.id, { firstFrameAssetId: v })
  }
})
const lastFrameId = computed({
  get: () => shot.value?.lastFrameAssetId,
  set: (v: ID | undefined) => {
    if (shot.value) project.updateShot(shot.value.id, { lastFrameAssetId: v })
  }
})
const isH3VideoNode = computed(() => type.value === 'shotVideo' && !ltxProfile.value && videoModel.value !== 'wan-prime')
const isH3Fl2va = computed(() => isH3VideoNode.value && h3GenMode.value === 'fl2va')
const videoStillHint = computed(() => {
  if (type.value !== 'shotVideo') return ''
  const mode = stillModeFromNode(nodeMeta.value)
  if (mode === 'identity') return translate('pipelineNode.identityOnly')
  if (mode === 'keyframe') return translate('pipelineNode.keyframeRequired')
  return translate('pipelineNode.boardRequired')
})
const showPrompt = computed(
  () =>
    type.value === 'shotImage' ||
    type.value === 'shotBoard' ||
    type.value === 'shotFrames' ||
    type.value === 'shotVideo' ||
    type.value === 'subject' ||
    type.value === 'sceneProps' ||
    type.value === 'scene' ||
    type.value === 'audio'
)

/** 시작과 종료 프레임은 각각의 URL로 나란히 표시한다. */
const frameUrls = ref({ start: '', end: '' })
async function loadFrames() {
  const s = shot.value
  if (!s) {
    frameUrls.value = { start: '', end: '' }
    return
  }
  const [a, b] = await Promise.all([
    s.firstFrameAssetId ? assets.getUrl(s.firstFrameAssetId) : Promise.resolve(undefined),
    s.lastFrameAssetId ? assets.getUrl(s.lastFrameAssetId) : Promise.resolve(undefined)
  ])
  frameUrls.value = { start: a || '', end: b || '' }
}

const extraRefIds = computed({
  get(): ID[] {
    if (type.value === 'subject') return subject.value?.referenceAssetIds ?? []
    if (type.value === 'prop') return propItem.value?.referenceAssetIds ?? []
    if (type.value === 'sceneProps') return scene.value?.propReferenceAssetIds ?? []
    if (type.value === 'scene') return scene.value?.referenceAssetIds ?? []
    return []
  },
  set(ids: ID[]) {
    if (type.value === 'subject' && subject.value) {
      project.updateSubject(subject.value.id, { referenceAssetIds: ids })
    } else if (type.value === 'prop' && propItem.value) {
      project.updateProp(propItem.value.id, { referenceAssetIds: ids })
    } else if (type.value === 'sceneProps' && scene.value) {
      project.updateScene(scene.value.id, { propReferenceAssetIds: ids })
    } else if (type.value === 'scene' && scene.value) {
      project.updateScene(scene.value.id, { referenceAssetIds: ids })
    }
  }
})

const promptValue = computed({
  get() {
    const p = project.current
    if (!p) return ''
    if (type.value === 'subject' && subject.value) return subject.value.sheetPrompt ?? ''
    if (type.value === 'prop' && propItem.value) return propItem.value.sheetPrompt ?? ''
    if (type.value === 'sceneProps' && scene.value) return scene.value.propSheetPrompt ?? ''
    if (type.value === 'scene' && scene.value) return scene.value.platePrompt ?? ''
    if (type.value === 'shotBoard' && shot.value) return shot.value.boardPrompt ?? ''
    if (type.value === 'shotImage' && shot.value) return shot.value.imagePrompt ?? ''
    if (type.value === 'shotVideo' && shot.value) return shot.value.compiledVideoPrompt ?? ''
    if (type.value === 'audio') return shot.value?.voiceover || ''
    return ''
  },
  set(v: string) {
    if (type.value === 'subject' && subject.value) project.updateSubject(subject.value.id, { sheetPrompt: v })
    else if (type.value === 'prop' && propItem.value) project.updateProp(propItem.value.id, { sheetPrompt: v })
    else if (type.value === 'sceneProps' && scene.value) {
      project.updateScene(scene.value.id, { propSheetPrompt: v })
    }
    else if (type.value === 'scene' && scene.value) project.updateScene(scene.value.id, { platePrompt: v })
    else if (type.value === 'shotBoard' && shot.value) project.updateShot(shot.value.id, { boardPrompt: v })
    else if (type.value === 'shotImage' && shot.value) project.updateShot(shot.value.id, { imagePrompt: v })
    else if (type.value === 'shotVideo' && shot.value) project.setShotVideoPrompt(shot.value.id, v)
    else if (type.value === 'audio' && shot.value) project.updateShot(shot.value.id, { voiceover: v })
  }
})

const promptHint = computed(() => {
  if (type.value === 'audio') return translate('pipelineNode.redubHint')
  if (type.value === 'shotVideo') return translate('pipelineNode.editVideoPrompt')
  if (settings.config.translateMediaPrompts) return translate('mediaPrompt.originalHint')
  return translate('pipelineNode.sendAsIs')
})

const metaLine = computed(() => {
  const ar = nodeAspectRatio.value
  const w = project.current?.settings.width ?? 1280
  const h = project.current?.settings.height ?? 720
  if (type.value === 'shotVideo') return `MiniMax H3 · ${ar}`
  if (type.value === 'audio') {
    if (!shot.value) return translate('pipelineNode.narration')
    return effectiveShotAudioMode(shot.value) === 'tts' ? translate('pipelineNode.postTts') : translate('pipelineNode.h3Voice')
  }
  const model = settings.config.image.model || translate('pipelineNode.imageGeneration')
  const sheet = ['subject', 'prop', 'sceneProps', 'scene'].includes(type.value)
  const imageRatio = drawThings.value && sheet ? '16:9' : ar
  const [width, height] = drawThings.value
    ? drawThingsSize(imageRatio, w, h) : [w, h]
  return `${model} · ${imageRatio} · ${width}×${height}`
})

const genLabel = computed(() => {
  if (gateBlocked.value) return translate('pipelineNode.approveFirst')
  const again = hasAsset.value
  if (type.value === 'subject') return again ? translate('pipelineNode.regenerate') : translate('pipelineNode.generateFourViews')
  if (type.value === 'prop') return again ? translate('pipelineNode.regenerate') : translate('pipelineNode.generatePropViews')
  if (type.value === 'sceneProps') return again ? translate('pipelineNode.regenerate') : translate('pipelineNode.generateKeyProps')
  if (type.value === 'scene') return again ? translate('pipelineNode.regenerate') : translate('pipelineNode.generateAnchor')
  if (type.value === 'shotBoard') return again ? translate('pipelineNode.regenerate') : translate('pipelineNode.generateBoard')
  if (type.value === 'shotImage') {
    return again ? translate('pipelineNode.regenerate') : videoRequiresStoryboard(project.current) ? translate('pipelineNode.generateIllustration') : translate('pipelineNode.generateGrid')
  }
  if (type.value === 'shotFrames') return again ? translate('pipelineNode.redrawFrames') : translate('pipelineNode.drawFrames')
  if (type.value === 'shotVideo') return again ? translate('pipelineNode.regenerate') : translate('pipelineNode.generateVideo')
  if (type.value === 'audio') {
    if (!shot.value || !needsExternalTts(shot.value, project.current)) return ''
    return again ? translate('pipelineNode.regenerate') : translate('pipelineNode.generateNarration')
  }
  if (type.value === 'export' || type.value === 'final') {
    return again || project.current?.finalVideoAssetId ? translate('pipelineNode.composeAgain') : translate('pipelineNode.compose')
  }
  return again ? translate('pipelineNode.regenerate') : translate('pipelineNode.generate')
})

const { findNode, removeSelectedNodes } = useVueFlow()

watch(assetId, () => loadMedia(), { immediate: true })
watch(
  () => [shot.value?.firstFrameAssetId, shot.value?.lastFrameAssetId],
  () => {
    if (type.value === 'shotFrames') void loadFrames()
  },
  { immediate: true }
)
watch(
  // 각 항목을 개별 감시 대상으로 등록한다. getter가 매번 배열을 새로 만들면
  // 같은 내용으로 프롬프트가 갱신될 때도 감시가 다시 실행된다.
  [
    () => props.selected,
    () => type.value,
    () => shot.value?.id,
    () => subject.value?.id,
    () => propItem.value?.id,
    () => scene.value?.id
  ],
  ([on]) => {
    panelOpen.value = Boolean(on)
    if (!on) {
      moreOpen.value = false
      cropOn.value = false
      trimOn.value = false
    }
    const p = project.current
    const t = type.value
    if (!p) return
    if (t === 'subject' && subject.value) {
      const patch = fillEmptyGeneratePrompt('subject', p, subject.value)
      if (patch) project.updateSubject(subject.value.id, patch)
    } else if (t === 'prop' && propItem.value && propItem.value.sheetPrompt == null) {
      project.updateProp(propItem.value.id, { sheetPrompt: defaultPropSheetPrompt(propItem.value, p) })
    } else if (t === 'scene' && scene.value) {
      const patch = fillEmptyGeneratePrompt('scene', p, scene.value)
      if (patch) project.updateScene(scene.value.id, patch)
    } else if (t === 'sceneProps' && scene.value) {
      const patch = fillEmptyGeneratePrompt('sceneProps', p, scene.value)
      if (patch) project.updateScene(scene.value.id, patch)
    } else if (t === 'shotBoard' && shot.value) {
      const patch = fillEmptyGeneratePrompt('shotBoard', p, shot.value)
      if (patch) project.updateShot(shot.value.id, patch)
    } else if (t === 'shotImage' && shot.value) {
      const patch = fillEmptyGeneratePrompt('shotImage', p, shot.value)
      if (patch) project.updateShot(shot.value.id, patch)
    }
  },
  { immediate: true }
)

const ltxProfile = computed(() => type.value === 'shotVideo' && videoModel.value === 'h3' && isLtxProfile(docVideoProfile.value)
  ? docVideoProfile.value : undefined)
const durationCapability = computed(() => videoDurationCapability({
  model: videoModel.value, profile: docVideoProfile.value, resolution: videoResolution.value,
  startEndFrames: h3GenMode.value === 'fl2va' || project.current?.settings.h3ShotChainMode === 'fl2va'
}))
const durationOptions = computed(() => durationCapability.value.durations)

const ltxResume = computed(() => isLtxTask(shot.value?.videoTaskId))
const shotDurationValue = computed(() => nearestVideoDuration(shot.value?.duration || 5, durationOptions.value))
const exceedsShotDuration = computed(() => shotDurationWarning(shot.value?.duration, durationCapability.value.max))

function setShotDuration(raw: number) {
  if (!shot.value) return
  project.updateShot(shot.value.id, { duration: nearestVideoDuration(raw || shot.value.duration, durationOptions.value) })
}

const redrawFrameWait = shallowRef<AbortController>()

/** 시작 또는 종료 프레임 하나만 다시 생성한다. */
async function redrawFrame(which: 'start' | 'end') {
  if (generating.value || toolBusy.value || !shot.value) return
  moreOpen.value = false
  const controller = drawThings.value ? new AbortController() : undefined
  redrawFrameWait.value = controller
  try {
    await regenerateShotFrame(
      shot.value,
      which,
      (msg) => {
        toolBusy.value = msg
      },
      controller?.signal
    )
    await loadFrames()
    toast.success(which === 'start' ? translate('common.startFrameRedrawn') : translate('common.endFrameRedrawn'))
  } catch (e: any) {
    if (controller?.signal.aborted) toast.info(translate('drawThings.cancelled'))
    else toast.error(friendlyAiError(e) || translate('common.redrawFailed'))
  } finally {
    redrawFrameWait.value = undefined
    toolBusy.value = ''
  }
}

const startFramePromptValue = computed({
  get() {
    const s = shot.value
    if (!s || !project.current) return ''
    return s.startFramePrompt?.trim() || shotFrameSendPrompt(s, project.current, 'start')
  },
  set(v: string) {
    if (shot.value) project.updateShot(shot.value.id, { startFramePrompt: v })
  }
})
const endFramePromptValue = computed({
  get() {
    const s = shot.value
    if (!s || !project.current) return ''
    return s.endFramePrompt?.trim() || shotFrameSendPrompt(s, project.current, 'end')
  },
  set(v: string) {
    if (shot.value) project.updateShot(shot.value.id, { endFramePrompt: v })
  }
})

function dismissPanel() {
  moreOpen.value = false
  cropOn.value = false
  trimOn.value = false
  panelOpen.value = false
  const n = findNode(props.id)
  if (n) removeSelectedNodes([n])
}

async function publishToLibrary() {
  if (!assetId.value || !isImageNode.value) return
  moreOpen.value = false
  try {
    const meta = assets.getMeta(assetId.value)
    await library.publishFrom(assetId.value, {
      filename: meta?.filename || title.value,
      prompt: promptValue.value
    })
    toast.success(translate('common.addedToPublicAssets'))
  } catch (e: any) {
    toast.error(e?.message || translate('common.libraryAddFailed'))
  }
}

async function loadMedia() {
  const id = assetId.value
  playing.value = false
  playbackDuration.value = 0
  if (!id) {
    mediaUrl.value = ''
    videoUrl.value = ''
    return
  }
  if (type.value === 'shotVideo' || type.value === 'final') {
    videoUrl.value = (await assets.getUrl(id)) || ''
    mediaUrl.value = (await assets.ensureThumb(id)) || videoUrl.value
  } else {
    videoUrl.value = ''
    mediaUrl.value = (await assets.getUrl(id)) || ''
  }
  // 시작과 종료 프레임을 함께 갱신한다.
  if (type.value === 'shotFrames') await loadFrames()
}

defineExpose({ loadMedia })

async function optimizePrompt(ev?: Event) {
  ev?.stopPropagation()
  if (type.value !== 'shotVideo' || !shot.value || optimizingPrompt.value || generating.value) return
  optimizingPrompt.value = true
  try {
    await optimizeShotVideoPrompt(shot.value)
    toast.success(translate('common.optimized'))
  } catch (e: any) {
    toast.error(friendlyAiError(e) || translate('common.optimizationFailed'))
  } finally {
    optimizingPrompt.value = false
  }
}

async function generateThis(ev?: Event, hd = false) {
  ev?.stopPropagation()
  if (generating.value || gateBlocked.value || toolBusy.value) return
  if ((type.value === 'export' || type.value === 'final') && !canBuildExport(project.current)) {
    toast.warn(translate('pipelineNode.noExport'))
    return
  }
  if (type.value === 'export' || type.value === 'final') {
    dismissPanel()
    await router.push('/edit')
    return
  }
  moreOpen.value = false
  dismissPanel()
  try {
    await runCanvasNode(
      props.id,
      (_id, msg) => {
        toolBusy.value = msg
      },
      undefined,
      hd ? { hd: true } : undefined
    )
    await loadMedia()
    if (hd) toast.success(translate('pipelineNode.upscaled'))
  } catch (e: any) {
    // 실패 상태만 표시하면 원인을 알 수 없으므로 오류 내용도 알림으로 표시한다.
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e) || translate('common.generateFailed'))
    else if (nodeMeta.value?.error && ['ltx.stopped', 'ltxDesktop.cancelRequested', 'drawThings.cancelled'].some(key => nodeMeta.value?.error === translate(key))) {
      toast.info(nodeMeta.value.error)
    }
  } finally {
    toolBusy.value = ''
  }
}

function onLoadedMetadata(ev: Event) {
  const v = ev.target as HTMLVideoElement
  if (v && Number.isFinite(v.duration) && v.duration > 0) {
    playbackDuration.value = v.duration
    if (trimOn.value) trimEnd.value = Number(v.duration.toFixed(2))
  }
}

function currentMedia(): HTMLMediaElement | null {
  if (isVideoNode.value) return videoEl.value
  if (type.value === 'audio') return audioEl.value
  return null
}

async function togglePlay(ev: Event) {
  ev.stopPropagation()
  selectCanvasNode(props.id)
  const v = currentMedia()
  if (!v) return
  if (v.paused) {
    try {
      v.muted = false
      await v.play()
      playing.value = true
    } catch {
      if (type.value === 'shotVideo') {
        try {
          v.muted = true
          await v.play()
          playing.value = true
        } catch {
          /* ignore */
        }
      }
    }
  } else {
    v.pause()
    playing.value = false
  }
}

function onVideoPlay() {
  playing.value = true
}
function onVideoPause() {
  const v = videoEl.value
  if (!v || v.ended) playing.value = false
}
function bufferedEnd(v: HTMLVideoElement) {
  try {
    if (v.buffered.length === 0) return 0
    return v.buffered.end(v.buffered.length - 1)
  } catch {
    return 0
  }
}
function onVideoEnded() {
  const v = videoEl.value
  if (v) {
    const dur = Number.isFinite(v.duration) ? v.duration : 0
    const buf = bufferedEnd(v)
    if (buf > v.currentTime + 0.2 || (dur > 0 && v.currentTime < dur - 0.35 && buf > v.currentTime + 0.05)) {
      v.play().catch(() => {})
      return
    }
    v.currentTime = 0
  }
  playing.value = false
}
function onCanPlay() {
  const v = currentMedia()
  if (playing.value && v?.paused && !v.ended) v.play().catch(() => {})
}
function onAudioEnded() {
  playing.value = false
  if (audioEl.value) audioEl.value.currentTime = 0
}

function startCrop() {
  if (!hasAsset.value) {
    toast.warn(translate('pipelineNode.generateBeforeCrop'))
    return
  }
  trimOn.value = false
  cropOn.value = true
  crop.value = { x: 0.08, y: 0.08, w: 0.84, h: 0.84 }
}

/** 영상의 끝 프레임을 이미지 노드로 추출한다. 다음 샷의 시작 프레임이나 참조로 쓸 수 있다. */
async function grabLastFrame() {
  if (toolBusy.value) return
  if (!assetId.value) {
    toast.warn(translate('pipelineNode.generateBeforeExtract'))
    return
  }
  cropOn.value = false
  trimOn.value = false
  toolBusy.value = translate('pipelineNode.extractingEnd')
  try {
    await grabVideoLastFrameNode(props.id, (msg) => {
      toolBusy.value = msg
    })
    toast.success(translate('pipelineNode.frameExtracted'))
  } catch (e: any) {
    toast.error(e?.message || translate('pipelineNode.extractFrameFailed'))
  } finally {
    toolBusy.value = ''
  }
}

function startTrim() {
  if (!videoUrl.value) {
    toast.warn(translate('pipelineNode.generateBeforeTrim'))
    return
  }
  cropOn.value = false
  const dur = playbackDuration.value || shot.value?.duration || 5
  trimStart.value = 0
  trimEnd.value = Number(dur.toFixed(2))
  trimOn.value = true
  if (videoEl.value) videoEl.value.currentTime = 0
}

function onCropDown(kind: string, ev: PointerEvent) {
  ev.preventDefault()
  ev.stopPropagation()
  const box = mediaBox.value
  if (!box) return
  drag = { kind, x: ev.clientX, y: ev.clientY, start: { ...crop.value } }
  window.addEventListener('pointermove', onCropMove)
  window.addEventListener('pointerup', onCropUp)
}

function onCropMove(ev: PointerEvent) {
  if (!drag || !mediaBox.value) return
  const rect = mediaBox.value.getBoundingClientRect()
  const dx = (ev.clientX - drag.x) / rect.width
  const dy = (ev.clientY - drag.y) / rect.height
  const s = drag.start
  if (drag.kind === 'move') {
    crop.value = clampRect({ ...s, x: s.x + dx, y: s.y + dy })
    return
  }
  let { x, y, w, h } = s
  if (drag.kind.includes('w')) {
    const nx = Math.min(x + w - 0.12, x + dx)
    w += x - nx
    x = nx
  }
  if (drag.kind.includes('e')) w = Math.max(0.12, w + dx)
  if (drag.kind.includes('n')) {
    const ny = Math.min(y + h - 0.12, y + dy)
    h += y - ny
    y = ny
  }
  if (drag.kind.includes('s')) h = Math.max(0.12, h + dy)
  crop.value = clampRect({ x, y, w, h })
}

function onCropUp() {
  drag = null
  window.removeEventListener('pointermove', onCropMove)
  window.removeEventListener('pointerup', onCropUp)
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onCropMove)
  window.removeEventListener('pointerup', onCropUp)
})

async function applyCrop() {
  const id = assetId.value
  const box = mediaBox.value
  if (!id || !box) return
  toolBusy.value = translate('pipelineNode.cropping')
  try {
    const blob = await assets.getBlob(id)
    if (!blob) throw new Error(translate('pipelineNode.imageReadFailed'))
    const out = await cropContainedImage(blob, { width: box.clientWidth, height: box.clientHeight }, crop.value)
    await replaceImage(out, `crop_${Date.now().toString(36)}`)
    cropOn.value = false
    toast.success(translate('pipelineNode.cropped'))
  } catch (e: any) {
    toast.error(e?.message || translate('pipelineNode.cropFailed'))
  } finally {
    toolBusy.value = ''
  }
}

async function applyTrim() {
  const id = assetId.value
  if (!id) return
  const start = Math.max(0, trimStart.value)
  const end = Math.max(start + 0.2, trimEnd.value)
  toolBusy.value = translate('pipelineNode.trimming')
  try {
    const blob = await assets.getBlob(id)
    if (!blob) throw new Error(translate('pipelineNode.videoReadFailed'))
    const w = project.current?.settings.width ?? 1280
    const h = project.current?.settings.height ?? 720
    const fps = project.current?.settings.fps ?? 30
    const out = await trimVideoBlob(blob, start, end - start, w, h, fps, (m) => {
      toolBusy.value = m
    })
    const asset = await assets.add(out, 'video', 'extracted', {
      filename: `trim_${Date.now().toString(36)}`,
      projectId: project.current?.id,
      shotId: shot.value?.id
    })
    if (type.value === 'final') project.setFinalVideo(asset.id)
    else if (shot.value) {
      project.assignShotVideo(shot.value.id, asset.id)
      project.updateShot(shot.value.id, { duration: Math.max(1, Math.round(end - start)) })
    }
    await project.save()
    trimOn.value = false
    await loadMedia()
    toast.success(translate('pipelineNode.trimmed'))
  } catch (e: any) {
    toast.error(e?.message || translate('pipelineNode.trimFailed'))
  } finally {
    toolBusy.value = ''
  }
}

async function replaceImage(blob: Blob, filename: string) {
  const asset = await assets.add(blob, 'image', 'extracted', {
    filename,
    projectId: project.current?.id,
    shotId: shot.value?.id
  })
  project.assignCanvasNodeAsset(props.id, asset.id)
  await project.save()
  await loadMedia()
}

function openOutputPicker() {
  pickerOpen.value = true
}

function onEmptyClick() {
  if (!isImageNode.value || generating.value) return
  if (props.selected && panelOpen.value) openOutputPicker()
}

async function onPickerConfirm(ids: ID[]) {
  pickerOpen.value = false
  const id = ids[0]
  if (!id) return
  try {
    const asset = await assets.adopt(id, 'image', {
      projectId: project.current?.id,
      shotId: shot.value?.id
    })
    project.assignCanvasNodeAsset(props.id, asset.id)
    await project.save()
    await loadMedia()
    toast.success(translate('common.imageSelected'))
  } catch (e: any) {
    toast.error(e?.message || translate('common.useFailed'))
  }
}

async function downloadAsset() {
  const id = assetId.value
  if (!id) {
    toast.warn(translate('pipelineNode.noDownload'))
    return
  }
  const blob = await assets.getBlob(id)
  if (!blob) {
    toast.error(translate('common.assetReadFailed'))
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${title.value}.${isVideoNode.value ? 'mp4' : type.value === 'audio' ? 'wav' : 'png'}`
  a.click()
  URL.revokeObjectURL(url)
}

function copyPrompt() {
  const t = promptValue.value.trim()
  if (!t) {
    toast.warn(translate('common.noPrompt'))
    return
  }
  navigator.clipboard.writeText(t).then(
    () => toast.success(translate('common.promptCopied')),
    () => toast.error(translate('common.copyFailed'))
  )
}

function openDetail() {
  inspectCanvasNode(props.id)
}

function previewFull() {
  if (isVideoNode.value && videoUrl.value) openLightbox(videoUrl.value, 'video', title.value)
  else if (mediaUrl.value) openLightbox(mediaUrl.value, 'image', title.value)
}

function onTrimStart(v: number) {
  trimStart.value = Math.min(v, trimEnd.value - 0.2)
  if (videoEl.value) videoEl.value.currentTime = trimStart.value
}

function onTrimEnd(v: number) {
  const max = playbackDuration.value || shot.value?.duration || 10
  trimEnd.value = Math.max(v, trimStart.value + 0.2)
  trimEnd.value = Math.min(trimEnd.value, max)
  if (videoEl.value) videoEl.value.currentTime = trimEnd.value
}

const cropStyle = computed(() => ({
  left: `${crop.value.x * 100}%`,
  top: `${crop.value.y * 100}%`,
  width: `${crop.value.w * 100}%`,
  height: `${crop.value.h * 100}%`
}))
</script>

<template>
  <div class="pnode" :class="[`kind-${type}`, `st-${status}`, { on: selected && panelOpen, empty: !hasAsset, busy: generating || !!toolBusy }]">
    <NodeLinkPlus :node-id="id" />
    <Handle v-if="type !== 'script'" id="in" type="target" :position="Position.Left" class="hndl" />
    <Handle v-if="type === 'shotBoard' || type === 'shotImage' || type === 'shotFrames'" id="char1" type="target" :position="Position.Left" :style="{ top: '28%' }" class="hndl" />
    <Handle v-if="type === 'shotBoard' || type === 'shotImage' || type === 'shotFrames'" id="char2" type="target" :position="Position.Left" :style="{ top: '50%' }" class="hndl" />
    <Handle v-if="type === 'shotBoard' || type === 'shotImage' || type === 'shotFrames'" id="scene" type="target" :position="Position.Left" :style="{ top: '72%' }" class="hndl" />
    <Handle v-if="type === 'shotImage' && videoRequiresStoryboard(project.current)" id="board" type="target" :position="Position.Left" :style="{ top: '50%' }" class="hndl" />
    <Handle v-if="type === 'shotVideo'" id="image" type="target" :position="Position.Left" :style="{ top: '30%' }" class="hndl" />
    <Handle v-if="type === 'shotVideo'" id="frames" type="target" :position="Position.Left" :style="{ top: '70%' }" class="hndl" />

    <transition name="float-up">
      <div v-if="selected && panelOpen" class="toolbar-wrap nodrag nowheel" @mousedown.stop @click.stop>
        <div class="toolbar">
          <button v-if="isImageNode && hasAsset" type="button" :disabled="!!toolBusy" @click="startCrop">
            <span>✂</span>{{ $t('common.crop') }}
          </button>
          <button v-if="isImageNode && !drawThings" type="button" :disabled="generating || gateBlocked || !!toolBusy" @click="generateThis($event, true)">
            <span>HD</span>{{ $t('pipelineNode.hd') }}
          </button>
          <button v-if="isVideoNode && hasAsset" type="button" :disabled="!!toolBusy" @click="startTrim">
            <span>🎞</span>{{ $t('common.trim') }}
          </button>
          <button
            v-if="isVideoNode && hasAsset"
            type="button"
            :disabled="!!toolBusy"
            :title="$t('pipelineNode.extractFrameHint')"
            @click="grabLastFrame"
          >
            <span>◫</span>{{ $t('pipelineNode.extractFrame') }}
          </button>
          <button v-if="genLabel" type="button" :disabled="generating || gateBlocked || !!toolBusy" @click="generateThis">
            <span>↺</span>{{ hasAsset ? $t('pipelineNode.redraw') : genLabel }}
          </button>
          <button
            v-if="type === 'shotVideo' && isH3VideoNode"
            type="button"
            :disabled="generating || gateBlocked || !!toolBusy || optimizingPrompt"
            :title="$t('common.optimizeCurrent')"
            @click="optimizePrompt"
          >
            <span>✦</span>{{ optimizingPrompt ? $t('common.optimizing') : $t('common.optimizePrompt') }}
          </button>
          <button
            v-if="isImageNode"
            type="button"
            :disabled="generating || !!toolBusy"
            :title="$t('pipelineNode.reuseImage')"
            @click="openOutputPicker"
          >
            <span>▣</span>{{ $t('common.useSelection') }}
          </button>
          <button v-if="hasAsset" type="button" @click="downloadAsset">
            <span>⬇</span>{{ $t('common.download') }}
          </button>
          <button type="button" class="icon" :title="$t('common.more')" @click="moreOpen = !moreOpen"><CanvasToolbarIcon name="more" :size="17" /></button>
          <button v-if="hasAsset" type="button" class="icon" :title="$t('common.fullImage')" @click="previewFull"><CanvasToolbarIcon name="expand" :size="17" /></button>
          <div v-if="moreOpen" class="more">
            <button v-if="showPrompt" type="button" @click="copyPrompt(); moreOpen = false">{{ $t('common.copyPrompt') }}</button>
            <button
              v-if="isImageNode && hasAsset"
              type="button"
              @click="publishToLibrary"
            >
              {{ $t('common.addToPublicLibrary') }}
            </button>
            <button type="button" @click="openDetail(); moreOpen = false">{{ $t('pipelineNode.details') }}</button>
          </div>
        </div>
      </div>
    </transition>

    <div v-if="type === 'subject' && subject" class="sc-head">
      <span class="sc-name" :title="title">{{ title }}</span>
      <span class="sc-role">{{ subject.role || subjectKindText || $t('common.character') }}</span>
    </div>

    <div ref="mediaBox" class="pnode-media" :style="{ aspectRatio: mediaAspect }">
      <template v-if="type === 'audio'">
        <audio
          v-if="mediaUrl"
          ref="audioEl"
          class="nodrag nowheel"
          :src="mediaUrl"
          preload="auto"
          @play="onVideoPlay"
          @ended="onAudioEnded"
          @canplay="onCanPlay"
        />
        <div class="audio-card">
          <button v-if="mediaUrl" class="vo-play nodrag" type="button" @click.stop="togglePlay" @mousedown.stop>
            {{ playing ? '❚❚' : '▶' }}
          </button>
          <span>{{ shot?.voiceover?.slice(0, 36) || (mediaUrl ? $t('common.narration') : $t('common.noNarration')) }}</span>
        </div>
      </template>
      <div v-else-if="type === 'export'" class="ph text">{{ $t('pipelineNode.compose') }}</div>
      <template v-else-if="isVideoNode && videoUrl">
        <video
          ref="videoEl"
          class="nowheel"
          :draggable="false"
          @dragstart.prevent
          :src="videoUrl"
          :poster="mediaUrl && mediaUrl !== videoUrl ? mediaUrl : undefined"
          playsinline
          preload="auto"
          @loadedmetadata="onLoadedMetadata"
          @canplay="onCanPlay"
          @play="onVideoPlay"
          @pause="onVideoPause"
          @ended="onVideoEnded"
        />
        <button class="play-btn nodrag" :class="{ playing }" type="button" :title="playing ? $t('common.pause') : $t('common.play')" @click.stop="togglePlay" @mousedown.stop>
          {{ playing ? 'Ⅱ' : '▶' }}
        </button>
      </template>
      <div v-else-if="type === 'shotFrames'" class="frame-pair">
        <div class="fp-cell">
          <img v-if="frameUrls.start" :src="frameUrls.start" :alt="$t('mediaNodes.startFrame')" :draggable="false" @dragstart.prevent />
          <div v-else class="fp-ph">＋</div>
          <span class="fp-tag">{{ $t('pipelineNode.start') }}</span>
          <button
            v-if="frameUrls.start && !generating && !toolBusy"
            class="fp-redo"
            :title="$t('pipelineNode.redrawStart')"
            @click.stop="redrawFrame('start')"
          >↺</button>
        </div>
        <span class="fp-arrow">→</span>
        <div class="fp-cell">
          <img v-if="frameUrls.end" :src="frameUrls.end" :alt="$t('mediaNodes.endFrame')" :draggable="false" @dragstart.prevent />
          <div v-else class="fp-ph">＋</div>
          <span class="fp-tag">{{ $t('pipelineNode.end') }}</span>
          <button
            v-if="frameUrls.end && !generating && !toolBusy"
            class="fp-redo"
            :title="$t('pipelineNode.redrawEnd')"
            @click.stop="redrawFrame('end')"
          >↺</button>
        </div>
      </div>
      <img v-else-if="mediaUrl" :src="mediaUrl" alt="" :draggable="false" @dragstart.prevent />
      <div
        v-else
        class="ph"
        :class="{ pick: isImageNode }"
        :title="isImageNode ? $t('common.useExistingImage') : undefined"
        @click="onEmptyClick"
      >
        {{ isVideoNode ? '▶' : '＋' }}
      </div>
      <span v-if="isVideoNode && durationLabel && !trimOn && !generating && !toolBusy" class="dur">{{ durationLabel }}</span>
      <button v-if="canStopDrawThingsNodeWait(props.id)" type="button" class="ltx-stop nodrag" @click.stop="stopDrawThingsNodeWait(props.id)">{{ $t('drawThings.stopWaiting') }}</button>
      <button v-if="redrawFrameWait" type="button" class="ltx-stop nodrag" @click.stop="redrawFrameWait.abort()">{{ $t('drawThings.stopWaiting') }}</button>
      <button v-if="type === 'shotVideo' && (ltxProfile || ltxResume) && generating" type="button" class="ltx-stop nodrag" @click.stop="stopLtxNodeWait(props.id)">{{ $t(isLtxDesktop(ltxProfile) ? 'ltxDesktop.cancel' : 'ltx.stop') }}</button>
      <button v-else-if="type === 'shotVideo' && ltxResume" type="button" class="ltx-stop nodrag" @click.stop="generateThis($event)">{{ $t('ltx.resume') }}</button>
      <NodeBusyOverlay v-if="generating || toolBusy" :label="toolBusy || $t('common.generating')" />
      <div v-if="status === 'failed' && nodeMeta?.error && !selected" class="fail-dot" :title="nodeMeta.error" />

      <div v-if="cropOn" class="crop-mask nodrag nowheel" @mousedown.stop>
        <div class="crop-box" :style="cropStyle" @pointerdown="onCropDown('move', $event)">
          <i class="h nw" @pointerdown.stop="onCropDown('nw', $event)" />
          <i class="h ne" @pointerdown.stop="onCropDown('ne', $event)" />
          <i class="h sw" @pointerdown.stop="onCropDown('sw', $event)" />
          <i class="h se" @pointerdown.stop="onCropDown('se', $event)" />
        </div>
        <div class="crop-actions">
          <button type="button" @click="cropOn = false">{{ $t('common.cancel') }}</button>
          <button type="button" class="ok" @click="applyCrop">{{ $t('pipelineNode.applyCrop') }}</button>
        </div>
      </div>

      <div v-if="trimOn" class="trim-bar nodrag nowheel" @mousedown.stop @click.stop>
        <div class="trim-times">{{ trimStart.toFixed(1) }}s — {{ trimEnd.toFixed(1) }}s</div>
        <input
          type="range"
          min="0"
          :max="playbackDuration || shot?.duration || 10"
          step="0.1"
          :value="trimStart"
          @input="onTrimStart(Number(($event.target as HTMLInputElement).value))"
        />
        <input
          type="range"
          min="0"
          :max="playbackDuration || shot?.duration || 10"
          step="0.1"
          :value="trimEnd"
          @input="onTrimEnd(Number(($event.target as HTMLInputElement).value))"
        />
        <div class="crop-actions">
          <button type="button" @click="trimOn = false">{{ $t('common.cancel') }}</button>
          <button type="button" class="ok" :disabled="!!toolBusy" @click="applyTrim">{{ $t('pipelineNode.applyTrim') }}</button>
        </div>
      </div>
    </div>

    <div v-if="type === 'subject' && subject" class="subject-card">
      <p v-if="subject.description" class="sc-desc" :title="subject.description">
        {{ subject.description }}
      </p>
      <div class="sc-voice" :class="{ set: voiceConfigured }">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="3.5" width="6" height="11" rx="3" />
          <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
        </svg>
        <span>{{ voiceSummary }}</span>
      </div>
    </div>
    <div v-else class="pnode-name">
      <span v-if="kindLabel" class="kind">{{ kindLabel }}</span>
      <span class="name" :title="title">{{ title }}</span>
      <span v-if="isVideoNode && durationLabel" class="len">{{ durationLabel }}</span>
    </div>

    <p v-if="type === 'shotVideo' && exceedsShotDuration" class="shot-duration-warning">
      {{ $t('storyboard.shotDurationWarning', { max: durationCapability.max, duration: shot?.duration }) }}
    </p>
    <p v-if="type === 'shotVideo' && ltxProfile && ltxShotSpeechTooFast(shot, shotDurationValue)" class="shot-duration-warning">
      {{ $t('ltx.speechTooFast', { seconds: shotDurationValue }) }}
    </p>
    <transition name="float-down">
      <div v-if="selected && panelOpen && showPrompt && !cropOn && !trimOn" class="prompt nodrag nowheel" @pointerdown.stop @mousedown.stop @click.stop>
      <SentMediaPrompts :prompts="nodeMeta?.data.sentMediaPrompts" />
      <div v-if="type === 'shotVideo'" class="prompt-tools">
        <button
          type="button"
          class="opt"
          :disabled="generating || gateBlocked || !!toolBusy || optimizingPrompt"
          @click="optimizePrompt"
        >
          {{ optimizingPrompt ? $t('common.optimizing') : $t('common.optimizePrompt') }}
        </button>
      </div>
      <div v-if="type === 'subject' && subject" class="voice-sec">
        <div class="voice-sec-head">
          <span class="voice-sec-title">{{ $t('pipelineNode.characterVoice') }}</span>
          <span class="voice-sec-tag">{{ $t('pipelineNode.extractedVoice') }}</span>
        </div>
        <textarea
          class="voice-input"
          rows="2"
          :value="voicePromptText"
          :placeholder="$t('pipelineNode.voiceDescriptionPlaceholder')"
          @input="voicePromptText = ($event.target as HTMLTextAreaElement).value"
        />
        <label v-if="isOpenAiTts(settings.config.tts)">
          {{ $t('openAiTts.characterVoice') }}
          <select
            :value="subject.openAiTtsVoice || ''"
            @change="project.updateSubject(subject.id, { openAiTtsVoice: ($event.target as HTMLSelectElement).value })"
          >
            <option value="">{{ $t('openAiTts.automaticVoice') }} · {{ recommendOpenAiVoice(voicePromptText) || settings.config.tts.voice }}</option>
            <option v-for="voice in OPENAI_TTS_VOICES" :key="voice" :value="voice">{{ voice }}</option>
          </select>
        </label>
        <div v-else class="voice-ref">
          <template v-if="voiceRefUrl">
            <button
              type="button"
              class="voice-play"
              :title="voiceRefPlaying ? $t('common.pause') : $t('pipelineNode.listenAudio')"
              @click="toggleVoiceRefPlay"
            >
              {{ voiceRefPlaying ? '❚❚' : '▶' }}
            </button>
            <span class="voice-ref-name" :title="voiceRefName">{{ voiceRefName }}</span>
            <span v-if="subject.clonedVoiceId" class="voice-cloned">{{ $t('pipelineNode.cloned') }}</span>
            <button type="button" class="voice-del" :title="$t('pipelineNode.removeAudio')" @click="removeVoiceRef">✕</button>
          </template>
          <button
            v-else
            type="button"
            class="voice-upload"
            :disabled="voiceUploading"
            @click="pickVoiceRef"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 16V4.5M7.5 9 12 4.5 16.5 9" />
              <path d="M4.5 16.5v2.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
            </svg>
            {{ voiceUploading ? $t('common.uploading') : $t('pipelineNode.uploadAudio') }}
          </button>
        </div>
        <p class="voice-sec-hint">
          {{ $t('pipelineNode.voiceCloneHint') }}
        </p>
        <audio
          v-if="voiceRefUrl"
          ref="voiceRefEl"
          :src="voiceRefUrl"
          preload="auto"
          class="voice-audio"
          @ended="voiceRefPlaying = false"
        />
        <input
          ref="voiceFileInput"
          type="file"
          accept="audio/*"
          style="display: none"
          @change="onVoiceRefChange"
        />
      </div>
      <div v-if="isFrameNode && shot" class="fp-prompts">
        <p class="fp-tip">
          {{ $t('pipelineNode.framePromptHint') }}
        </p>
        <label>{{ $t('common.startFramePrompt') }}</label>
        <textarea
          rows="6"
          :value="startFramePromptValue"
          :placeholder="$t('common.startFramePromptHint')"
          @input="startFramePromptValue = ($event.target as HTMLTextAreaElement).value"
        />
        <label>{{ $t('common.endFramePrompt') }}</label>
        <textarea
          rows="6"
          :value="endFramePromptValue"
          :placeholder="$t('common.endFramePromptHint')"
          @input="endFramePromptValue = ($event.target as HTMLTextAreaElement).value"
        />
      </div>
      <textarea
        v-else
        rows="12"
        :value="promptValue"
        :placeholder="promptHint"
        @input="promptValue = ($event.target as HTMLTextAreaElement).value"
      />
      <H3GenModeSelect v-if="isH3VideoNode" v-model="h3GenMode" />
      <FramePairSlots
        v-if="isH3Fl2va || ltxProfile"
        v-model:first-id="firstFrameId"
        v-model:last-id="lastFrameId"
        :last-required="lastFrameRequired"
        :first-hint="shot?.imageAssetId ? $t('common.useShotImage') : $t('common.chooseFirstFrame')"
      />
      <ShotRefStrip
        v-else-if="shot && (type === 'shotBoard' || type === 'shotImage' || type === 'shotVideo')"
        :shot="shot"
        :mode="type === 'shotVideo' ? 'video' : type === 'shotBoard' ? 'board' : 'image'"
      />
      <ShotRefStrip
        v-else-if="type === 'subject' || type === 'prop' || type === 'sceneProps' || type === 'scene'"
        v-model:extra-ids="extraRefIds"
      />
      <div class="prompt-foot">
        <ImageModelSelect v-if="isImageNode || isFrameNode || type === 'prop'" />
        <VideoModelSelect
          v-else-if="type === 'shotVideo'"
          v-model="videoModel"
          :profile-id="nodeMeta?.data.videoProfileId"
          @select-profile="(id) => applyShotVideoProfile(props.id, id)"
        />
        <span v-if="type === 'shotVideo' && videoStillHint" class="still-hint">{{ videoStillHint }}</span>
        <span v-else>{{ metaLine }}</span>
        <AspectRatioSeg
          v-if="type === 'shotBoard' || type === 'shotImage' || type === 'shotFrames'"
          v-model="nodeAspectRatio"
          compact
        />
        <ImageResolutionSeg
          v-if="(isImageNode || isFrameNode) && !drawThings && imageResolutionChoices.length"
          v-model="imageResolution"
          :choices="imageResolutionChoices"
        />
        <VideoSettingsPopover
          v-if="type === 'shotVideo' && shot"
          :resolution="videoResolution"
          :resolutions="resolutionChoices"
          :aspect="nodeAspectRatio"
          :duration="shotDurationValue"
          :durations="durationOptions"
          :ltx-model="ltxProfile ? ltxProfile.workflowId || LTX_DEFAULT_MODEL : undefined"
          :ltx-desktop="isLtxDesktop(ltxProfile)"
          :show-audio="showVideoAudio"
          :audio="generateAudio"
          @update:resolution="videoResolution = $event"
          @update:aspect="nodeAspectRatio = $event"
          @update:duration="setShotDuration($event)"
          @update:audio="generateAudio = $event"
        />
        <button
          v-if="genLabel"
          class="go"
          type="button"
          :disabled="generating || gateBlocked || !!toolBusy || optimizingPrompt"
          :title="genLabel"
          @click="generateThis"
        >
          ↑
        </button>
      </div>
      </div>
    </transition>

    <Handle id="out" type="source" :position="Position.Right" class="hndl" />

    <AssetPicker
      :open="pickerOpen"
      kind="image"
      :title="$t('pipelineNode.useExistingResult', { p0: kindLabel || $t('pipelineNode.thisNode') })"
      show-library
      default-tab="page"
      :selected-ids="assetId ? [assetId] : []"
      @close="pickerOpen = false"
      @confirm="onPickerConfirm"
    />
  </div>
</template>

<style scoped>
.shot-duration-warning { margin: 4px 8px; color: var(--color-warning, #ddac59); font-size: 11px; }
.ltx-stop { position: absolute; right: 8px; bottom: 8px; z-index: 10; }
.pnode {
  position: relative;
  width: 240px;
  background: color-mix(in srgb, var(--nb-bg-2) 62%, transparent);
  border: 1px solid var(--color-node-border);
  border-radius: 6px;
  overflow: visible;
  color: var(--color-text-1);
  box-shadow: var(--shadow-node);
  transition: border-color 0.2s ease, box-shadow 0.22s ease;
}
.pnode.on {
  border-color: var(--color-text-1);
  box-shadow: 0 0 0 1px var(--color-text-1), var(--shadow-md);
  z-index: 4;
}
.pnode.st-running,
.pnode.busy {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px rgba(126, 180, 255, 0.28);
  animation: node-busy 1.35s ease-in-out infinite;
  z-index: 5;
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
.pnode.st-failed {
  border-color: var(--color-error);
}
.toolbar-wrap {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
  z-index: 6;
  transform-origin: 50% 100%;
}
.toolbar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 10px;
  background: #2a2a32;
  color: var(--color-text-1);
  border: 1px solid var(--color-border);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
  white-space: nowrap;
}
.toolbar > button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-1);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.toolbar > button span {
  font-size: 11px;
  opacity: 0.7;
}
.toolbar > button:hover:not(:disabled) {
  background: var(--color-fill-hover);
}
.toolbar > button:disabled {
  opacity: 0.35;
  cursor: default;
}
.toolbar > button.icon {
  width: 30px;
  justify-content: center;
  padding: 6px 0;
}
.more {
  position: absolute;
  top: calc(100% + 4px);
  right: 4px;
  min-width: 132px;
  padding: 4px;
  border-radius: 8px;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45);
}
.more button {
  display: block;
  width: 100%;
  margin: 0;
  padding: 7px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  font-size: 12px;
  color: var(--color-text-1);
}
.more button:hover {
  background: var(--color-fill-hover);
}
.pnode-media {
  position: relative;
  width: 100%;
  background: var(--color-node-well);
  overflow: hidden;
  border-radius: inherit;
}
.pnode-media img,
.pnode-media video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
  display: block;
  background: var(--color-node-well);
}
.pnode-media video {
  cursor: grab;
}
.pnode-media img { user-select: none; -webkit-user-drag: none; cursor: grab; }
.pnode-media img:active, .pnode-media video:active { cursor: grabbing; }
.pnode-media .play-btn.playing { opacity: 0; }
.pnode-media:hover .play-btn.playing, .pnode-media .play-btn.playing:focus-visible { opacity: 1; }
.play-btn {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 2;
  width: 44px;
  height: 44px;
  margin: 0;
  padding: 0 0 2px 3px;
  border: none;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.play-btn:hover {
  background: var(--color-accent);
}
.dur {
  position: absolute;
  right: 6px;
  bottom: 6px;
  z-index: 2;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: rgba(0, 0, 0, 0.72);
  padding: 2px 6px;
  border-radius: 4px;
  pointer-events: none;
}
.fail-dot {
  position: absolute;
  right: 8px;
  top: 8px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ef4444;
}
.ph {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-4);
  font-size: 22px;
}
.ph.pick {
  cursor: pointer;
}
.ph.text {
  font-size: 13px;
  font-weight: 600;
}

/* 시작과 종료 프레임을 나란히 배치 */
.frame-pair {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 2px;
}
.fp-cell {
  position: relative;
  flex: 1;
  min-width: 0;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.2);
}
.fp-cell img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.fp-ph {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-4);
  font-size: 18px;
}
.fp-tag {
  position: absolute;
  left: 4px;
  bottom: 4px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 10px;
  line-height: 1.6;
}
.fp-redo {
  position: absolute;
  right: 3px;
  top: 3px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.frame-pair:hover .fp-redo {
  opacity: 1;
}
.fp-redo:hover {
  background: rgba(0, 0, 0, 0.8);
}
.fp-arrow {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 2;
  padding: 0 3px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 11px;
}
.fp-prompts {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fp-prompts label {
  color: var(--color-text-2);
  font-size: 11px;
}
.fp-prompts textarea {
  min-height: 72px;
}
.fp-tip {
  margin: 0;
  color: var(--color-text-3);
  font-size: 11px;
  line-height: 1.6;
}
.audio-card {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  font-size: 12px;
  color: var(--color-text-2);
}
.audio-card span {
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.vo-play {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  margin: 0;
  padding: 0 0 1px 1px;
  border: none;
  border-radius: 50%;
  background: var(--color-accent);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.pnode-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 10px;
  background: transparent;
  border-radius: 0 0 5px 5px;
}

/* 캐릭터 카드 */
.pnode.kind-subject {
  border-color: rgba(167, 139, 250, 0.28);
}
.pnode.kind-subject .pnode-media {
  border-bottom: 1px solid rgba(167, 139, 250, 0.16);
}
.pnode.on.kind-subject {
  border-color: rgba(167, 139, 250, 0.85);
  box-shadow: 0 0 0 1px rgba(167, 139, 250, 0.5), var(--shadow-md);
}
.subject-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 11px 9px;
  background:
    linear-gradient(180deg, rgba(167, 139, 250, 0.07), transparent 42%),
    transparent;
  border-radius: 0 0 5px 5px;
}
.sc-head {
  display: flex;
  padding: 4px 10px;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.sc-name {
  min-width: 0;
  flex: 1 1 64px;
  font-size: 13px;
  font-weight: 680;
  letter-spacing: 0.01em;
  color: var(--color-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sc-role {
  max-width: 100%;
  padding: 2px 8px;
  border-radius: 8px;
  border: 1px solid rgba(167, 139, 250, 0.4);
  background: rgba(167, 139, 250, 0.12);
  color: #c4b5fd;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  overflow-wrap: anywhere;
}
.sc-desc {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--color-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sc-voice {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  padding: 5px 8px;
  border-radius: 7px;
  border: 1px dashed var(--color-border);
  color: var(--color-text-4);
  font-size: 11px;
}
.sc-voice svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sc-voice span {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sc-voice.set {
  border-style: solid;
  border-color: rgba(52, 211, 153, 0.35);
  background: rgba(52, 211, 153, 0.08);
  color: #6ee7b7;
}

/* 캐릭터 음성 편집 패널 */
.voice-sec {
  margin-bottom: 8px;
  padding: 9px 10px;
  border: 1px solid rgba(167, 139, 250, 0.22);
  border-radius: 10px;
  background: rgba(167, 139, 250, 0.05);
}
.voice-sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.voice-sec-title {
  font-size: 12px;
  font-weight: 680;
  color: var(--color-text-1);
  letter-spacing: 0.02em;
}
.voice-sec-tag {
  font-size: 10px;
  color: var(--color-text-4);
}
.voice-input {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--color-border);
  outline: none;
  border-radius: 8px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  font-size: 12px;
  line-height: 1.5;
  padding: 7px 9px;
  font-family: inherit;
}
.voice-input:focus {
  border-color: rgba(167, 139, 250, 0.6);
}
.voice-ref {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 7px;
}
.voice-upload {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 11px;
  border: 1px dashed rgba(167, 139, 250, 0.45);
  border-radius: 8px;
  background: transparent;
  color: #c4b5fd;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.voice-upload:hover:not(:disabled) {
  background: rgba(167, 139, 250, 0.1);
}
.voice-upload:disabled {
  opacity: 0.5;
  cursor: default;
}
.voice-upload svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.voice-play {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  margin: 0;
  padding: 0 0 1px 1px;
  border: none;
  border-radius: 50%;
  background: rgba(167, 139, 250, 0.9);
  color: #fff;
  font-size: 10px;
  cursor: pointer;
}
.voice-ref-name {
  min-width: 0;
  flex: 1;
  font-size: 11px;
  color: var(--color-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.voice-cloned {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 99px;
  background: rgba(52, 211, 153, 0.14);
  border: 1px solid rgba(52, 211, 153, 0.35);
  color: #6ee7b7;
  font-size: 10px;
  font-weight: 600;
}
.voice-del {
  flex-shrink: 0;
  margin: 0;
  padding: 3px 5px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-4);
  font-size: 11px;
  cursor: pointer;
}
.voice-del:hover {
  color: var(--color-error);
  background: rgba(239, 68, 68, 0.12);
}
.voice-sec-hint {
  margin: 7px 0 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--color-text-4);
}
.voice-audio {
  display: none;
}
.pnode-name .kind {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--color-text-4);
}
.pnode-name .name {
  min-width: 0;
  flex: 1;
  font-size: 12px;
  font-weight: 650;
  color: var(--color-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pnode-name .len {
  flex-shrink: 0;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-4);
}
.prompt {
  position: absolute;
  left: 50%;
  top: calc(100% + 8px);
  z-index: 5;
  width: 800px;
  min-width: 800px;
  transform: translateX(-50%);
  transform-origin: 50% 0;
  overflow: visible;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 10px 12px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
}
.prompt textarea {
  width: 100%;
  min-height: 88px;
  resize: vertical;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text-1);
  font-size: 12px;
  line-height: 1.5;
  font-family: inherit;
}
.prompt-tools {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 4px;
}
.opt {
  margin: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-accent);
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}
.opt:disabled {
  opacity: 0.4;
  cursor: default;
}
.prompt-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
}
.prompt-foot > :deep(.psel) {
  flex: 1 1 min(100%, 180px);
}
.prompt-foot span {
  font-size: 10px;
  color: var(--color-text-4);
}
.dur-edit {
  margin-left: auto;
}
.dur-edit select {
  display: block;
  height: 28px;
  min-width: 72px;
  padding: 0 26px 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background-color: var(--color-bg-1);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path fill='%23ececef' d='M1.2 1.2L6 6l4.8-4.8' stroke='%23ececef' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 10px;
  color: var(--color-text-1);
  font-size: 12px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  line-height: 28px;
  outline: none;
  cursor: pointer;
  appearance: none;
  color-scheme: dark;
}
.dur-edit select option {
  background: var(--color-bg-1);
  color: var(--color-text-1);
}
.go {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  margin: 0;
  border: none;
  border-radius: 50%;
  background: #ececef;
  color: #111;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
}
.go:disabled {
  opacity: 0.4;
  cursor: default;
}
.crop-mask {
  position: absolute;
  inset: 0;
  z-index: 4;
  background: rgba(0, 0, 0, 0.35);
}
.crop-box {
  position: absolute;
  border: 1.5px solid #fff;
  box-shadow: 0 0 0 999px rgba(0, 0, 0, 0.45);
  cursor: move;
}
.crop-box .h {
  position: absolute;
  width: 10px;
  height: 10px;
  background: #fff;
  border-radius: 2px;
}
.crop-box .nw { left: -5px; top: -5px; cursor: nwse-resize; }
.crop-box .ne { right: -5px; top: -5px; cursor: nesw-resize; }
.crop-box .sw { left: -5px; bottom: -5px; cursor: nesw-resize; }
.crop-box .se { right: -5px; bottom: -5px; cursor: nwse-resize; }
.crop-actions {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  z-index: 5;
}
.crop-actions button,
.trim-bar button {
  margin: 0;
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  font-size: 11px;
}
.crop-actions .ok,
.trim-bar .ok {
  background: #fff;
  color: #111;
  font-weight: 700;
}
.trim-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 4;
  padding: 8px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.82));
}
.trim-times {
  font-size: 11px;
  color: #fff;
  margin-bottom: 4px;
}
.trim-bar input[type='range'] {
  width: 100%;
  margin: 0 0 4px;
}
.hndl {
  width: 8px;
  height: 8px;
  background: var(--color-accent);
  border: 1px solid #fff;
}
.pnode.kind-subject,
.pnode.kind-sceneProps,
.pnode.kind-scene,
.pnode.kind-shotBoard,
.pnode.kind-shotImage,
.pnode.kind-shotVideo { border-color: var(--color-node-border); }
.pnode.on.kind-subject,
.pnode.on.kind-sceneProps,
.pnode.on.kind-scene,
.pnode.on.kind-shotBoard,
.pnode.on.kind-shotImage,
.pnode.on.kind-shotVideo {
  border-color: var(--color-text-1);
}

.float-up-enter-active,
.float-up-leave-active,
.float-down-enter-active,
.float-down-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
.float-up-enter-from,
.float-up-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px) scale(0.96);
}
.float-down-enter-from,
.float-down-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-10px) scale(0.98);
}
</style>
