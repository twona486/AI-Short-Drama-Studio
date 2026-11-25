<script setup lang="ts">
import { isOpenAiTts } from '@/services/ai/openAiTts'
import { ltxShotSpeechTooFast } from '@/services/ai/ltxShotPrompt'
import { nearestVideoDuration, videoDurationCapability, shotDurationWarning } from '@/services/ai/videoDuration'
import { isLtxDesktop } from '@/services/ai/ltxDesktopOptions'
import { isLtxProfile, LTX_DEFAULT_MODEL } from '@/services/ai/ltxOptions'
import { confirmAction } from '@/utils/confirmAction'
import { t as translate } from '@/i18n'
import { computed, ref, watch } from 'vue'
import { useProjectStore, useAssetsStore, useToastStore, useSettingsStore } from '@/stores'
import { llmChoiceKey, llmModelGroups, parseLlmChoiceKey } from '@/stores/settings'
import { runCanvasNode, runScriptNode, rewriteShotPerformance, optimizeShotVideoPrompt, optimizeFreeformVideoPrompt, isFl2vaChainActive, regenerateShotFrame } from '@/services/canvas/runner'
import { isNodeRunning } from '@/services/canvas/jobs'
import { effectiveShotAudioMode, needsExternalTts } from '@/utils/shot'
import { applyShotVideoModel, applyShotVideoProfile } from '@/services/canvas/videoModel'
import { videoRequiresStoryboard } from '@/utils/storyboardGate'
import { stillModeForShot } from '@/utils/videoStill'
import { needsPlayReview } from '@/services/canvas/playGate'
import { isPlayReady } from '@/services/ai'
import { shotFrameSendPrompt } from '@/utils/nodePrompt'
import { scriptFromImportedPlay } from '@/utils/scriptMarkdown'
import { pickPlayMarkdownFile } from '@/utils/pickPlayFile'
import { friendlyAiError, shouldToastAiError } from '@/services/ai/abort'
import ImageModelSelect from '@/components/settings/ImageModelSelect.vue'
import VideoModelSelect from '@/components/settings/VideoModelSelect.vue'
import ImageResolutionSeg from '@/components/common/ImageResolutionSeg.vue'
import VideoSettingsPopover from '@/components/canvas/VideoSettingsPopover.vue'
import { pickDocImageResolution, pickDocVideoResolution, videoResolutionChoices, type DocImageResolution } from '@/services/ai/modelOptions'
import H3GenModeSelect from '@/components/settings/H3GenModeSelect.vue'
import FramePairSlots from '@/components/canvas/FramePairSlots.vue'
import TtsModelSelect from '@/components/settings/TtsModelSelect.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import AspectRatioSeg from '@/components/common/AspectRatioSeg.vue'
import AssetPicker from '@/components/common/AssetPicker.vue'
import { openLightbox } from '@/composables/useLightbox'
import { cssAspectRatio } from '@/services/canvas/layout'
import { nextExtractStage, type ExtractStage } from '@/services/canvas/pipeline'
import { canBuildExport } from '@/utils/timeline'
import {
  defaultPropSheetPrompt,
  fillEmptyGeneratePrompt,
  rebuildGeneratePrompt
} from '@/utils/nodePrompt'
import { VISUAL_STYLE_LABEL } from '@/utils/visualStyle'
import { resolvedCanvasReferenceAssetIds } from '@/services/canvas/references'
import ShotRefStrip from '@/components/canvas/ShotRefStrip.vue'
import { normalizeH3GenMode, normalizeVideoGenModel, type AspectRatio, type CanvasNode, type H3VideoGenMode, type ID, type ShotAudioMode, type VideoGenModel, type VideoResolution, type VisualStyle } from '@/types'

const props = defineProps<{
  node: CanvasNode | null
}>()

const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()
const settings = useSettingsStore()
const preview = ref('')
const historyUrls = ref<Record<string, string>>({})
const running = computed(() => (props.node ? isNodeRunning(props.node.id) : false))

const continueHint = ref('')
const pickerOpen = ref(false)
const optimizingPrompt = ref(false)
const keepAmbientAudio = computed({
  get: () => project.current?.settings.keepAmbientAudio !== false,
  set: (v: boolean) => project.setSettings({ keepAmbientAudio: v })
})
const ambientVolume = computed({
  get: () => project.current?.settings.originalVolume ?? 0.55,
  set: (v: number) => project.setSettings({ originalVolume: v })
})
const burnCaptions = computed({
  get: () => project.current?.settings.burnCaptions !== false,
  set: (v: boolean) => project.setSettings({ burnCaptions: v })
})
const isExportNode = computed(
  () => props.node?.type === 'export' || props.node?.type === 'final'
)

const shot = computed(() => {
  const id = props.node?.data.shotId
  return project.current?.shots.find((s) => s.id === id)
})
const subject = computed(() => {
  const id = props.node?.data.subjectId
  return (project.current?.subjects ?? []).find((s) => s.id === id)
})
const propItem = computed(() => {
  const id = props.node?.data.propId
  return (project.current?.props ?? []).find((item) => item.id === id)
})
const scene = computed(() => {
  const id = props.node?.data.sceneId
  return (project.current?.scenes ?? []).find((s) => s.id === id)
})

const extraRefIds = computed({
  get(): ID[] {
    const t = props.node?.type
    if (t === 'subject') return subject.value?.referenceAssetIds ?? []
    if (t === 'prop') return propItem.value?.referenceAssetIds ?? []
    if (t === 'sceneProps') return scene.value?.propReferenceAssetIds ?? []
    if (t === 'scene') return scene.value?.referenceAssetIds ?? []
    return []
  },
  set(ids: ID[]) {
    const t = props.node?.type
    if (t === 'subject' && subject.value) {
      project.updateSubject(subject.value.id, { referenceAssetIds: ids })
    } else if (t === 'prop' && propItem.value) {
      project.updateProp(propItem.value.id, { referenceAssetIds: ids })
    } else if (t === 'sceneProps' && scene.value) {
      project.updateScene(scene.value.id, { propReferenceAssetIds: ids })
    } else if (t === 'scene' && scene.value) {
      project.updateScene(scene.value.id, { referenceAssetIds: ids })
    }
  }
})

const inspectorRefIds = computed(() => {
  const p = project.current
  const n = props.node
  if (!p || !n || (n.type !== 'imageGen' && n.type !== 'videoGen')) return []
  return resolvedCanvasReferenceAssetIds(p, n)
})
const inspectorRefUrls = ref<Record<string, string>>({})

watch(
  () => inspectorRefIds.value.join(','),
  async () => {
    const next: Record<string, string> = {}
    for (const id of inspectorRefIds.value) {
      next[id] = (await assets.getUrl(id)) || ''
    }
    inspectorRefUrls.value = next
  },
  { immediate: true }
)

function removeInspectorRef(id: ID) {
  if (!props.node) return
  project.removeCanvasNodeRef(props.node.id, id)
  toast.success(translate('common.referenceRemoved'))
}

const currentAssetId = computed(() => {
  const t = props.node?.type
  if (t === 'final') return project.current?.finalVideoAssetId
  if (t === 'subject') return subject.value?.designSheetAssetId
  if (t === 'prop') return propItem.value?.designSheetAssetId
  if (t === 'sceneProps') return scene.value?.propSheetAssetId
  if (t === 'scene') return scene.value?.plateAssetId
  if (t === 'shotBoard') return shot.value?.boardAssetId
  if (t === 'shotImage') return shot.value?.imageAssetId
  if (t === 'shotFrames') return shot.value?.firstFrameAssetId || shot.value?.lastFrameAssetId
  if (t === 'shotVideo') return shot.value?.videoAssetId
  if (t === 'audio') return shot.value?.audioAssetId
  if (t === 'imageGen' || t === 'videoGen') return props.node?.data.outputAssetId
  return undefined
})

const hasAsset = computed(() => Boolean(currentAssetId.value))
const waitingReview = computed(() => needsPlayReview(project.current))
const gateBlocked = computed(() => {
  const t = props.node?.type
  return Boolean(
    t &&
      t !== 'script' &&
      t !== 'export' &&
      t !== 'final' &&
      t !== 'imageGen' &&
      t !== 'videoGen' &&
      waitingReview.value
  )
})

const actionLabel = computed(() => {
  const t = props.node?.type
  const again = hasAsset.value || Boolean(project.current?.finalVideoAssetId)
  if (t === 'script') {
    return isPlayReady(project.current?.script) ? translate('nodeInspector.rewriteScript') : translate('nodeInspector.writeScript')
  }
  if (t === 'subject') return again ? translate('nodeInspector.regenerateFourViews') : translate('nodeInspector.generateFourViews')
  if (t === 'prop') return again ? translate('nodeInspector.regeneratePropViews') : translate('nodeInspector.generatePropViews')
  if (t === 'sceneProps') return again ? translate('nodeInspector.regenerateKeyProps') : translate('nodeInspector.generateKeyProps')
  if (t === 'scene') return again ? translate('nodeInspector.regenerateAnchors') : translate('nodeInspector.generateAnchors')
  if (t === 'shotBoard') return again ? translate('nodeInspector.regenerateBoard') : translate('nodeInspector.generateBoard')
  if (t === 'shotImage') {
    return again
      ? videoRequiresStoryboard(project.current)
        ? translate('nodeInspector.regenerateShotImage')
        : translate('nodeInspector.regenerateGrid')
      : videoRequiresStoryboard(project.current)
        ? translate('nodeInspector.generateShotImage')
        : translate('nodeInspector.generateGrid')
  }
  if (t === 'shotFrames') return again ? translate('nodeInspector.redrawFrames') : translate('nodeInspector.drawFrames')
  if (t === 'shotVideo') return again ? translate('nodeInspector.regenerateVideo') : translate('nodeInspector.generateVideo')
  if (t === 'audio') {
    if (!shot.value || !needsExternalTts(shot.value, project.current)) return translate('nodeInspector.noExtraVoice')
    return again ? translate('nodeInspector.regenerateNarration') : translate('nodeInspector.generateNarration')
  }
  if (t === 'export' || t === 'final') return again ? translate('nodeInspector.composeAgain') : translate('nodeInspector.composeVideo')
  return again ? translate('nodeInspector.regenerate') : translate('nodeInspector.generateNode')
})

const extractLabel = computed(() => {
  const stage = nextExtractStage(project.current)
  if (stage === 'subjects') return translate('nodeInspector.stepSubjects')
  if (stage === 'scenes') return translate('nodeInspector.stepScenes')
  if (stage === 'shots') return translate('nodeInspector.stepShots')
  return ''
})
const canExtractNext = computed(() => Boolean(nextExtractStage(project.current)))
const isImg2Video = computed(() => project.current?.pipelineMode === 'img2video')
const canExtractShots = computed(
  () => Boolean((project.current?.subjects ?? []).length && (project.current?.scenes ?? []).length)
)

const isImageNode = computed(() => {
  const t = props.node?.type
  return (
    t === 'subject' ||
    t === 'sceneProps' ||
    t === 'scene' ||
    t === 'shotBoard' ||
    t === 'shotImage' ||
    t === 'shotFrames'
  )
})
const canPickAsset = computed(() => isImageNode.value || props.node?.type === 'imageGen')
const isVideoNode = computed(() => props.node?.type === 'shotVideo' || props.node?.type === 'videoGen')

/** 현재 샷 화자의 음색은 최신 캐릭터 카드 값이 우선하며, 없으면 추출 시 저장한 값을 쓴다. */
const shotSpeakerVoice = computed(() => {
  const s = shot.value
  if (!s) return ''
  const label = String(s.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const subs = project.current?.subjects ?? []
  const hit = label
    ? subs.find((x) => x.name.trim() === label) ??
      subs.find((x) => {
        const n = x.name.trim()
        return n && (label.includes(n) || n.includes(label))
      })
    : undefined
  return hit?.voicePrompt?.trim() || s.speakerVoice || ''
})
const shotSpeakerName = computed(() => {
  const s = shot.value
  if (!s) return ''
  return String(s.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim() || ''
})

const showAspect = computed(() => {
  const t = props.node?.type
  return (
    t === 'script' ||
    t === 'shotBoard' ||
    t === 'shotImage' ||
    t === 'shotVideo' ||
    t === 'imageGen' ||
    t === 'videoGen'
  )
})
const nodeAspectRatio = computed({
  get: () => props.node?.data.aspectRatio ?? project.current?.settings.aspectRatio ?? '16:9',
  set: (v: AspectRatio) => {
    const node = props.node
    if (!node) return
    if (node.type === 'script') {
      project.setAspectRatio(v)
      return
    }
    project.patchCanvasNode(node.id, {
      aspectRatio: v,
      ...(node.type === 'imageGen' || node.type === 'videoGen'
        ? { outputAssetId: undefined, videoTaskId: undefined }
        : {})
    })
    if (node.type === 'shotVideo' && shot.value) project.invalidateShotAssets(shot.value.id, 'video')
    else if ((node.type === 'shotImage' || node.type === 'shotBoard') && shot.value) {
      project.invalidateShotAssets(shot.value.id, 'image')
    }
  }
})

const videoModel = computed({
  get: () => normalizeVideoGenModel(props.node?.data.videoModel ?? (props.node?.type === 'shotVideo' ? settings.config.defaultVideoModel : undefined)),
  set: (v: VideoGenModel) => {
    if (!props.node) return
    applyShotVideoModel(props.node.id, v)
  }
})
function onSelectVideoProfile(profileId: string) {
  if (props.node) applyShotVideoProfile(props.node.id, profileId)
}
const resolutionChoices = computed(() =>
  videoResolutionChoices({
    model: videoModel.value,
    profile: videoModel.value !== 'h3' && docVideoProfile.value?.provider === 'ltx' || videoModel.value === 'wan-prime' ? null : docVideoProfile.value
  })
)
const videoResolution = computed({
  get: () => {
    const choices = resolutionChoices.value
    if (choices.length) return pickDocVideoResolution(props.node?.data.videoResolution ?? project.current?.settings.defaultVideoResolution, choices) || choices[0]
    return '768p' as VideoResolution
  },
  set: (v: VideoResolution) => {
    if (props.node) project.patchCanvasNode(props.node.id, { videoResolution: v })
  }
})
const docVideoProfile = computed(() => {
  const id = props.node?.data.videoProfileId || shot.value?.videoProfileId || settings.config.activeVideoId
  return settings.config.videos.find((item) => item.id === id)
})
const imageResolutionChoices = computed(
  () =>
    settings.config.images.find((item) => item.id === settings.config.activeImageId)?.options?.imageResolutions ||
    []
)
const imageResolution = computed({
  get: () => pickDocImageResolution(props.node?.data.imageResolution, imageResolutionChoices.value) || '2k',
  set: (v: DocImageResolution) => {
    if (props.node) project.patchCanvasNode(props.node.id, { imageResolution: v })
  }
})
const ltxProfile = computed(() => videoModel.value === 'h3' && isLtxProfile(docVideoProfile.value)
  ? docVideoProfile.value : undefined)
const durationCapability = computed(() => videoDurationCapability({
  model: videoModel.value, profile: docVideoProfile.value, resolution: videoResolution.value,
  startEndFrames: h3GenMode.value === 'fl2va' ||
    (props.node?.type === 'shotVideo' && isFl2vaChainActive(project.current))
}))
const inspectorDurations = computed(() => durationCapability.value.durations)
const inspectorDuration = computed({
  get() {
    const opts = inspectorDurations.value
    const raw = Math.round(
      Number(props.node?.type === 'shotVideo' ? shot.value?.duration : props.node?.data.duration) || opts[0] || 5
    )
    return nearestVideoDuration(raw, opts)
  },
  set(v: number) {
    if (!props.node) return
    if (props.node.type === 'shotVideo' && shot.value) {
      project.updateShot(shot.value.id, { duration: v })
      return
    }
    project.patchCanvasNode(props.node.id, { duration: v })
  }
})
const showVideoAudio = computed(() => Boolean(ltxProfile.value) || docVideoProfile.value?.options?.videoAudio === true)
const lastFrameRequired = computed(() => docVideoProfile.value?.options?.lastFrameRequired === true)
const generateAudio = computed({
  get: () => props.node?.data.generateAudio ?? Boolean(ltxProfile.value),
  set: (v: boolean) => {
    if (props.node) project.patchCanvasNode(props.node.id, { generateAudio: v })
  }
})
const isH3Video = computed(
  () =>
    (props.node?.type === 'shotVideo' || props.node?.type === 'videoGen') &&
    !ltxProfile.value && videoModel.value !== 'wan-prime'
)
const h3GenMode = computed({
  get: () =>
    props.node?.type === 'videoGen'
      ? normalizeH3GenMode(props.node.data.h3GenMode)
      : normalizeH3GenMode(shot.value?.h3GenMode),
  set: (v: H3VideoGenMode) => {
    if (props.node?.type === 'videoGen') {
      project.patchCanvasNode(props.node.id, { h3GenMode: v })
    } else if (shot.value) {
      project.updateShot(shot.value.id, { h3GenMode: v })
    }
  }
})
const firstFrameId = computed({
  get: () =>
    props.node?.type === 'videoGen'
      ? props.node.data.firstFrameAssetId
      : shot.value?.firstFrameAssetId,
  set: (v: ID | undefined) => {
    if (props.node?.type === 'videoGen') {
      project.patchCanvasNode(props.node.id, { firstFrameAssetId: v })
    } else if (shot.value) {
      project.updateShot(shot.value.id, { firstFrameAssetId: v })
    }
  }
})
const lastFrameId = computed({
  get: () =>
    props.node?.type === 'videoGen'
      ? props.node.data.lastFrameAssetId
      : shot.value?.lastFrameAssetId,
  set: (v: ID | undefined) => {
    if (props.node?.type === 'videoGen') {
      project.patchCanvasNode(props.node.id, { lastFrameAssetId: v })
    } else if (shot.value) {
      project.updateShot(shot.value.id, { lastFrameAssetId: v })
    }
  }
})
const isH3Fl2va = computed(() => isH3Video.value && h3GenMode.value === 'fl2va')
/** 시작·끝 프레임 연결 모드에서는 샷 순서로 프레임을 자동 연결한다. */
const fl2vaChain = computed(() => isH3Video.value && isFl2vaChainActive(project.current))

/** 시작과 종료 두 프레임의 개별 화면 프롬프트. */
const startFramePromptValue = computed(() => {
  const s = shot.value
  if (!s || !project.current) return ''
  return s.startFramePrompt?.trim() || shotFrameSendPrompt(s, project.current, 'start')
})
const endFramePromptValue = computed(() => {
  const s = shot.value
  if (!s || !project.current) return ''
  return s.endFramePrompt?.trim() || shotFrameSendPrompt(s, project.current, 'end')
})
async function redrawFrame(which: 'start' | 'end') {
  const s = shot.value
  if (!s || running.value) return
  try {
    await regenerateShotFrame(s, which, (msg) => toast.info(msg))
    toast.success(which === 'start' ? translate('common.startFrameRedrawn') : translate('common.endFrameRedrawn'))
  } catch (e: any) {
    toast.error(friendlyAiError(e) || translate('common.redrawFailed'))
  }
}

const canRun = computed(() => {
  if (running.value || gateBlocked.value) return false
  if (props.node?.type === 'export' || props.node?.type === 'final') {
    return canBuildExport(project.current)
  }
  if (props.node?.type === 'audio' && shot.value && !needsExternalTts(shot.value, project.current)) return false
  return true
})

const previewAspect = computed(() => {
  if (props.node?.type === 'subject' || props.node?.type === 'prop' || props.node?.type === 'sceneProps' || props.node?.type === 'scene') {
    return cssAspectRatio('16:9')
  }
  return cssAspectRatio(nodeAspectRatio.value)
})

const kindLabel = computed(() => {
  const t = props.node?.type
  if (t === 'script') return translate('nodeInspector.fullScript')
  if (t === 'subject') return translate('nodeInspector.subjectType')
  if (t === 'prop') return translate('nodeInspector.propType')
  if (t === 'sceneProps') return translate('nodeInspector.scenePropType')
  if (t === 'scene') return translate('nodeInspector.sceneType')
  if (t === 'shotBoard') return translate('nodeInspector.boardType')
  if (t === 'shotImage') return videoRequiresStoryboard(project.current) ? translate('nodeInspector.shotImageType') : translate('nodeInspector.gridType')
  if (t === 'shotFrames') return translate('nodeInspector.framesType')
  if (t === 'shotVideo') {
    const d = shot.value?.duration
    return d ? translate('nodeInspector.videoDurationType', { p0: d }) : translate('nodeInspector.videoType')
  }
  if (t === 'audio') return translate('nodeInspector.audioType')
  if (t === 'export') return translate('nodeInspector.exportType')
  if (t === 'final') return translate('nodeInspector.finalType')
  if (t === 'imageGen') return translate('nodeInspector.imageType')
  if (t === 'videoGen') return translate('nodeInspector.imageToVideoType')
  return t || ''
})

const title = computed(() => {
  if (!props.node) return translate('nodeInspector.unselected')
  if (props.node.type === 'script') return project.current?.script?.topic || translate('nodeInspector.script')
  if (subject.value) return subject.value.name
  if (propItem.value) return propItem.value.name
  if (scene.value) return scene.value.name
  if (shot.value) return `${shot.value.index + 1}. ${shot.value.title}`
  if (props.node.type === 'export') return translate('nodeInspector.composeVideo')
  if (props.node.type === 'final') return translate('nodeInspector.videoPreview')
  return props.node.data.label || props.node.type
})

const historyIds = computed(() => {
  const t = props.node?.type
  if (t === 'subject') return subject.value?.designSheetHistoryIds ?? []
  if (t === 'sceneProps') return scene.value?.propSheetHistoryIds ?? []
  if (t === 'scene') return scene.value?.plateHistoryIds ?? []
  if (t === 'shotBoard') return shot.value?.boardHistoryIds ?? []
  if (t === 'shotImage') return shot.value?.imageHistoryIds ?? []
  if (t === 'shotVideo') return shot.value?.videoHistoryIds ?? []
  return []
})

const videoPromptPlaceholder = computed(() =>
  translate('nodeInspector.editVideoPrompt')
)

watch(
  [
    () => props.node?.id,
    () => props.node?.type,
    () => subject.value?.id,
    () => propItem.value?.id,
    () => scene.value?.id,
    () => shot.value?.id
  ],
  () => {
    const p = project.current
    const node = props.node
    if (!p || !node) return
    const t = node.type
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

async function refreshPreview() {
  preview.value = ''
  const id = currentAssetId.value
  if (!id || !props.node) return
  preview.value = (await assets.getUrl(id)) || ''
}

async function loadHistory() {
  const ids = historyIds.value
  const next: Record<string, string> = {}
  for (const id of ids) {
    const url =
      props.node?.type === 'shotVideo'
        ? (await assets.ensureThumb(id)) || (await assets.getUrl(id))
        : await assets.getUrl(id)
    if (url) next[id] = url
  }
  historyUrls.value = next
}

async function restoreHistory(assetId: string) {
  if (!props.node) return
  project.assignCanvasNodeAsset(props.node.id, assetId)
  await project.save()
  await refreshPreview()
  await loadHistory()
  toast.success(translate('nodeInspector.restored'))
}

async function onPickerConfirm(ids: ID[]) {
  pickerOpen.value = false
  const id = ids[0]
  if (!id || !props.node) return
  try {
    const asset = await assets.adopt(id, 'image', {
      projectId: project.current?.id,
      shotId: props.node.data.shotId
    })
    project.assignCanvasNodeAsset(props.node.id, asset.id)
    await project.save()
    await refreshPreview()
    await loadHistory()
    toast.success(translate('common.imageSelected'))
  } catch (e: any) {
    toast.error(e?.message || translate('common.useFailed'))
  }
}

async function downloadFinal() {
  const id = project.current?.finalVideoAssetId
  if (!id) {
    toast.warn(translate('nodeInspector.noComposedVideo'))
    return
  }
  const blob = await assets.getBlob(id)
  if (!blob) {
    toast.error(translate('nodeInspector.videoReadFailed'))
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${project.current?.name ?? 'final'}.mp4`
  a.click()
  URL.revokeObjectURL(url)
}

async function run() {
  if (!props.node) return
  if (gateBlocked.value) {
    toast.warn(translate('common.reviewScript'))
    return
  }
  try {
    if (props.node.type === 'script') {
      await runScriptNode('play', undefined, undefined, llmModel.value)
    } else {
      await runCanvasNode(props.node.id)
    }
    await refreshPreview()
    await loadHistory()
    toast.success(actionLabel.value + translate('common.done'))
  } catch (e: any) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e) || translate('common.generateFailed'))
  }
}

async function runContinue() {
  if (!props.node) return
  try {
    await runScriptNode('continue', undefined, undefined, llmModel.value, continueHint.value)
    toast.success(translate('nodeInspector.continued'))
  } catch (e: any) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e) || translate('common.continueFailed'))
  }
}

async function runExtract(stage?: ExtractStage) {
  if (!props.node) return
  if (stage === 'shots' && !canExtractShots.value) {
    toast.warn(translate('common.extractBeforeShots'))
    return
  }
  try {
    await runScriptNode('extract', undefined, undefined, llmModel.value, undefined, stage)
    toast.success(
      stage === 'subjects'
        ? translate('nodeInspector.characterExtracted')
        : stage === 'scenes'
          ? translate('nodeInspector.sceneExtracted')
          : stage === 'shots'
            ? translate('nodeInspector.storyboardExtracted')
            : translate('nodeInspector.extracted')
    )
  } catch (e: any) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e) || translate('nodeInspector.extractionFailed'))
  }
}

watch(
  () => [props.node?.id, currentAssetId.value] as const,
  () => {
    refreshPreview()
    loadHistory()
  }
)

watch(running, (now, was) => {
  if (was && !now) {
    refreshPreview()
    loadHistory()
  }
})

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

function patchScript(field: 'topic' | 'content', value: string) {
  if (!project.current?.script) return
  project.setScript({ ...project.current.script, [field]: value })
  if (field === 'topic') project.applyPlayTitle(value)
}

async function importPlayMarkdown() {
  if (!project.current) return
  const existing = (project.current.script?.content || '').trim()
  if (existing && !await confirmAction(translate('common.replaceScriptConfirm'))) return
  try {
    const picked = await pickPlayMarkdownFile()
    if (!picked) return
    const script = scriptFromImportedPlay(project.current, picked.text, picked.filename)
    project.setScript(script)
    project.applyPlayTitle(script.topic)
    if (project.current.pipelineMode !== 'img2video') project.setPlayApproved(false)
    await project.save()
    toast.success(translate('common.importedNamed', { p0: script.topic }))
  } catch (e: any) {
    toast.error(e?.message || translate('common.importFailed'))
  }
}

const styleOptions = Object.entries(VISUAL_STYLE_LABEL) as [VisualStyle, string][]
const projectStyle = computed({
  get: () => project.current?.script?.style ?? 'cinematic',
  set: (style: VisualStyle) => {
    if (!project.current?.script) return
    project.setScript({ ...project.current.script, style })
  }
})

function rebuildPrompt() {
  const p = project.current
  const node = props.node
  if (!p || !node) return
  const t = node.type
  if (t === 'subject' && subject.value) {
    project.updateSubject(subject.value.id, rebuildGeneratePrompt('subject', p, subject.value))
  } else if (t === 'prop' && propItem.value) {
    project.updateProp(propItem.value.id, { sheetPrompt: defaultPropSheetPrompt(propItem.value, p) })
  } else if (t === 'scene' && scene.value) {
    project.updateScene(scene.value.id, rebuildGeneratePrompt('scene', p, scene.value))
  } else if (t === 'sceneProps' && scene.value) {
    project.updateScene(scene.value.id, rebuildGeneratePrompt('sceneProps', p, scene.value))
  } else if (t === 'shotBoard' && shot.value) {
    project.updateShot(shot.value.id, rebuildGeneratePrompt('shotBoard', p, shot.value))
  } else if (t === 'shotImage' && shot.value) {
    project.updateShot(shot.value.id, rebuildGeneratePrompt('shotImage', p, shot.value))
  } else if (t === 'shotVideo' && shot.value) {
    project.updateShot(shot.value.id, rebuildGeneratePrompt('shotVideo', p, shot.value))
  } else {
    return
  }
  toast.success(translate('nodeInspector.styleApplied'))
}

async function resetVideoPrompt() {
  if (!shot.value) return
  try {
    await rewriteShotPerformance(shot.value)
    toast.success(translate('nodeInspector.motionUpdated'))
  } catch (e: any) {
    toast.error(friendlyAiError(e) || translate('common.rewriteFailed'))
  }
}

async function optimizeVideoPrompt() {
  if (optimizingPrompt.value) return
  optimizingPrompt.value = true
  try {
    if (props.node?.type === 'videoGen') {
      await optimizeFreeformVideoPrompt(props.node.id)
    } else if (shot.value) {
      await optimizeShotVideoPrompt(shot.value)
    } else {
      return
    }
    toast.success(translate('common.optimized'))
  } catch (e: any) {
    toast.error(friendlyAiError(e) || translate('common.optimizationFailed'))
  } finally {
    optimizingPrompt.value = false
  }
}
</script>

<template>
  <aside class="insp">
    <div v-if="!node" class="empty">{{ $t('nodeInspector.emptyHint') }}</div>
    <template v-else>
      <div class="insp-k">{{ kindLabel }}</div>
      <h3>{{ title }}</h3>
      <p v-if="node.error" class="err">{{ node.error }}</p>
      <p v-else-if="hasAsset && node.type === 'audio'" class="hint">
        {{ $t('nodeInspector.listenHint') }}
      </p>
      <p v-else-if="hasAsset && node.type !== 'script' && node.type !== 'export' && node.type !== 'final'" class="hint">
        {{ $t('nodeInspector.regenerateHint') }}
      </p>
      <p v-else-if="canPickAsset" class="hint">
        {{ $t('nodeInspector.imageLibraryHint') }}
      </p>

      <p v-else-if="node.type === 'script'" class="hint">
        {{
          isImg2Video
            ? $t('nodeInspector.scriptNodeHint')
            : $t('nodeInspector.beforeExtract')
        }}
      </p>
      <p v-else-if="node.type === 'export'" class="hint">
        {{ $t('nodeInspector.composeHint') }}
      </p>
      <p v-else-if="node.type === 'final'" class="hint">
        {{ $t('nodeInspector.videoPreviewHint') }}
      </p>
      <p v-else-if="gateBlocked" class="hint">{{ $t('common.reviewScript') }}</p>

      <AspectRatioSeg v-if="showAspect" v-model="nodeAspectRatio" />

      <div v-if="preview && (node.type === 'shotVideo' || node.type === 'final')" class="prev prev-video">
        <div class="prev-frame" :style="{ aspectRatio: previewAspect }">
          <video :src="preview" controls playsinline preload="auto" />
        </div>
      </div>
      <div v-else-if="preview && node.type === 'audio'" class="prev prev-audio">
        <audio :src="preview" controls preload="auto" />
        <span>{{ $t('nodeInspector.listenNarration') }}</span>
      </div>
      <button
        v-else-if="preview"
        class="prev"
        type="button"
        :title="$t('common.clickFullImage')"
        @click="openLightbox(preview, 'image', title)"
      >
        <div class="prev-frame" :style="{ aspectRatio: previewAspect }">
          <img :src="preview" alt="" />
        </div>
        <span>{{ $t('common.fullImage') }}</span>
      </button>

      <template v-if="isExportNode && project.current">
        <label>{{ $t('common.caption') }}</label>
        <label class="check">
          <input v-model="burnCaptions" type="checkbox" />
          <span>{{ $t('nodeInspector.burnCaptions') }}</span>
        </label>

        <label>{{ $t('nodeInspector.shotAudio') }}</label>
        <div class="seg">
          <button
            type="button"
            class="seg-btn"
            :class="{ on: keepAmbientAudio }"
            @click="keepAmbientAudio = true"
          >
            {{ $t('nodeInspector.keepAudio') }}
          </button>
          <button
            type="button"
            class="seg-btn"
            :class="{ on: !keepAmbientAudio }"
            @click="keepAmbientAudio = false"
          >
            {{ $t('nodeInspector.discard') }}
          </button>
        </div>
        <p class="hint">
          {{
            keepAmbientAudio
              ? $t('nodeInspector.keepAudioHint')
              : $t('nodeInspector.muteHint')
          }}
        </p>
        <div v-if="keepAmbientAudio" class="vol-row">
          <span class="hint">{{ $t('common.ambientSound') }}</span>
          <input v-model.number="ambientVolume" type="range" min="0.1" max="1" step="0.05" />
          <span class="hint">{{ Math.round(ambientVolume * 100) }}%</span>
        </div>
      </template>

      <template v-if="node.type === 'script' && project.current">
        <label>{{ $t('common.topic') }}</label>
        <input
          :value="project.current.script?.topic"
          @input="patchScript('topic', ($event.target as HTMLInputElement).value)"
        />
        <label>{{ $t('nodeInspector.markdownScript') }}</label>
        <div class="lab-row">
          <p class="hint">{{ $t('nodeInspector.importFormats') }}</p>
          <button class="link" type="button" @click="importPlayMarkdown">{{ $t('common.importMarkdown') }}</button>
        </div>
        <textarea
          rows="12"
          :value="project.current.script?.content"
          @input="patchScript('content', ($event.target as HTMLTextAreaElement).value)"
        />
        <GradientButton
          v-if="waitingReview"
          block
          type="secondary"
          @click="project.setPlayApproved(true)"
        >
          {{ $t('nodeInspector.approve') }}
        </GradientButton>
        <label>{{ $t('common.visualStyle') }}</label>
        <select v-model="projectStyle">
          <option v-for="[id, name] in styleOptions" :key="id" :value="id">{{ name }}</option>
        </select>
        <p class="hint">{{ $t('nodeInspector.projectStyleHint') }}</p>
        <label>{{ $t('nodeInspector.scriptLlm') }}</label>
        <select v-model="llmChoice">
          <option v-if="!llmGroups.some((g) => g.models.length)" value="">{{ $t('common.noModel') }}</option>
          <optgroup v-for="g in llmGroups" :key="g.id" :label="g.name">
            <option v-for="m in g.models" :key="`${g.id}::${m}`" :value="`${g.id}::${m}`">{{ m }}</option>
          </optgroup>
        </select>
      </template>

      <template v-else-if="node.type === 'prop' && propItem">
        <label>{{ $t('nodeInspector.actualImagePrompt') }}</label>
        <div class="lab-row">
          <p class="hint">{{ $t('nodeInspector.characterPreviewPrompt') }}</p>
          <button class="link" type="button" @click="rebuildPrompt">{{ $t('nodeInspector.rebuildWithStyle') }}</button>
        </div>
        <textarea
          rows="12"
          :value="propItem.sheetPrompt ?? ''"
          :placeholder="$t('nodeInspector.propHint')"
          @input="project.updateProp(propItem.id, { sheetPrompt: ($event.target as HTMLTextAreaElement).value })"
        />
        <label>{{ $t('nodeInspector.propName') }}</label>
        <input
          :value="propItem.name"
          @change="project.updateProp(propItem.id, { name: ($event.target as HTMLInputElement).value.trim() || propItem.name })"
        />
      </template>

      <template v-else-if="node.type === 'subject' && subject">
        <label>{{ $t('nodeInspector.actualImagePrompt') }}</label>
        <div class="lab-row">
          <p class="hint">{{ $t('nodeInspector.changeStyleHint') }}</p>
          <button class="link" type="button" @click="rebuildPrompt">{{ $t('nodeInspector.rebuildWithStyle') }}</button>
        </div>
        <textarea
          rows="16"
          :value="subject.sheetPrompt ?? ''"
          :placeholder="$t('nodeInspector.characterPrompt')"
          @input="project.updateSubject(subject.id, { sheetPrompt: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'sceneProps' && scene">
        <label>{{ $t('nodeInspector.actualImagePrompt') }}</label>
        <div class="lab-row">
          <p class="hint">{{ $t('nodeInspector.sendAsIs') }}</p>
          <button class="link" type="button" @click="rebuildPrompt">{{ $t('nodeInspector.rebuildWithStyle') }}</button>
        </div>
        <textarea
          rows="16"
          :value="scene.propSheetPrompt ?? ''"
          :placeholder="$t('nodeInspector.propPromptHint')"
          @input="project.updateScene(scene.id, { propSheetPrompt: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'scene' && scene">
        <label>{{ $t('nodeInspector.actualImagePrompt') }}</label>
        <div class="lab-row">
          <p class="hint">{{ $t('nodeInspector.sendAsIs') }}</p>
          <button class="link" type="button" @click="rebuildPrompt">{{ $t('nodeInspector.rebuildWithStyle') }}</button>
        </div>
        <textarea
          rows="16"
          :value="scene.platePrompt ?? ''"
          :placeholder="$t('nodeInspector.gridAnchorPrompt')"
          @input="project.updateScene(scene.id, { platePrompt: ($event.target as HTMLTextAreaElement).value })"
        />
        <label>{{ $t('nodeInspector.locationDescription') }}</label>
        <textarea
          rows="4"
          :value="scene.description"
          :placeholder="$t('nodeInspector.emptySceneHint')"
          @input="project.updateScene(scene.id, { description: ($event.target as HTMLTextAreaElement).value })"
        />
        <label>{{ $t('common.frameAnchor') }}</label>
        <input
          :value="scene.mainAnchor || ''"
          :placeholder="$t('nodeInspector.anchorExample')"
          @change="project.updateScene(scene.id, { mainAnchor: ($event.target as HTMLInputElement).value })"
        />
        <label>{{ $t('nodeInspector.gridAnchor') }}</label>
        <textarea
          rows="3"
          :value="scene.anchors || ''"
          :placeholder="$t('nodeInspector.sceneAnchorExample')"
          @input="project.updateScene(scene.id, { anchors: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'shotBoard' && shot">
        <label>{{ $t('nodeInspector.actualImagePrompt') }}</label>
        <div class="lab-row">
          <p class="hint">{{ $t('nodeInspector.sendAsIs') }}</p>
          <button class="link" type="button" @click="rebuildPrompt">{{ $t('nodeInspector.rebuildWithStyle') }}</button>
        </div>
        <textarea
          rows="16"
          :value="shot.boardPrompt ?? ''"
          :placeholder="$t('nodeInspector.boardPrompt')"
          @input="project.updateShot(shot.id, { boardPrompt: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'shotImage' && shot">
        <div class="lab-row">
          <label>{{ $t('nodeInspector.actualImagePrompt') }}</label>
          <button class="link" type="button" @click="rebuildPrompt">{{ $t('nodeInspector.rebuildWithStyle') }}</button>
        </div>
        <p class="hint">{{ $t('nodeInspector.imagePromptHint') }}</p>
        <textarea
          rows="16"
          :value="shot.imagePrompt ?? ''"
          :placeholder="$t('nodeInspector.gridHint')"
          @input="project.updateShot(shot.id, { imagePrompt: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'shotFrames' && shot">
        <p class="hint">
          {{ $t('nodeInspector.framesHint') }}
        </p>
        <div class="lab-row">
          <label>{{ $t('common.startFramePrompt') }}</label>
          <button class="link" type="button" :disabled="running" @click="redrawFrame('start')">{{ $t('nodeInspector.redraw') }}</button>
        </div>
        <textarea
          rows="9"
          :value="startFramePromptValue"
          :placeholder="$t('common.startFramePromptHint')"
          @input="project.updateShot(shot.id, { startFramePrompt: ($event.target as HTMLTextAreaElement).value })"
        />
        <div class="lab-row">
          <label>{{ $t('common.endFramePrompt') }}</label>
          <button class="link" type="button" :disabled="running" @click="redrawFrame('end')">{{ $t('nodeInspector.redraw') }}</button>
        </div>
        <textarea
          rows="9"
          :value="endFramePromptValue"
          :placeholder="$t('common.endFramePromptHint')"
          @input="project.updateShot(shot.id, { endFramePrompt: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'shotVideo' && shot">
        <div class="lab-row">
          <label>{{ $t('nodeInspector.actualVideoPrompt') }}</label>
          <div class="lab-actions">
            <button
              class="link"
              type="button"
              :disabled="optimizingPrompt || running"
              @click="optimizeVideoPrompt"
            >
              {{ optimizingPrompt ? $t('common.optimizing') : $t('common.optimizePrompt') }}
            </button>
            <button class="link" type="button" :disabled="optimizingPrompt || running" @click="resetVideoPrompt">{{ $t('nodeInspector.rebuildFromStoryboard') }}</button>
          </div>
        </div>
        <p class="hint">
          {{ $t('nodeInspector.h3EditableNarration', { tag: '<d>' }) }}
        </p>
        <textarea
          rows="16"
          :value="shot.compiledVideoPrompt ?? ''"
          :placeholder="videoPromptPlaceholder"
          @input="project.setShotVideoPrompt(shot.id, ($event.target as HTMLTextAreaElement).value)"
        />
        <label>{{ $t('common.secondsDuration') }}</label>
        <p v-if="shotDurationWarning(shot.duration, durationCapability.max)" class="hint">
          {{ $t('storyboard.shotDurationWarning', { max: durationCapability.max, duration: shot.duration }) }}
        </p>
        <p v-if="ltxProfile && ltxShotSpeechTooFast(shot, inspectorDuration)" class="hint">
          {{ $t('ltx.speechTooFast', { seconds: inspectorDuration }) }}
        </p>
        <select v-model.number="inspectorDuration">
          <option v-for="seconds in inspectorDurations" :key="seconds" :value="seconds">{{ seconds }}</option>
        </select>
        <label>{{ $t('common.cameraMotion') }}</label>
        <select
          :value="shot.cameraMovement"
          @change="project.updateShot(shot.id, { cameraMovement: ($event.target as HTMLSelectElement).value as any })"
        >
          <option value="static">{{ $t('common.cameraFixed') }}</option>
          <option value="push">{{ $t('common.cameraPush') }}</option>
          <option value="pull">{{ $t('common.cameraPull') }}</option>
          <option value="pan">{{ $t('common.cameraPan') }}</option>
          <option value="tilt">{{ $t('common.cameraTrack') }}</option>
          <option value="orbit">{{ $t('common.cameraOrbit') }}</option>
        </select>
        <p
          v-if="shot && project.current && stillModeForShot(shot, project.current) === 'storyboard' && !isH3Fl2va && !shot.boardAssetId"
          class="err"
        >{{ $t('nodeInspector.needsBoard') }}</p>
        <p
          v-else-if="shot && project.current && stillModeForShot(shot, project.current) === 'keyframe' && !isH3Fl2va && !shot.imageAssetId"
          class="err"
        >{{ $t('nodeInspector.needsGrid') }}</p>
        <p v-else-if="isH3Fl2va && lastFrameRequired && shot && !shot.lastFrameAssetId" class="err">
          {{ $t('nodeInspector.requiresEndFrame') }}
        </p>
        <p v-else-if="fl2vaChain && shot && !isH3Fl2va" class="hint">
          {{ $t('nodeInspector.chainHint') }}
        </p>
      </template>

      <H3GenModeSelect v-if="isH3Video" v-model="h3GenMode" />
      <FramePairSlots
        v-if="isH3Fl2va || (ltxProfile && !node.data.captureId)"
        v-model:first-id="firstFrameId"
        v-model:last-id="lastFrameId"
        :last-required="lastFrameRequired"
        :first-hint="node.type === 'shotVideo' && shot?.imageAssetId ? $t('common.useShotImage') : ''"
      />
      <ShotRefStrip
        v-else-if="shot && (node.type === 'shotBoard' || node.type === 'shotImage' || node.type === 'shotVideo')"
        :shot="shot"
        :mode="node.type === 'shotVideo' ? 'video' : node.type === 'shotBoard' ? 'board' : 'image'"
      />
      <ShotRefStrip
        v-else-if="node.type === 'subject' || node.type === 'prop' || node.type === 'sceneProps' || node.type === 'scene'"
        v-model:extra-ids="extraRefIds"
      />
      <template v-if="node.type === 'videoGen'">
        <div class="lab-row">
          <label>{{ $t('nodeInspector.actualVideoPrompt') }}</label>
          <button
            class="link"
            type="button"
            :disabled="optimizingPrompt || running || videoModel === 'wan-prime'"
            @click="optimizeVideoPrompt"
          >
            {{ optimizingPrompt ? $t('common.optimizing') : $t('common.optimizePrompt') }}
          </button>
        </div>
        <p class="hint">{{ $t('nodeInspector.h3EditableDialogue', { tag: '<d>' }) }}</p>
        <textarea
          rows="12"
          :value="node.data.prompt ?? ''"
          :placeholder="$t('nodeInspector.videoPrompt')"
          @input="project.setCanvasNodePrompt(node.id, ($event.target as HTMLTextAreaElement).value)"
        />
      </template>
      <div v-if="node.type === 'imageGen' || node.type === 'videoGen'" class="insp-refs">
        <div class="lab-row"><label>{{ $t('common.referenceImage') }}</label></div>
        <div v-if="inspectorRefIds.length" class="insp-ref-list">
          <div v-for="id in inspectorRefIds" :key="id" class="insp-ref">
            <img v-if="inspectorRefUrls[id]" :src="inspectorRefUrls[id]" alt="" />
            <button type="button" class="insp-ref-del" :title="$t('common.removeReference')" @click="removeInspectorRef(id)">×</button>
          </div>
        </div>
        <p v-else class="hint">{{ $t('nodeInspector.noReferenceHint') }}</p>
      </div>

      <template v-else-if="node.type === 'audio' && shot">
        <label>{{ $t('common.narrationMode') }}</label>
        <select
          :value="effectiveShotAudioMode(shot)"
          @change="project.setShotAudioMode(shot.id, ($event.target as HTMLSelectElement).value as ShotAudioMode)"
        >
          <option value="h3-dialogue" :disabled="!project.shotSupportsVideoVoice(shot)">{{ $t('common.h3Dialogue') }}</option>
          <option value="h3-voiceover" :disabled="!project.shotSupportsVideoVoice(shot)">{{ $t('nodeInspector.h3Offscreen') }}</option>
          <option value="tts">{{ $t('common.postTts') }}</option>
          <option value="none">{{ $t('common.noNarration') }}</option>
        </select>
        <p v-if="!project.shotSupportsVideoVoice(shot)" class="hint">{{ $t('common.videoVoiceUnsupported') }}</p>
        <label>{{ $t('common.narrationText') }}</label>
        <textarea
          rows="4"
          :value="shot.voiceover"
          :placeholder="$t('nodeInspector.dialogue')"
          @input="project.updateShot(shot.id, { voiceover: ($event.target as HTMLTextAreaElement).value })"
        />
        <TtsModelSelect v-if="effectiveShotAudioMode(shot) === 'tts'" />
        <template v-if="effectiveShotAudioMode(shot) === 'tts' && isOpenAiTts(settings.config.tts)">
          <p class="hint">{{ $t('openAiTts.generatedVoiceHint') }}</p>
          <label>{{ $t('openAiTts.shotInstruction') }}</label>
          <textarea
            rows="2"
            :value="shot.ttsInstruction"
            :placeholder="$t('openAiTts.shotInstructionPlaceholder')"
            @input="project.updateShot(shot.id, { ttsInstruction: ($event.target as HTMLTextAreaElement).value })"
          />
        </template>
        <label>{{ $t('nodeInspector.speakingVoice') }}</label>
        <textarea
          rows="2"
          :value="shotSpeakerVoice"
          :placeholder="
            shotSpeakerName
              ? $t('nodeInspector.noVoiceForCharacter', { p0: shotSpeakerName })
              : $t('nodeInspector.voiceHint')
          "
          @input="project.updateShot(shot.id, { speakerVoice: ($event.target as HTMLTextAreaElement).value })"
        />
        <p class="hint">
          {{
            shotSpeakerVoice
              ? $t('nodeInspector.voiceDescriptionHint')
              : $t('nodeInspector.oneVoice')
          }}
        </p>
      </template>

      <div v-if="historyIds.length" class="hist">
        <span>{{ $t('nodeInspector.historyHint') }}</span>
        <div class="hist-row">
          <div v-for="hid in historyIds" :key="hid" class="hist-item">
            <button
              class="hist-thumb"
              type="button"
              :title="$t('common.fullImage')"
              @click="openLightbox(historyUrls[hid], 'image')"
            >
              <img v-if="historyUrls[hid]" :src="historyUrls[hid]" alt="" />
            </button>
            <button class="hist-use" type="button" @click="restoreHistory(hid)">{{ $t('nodeInspector.restore') }}</button>
          </div>
        </div>
      </div>

      <div v-if="isImageNode || isVideoNode" class="insp-params">
        <ImageModelSelect v-if="isImageNode" />
        <ImageResolutionSeg
          v-if="isImageNode && imageResolutionChoices.length"
          v-model="imageResolution"
          :choices="imageResolutionChoices"
        />
        <VideoModelSelect
          v-if="isVideoNode"
          v-model="videoModel"
          :profile-id="node.data.videoProfileId"
          @select-profile="onSelectVideoProfile"
        />
        <VideoSettingsPopover
          v-if="isVideoNode"
          plain
          :resolution="videoResolution"
          :resolutions="resolutionChoices"
          :aspect="nodeAspectRatio"
          :duration="inspectorDuration"
          :durations="inspectorDurations"
          :ltx-model="ltxProfile ? ltxProfile.workflowId || LTX_DEFAULT_MODEL : undefined"
          :ltx-desktop="isLtxDesktop(ltxProfile)"
          :show-audio="showVideoAudio"
          :audio="generateAudio"
          @update:resolution="videoResolution = $event"
          @update:aspect="nodeAspectRatio = $event"
          @update:duration="inspectorDuration = $event"
          @update:audio="generateAudio = $event"
        />
      </div>
      <template v-if="node.type === 'script' && isPlayReady(project.current?.script)">
        <label>{{ $t('common.continueDirection') }}</label>
        <textarea
          rows="3"
          :value="continueHint"
          :placeholder="$t('nodeInspector.continueExample')"
          @input="continueHint = ($event.target as HTMLTextAreaElement).value"
        />
      </template>
      <GradientButton
        v-if="node.type === 'script' && isPlayReady(project.current?.script)"
        block
        :loading="running"
        :disabled="running"
        @click="runContinue"
      >
        {{ $t('common.continueScript') }}
      </GradientButton>
      <GradientButton
        v-if="node.type === 'script'"
        block
        :type="isPlayReady(project.current?.script) ? 'secondary' : undefined"
        :loading="running"
        :disabled="running"
        @click="run"
      >
        {{ actionLabel }}
      </GradientButton>
      <GradientButton
        v-if="canPickAsset"
        block
        type="secondary"
        :disabled="running"
        @click="pickerOpen = true"
      >
        {{ $t('nodeInspector.chooseFromLibrary') }}
      </GradientButton>
      <template v-if="node.type === 'script' && isImg2Video">
        <GradientButton
          block
          type="secondary"
          :loading="running"
          :disabled="running || !((project.current?.script?.content || '').trim())"
          @click="runExtract('subjects')"
        >
          {{ $t('common.extractCharacters') }}
        </GradientButton>
        <GradientButton
          block
          type="secondary"
          :loading="running"
          :disabled="running || !((project.current?.script?.content || '').trim())"
          @click="runExtract('scenes')"
        >
          {{ $t('common.extractScenes') }}
        </GradientButton>
        <GradientButton
          block
          type="secondary"
          :loading="running"
          :disabled="running || !canExtractShots"
          @click="runExtract('shots')"
        >
          {{ $t('common.extractStoryboard') }}
        </GradientButton>
      </template>
      <GradientButton
        v-else-if="node.type === 'script' && canExtractNext"
        block
        type="secondary"
        :loading="running"
        :disabled="running || !((project.current?.script?.content || '').trim())"
        @click="runExtract()"
      >
        {{ extractLabel }}
      </GradientButton>
      <GradientButton
        v-else-if="node.type !== 'script' || !canExtractNext"
        block
        :loading="running"
        :disabled="!canRun"
        @click="run"
      >
        {{ gateBlocked ? $t('nodeInspector.approveScriptFirst') : actionLabel }}
      </GradientButton>
      <GradientButton
        v-if="node.type === 'final' && hasAsset"
        block
        type="secondary"
        @click="downloadFinal"
      >
        {{ $t('common.videoDownload') }}
      </GradientButton>
      <button class="ghost" type="button" @click="refreshPreview">{{ $t('common.previewRefresh') }}</button>
    </template>
    <AssetPicker
      :open="pickerOpen"
      kind="image"
      :title="$t('common.useImageForNode')"
      show-library
      default-tab="page"
      :selected-ids="currentAssetId ? [currentAssetId] : []"
      @close="pickerOpen = false"
      @confirm="onPickerConfirm"
    />
  </aside>
</template>

<style scoped>
.insp {
  width: 300px;
  flex-shrink: 0;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg-1);
  padding: 14px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.insp h3 {
  margin: 0;
  font-size: 16px;
}
.insp-k {
  font-size: 10px;
  color: var(--color-text-4);
  text-transform: uppercase;
}
.insp-ref-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  overflow: visible;
  padding-top: 6px;
}
.insp-ref {
  position: relative;
  width: 56px;
  overflow: visible;
}
.insp-ref img {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 8px;
  display: block;
  background: var(--color-bg-2);
}
.insp-ref-del {
  position: absolute;
  top: -6px;
  right: -6px;
  z-index: 2;
  box-sizing: border-box;
  width: 20px;
  height: 20px;
  margin: 0;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid #fff;
  border-radius: 50%;
  background: #e5484d;
  color: #fff !important;
  font-size: 14px;
  font-weight: 800;
  line-height: 1;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.55);
  cursor: pointer;
}
.empty,
.err,
.hint {
  font-size: 12px;
  color: var(--color-text-3);
  margin: 0;
}
.err {
  color: var(--color-error);
}
.lab-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.lab-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.link {
  font-size: 11px;
  color: var(--color-accent);
  padding: 0;
  background: none;
}
.link:disabled {
  opacity: 0.4;
  cursor: default;
}
label {
  font-size: 11px;
  color: var(--color-text-4);
}
input,
textarea,
select {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text-1);
  padding: 8px;
  font: inherit;
  font-size: 12px;
}
textarea {
  min-height: 120px;
  flex: 1;
}
.prev {
  align-self: flex-start;
  width: 148px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-bg-3);
  cursor: zoom-in;
}
.prev-frame {
  position: relative;
  width: 100%;
  background: var(--color-bg-2);
}
.prev img,
.prev video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
  display: block;
}
.prev span {
  display: block;
  font-size: 10px;
  color: var(--color-text-4);
  padding: 4px 6px 5px;
  text-align: center;
}
.prev-audio {
  width: 100%;
  max-width: 100%;
  cursor: default;
  padding: 8px 8px 0;
}
.prev-audio audio {
  width: 100%;
  height: 36px;
  display: block;
}
.prev-video {
  width: 100%;
  max-width: 220px;
  cursor: default;
}
.insp-params {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.hist {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hist > span {
  font-size: 11px;
  color: var(--color-text-4);
}
.hist-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.hist-item {
  width: 56px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: none;
}
.hist-thumb {
  width: 56px;
  height: 40px;
  padding: 0;
  border-radius: 6px;
  overflow: hidden;
  background: var(--color-bg-3);
  cursor: zoom-in;
}
.hist-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hist-use {
  font-size: 10px;
  padding: 1px 0;
  color: var(--color-text-4);
  background: none;
}
.hist-use:hover {
  color: var(--color-accent);
}
.ghost {
  font-size: 12px;
  color: var(--color-text-3);
  padding: 6px;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-2);
}
.check input {
  width: auto;
}
.seg {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.seg-btn {
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
  color: var(--color-text-2);
  border-radius: 8px;
  padding: 8px 6px;
  font-size: 12px;
  cursor: pointer;
}
.seg-btn.on {
  border-color: var(--color-accent);
  color: var(--color-text-1);
  background: color-mix(in srgb, var(--color-accent) 16%, var(--color-bg-2));
}
.vol-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: center;
}
.vol-row input[type='range'] {
  padding: 0;
  background: transparent;
  border: none;
}
</style>
