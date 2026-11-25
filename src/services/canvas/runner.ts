import { isLtxDesktop, isLtxTask } from '@/services/ai/ltxDesktopOptions'
import { isLtxProfile } from '@/services/ai/ltxOptions'
import { uiPunctuation } from '@/i18n'
import { t as translate } from "@/i18n"
import {
  useProjectStore,
  useAssetsStore,
  useSettingsStore,
  useLibraryStore,
  useScriptsStore
} from '@/stores'
import {
  generateImage,
  generateVideo,
  generateSpeech,
  generateStoryboard,
  generatePlay,
  storyboardToShots,
  applyAestheticToScript,
  isPlayReady,
  buildH3ImageSlots,
  compileH3OfficialPrompt,
  isCompleteRef2VA,
  spokenTextOnly,
  enrichVideoPerformance,
  reviewImageQuality,
  reviewVideoQuality,
  reviewSpeechQuality,
  analyzeRemakeVideo,
  remakeShotsFromAnalysis,
  extractTargetDurationSec,
  bindShotVoiceHints,
  FALLBACK_VOICE_PROMPT,
  DIGITAL_HUMAN_VISUAL_LOCK,
  DIGITAL_HUMAN_AESTHETIC,
  DIGITAL_HUMAN_AUDIO_DESCRIPTION,
  DIGITAL_HUMAN_SPEAKER_HINT,
  DIGITAL_HUMAN_SPEAKER_NAME,
  DIGITAL_HUMAN_SCENE_NAME,
  DIGITAL_HUMAN_SCENE_DESCRIPTION,
  DIGITAL_HUMAN_SCENE_ANCHOR,
  DIGITAL_HUMAN_IMAGE_ASSIGNMENT,
  cloneVoiceFromSample,
  synthesizeClonedSpeech,
  modelAcceptsReferenceAudio
} from '@/services/ai'
import { blobToChatImageUrl, callLLM } from '@/services/ai/client'
import { stripReasoningLeak } from '@/utils/jsonRepair'
import { imageModelForProject, getVideoPromptStyle } from '@/services/ai/runtime'
import { DRAW_THINGS_PROVIDER } from '@/services/ai/drawThingsOptions'
import { pickDocImageResolution } from '@/services/ai/modelOptions'
import { importedDirectorPrefix } from '@/services/settings/directorSkill'
import { collectShotRefIds, collectShotBoardRefIds, collectShotKeyframeRefIds, collectShotVideoEntries, packVideoRefEntries, boundSubjectIds, sceneAssetForShot, sceneForShot, subjectsForShot, sceneHasKeyProps } from '@/utils/consistency'
import { resolveShotPlace } from '@/utils/shotPlace'
import { DIRECTOR_TIMELINE_SPEC, directorTimelineIssue, h3DirectorBodyIssue, preservesScreenText } from '@/utils/shotPrompt'
import { videoRequiresStoryboard } from '@/utils/storyboardGate'
import { stillModeForShot, shotsMissingKeyframe, shotsMissingStoryboard, needsShotFrames, shotUsesFrames } from '@/utils/videoStill'
import {
  extractPlayDirectives,
  extractSceneSlice
} from '@/utils/scriptMarkdown'
import { countAddedPlayScenes } from '@/utils/playContinue'
import {
  h3VoiceMode,
  needsExternalTts,
  pushHistory,
  resolveH3VoiceMode
} from '@/utils/shot'
import { rebuildCanvasGraph, absoluteCanvasPosition, nextFreeformPosition, NODE_W } from './layout'
import { emitCanvasActivity, revealCanvas, selectCanvasNode } from './canvasBridge'
import { extractStageLabel, extractStageNoun, nextExtractStage, type ExtractStage } from './pipeline'
import { friendlyAiError } from '@/services/ai/abort'
import { lookFromScript, lookFromTexts, styleLabel, inferVisualStyleFromText } from '@/utils/visualStyle'
import { aspectToSize } from '@/utils/aspect'
import {
  boardSendPrompt,
  scenePropSendPrompt,
  sceneSendPrompt,
  shotImageSendPrompt,
  defaultShotImagePrompt,
  shotFrameSendPrompt,
  subjectSendPrompt,
  propSendPrompt,
  videoSendPrompt
} from '@/utils/nodePrompt'
import { playTitleOf, topicFromBrief } from '@/utils/storyBrief'
import { isNodeRunning, mapPool, withNodeJob, VIDEO_GEN_CONCURRENCY } from './jobs'
import { isPlayApproved, playGateMessage } from './playGate'
import { generateFinalCut } from './exportFinal'
import { setActiveProjectDir } from '@/services/storage'
import { toDigitalHumanWav, extractVideoLastFrame } from '@/services/ffmpeg'
import type { AspectRatio, CanvasNode, ID, Project, Scene, Shot, StoryProp, Subject, VideoGenModel, VideoResolution } from '@/types'
import {
  isH3VideoFamily,
  normalizeH3GenMode,
  normalizeVideoGenModel,
  normalizeVideoResolution,
  videoMaxRefImages,
  videoMaxSeconds,
  videoMinSeconds
} from '@/types'
import { canvasNodeProducesImage, canvasReferenceSlotEntries, resolvedCanvasReferenceAssetIds } from '@/services/canvas/references'
import { resolveH3PromptProfile } from './videoPromptProfile'
import { withVideoReferenceBlock } from '@/utils/videoReferenceBlock'
import { optimizeH3FullReference } from '@/services/ai/h3FullReference'

export type RunProgress = (nodeId: string, msg: string) => void
export type NodeRunOpts = { hd?: boolean }

let pendingRun: NodeRunOpts = {}

function evenPx(n: number) {
  const v = Math.max(2, Math.round(n))
  return v % 2 === 0 ? v : v + 1
}

function imageGenSize(kind: 'shot' | 'sheet' | 'scene', aspectRatio?: AspectRatio) {
  const project = useProjectStore()
  const hd = Boolean(pendingRun.hd)
  if (kind === 'sheet') {
    return hd ? { width: 2560, height: 1440 } : { width: 1792, height: 1024 }
  }
  const base = aspectRatio
    ? aspectToSize(aspectRatio)
    : {
        width: project.current?.settings.width ?? 1280,
        height: project.current?.settings.height ?? 720
      }
  const w = base.width
  const h = base.height
  if (!hd) return { width: w, height: h }
  const scale = Math.max(1, 2048 / Math.max(w, h))
  return { width: evenPx(w * scale), height: evenPx(h * scale) }
}

function canvasNodeAspect(node: CanvasNode | undefined, fallback: AspectRatio): AspectRatio {
  return node?.data.aspectRatio ?? fallback
}

function shotNodeAspect(
  project: NonNullable<ReturnType<typeof useProjectStore>['current']>,
  shotId: string,
  type: 'shotBoard' | 'shotImage' | 'shotVideo'
): AspectRatio {
  return canvasNodeAspect(
    project.canvas?.nodes.find((node) => node.type === type && node.data.shotId === shotId),
    project.settings.aspectRatio
  )
}

function ensureNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException(translate('canvasRunner.aborted'), 'AbortError')
}

function patchNode(
  project: ReturnType<typeof useProjectStore>,
  nodeId: string,
  status: CanvasNode['status'],
  error?: string
) {
  const node = project.current?.canvas?.nodes.find((n) => n.id === nodeId)
  if (!node) return
  node.status = status
  node.error = error
}

async function productRefBlobs() {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const blobs: Blob[] = []
  for (const id of project.current?.script?.referenceAssetIds ?? []) {
    const b = await assets.getBlob(id)
    if (b) blobs.push(b)
  }
  return blobs.slice(0, 3)
}

function resolveLlmModel(override?: string): string | undefined {
  const picked = override?.trim()
  if (picked) return picked
  return useSettingsStore().config.llm.model?.trim() || undefined
}

function findCanvasNode(match: (node: CanvasNode) => boolean) {
  return useProjectStore().current?.canvas?.nodes.find(match)
}

function docImageResolution(node?: CanvasNode | null) {
  const settings = useSettingsStore()
  const profile = settings.config.images.find((item) => item.id === settings.config.activeImageId)
  return pickDocImageResolution(node?.data.imageResolution, profile?.options?.imageResolutions)
}

function videoProfileById(profileId?: string) {
  const settings = useSettingsStore()
  return (
    settings.config.videos.find((item) => item.id === profileId) ||
    settings.config.videos.find((item) => item.id === settings.config.activeVideoId)
  )
}

function docGenerateAudio(profileId: string | undefined, enabled?: boolean) {
  const profile = videoProfileById(profileId)
  if (isLtxProfile(profile)) return enabled ?? true
  if (profile?.options?.videoAudio !== true) return undefined
  return Boolean(enabled)
}

function shotVideoAudio(shotId: string, profileId?: string) {
  const node = findCanvasNode((item) => item.type === 'shotVideo' && item.data.shotId === shotId)
  return docGenerateAudio(profileId || node?.data.videoProfileId, node?.data.generateAudio)
}

/** 대본이 바뀌면 이전에 저장한 재개 지점을 무효화한다. */
function scriptPlayKey(content: string): string {
  const text = String(content || '')
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return `${text.length}-${(hash >>> 0).toString(36)}`
}

function nodeActivityLabel(node: CanvasNode, p: NonNullable<ReturnType<typeof useProjectStore>['current']>) {
  const subjects = p.subjects ?? []
  const scenes = p.scenes ?? []
  const shots = p.shots ?? []
  const shotNo = (id?: string) => {
    const shot = shots.find((item) => item.id === id)
    return shot ? translate('canvasRunner.shotNumber', { number: shot.index + 1 }) : translate('canvasRunner.storyboard')
  }
  switch (node.type) {
    case 'script':
      return translate('canvasRunner.writeScript')
    case 'subject':
      return translate('canvasRunner.characterViewsLabel', { name: subjects.find((s) => s.id === node.data.subjectId)?.name || translate('canvasRunner.character') })
    case 'prop':
      return translate('canvasRunner.propViewsLabel', { name: (p.props ?? []).find((item) => item.id === node.data.propId)?.name || translate('canvasRunner.prop') })
    case 'subjectProps':
      return translate('canvasRunner.assetLabel', { name: subjects.find((s) => s.id === node.data.subjectId)?.name || translate('canvasRunner.character') })
    case 'scene':
      return translate('canvasRunner.sceneAnchorLabel', { name: scenes.find((s) => s.id === node.data.sceneId)?.name || translate('canvasRunner.scene') })
    case 'sceneProps':
      return translate('canvasRunner.keyPropLabel', { name: scenes.find((s) => s.id === node.data.sceneId)?.name || translate('canvasRunner.scene') })
    case 'shotBoard':
      return translate('canvasRunner.panelLabel', { shot: shotNo(node.data.shotId) })
    case 'shotImage':
      return translate('canvasRunner.imageLabel', { shot: shotNo(node.data.shotId) })
    case 'shotVideo':
      return translate('canvasRunner.videoLabel', { shot: shotNo(node.data.shotId) })
    case 'audio':
      return translate('canvasRunner.narrationLabel', { shot: shotNo(node.data.shotId) })
    case 'audioGen':
      return '오디오 합성'
    case 'export':
    case 'final':
      return translate('canvasRunner.assemble')
    default:
      return node.data.label || node.type
  }
}

function scriptActivityLabel(kind: 'play' | 'extract' | 'continue', stage?: ExtractStage) {
  if (kind === 'extract') {
    if (stage) return translate('canvasRunner.extractStage', { stage: extractStageNoun(stage) })
    return extractStageLabel(useProjectStore().current)
  }
  if (kind === 'continue') return translate('canvasRunner.continueScript')
  return translate('canvasRunner.writeScript')
}

function trackActivity(
  nodeId: string,
  label: string,
  source: 'canvas' | 'agent',
  report?: (msg: string) => void
) {
  emitCanvasActivity({ kind: 'start', nodeId, label, source })
  return {
    progress(msg: string) {
      report?.(msg)
      emitCanvasActivity({ kind: 'progress', nodeId, label, message: msg, source })
    },
    done(message?: string) {
      emitCanvasActivity({ kind: 'done', nodeId, label, message, source })
    },
    fail(e: unknown) {
      emitCanvasActivity({
        kind: 'error',
        nodeId,
        label,
        message: friendlyAiError(e),
        source
      })
    }
  }
}

async function extraRefBlobs(ids: string[] | undefined, label: string) {
  const assets = useAssetsStore()
  const library = useLibraryStore()
  const blobs: Blob[] = []
  const labels: string[] = []
  const seen = new Set<string>()
  for (const id of ids ?? []) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    const b = (await assets.getBlob(id)) || (await library.getBlob(id))
    if (!b) continue
    blobs.push(b)
    labels.push(label)
  }
  return { blobs, labels }
}

type SharedImageCategory = 'character' | 'scene' | 'prop' | 'other'

async function saveGeneratedImageToSharedLibrary(
  blob: Blob,
  category: SharedImageCategory,
  filename: string,
  prompt: string,
  onProgress?: (msg: string) => void
) {
  onProgress?.(translate('canvasRunner.saveToSharedLibrary'))
  return useLibraryStore().addCategorized(blob, category, 'ai-generated', { filename, prompt })
}

export async function generateSubjectSheet(sub: Subject, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  const latest = (project.current.subjects ?? []).find((s) => s.id === sub.id) || sub
  const look = lookFromScript(project.current.script)
  const style = look.style
  const product = await productRefBlobs()
  const extras = await extraRefBlobs(latest.referenceAssetIds, `Additional reference for ${latest.name}. Match appearance exactly.`)
  const useProduct = product.length > 0 && (Boolean(latest.fromReference) || latest.kind === 'other')
  const refs = [...(useProduct ? product : []), ...extras.blobs].slice(0, 10)
  const labels = [
    ...(useProduct ? product.map(() => `Reference photograph of ${latest.name}. Match appearance exactly.`) : []),
    ...extras.labels
  ].slice(0, 10)
  const prompt = subjectSendPrompt(latest, project.current)
  if (prompt !== (latest.sheetPrompt || '')) {
    project.updateSubject(latest.id, { sheetPrompt: prompt })
  }
  onProgress?.(refs.length ? translate('canvasRunner.generateViewsWithRefs', { count: refs.length }) : translate('canvasRunner.generateViews'))
  const size = imageGenSize('sheet')
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio: '16:9',
      resolution: docImageResolution(findCanvasNode((node) => node.type === 'subject' && node.data.subjectId === latest.id)),
      referenceImages: refs.length ? refs : undefined,
      referenceLabels: labels.length ? labels : undefined,
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `turnaround_${latest.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
  onProgress?.(translate('canvasRunner.checkCharacter'))
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`4면 설정 이미지 파일이 유효하지 않습니다. ${quality.issues.join(uiPunctuation.semicolon)}`)
  await saveGeneratedImageToSharedLibrary(result.blob, 'character', asset.filename, prompt, onProgress)
  project.updateSubject(latest.id, {
    designSheetAssetId: asset.id,
    designSheetHistoryIds: pushHistory(
      latest.designSheetAssetId,
      asset.id,
      latest.designSheetHistoryIds
    )
  })
  await project.save()
  return asset
}

export async function generatePropSheet(prop: StoryProp, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  const latest = (project.current.props ?? []).find((item) => item.id === prop.id) || prop
  const look = lookFromScript(project.current.script)
  const extras = await extraRefBlobs(latest.referenceAssetIds, `Additional reference for the prop ${latest.name}. Match its shape and materials exactly.`)
  const prompt = propSendPrompt(latest, project.current)
  if (prompt !== (latest.sheetPrompt || '')) {
    project.updateProp(latest.id, { sheetPrompt: prompt })
  }
  onProgress?.(extras.blobs.length ? translate('canvasRunner.generatePropViewsWithRefs', { count: extras.blobs.length }) : translate('canvasRunner.generatePropViews'))
  const size = imageGenSize('sheet')
  const result = await generateImage(
    {
      prompt,
      style: look.style,
      width: size.width,
      height: size.height,
      aspectRatio: '16:9',
      resolution: docImageResolution(findCanvasNode((node) => node.type === 'prop' && node.data.propId === latest.id)),
      referenceImages: extras.blobs.length ? extras.blobs : undefined,
      referenceLabels: extras.labels.length ? extras.labels : undefined,
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `prop_${latest.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
  onProgress?.(translate('canvasRunner.checkProp'))
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`소품의 다각도 이미지 파일이 유효하지 않습니다. ${quality.issues.join(uiPunctuation.semicolon)}`)
  await saveGeneratedImageToSharedLibrary(result.blob, 'prop', asset.filename, prompt, onProgress)
  project.updateProp(latest.id, {
    designSheetAssetId: asset.id,
    designSheetHistoryIds: pushHistory(latest.designSheetAssetId, asset.id, latest.designSheetHistoryIds)
  })
  await project.save()
  return asset
}

export async function generateScenePropSheet(
  scn: Scene,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  const latest = (project.current.scenes ?? []).find((s) => s.id === scn.id) || scn
  if (!sceneHasKeyProps(latest)) throw new Error('현재 장면에 주요 소품이 없습니다. 화면에서 잘 보이거나 이야기를 움직이는 소품을 1–4개 입력하세요.')
  const look = lookFromScript(project.current.script)
  const style = look.style
  const prompt = scenePropSendPrompt(latest, project.current)
  if (!latest.propSheetPrompt?.trim()) {
    project.updateScene(latest.id, { propSheetPrompt: prompt })
  }
  const refs: Blob[] = []
  const labels: string[] = []
  if (latest.plateAssetId) {
    const plate = await assets.getBlob(latest.plateAssetId)
    if (plate) {
      refs.push(plate)
      labels.push(`Location anchor for ${latest.name}. Match the featured prop to the period, materials, and colors of this setting.`)
    }
  }
  const extras = await extraRefBlobs(latest.propReferenceAssetIds, `Additional reference for the featured prop. Match its appearance exactly.`)
  refs.push(...extras.blobs)
  labels.push(...extras.labels)
  const clippedRefs = refs.slice(0, 10)
  const clippedLabels = labels.slice(0, 10)
  onProgress?.(clippedRefs.length ? translate('canvasRunner.generateKeyPropWithRefs', { count: clippedRefs.length }) : translate('canvasRunner.generateKeyProp'))
  const size = imageGenSize('sheet')
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio: '16:9',
      resolution: docImageResolution(
        findCanvasNode((node) => node.type === 'sceneProps' && node.data.sceneId === latest.id)
      ),
      referenceImages: clippedRefs.length ? clippedRefs : undefined,
      referenceLabels: clippedLabels.length ? clippedLabels : undefined,
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `scene_props_${latest.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
  onProgress?.(translate('canvasRunner.checkKeyProp'))
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`주요 소품 이미지 파일이 유효하지 않습니다. ${quality.issues.join(uiPunctuation.semicolon)}`)
  await saveGeneratedImageToSharedLibrary(result.blob, 'prop', asset.filename, prompt, onProgress)
  project.updateScene(latest.id, {
    propSheetAssetId: asset.id,
    propSheetHistoryIds: pushHistory(latest.propSheetAssetId, asset.id, latest.propSheetHistoryIds)
  })
  await project.save()
  return asset
}

export async function generateScenePlate(scn: Scene, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  const latest = (project.current.scenes ?? []).find((s) => s.id === scn.id) || scn
  const look = lookFromScript(project.current.script)
  const style = look.style
  const extras = await extraRefBlobs(latest.referenceAssetIds, `Reference for ${latest.name}. Match the spatial layout and lighting exactly.`)
  const prompt = sceneSendPrompt(latest, project.current)
  if (!latest.platePrompt?.trim()) {
    project.updateScene(latest.id, { platePrompt: prompt })
  }
  onProgress?.(extras.blobs.length ? translate('canvasRunner.generateSceneWithRefs', { count: extras.blobs.length }) : translate('canvasRunner.generateScene'))
  const size = imageGenSize('sheet')
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio: '16:9',
      resolution: docImageResolution(findCanvasNode((node) => node.type === 'scene' && node.data.sceneId === latest.id)),
      referenceImages: extras.blobs.length ? extras.blobs.slice(0, 10) : undefined,
      referenceLabels: extras.labels.length ? extras.labels.slice(0, 10) : undefined,
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `anchors_${latest.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
  onProgress?.(translate('canvasRunner.checkScene'))
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`장면 기준 이미지 파일이 유효하지 않습니다. ${quality.issues.join(uiPunctuation.semicolon)}`)
  await saveGeneratedImageToSharedLibrary(result.blob, 'scene', asset.filename, prompt, onProgress)
  project.updateScene(latest.id, {
    plateAssetId: asset.id,
    plateHistoryIds: pushHistory(latest.plateAssetId, asset.id, latest.plateHistoryIds)
  })
  await project.save()
  return asset
}

export async function generateShotBoard(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  if (project.current && !videoRequiresStoryboard(project.current)) {
    return generateShotImage(shot, onProgress, signal)
  }
  const assets = useAssetsStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  const rebound = boundSubjectIds(shot, project.current.subjects ?? [])
  if (rebound.length) {
    project.updateShot(shot.id, { subjectIds: rebound })
    shot = project.current.shots.find((s) => s.id === shot.id) || { ...shot, subjectIds: rebound }
  }
  const look = lookFromScript(project.current.script)
  const style = look.style
  const bundle = collectShotBoardRefIds(shot, project.current)
  const blobs: Blob[] = []
  const labels: string[] = []
  for (let i = 0; i < bundle.ids.length; i++) {
    const b = (await assets.getBlob(bundle.ids[i])) || (await useLibraryStore().getBlob(bundle.ids[i]))
    if (!b) continue
    blobs.push(b)
    labels.push(bundle.labels[i])
  }
  const prompt = boardSendPrompt(shot, project.current)
  if (!shot.boardPrompt?.trim()) {
    project.updateShot(shot.id, { boardPrompt: prompt })
  }
  onProgress?.(blobs.length ? `스토리 개요판을 그리는 중(참조 이미지 ${blobs.length}장)…` : '스토리 개요판을 그리는 중…')
  const aspectRatio = shotNodeAspect(project.current, shot.id, 'shotBoard')
  const size = imageGenSize('shot', aspectRatio)
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio,
      resolution: docImageResolution(findCanvasNode((node) => node.type === 'shotBoard' && node.data.shotId === shot.id)),
      referenceImages: blobs.length ? blobs : undefined,
      referenceLabels: labels.length ? labels : undefined,
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `board_${shot.index + 1}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id,
    shotId: shot.id
  })
  onProgress?.('스토리 개요판 파일을 확인하는 중…')
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`스토리 개요판 파일이 유효하지 않습니다. ${quality.issues.join(uiPunctuation.semicolon)}`)
  await saveGeneratedImageToSharedLibrary(result.blob, 'other', asset.filename, prompt, onProgress)
  project.assignShotBoard(shot.id, asset.id)
  await project.save()
  return asset
}

export async function generateShotImage(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  const rebound = boundSubjectIds(shot, project.current.subjects ?? [])
  if (rebound.length) {
    project.updateShot(shot.id, { subjectIds: rebound })
    shot = project.current.shots.find((s) => s.id === shot.id) || { ...shot, subjectIds: rebound }
  }
  if (videoRequiresStoryboard(project.current) && !shot.boardAssetId) {
    await generateShotBoard(shot, onProgress, signal)
    shot = project.current.shots.find((s) => s.id === shot.id) || shot
  } else {
    for (const sub of subjectsForShot(shot, project.current)) {
      const latest = (project.current.subjects ?? []).find((item) => item.id === sub.id) || sub
      if (latest.designSheetAssetId) continue
      onProgress?.(`‘${latest.name}’의 캐릭터 디자인 이미지를 먼저 생성하는 중…`)
      await generateSubjectSheet(latest, onProgress, signal)
    }
    const scene = sceneAssetForShot(shot, project.current)
    if (scene && !scene.plateAssetId) {
      onProgress?.(`‘${scene.name}’ 장면을 먼저 보완하는 중…`)
      await generateScenePlate(scene, onProgress, signal)
    }
    shot = project.current.shots.find((s) => s.id === shot.id) || shot
  }
  const look = lookFromScript(project.current.script)
  const style = look.style
  const bundle = videoRequiresStoryboard(project.current)
    ? collectShotRefIds(shot, project.current)
    : collectShotKeyframeRefIds(shot, project.current)
  const blobs: Blob[] = []
  const labels: string[] = []
  const library = useLibraryStore()
  for (let i = 0; i < bundle.ids.length; i++) {
    const b = (await assets.getBlob(bundle.ids[i])) || (await library.getBlob(bundle.ids[i]))
    if (!b) continue
    blobs.push(b)
    labels.push(bundle.labels[i])
  }
  let prompt = shotImageSendPrompt(shot, project.current)
  if (!videoRequiresStoryboard(project.current) && !/2\s*列|四宫格|正好\s*4\s*格|4분할|2\s*[×x]\s*2|four-panel/i.test(prompt)) {
    prompt = defaultShotImagePrompt(shot, project.current)
  }
  if (prompt !== (shot.imagePrompt || '')) {
    project.updateShot(shot.id, { imagePrompt: prompt })
  }
  onProgress?.(blobs.length ? `4분할 키프레임을 그리는 중(캐릭터·장면 참조 이미지 ${blobs.length}장)…` : '4분할 키프레임을 그리는 중…')
  const aspectRatio = shotNodeAspect(project.current, shot.id, 'shotImage')
  const size = imageGenSize('shot', aspectRatio)
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio,
      resolution: docImageResolution(findCanvasNode((node) => node.type === 'shotImage' && node.data.shotId === shot.id)),
      referenceImages: blobs.length ? blobs : undefined,
      referenceLabels: labels.length ? labels : undefined,
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `shot_${shot.index + 1}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id,
    shotId: shot.id
  })
  onProgress?.('키프레임 파일을 확인하는 중…')
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`키프레임 파일이 유효하지 않습니다. ${quality.issues.join(uiPunctuation.semicolon)}`)
  await saveGeneratedImageToSharedLibrary(result.blob, 'other', asset.filename, prompt, onProgress)
  project.assignShotImage(shot.id, asset.id)
  await project.save()
  return asset
}

function refreshShot(shotId: string): Shot {
  const shot = useProjectStore().current?.shots.find((item) => item.id === shotId)
  if (!shot) throw new Error('스토리보드 샷을 찾을 수 없습니다.')
  return shot
}

/** 캐릭터와 장면의 참조 이미지를 시작·끝 프레임에 사용한다. 개요판 모드에서는 개요판도 제공한다. */
async function collectFrameRefBlobs(
  shot: Shot,
  project: Project,
  onProgress?: (msg: string) => void
): Promise<{ blobs: Blob[]; labels: string[] }> {
  const assets = useAssetsStore()
  const library = useLibraryStore()
  // 프레임을 만들 때는 캐릭터 4면 설정 이미지, 소품, 장면 기준 이미지를 모두 참고한다.
  // 4분할 키프레임은 격자가 프레임에 들어갈 수 있어 사용하지 않는다.
  const bundle = collectShotRefIds(shot, project)
  const blobs: Blob[] = []
  const labels: string[] = []
  for (let i = 0; i < bundle.ids.length; i++) {
    const blob = (await assets.getBlob(bundle.ids[i])) || (await library.getBlob(bundle.ids[i]))
    if (!blob) continue
    blobs.push(blob)
    labels.push(bundle.labels[i])
  }
  if (!blobs.length) {
    onProgress?.('캐릭터나 장면의 참조 이미지가 없어 스토리보드 설명을 바탕으로 프레임을 생성합니다.')
  }
  return { blobs, labels }
}

/** 프레임을 생성해 리소스 라이브러리에 저장한다. */
async function renderShotFrame(
  shot: Shot,
  which: 'start' | 'end',
  blobs: Blob[],
  labels: string[],
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  const prompt = shotFrameSendPrompt(shot, project.current, which)
  const look = lookFromScript(project.current.script)
  const aspectRatio = shotNodeAspect(project.current, shot.id, 'shotImage')
  const size = imageGenSize('shot', aspectRatio)
  const word = which === 'start' ? translate('canvasRunner.firstFrame') : translate('canvasRunner.lastFrame')
  onProgress?.(`이 샷의 ${word}을 생성하는 중(캐릭터·장면 참조 이미지 ${blobs.length}장)…`)
  const fail = (e: any) => {
    const reason = friendlyAiError(e) || e?.message || translate('canvasRunner.unknownCause')
    // 실패한 샷 번호와 프레임을 오류에 포함한다.
    return new Error(translate('canvasRunner.frameFailed', { number: shot.index + 1, frame: word, reason: reason }))
  }
  let result
  try {
    result = await generateImage(
      {
        prompt,
        style: look.style,
        width: size.width,
        height: size.height,
        aspectRatio,
        resolution: docImageResolution(findCanvasNode((node) => node.type === 'shotFrames' && node.data.shotId === shot.id)),
        referenceImages: blobs.length ? blobs : undefined,
        referenceLabels: labels.length ? labels : undefined,
        model: imageModelForProject(project.current.pipelineMode),
        signal
      },
      onProgress
    )
  } catch (e: any) {
    ensureNotCancelled(signal)
    throw fail(e)
  }
  onProgress?.(`${word} 파일을 확인하는 중…`)
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw fail(new Error(translate('canvasRunner.invalidFrame', { frame: word, reason: quality.issues.join(uiPunctuation.semicolon) })))
  try {
    const asset = await assets.add(result.blob, 'image', 'ai-generated', {
      filename: `shot${shot.index + 1}_${which}frame_${Date.now().toString(36)}`,
      prompt,
      projectId: project.current.id,
      shotId: shot.id
    })
    return asset
  } catch (e: any) {
    throw fail(e)
  }
}

/**
 * 샷의 캐릭터와 장면으로 시작·끝 프레임을 각각 생성한다.
 * 끝 프레임에는 시작 프레임을 참고해 외모, 의상, 카메라 위치와 조명을 유지한다.
 * 시작 프레임에는 이전 샷의 끝 프레임을 제공해 연속성을 유지한다.
 */
export async function generateShotFramePair(
  shot: Shot,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  const rebound = boundSubjectIds(shot, project.current.subjects ?? [])
  if (rebound.length) {
    project.updateShot(shot.id, { subjectIds: rebound })
    shot = refreshShot(shot.id)
  }
  // 참조 이미지를 보완하지 못해도 프레임 생성을 계속한다.
  // 참조 이미지 오류로 두 프레임의 생성이 모두 중단되는 일을 방지한다.
  // 시작·끝 프레임을 쓰는 샷에는 별도의 스토리 개요판을 생성하지 않는다.
  try {
    if (videoRequiresStoryboard(project.current) && !shotUsesFrames(shot, project.current) && !shot.boardAssetId) {
      await generateShotBoard(shot, onProgress, signal)
      shot = refreshShot(shot.id)
    } else {
      for (const sub of subjectsForShot(shot, project.current)) {
        const latest = (project.current.subjects ?? []).find((item) => item.id === sub.id) || sub
        if (latest.designSheetAssetId) continue
        onProgress?.(`‘${latest.name}’의 캐릭터 디자인 이미지를 먼저 생성하는 중…`)
        await generateSubjectSheet(latest, onProgress, signal)
      }
      const scene = sceneAssetForShot(shot, project.current)
      if (scene && !scene.plateAssetId) {
        onProgress?.(`‘${scene.name}’ 장면을 먼저 보완하는 중…`)
        await generateScenePlate(scene, onProgress, signal)
      }
      shot = refreshShot(shot.id)
    }
  } catch (e: any) {
    onProgress?.(`필요한 자료를 모두 생성하지 못했습니다(${friendlyAiError(e) || e?.message || '알 수 없는 원인'}). 기존 참조 자료로 프레임을 생성합니다.`)
    shot = refreshShot(shot.id)
  }
  const { blobs, labels } = await collectFrameRefBlobs(shot, project.current, onProgress)

  // 이전 샷의 끝 프레임에서 현재 샷의 시작 프레임으로 연결한다.
  const ordered = [...project.current.shots].sort((a, b) => a.index - b.index)
  const pos = ordered.findIndex((item) => item.id === shot.id)
  const prevShot = pos > 0 ? ordered[pos - 1] : undefined
  const prevTailId = pos > 0 ? prevShot?.lastFrameAssetId : undefined
  const startBlobs = [...blobs]
  const startLabels = [...labels]
  if (prevTailId) {
    const tail = await tryLoadRefImageBlob(prevTailId)
    if (tail) {
      startBlobs.push(tail)
      startLabels.push('the last frame of the previous shot; continue from this exact framing and lighting')
    }
  }
  const startAsset = await renderShotFrame(shot, 'start', startBlobs, startLabels, onProgress, signal)
  project.updateShot(shot.id, { firstFrameAssetId: startAsset.id })
  shot = refreshShot(shot.id)
  await project.save()

  // 시작 프레임을 참고해 끝 프레임의 인물, 카메라와 조명을 유지한다.
  const startBlob = await assets.getBlob(startAsset.id)
  const endBlobs = startBlob ? [...blobs, startBlob] : [...blobs]
  const endLabels = [
    ...labels,
    'the first frame of this same shot; keep identical camera, lens, outfit and lighting'
  ]
  const endAsset = await renderShotFrame(shot, 'end', endBlobs, endLabels, onProgress, signal)
  const patch: Partial<Shot> = { lastFrameAssetId: endAsset.id }
  if (!shot.startFramePrompt?.trim()) patch.startFramePrompt = shotFrameSendPrompt(shot, project.current, 'start')
  if (!shot.endFramePrompt?.trim()) patch.endFramePrompt = shotFrameSendPrompt(shot, project.current, 'end')
  project.updateShot(shot.id, patch)
  await project.save()
  onProgress?.('시작·끝 프레임을 모두 생성했습니다. 영상을 생성할 수 있습니다.')
  return { first: startAsset, last: endAsset }
}

/** 시작 또는 끝 프레임 하나만 다시 생성한다. */
export async function regenerateShotFrame(
  shot: Shot,
  which: 'start' | 'end',
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  shot = refreshShot(shot.id)
  const { blobs, labels } = await collectFrameRefBlobs(shot, project.current, onProgress)
  if (which === 'end') {
    const firstId = shot.firstFrameAssetId
    const first = firstId ? await tryLoadRefImageBlob(firstId) : undefined
    if (first) {
      blobs.push(first)
      labels.push('the first frame of this same shot; keep identical camera, lens, outfit and lighting')
    }
  } else {
    const ordered = [...project.current.shots].sort((a, b) => a.index - b.index)
    const pos = ordered.findIndex((item) => item.id === shot.id)
    const prevTailId = pos > 0 ? ordered[pos - 1]?.lastFrameAssetId : undefined
    const tail = prevTailId ? await tryLoadRefImageBlob(prevTailId) : undefined
    if (tail) {
      blobs.push(tail)
      labels.push('the last frame of the previous shot; continue from this exact framing and lighting')
    }
  }
  const asset = await renderShotFrame(shot, which, blobs, labels, onProgress, signal)
  const old = which === 'start' ? shot.firstFrameAssetId : shot.lastFrameAssetId
  if (old && old !== asset.id) await assets.remove(old).catch(() => undefined)
  project.updateShot(
    shot.id,
    which === 'start' ? { firstFrameAssetId: asset.id } : { lastFrameAssetId: asset.id }
  )
  await project.save()
  return asset
}

async function ensureShotVideoRefs(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const project = useProjectStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  for (const sub of subjectsForShot(shot, project.current)) {
    const latest = (project.current.subjects ?? []).find((item) => item.id === sub.id) || sub
    if (latest.designSheetAssetId) continue
    onProgress?.(`‘${latest.name}’의 캐릭터 디자인 이미지를 먼저 생성하는 중…`)
    await generateSubjectSheet(latest, onProgress, signal)
  }
  const scene = sceneAssetForShot(shot, project.current)
  if (scene) {
    if (shot.sceneId !== scene.id) {
      project.updateShot(shot.id, { sceneId: scene.id })
    }
    const latestScene = (project.current.scenes ?? []).find((item) => item.id === scene.id) || scene
    if (!latestScene.plateAssetId) {
      onProgress?.(`‘${latestScene.name}’ 장면을 먼저 보완하는 중…`)
      await generateScenePlate(latestScene, onProgress, signal)
    }
  }
  shot = refreshShot(shot.id)
  // 시작·끝 프레임을 쓰는 영상은 해당 두 이미지로 생성한다.
  const stillMode = stillModeForShot(shot, project.current)
  if (!shotUsesFrames(shot, project.current) && stillMode === 'storyboard' && !shot.boardAssetId) {
    onProgress?.('이 샷의 스토리 개요판을 먼저 생성하는 중…')
    await generateShotBoard(shot, onProgress, signal)
  } else if (!shotUsesFrames(shot, project.current) && stillMode === 'keyframe' && !shot.imageAssetId) {
    onProgress?.('이 샷의 4분할 키프레임을 먼저 생성하는 중…')
    await generateShotImage(shot, onProgress, signal)
  }
  return refreshShot(shot.id)
}

/**
 * 스마트 내레이션 샷은 프로젝트에 업로드한 인물 이미지만 참조한다.
 * 영화 스토리보드 참조를 함께 넣으면 원래 인물의 외형이 달라질 수 있다.
 */
async function regenerateDigitalHumanShot(
  shot: Shot,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  const flow = p?.speechWorkflow
  if (!p || p.pipelineMode !== 'smart-speech' || flow?.mode !== 'digital-human') {
    throw new Error('현재 프로젝트는 디지털 휴먼 내레이션 프로젝트가 아닙니다.')
  }
  const aspectRatio = shotNodeAspect(p, shot.id, 'shotVideo')
  const videoSize = aspectToSize(aspectRatio)
  const referenceId = flow.imageAssetId
  if (!referenceId) {
    throw new Error('디지털 휴먼의 캐릭터 참조 이미지가 없어 임의의 인물을 생성하지 않았습니다. 캐릭터 이미지를 다시 업로드한 뒤 생성하세요.')
  }
  const referenceBlob = await assets.getBlob(referenceId)
  if (!referenceBlob) {
    throw new Error('디지털 휴먼의 캐릭터 참조 이미지 파일을 읽지 못해 생성 작업을 제출하지 않았습니다.')
  }
  const spoken = spokenTextOnly(shot.voiceover || '')
  if (!spoken) throw new Error('이 샷에 내레이션 원문이 없습니다.')
  let cloned = flow.clonedVoiceId
    ? { voiceId: flow.clonedVoiceId, model: flow.clonedVoiceModel || 'qwen3-tts-vc-2026-01-22' }
    : null
  if (!cloned) {
    const sampleId = flow.voiceSampleAssetId || flow.audioAssetId
    const sampleBlob = sampleId ? await assets.getBlob(sampleId) : undefined
    if (!sampleBlob) throw new Error('음성 샘플이 없어 음색을 복제하고 대사를 합성할 수 없습니다.')
    onProgress?.('업로드한 오디오에서 음색을 복제하는 중…')
    cloned = await cloneVoiceFromSample(sampleBlob, `aicut${p.id.replace(/[^a-z0-9]/gi, '').slice(-8)}`, signal)
    p.speechWorkflow = {
      ...flow,
      clonedVoiceId: cloned.voiceId,
      clonedVoiceModel: cloned.model,
      updatedAt: Date.now()
    }
    await project.save()
  }
  onProgress?.('복제한 음색으로 대사를 합성하는 중…')
  const rawSpeech = await synthesizeClonedSpeech(spoken, cloned.voiceId, cloned.model, signal)
  const speechBlob = (await toDigitalHumanWav(rawSpeech, onProgress)).blob
  const speechAsset = await assets.add(speechBlob, 'audio', 'ai-generated', {
    filename: `내레이션_${String(shot.index + 1).padStart(2, '0')}_${Date.now().toString(36)}.wav`,
    prompt: spoken,
    projectId: p.id,
    shotId: shot.id
  })
  project.assignShotAudio(shot.id, speechAsset.id)
  const speechIds = [...(flow.generatedSpeechAssetIds || [])]
  speechIds[shot.index] = speechAsset.id
  if (p.speechWorkflow) {
    p.speechWorkflow = { ...p.speechWorkflow, generatedSpeechAssetIds: speechIds, updatedAt: Date.now() }
  }

  if (shot.imageAssetId !== referenceId) {
    project.updateShot(shot.id, { imageAssetId: referenceId })
    await project.save()
  }
  onProgress?.('프로젝트 캐릭터 이미지를 유일한 참조로 사용해 같은 인물의 내레이션을 생성하는 중…')
  const result = await generateVideo(
    {
      imageBlob: referenceBlob,
      prompt: DIGITAL_HUMAN_VISUAL_LOCK,
      aesthetic: DIGITAL_HUMAN_AESTHETIC,
      audioDescription: DIGITAL_HUMAN_AUDIO_DESCRIPTION,
      voiceover: spoken,
      voiceMode: 'dialogue',
      speakerHint: DIGITAL_HUMAN_SPEAKER_HINT,
      speakerName: DIGITAL_HUMAN_SPEAKER_NAME,
      onScreenNames: [DIGITAL_HUMAN_SPEAKER_NAME],
      sceneName: DIGITAL_HUMAN_SCENE_NAME,
      sceneDescription: DIGITAL_HUMAN_SCENE_DESCRIPTION,
      sceneAnchor: DIGITAL_HUMAN_SCENE_ANCHOR,
      shotTitle: 'Locked single-person talking head',
      imageAssignments: [DIGITAL_HUMAN_IMAGE_ASSIGNMENT],
      duration: Math.min(15, Math.max(5, Math.ceil(shot.duration))),
      width: videoSize.width,
      height: videoSize.height,
      aspectRatio,
      cameraMovement: 'static',
      audioBlob: speechBlob,
      audioSync: true,
      promptAsIs: true,
      mode: 'I2VA',
      videoProfileId: shot.videoProfileId,
      signal,
      resumeTaskId: shot.videoTaskId,
      onTaskSubmitted: async (taskId) => {
        project.updateShot(shot.id, { videoTaskId: taskId })
        await project.save()
      }
    },
    onProgress
  )
  ensureNotCancelled(signal)
  const quality = await reviewVideoQuality(result.blob, result.prompt, signal)
  if (!quality.passed) throw new Error(`영상 파일이 유효하지 않습니다. ${quality.issues.join(uiPunctuation.semicolon)}`)
  const asset = await assets.add(result.blob, 'video', 'ai-generated', {
    filename: `digital_human_${shot.index + 1}_${Date.now().toString(36)}.mp4`,
    prompt: result.prompt,
    projectId: p.id,
    shotId: shot.id
  })
  project.assignShotVideo(shot.id, asset.id)
  project.updateShot(shot.id, { videoTaskId: undefined })
  const generatedIds = [...(flow.generatedVideoAssetIds || [])]
  generatedIds[shot.index] = asset.id
  p.speechWorkflow = {
    ...flow,
    generatedVideoAssetIds: generatedIds,
    progress: translate('canvasRunner.regenerated', { number: shot.index + 1 }),
    updatedAt: Date.now()
  }
  await project.save()
  return asset
}

async function loadRefImageBlob(id: ID, label: string): Promise<Blob> {
  const assets = useAssetsStore()
  const library = useLibraryStore()
  const blob = (await assets.getBlob(id)) || (await library.getBlob(id))
  if (!blob) throw new Error(`${label}을 읽지 못했습니다.`)
  return blob
}

/** 선택 참조 이미지를 읽지 못하면 오류 없이 이미지를 생략한다. */
async function tryLoadRefImageBlob(id?: ID): Promise<Blob | undefined> {
  if (!id) return undefined
  const assets = useAssetsStore()
  const library = useLibraryStore()
  try {
    return (await assets.getBlob(id)) || (await library.getBlob(id)) || undefined
  } catch {
    return undefined
  }
}

function canvasVideoNodeForShot(shot: Shot) {
  return useProjectStore().current?.canvas?.nodes.find(
    (n) => n.type === 'shotVideo' && n.data.shotId === shot.id
  )
}

function canvasVideoModelForShot(shot: Shot): VideoGenModel {
  const nodeModel = canvasVideoNodeForShot(shot)?.data.videoModel
  if (nodeModel) return normalizeVideoGenModel(nodeModel)
  // 노드에서 모델을 따로 고르지 않았으면 기본 영상 모델을 쓴다.
  const preferred = useSettingsStore().config.defaultVideoModel
  if (preferred) return normalizeVideoGenModel(preferred)
  return normalizeVideoGenModel(undefined)
}

function canvasVideoResolutionForShot(shot: Shot, videoModel: VideoGenModel): VideoResolution {
  return normalizeVideoResolution(canvasVideoNodeForShot(shot)?.data.videoResolution ?? useProjectStore().current?.settings.defaultVideoResolution, videoModel)
}

function clampVideoDuration(raw: number | undefined, videoModel: VideoGenModel, fallback = 5) {
  const min = videoMinSeconds(videoModel)
  const max = videoMaxSeconds(videoModel)
  return Math.min(max, Math.max(min, Math.round(raw || fallback)))
}

function storyboardVideoModel(): VideoGenModel {
  const p = useProjectStore().current
  const existing = p?.canvas?.nodes.find((node) => node.type === 'shotVideo')
  if (existing?.data.videoModel) return normalizeVideoGenModel(existing.data.videoModel)
  const preferred = useSettingsStore().config.defaultVideoModel
  if (preferred) return normalizeVideoGenModel(preferred)
  const cfg = useSettingsStore().config.video
  const marker = `${cfg.provider || ''} ${cfg.workflowId || ''} ${cfg.adapter?.type || ''}`.toLowerCase()
  if (/h3.*v5/.test(marker) && !/15s/.test(marker)) return 'h3-v5'
  return 'h3'
}

function shotUsesFl2va(shot: Shot, videoModel: VideoGenModel): boolean {
  return videoModel !== 'wan-prime' && normalizeH3GenMode(shot.h3GenMode) === 'fl2va'
}

/**
 * 프로젝트에서 시작·끝 프레임 연결 모드를 켰는지 확인한다.
 * 다음 샷의 시작 프레임에 이전 영상의 끝 프레임을 쓰므로 순차 실행한다.
 * 동시에 생성하면 이전 샷이 준비되지 않아 현재 샷의 참조 이미지로 대체된다.
 */
export function isFl2vaChainActive(project?: { settings?: { h3ShotChainMode?: 'auto' | 'fl2va' } } | null): boolean {
  return (project?.settings?.h3ShotChainMode || 'auto') === 'fl2va'
}

/** 현재 영상이 생성되면 끝 프레임을 다음 샷의 시작 프레임으로 저장한다. 수동 선택은 유지한다. */
async function chainLastFrameToNextShot(
  shot: Shot,
  videoAssetId: ID,
  onProgress?: (msg: string) => void
) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  if (!p) return
  const ordered = [...p.shots].sort((a, b) => a.index - b.index)
  const next = ordered.find((s) => s.index === shot.index + 1)
  if (!next) return
  // 수동 시작 프레임은 유지한다. 현재 샷을 다시 만들면 이전 자동 프레임을 교체한다.
  const existing = next.firstFrameAssetId
  if (existing) {
    const meta = assets.getMeta(existing)
    const autoChained = Boolean(meta && /^shot\d+_lastframe_/.test(meta.filename || ''))
    if (!autoChained) return
    await assets.remove(existing).catch(() => undefined)
  }
  const blob = await assets.getBlob(videoAssetId)
  if (!blob) return
  try {
    onProgress?.('이 샷의 끝 프레임을 추출해 다음 샷의 시작 프레임으로 연결하는 중…')
    const frame = await extractVideoLastFrame(blob)
    const asset = await assets.add(frame, 'image', 'ai-generated', {
      filename: `shot${shot.index + 1}_lastframe_${Date.now().toString(36)}`,
      projectId: p.id,
      shotId: shot.id
    })
    project.updateShot(next.id, { firstFrameAssetId: asset.id })
    await project.save()
    onProgress?.(`${shot.index + 1}번 샷의 끝 프레임을 ${next.index + 1}번 샷의 시작 프레임으로 설정했습니다.`)
  } catch (e: any) {
    // 프레임 추출 실패는 현재 영상에 영향을 주지 않는다. 다음 샷에서 이전 영상을 다시 읽을 수 있다.
    onProgress?.(`끝 프레임을 저장하지 못했습니다. 다음 샷 영상을 생성할 때 추출합니다. ${e?.message || e}`)
  }
}

/** 프레임 연결을 위해 캔버스 노드를 샷 번호순으로 정렬한다. */
function sortNodeIdsByShotIndex(p: Project, ids: string[]): string[] {
  const indexByShot = new Map(p.shots.map((s) => [s.id, s.index]))
  const rank = (id: string) => {
    const node = p.canvas?.nodes?.find((n) => n.id === id)
    const sid = node?.data?.shotId
    const idx = sid ? indexByShot.get(sid) : undefined
    return idx ?? Number.MAX_SAFE_INTEGER
  }
  return [...ids].sort((a, b) => rank(a) - rank(b))
}

/** 끝 프레임을 다시 추출할 때 기존 이미지가 다른 곳에서 쓰이는지 확인한다. */
function assetStillInUse(p: Project, assetId: ID): boolean {
  for (const n of p.canvas?.nodes ?? []) {
    if (n.data.outputAssetId === assetId) return true
    if ((n.data.referenceAssetIds ?? []).includes(assetId)) return true
    if (n.data.firstFrameAssetId === assetId || n.data.lastFrameAssetId === assetId) return true
  }
  for (const s of p.shots ?? []) {
    if (
      s.imageAssetId === assetId ||
      s.boardAssetId === assetId ||
      s.firstFrameAssetId === assetId ||
      s.lastFrameAssetId === assetId
    ) {
      return true
    }
  }
  return false
}

/**
 * 영상의 끝 프레임을 추출해 영상 노드 옆에 이미지 노드를 배치한다.
 * 다음 영상의 시작 프레임이나 참조 이미지로 쓰거나 따로 다운로드할 수 있다.
 * 같은 영상에서 다시 추출하면 기존 이미지 노드만 갱신한다.
 */
export async function grabVideoLastFrameNode(
  nodeId: string,
  onProgress?: (msg: string) => void
): Promise<ID> {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  if (!p?.canvas) throw new Error('캔버스가 아직 준비되지 않았습니다.')
  const node = p.canvas.nodes.find((n) => n.id === nodeId)
  if (!node) throw new Error('해당 영상 노드를 찾을 수 없습니다.')
  const shot = node.data.shotId ? p.shots.find((s) => s.id === node.data.shotId) : undefined
  const videoId =
    node.type === 'final' || node.type === 'export'
      ? p.finalVideoAssetId
      : node.data.outputAssetId || shot?.videoAssetId
  if (!videoId) throw new Error('이 노드에 영상이 없습니다. 영상을 먼저 생성한 뒤 끝 프레임을 추출하세요.')
  const blob = await assets.getBlob(videoId)
  if (!blob) throw new Error('영상을 읽지 못했습니다.')
  onProgress?.('마지막 프레임을 추출하는 중…')
  const frame = await extractVideoLastFrame(blob)
  const asset = await assets.add(frame, 'image', 'extracted', {
    filename: `lastframe_${shot ? `shot${shot.index + 1}_` : ''}${Date.now().toString(36)}`,
    projectId: p.id,
    shotId: shot?.id
  })

  const frameNodeId = `lastFrame:${node.id}`
  const label = shot ? `${shot.index + 1}번 샷 · 끝 프레임` : `${node.data.label || '영상'} · 끝 프레임`
  const existing = p.canvas.nodes.find((n) => n.id === frameNodeId)
  if (existing) {
    const old = existing.data.outputAssetId
    existing.data = { ...existing.data, label, outputAssetId: asset.id }
    existing.status = 'success'
    existing.error = undefined
    if (old && old !== asset.id && !assetStillInUse(p, old)) {
      await assets.remove(old).catch(() => undefined)
    }
  } else {
    // 자유 작업 영역 오른쪽에서 원본 영상과 같은 높이에 배치한다.
    // 오른쪽의 내레이션 및 합성 그룹과 겹치지 않게 한다.
    const abs = absoluteCanvasPosition(p.canvas.nodes, node)
    const groups = p.canvas.nodes.filter((n) => n.type === 'groupFrame')
    const right = groups.length
      ? Math.max(...groups.map((g) => g.position.x + (Number(g.data.width) || NODE_W)))
      : abs.x + NODE_W
    const pos = nextFreeformPosition(p.canvas.nodes, { click: { x: right + 48, y: abs.y } })
    p.canvas.nodes = [
      ...p.canvas.nodes,
      {
        id: frameNodeId,
        type: 'imageGen',
        position: { x: pos.x, y: pos.y },
        data: {
          label,
          prompt: '',
          referenceAssetIds: [],
          referenceSourceNodeIds: [],
          aspectRatio: p.settings.aspectRatio,
          outputAssetId: asset.id
        },
        status: 'success'
      }
    ]
    const edgeId = `e-${node.id}-${frameNodeId}`
    if (!p.canvas.edges.some((e) => e.id === edgeId)) {
      p.canvas.edges = [
        ...p.canvas.edges,
        {
          id: edgeId,
          source: node.id,
          target: frameNodeId,
          sourceHandle: 'out',
          targetHandle: 'in'
        }
      ]
    }
  }
  await project.save()
  selectCanvasNode(frameNodeId)
  revealCanvas(frameNodeId)
  onProgress?.('영상 옆의 이미지 노드에 끝 프레임을 넣었습니다.')
  return frameNodeId
}

export function rebindShotScenes() {
  const project = useProjectStore()
  const p = project.current
  if (!p) return
  for (const shot of p.shots) {
    const scene = sceneAssetForShot(shot, p)
    if (scene && shot.sceneId !== scene.id) {
      project.updateShot(shot.id, { sceneId: scene.id })
    }
  }
}

export async function generateShotVideo(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  shot = refreshShot(shot.id)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  const videoNode = canvasVideoNodeForShot(shot)
  const profileId = videoNode?.data.videoProfileId || shot.videoProfileId
  const profile = videoProfileById(profileId)
  if (isLtxTask(shot.videoTaskId) ||
    (canvasVideoModelForShot(shot) === 'h3' && isLtxProfile(profile))) {
    const p = project.current
    const resumeTaskId = shot.videoTaskId
    const resuming = isLtxTask(resumeTaskId)
    const aspectRatio = shotNodeAspect(p, shot.id, 'shotVideo')
    const result = await generateVideo({
      prompt: shot.compiledVideoPrompt || '',
      imageBlob: resuming ? undefined : await tryLoadRefImageBlob(shot.firstFrameAssetId || shot.imageAssetId),
      lastFrameBlob: resuming ? undefined : await tryLoadRefImageBlob(shot.lastFrameAssetId),
      duration: shot.duration,
      ...aspectToSize(aspectRatio),
      aspectRatio,
      videoProfileId: profileId || profile?.id,
      videoResolution: canvasVideoResolutionForShot(shot, 'h3'),
      generateAudio: shotVideoAudio(shot.id, profileId),
      signal,
      resumeTaskId,
      onTaskSubmitted: async (videoTaskId) => {
        if (project.current?.id !== p.id) return
        project.updateShot(shot.id, { videoTaskId, videoProfileId: profile?.id })
        if (videoNode) project.patchCanvasNode(videoNode.id, { videoTaskId, videoProfileId: profile?.id })
        await project.save()
      },
      onTaskTerminalFailure: async () => {
        if (project.current?.id !== p.id) return
        project.updateShot(shot.id, { videoTaskId: undefined })
        if (videoNode) project.patchCanvasNode(videoNode.id, { videoTaskId: undefined })
        await project.save()
      }
    }, onProgress)
    ensureNotCancelled(signal)
    if (project.current?.id !== p.id) throw new DOMException(translate('ltx.projectChanged'), 'AbortError')
    if (p.folderPath) setActiveProjectDir(p.folderPath)
    const asset = await assets.add(result.blob, 'video', 'ai-generated', {
      filename: `video_${shot.index + 1}_${Date.now().toString(36)}.mp4`,
      prompt: result.prompt,
      projectId: p.id,
      shotId: shot.id
    })
    if (project.current?.id === p.id) {
      project.assignShotVideo(shot.id, asset.id)
      project.updateShot(shot.id, { videoTaskId: undefined })
      if (videoNode) project.patchCanvasNode(videoNode.id, { videoTaskId: undefined })
      await project.save()
    }
    return asset
  }
  if (!(shot.compiledVideoPrompt || '').trim()) {
    throw new Error('이미지→영상 프롬프트가 비어 있습니다. 직접 작성하거나 ‘프롬프트 최적화’ 또는 ‘스토리보드 기준으로 다시 작성’을 누르세요.')
  }
  const aspectRatio = shotNodeAspect(project.current, shot.id, 'shotVideo')
  const videoSize = aspectToSize(aspectRatio)
  if (
    project.current.pipelineMode === 'smart-speech' &&
    project.current.speechWorkflow?.mode === 'digital-human'
  ) {
    return regenerateDigitalHumanShot(shot, onProgress, signal)
  }
  const videoModel = canvasVideoModelForShot(shot)
  const chainFl2va =
    videoModel !== 'wan-prime' &&
    (project.current.settings.h3ShotChainMode || 'auto') === 'fl2va'
  const perShotFl2va = shotUsesFl2va(shot, videoModel)
  // 프레임 연결에 필요한 두 장이 없으면 일반 영상 생성에 확보한 시작 프레임을 전달한다.
  // 일반 경로에서도 이전 샷과 현재 샷의 연결을 유지한다.
  let chainFirstBlob: Blob | undefined
  if (perShotFl2va || chainFl2va) {
    const ordered = [...project.current.shots].sort((a, b) => a.index - b.index)
    // 샷 삭제로 번호가 연속적이지 않을 수 있어 배열 위치로 앞뒤 샷을 찾는다.
    const pos = ordered.findIndex((item) => item.id === shot.id)
    const prevShot = pos > 0 ? ordered[pos - 1] : undefined
    const nextShot = pos >= 0 && pos + 1 < ordered.length ? ordered[pos + 1] : undefined
    const isFirstShot = pos === 0
    // 시작 프레임은 수동 선택, 이전 영상의 끝 프레임, 현재 샷 이미지 순으로 고른다.
    // 참조 파일을 읽지 못하면 해당 이미지만 생략한다.
    let firstBlob: Blob | undefined
    if (shot.firstFrameAssetId) {
      firstBlob = await tryLoadRefImageBlob(shot.firstFrameAssetId)
    }
    if (!firstBlob && chainFl2va && !isFirstShot) {
      const prevVideoId = prevShot?.videoAssetId
      const prevVideoBlob = prevVideoId ? await assets.getBlob(prevVideoId) : undefined
      if (prevVideoBlob) {
        onProgress?.('이전 샷 영상의 끝 프레임을 추출해 현재 샷의 시작 프레임으로 설정하는 중…')
        firstBlob = await extractVideoLastFrame(prevVideoBlob).catch(() => undefined)
      } else {
        onProgress?.('이전 샷 영상이 없어 현재 샷 이미지를 시작 프레임으로 사용합니다.')
      }
    }
    if (!firstBlob && shot.imageAssetId) {
      firstBlob = await tryLoadRefImageBlob(shot.imageAssetId)
    }
    if (!firstBlob) {
      // 현재 샷에 수동으로 프레임 모드를 지정했으면 필수 시작 프레임이 없을 때 안내한다.
      // 프로젝트 전체의 프레임 연결 설정에서는 프레임이 부족하면 일반 방식으로 생성한다.
      // 프레임 누락으로 전체 프로젝트의 영상 생성이 막히지 않게 한다.
      if (perShotFl2va) {
        throw new Error(
          '이 샷에 시작·끝 프레임 모드를 직접 켰지만 시작 프레임이 없습니다. 노드에서 시작 프레임을 선택하거나 생성 모드를 ‘참조 이미지’로 바꾸세요.'
        )
      }
      onProgress?.(
        isFirstShot
          ? '1번 샷에 시작 프레임과 샷 이미지가 없어 시작·끝 프레임을 이을 수 없습니다. 일반 방식으로 영상을 생성합니다.'
          : '이전 샷 영상과 현재 샷 이미지가 모두 없어 시작 프레임을 가져올 수 없습니다. 일반 방식으로 영상을 생성합니다.'
      )
    }
    // 끝 프레임은 수동 선택을 우선하고 프레임 연결 모드에서는 다음 샷 이미지도 쓸 수 있다.
    let lastBlob: Blob | undefined
    if (shot.lastFrameAssetId) {
      lastBlob = await tryLoadRefImageBlob(shot.lastFrameAssetId)
    }
    if (!lastBlob && chainFl2va) {
      // 다음 샷 이미지나 이미 연결한 다음 샷의 시작 프레임을 끝 프레임으로 쓸 수 있다.
      const tailId = nextShot?.imageAssetId || nextShot?.firstFrameAssetId
      if (tailId) lastBlob = await tryLoadRefImageBlob(tailId)
    }
    if (!lastBlob) {
      if (perShotFl2va && videoProfileById(shot.videoProfileId)?.options?.lastFrameRequired === true) {
        throw new Error('이 샷의 영상 모델에는 끝 프레임이 필요합니다. 노드에서 끝 프레임을 선택하거나 생성 모드를 ‘참조 이미지’로 바꾸세요.')
      }
      if (firstBlob) onProgress?.('끝 프레임이 없어 시작 프레임으로 일반 방식의 영상을 생성합니다.')
    }
    if (firstBlob && lastBlob) {
      onProgress?.('시작·끝 프레임을 읽는 중…')
      const promptStyle = getVideoPromptStyle()
      const cast = subjectsForShot(shot, project.current)
      const scene = sceneForShot(shot, project.current)
      const place = resolveShotPlace(shot, scene)
      const spoken = spokenTextOnly(shot.voiceover || '')
      const visibleSpeaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
      const onScreenNames = cast.map((subject) => subject.name)
      const voiceMode = spoken ? resolveH3VoiceMode(shot, onScreenNames) : 'none'
      shot = refreshShot(shot.id)
      const officialPrompt = videoSendPrompt(shot, project.current)
      onProgress?.('노드의 전체 프롬프트로 시작·끝 프레임 영상을 생성하는 중…')
      const result = await generateVideo(
        {
          imageBlob: firstBlob,
          lastFrameBlob: lastBlob,
          prompt: officialPrompt,
          promptAsIs: true,
          aesthetic: project.current.script?.visualStyleOverride || project.current.script?.h3Aesthetic || project.current.script?.aesthetic,
          audioDescription: shot.audioDescription,
          voiceover: spoken,
          voiceMode,
          speakerHint: shot.speakerHint,
          speakerVoice: resolveShotSpeakerVoice(shot, project.current),
          speakerName: visibleSpeaker,
          onScreenNames,
          sceneName: place.name,
          sceneLighting: place.lighting,
          shotTitle: shot.title,
          duration: clampVideoDuration(shot.duration, videoModel),
          width: videoSize.width,
          height: videoSize.height,
          aspectRatio,
          cameraMovement: shot.cameraMovement,
          promptStyle,
          videoModel: 'h3',
          videoProfileId: shot.videoProfileId,
          videoResolution: canvasVideoResolutionForShot(shot, videoModel),
          generateAudio: shotVideoAudio(shot.id, shot.videoProfileId),
          h3GenMode: 'fl2va',
          mode: 'I2VA',
          signal,
          resumeTaskId: shot.videoTaskId,
          onTaskSubmitted: async (taskId) => {
            project.updateShot(shot.id, { videoTaskId: taskId })
            await project.save()
          }
        },
        onProgress
      )
      onProgress?.('영상 파일을 확인하는 중…')
      const quality = await reviewVideoQuality(result.blob, result.prompt, signal)
      if (!quality.passed) throw new Error(`영상 파일이 유효하지 않습니다. ${quality.issues.join(uiPunctuation.semicolon)}`)
      const asset = await assets.add(result.blob, 'video', 'ai-generated', {
        filename: `video_${shot.index + 1}_${Date.now().toString(36)}`,
        prompt: result.prompt,
        projectId: project.current.id,
        shotId: shot.id
      })
      project.assignShotVideo(shot.id, asset.id)
      project.updateShot(shot.id, { videoTaskId: undefined })
      await project.save()
      if (chainFl2va) await chainLastFrameToNextShot(shot, asset.id, onProgress)
      return asset
    }
    // 프레임 연결에 실패해도 확보한 시작 프레임을 일반 생성에 전달한다.
    if (chainFl2va && firstBlob) chainFirstBlob = firstBlob
  }
  shot = await ensureShotVideoRefs(shot, onProgress, signal)

  const stillMode = stillModeForShot(shot, project.current)
  const allEntries = collectShotVideoEntries(shot, project.current)
  let packed = packVideoRefEntries(allEntries)
  if (chainFirstBlob) {
    // 이전 영상의 끝 프레임을 저장해 일반 생성에서도 첫 번째 참조 이미지로 사용한다.
    try {
      const chained = await assets.add(chainFirstBlob, 'image', 'ai-generated', {
        filename: `shot${shot.index + 1}_chainstart_${Date.now().toString(36)}`,
        projectId: project.current.id,
        shotId: shot.id
      })
      packed = [
        {
          id: chained.id,
          kind: 'extra',
          name: 'Previous shot’s last frame',
          label: 'starting frame of [Shot 1]; the exact image this shot must begin from'
        },
        ...packed.filter((entry) => entry.id !== chained.id)
      ]
      onProgress?.('이전 샷의 끝 프레임을 첫 번째 참조 이미지로 사용해 연속성을 유지합니다.')
    } catch {
      // 끝 프레임 저장에 실패해도 일반 생성은 계속한다.
    }
  }
  if (stillMode === 'keyframe' && !packed.some((entry) => entry.kind === 'keyframe') && shot.imageAssetId) {
    packed = [
      {
        id: shot.imageAssetId,
        kind: 'keyframe',
        name: 'keyframe',
        label: '2x2 four-panel keyframe for [Shot 1]; exactly 4 cells'
      },
      ...packed.filter((entry) => entry.id !== shot.imageAssetId)
    ]
  }
  if (stillMode === 'storyboard' && !packed.some((entry) => entry.kind === 'board')) {
    throw new Error('이 샷의 전체 전개를 담는 스토리 개요판이 없어 영상을 생성할 수 없습니다.')
  }
  if (stillMode === 'keyframe' && !packed.some((entry) => entry.kind === 'keyframe')) {
    throw new Error('현재 영상 모델에 필요한 이 샷의 4분할 키프레임이 없습니다.')
  }
  if ((project.current.scenes ?? []).length && !packed.some((entry) => entry.kind === 'scene')) {
    const scene = sceneAssetForShot(shot, project.current)
    throw new Error(
      scene
        ? `‘${scene.name}’의 장면 이미지가 없어 영상을 생성할 수 없습니다. 장면 이미지를 먼저 생성하세요.`
        : '장면 이미지가 없어 영상을 생성할 수 없습니다. 장면 이미지를 만들거나 이 샷을 장면에 연결하세요.'
    )
  }
  if (!packed.length) {
    throw new Error(
      stillMode === 'identity'
        ? '참조 이미지가 없어 영상을 생성할 수 없습니다. 캐릭터 디자인 이미지와 장면 이미지를 만들거나 이 샷에 참조 이미지를 추가하세요.'
        : '참조 이미지가 없어 영상을 생성할 수 없습니다. 캐릭터 설정 이미지, 장면 이미지, 샷 이미지를 만들거나 이 샷에 참조 이미지를 추가하세요.'
    )
  }
  const blobs: Blob[] = []
  const library = useLibraryStore()
  for (const entry of packed) {
    const blob = (await assets.getBlob(entry.id)) || (await library.getBlob(entry.id))
    if (!blob) throw new Error(`${entry.name || entry.kind} 참조 이미지를 읽지 못했습니다.`)
    blobs.push(blob)
  }
  const extraChars = allEntries.filter((entry) => entry.kind === 'character').length
    - packed.filter((entry) => entry.kind === 'character').length
  const extraDropped = allEntries.filter((entry) => entry.kind === 'extra').length
    - packed.filter((entry) => entry.kind === 'extra').length
  if (extraChars > 0 || extraDropped > 0) {
    onProgress?.(`참조 이미지 최대 9장을 준비했어요. 캐릭터 설정 이미지, 장면${stillMode === 'keyframe' ? ', 4분할 키프레임' : stillMode === 'storyboard' ? ', 스토리 개요판' : ''}과 사용자가 추가한 참조 이미지가 포함돼요.`)
  }

  const promptStyle = getVideoPromptStyle()
  const cast = subjectsForShot(shot, project.current)
  const scene = sceneForShot(shot, project.current)
  const place = resolveShotPlace(shot, scene)
  const spoken = spokenTextOnly(shot.voiceover || '')
  const visibleSpeaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const onScreenNames = cast.map((subject) => subject.name)
  const voiceMode = spoken ? resolveH3VoiceMode(shot, onScreenNames) : 'none'
  const imageSlots = buildH3ImageSlots(packed)
  const imageAssignments = imageSlots.map((slot) => slot.job)
  const hasIdentityRefs = packed.some(
    (entry) => entry.kind === 'character' || entry.kind === 'scene' || entry.kind === 'board'
  )
  const hasKeyframeFrame = packed.some((entry) => entry.kind === 'keyframe')
  const h3Mode = hasKeyframeFrame || hasIdentityRefs || packed.length > 1 ? 'R2VA' : 'I2VA'
  shot = refreshShot(shot.id)
  const officialPrompt = withVideoReferenceBlock(videoSendPrompt(shot, project.current), packed)
  if (officialPrompt !== shot.compiledVideoPrompt) {
    project.setShotVideoPrompt(shot.id, officialPrompt)
    await project.save()
    onProgress?.('실제 참조 이미지 순서에 맞춰 노드의 이미지 매핑을 갱신했어요.')
  }
  onProgress?.('노드의 전체 프롬프트로 영상을 생성하는 중…')
  const slotNames = packed.map((entry, index) =>
    entry.kind === 'character'
      ? `Picture ${index + 1}: ${entry.name}, character reference`
      : entry.kind === 'scene'
        ? `Picture ${index + 1}: location reference`
        : entry.kind === 'extra'
          ? `Picture ${index + 1}: additional reference`
            : entry.kind === 'keyframe'
            ? `Picture ${index + 1}: four-panel storyboard keyframe`
            : `Picture ${index + 1}: storyboard panel`
  )
  onProgress?.(`영상 생성 중(${slotNames.join(uiPunctuation.listSeparator)})…`)
  const result = await generateVideo(
    {
      imageBlob: blobs[0],
      referenceImages: blobs.slice(1),
      prompt: officialPrompt,
      promptAsIs: true,
      aesthetic: project.current.script?.visualStyleOverride || project.current.script?.h3Aesthetic || project.current.script?.aesthetic,
      audioDescription: shot.audioDescription,
      voiceover: spoken,
      voiceMode,
      speakerHint: shot.speakerHint,
      speakerVoice: resolveShotSpeakerVoice(shot, project.current),
      speakerName: visibleSpeaker,
      onScreenNames,
      sceneName: place.name,
      sceneLighting: place.lighting,
      shotTitle: shot.title,
      imageAssignments,
      imageSlots,
      duration: clampVideoDuration(shot.duration, videoModel),
      width: videoSize.width,
      height: videoSize.height,
      aspectRatio,
      cameraMovement: shot.cameraMovement,
      promptStyle,
      videoModel,
      videoProfileId: shot.videoProfileId,
      videoResolution: canvasVideoResolutionForShot(shot, videoModel),
      generateAudio: shotVideoAudio(shot.id, shot.videoProfileId),
      h3GenMode: 'reference',
      mode: h3Mode,
      signal,
      resumeTaskId: shot.videoTaskId,
      onTaskSubmitted: async (taskId) => {
        project.updateShot(shot.id, { videoTaskId: taskId })
        await project.save()
      }
    },
    onProgress
  )
  onProgress?.('영상 파일을 확인하는 중…')
  const quality = await reviewVideoQuality(result.blob, result.prompt, signal)
  if (!quality.passed) throw new Error(`영상 파일이 유효하지 않습니다. ${quality.issues.join(uiPunctuation.semicolon)}`)
  const asset = await assets.add(result.blob, 'video', 'ai-generated', {
    filename: `video_${shot.index + 1}_${Date.now().toString(36)}`,
    prompt: result.prompt,
    projectId: project.current.id,
    shotId: shot.id
  })
  project.assignShotVideo(shot.id, asset.id)
  project.updateShot(shot.id, { videoTaskId: undefined })
  await project.save()
  return asset
}

/** 현재 샷의 현장 기록과 챕터 대본을 바탕으로 영상 연출을 다시 작성한다. */
export async function rewriteShotPerformance(shot: Shot, signal?: AbortSignal): Promise<string> {
  const project = useProjectStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  const shots = project.current.shots
  const shotIndex = shots.findIndex((item) => item.id === shot.id)
  const scene = sceneForShot(shot, project.current)
  const play = project.current.script?.content || ''
  const performance = await enrichVideoPerformance({
    shot,
    force: true,
    prevShot: shotIndex > 0 ? shots[shotIndex - 1] : undefined,
    nextShot: shotIndex >= 0 ? shots[shotIndex + 1] : undefined,
    subjects: subjectsForShot(shot, project.current),
    scene,
    chapterNotes: extractPlayDirectives(play),
    sceneExcerpt: extractSceneSlice(play, scene?.name),
    signal
  })
  return optimizeShotVideoPrompt(shot, signal, performance)
}

/** H3에서는 노드 원문을 공식 영어 형식으로 바꾼다. 다중 참조는 여섯 구역, 시작과 끝 프레임은 첫 정렬 지시와 세 구역을 사용한다. */
async function compileH3NodePrompt(input: {
  source: string
  referenceIds?: string[]
  imageSlots: ReturnType<typeof buildH3ImageSlots>
  duration: number
  aspectRatio?: AspectRatio
  mode: 'R2VA' | 'FL2VA'
  aesthetic?: string
  audioDescription?: string
  voiceover?: string
  voiceMode?: 'dialogue' | 'voiceover' | 'none'
  speakerVoice?: string
  speakerName?: string
  onScreenNames?: string[]
  sceneName?: string
  sceneDescription?: string
  sceneLighting?: string
  sceneAnchor?: string
  shotTitle?: string
  cameraMovement?: Shot['cameraMovement']
  signal?: AbortSignal
}): Promise<string> {
  if (input.mode === 'R2VA') {
    return optimizeH3FullReference({ source: input.source, duration: input.duration, dialogue: input.voiceover, aesthetic: input.aesthetic, signal: input.signal,
      references: (input.referenceIds || []).map((id, index) => ({ id, name: input.imageSlots[index]?.sourceName || input.imageSlots[index]?.name || `Picture ${index + 1}`, kind: input.imageSlots[index]?.kind || 'extra' })) })
  }
  const spoken = (input.voiceover || '').trim()
  const compiled = (
    await compileH3OfficialPrompt({
      prompt: input.source,
      aesthetic: input.aesthetic,
      audioDescription: input.audioDescription,
      voiceover: spoken || undefined,
      voiceMode: spoken ? input.voiceMode : input.voiceMode === 'none' ? 'none' : undefined,
      speakerVoice: input.speakerVoice,
      speakerName: input.speakerName,
      onScreenNames: input.onScreenNames,
      sceneName: input.sceneName,
      sceneDescription: input.sceneDescription,
      sceneLighting: input.sceneLighting,
      sceneAnchor: input.sceneAnchor,
      shotTitle: input.shotTitle,
      imageAssignments: input.imageSlots.map((slot) => slot.job),
      imageSlots: input.imageSlots,
      duration: input.duration,
      aspectRatio: input.aspectRatio,
      cameraMovement: input.cameraMovement,
      mode: input.mode,
      signal: input.signal
    })
  ).trim()
  const visible = stripReasoningLeak(compiled)
  if (!visible) throw new Error('모델이 추론 과정만 보내고 프롬프트를 보내지 않았어요.')
  const body = visible.match(/integrated_multimodal_description:\s*([\s\S]*?)(?=\n\s*overall_soundscape:|$)/i)?.[1] || ''
  const issue = h3DirectorBodyIssue(body, input.duration)
  if (issue || !preservesScreenText(withVideoReferenceBlock(input.source, []), body)) {
    throw new Error(`H3 시작·끝 프레임 프롬프트를 최적화하지 못했어요. ${issue || '화면 문구가 빠졌거나 순서가 바뀌었어요.'} 기존 프롬프트를 보관했어요.`)
  }
  return visible
}

/** Wan 같은 H3 이외 모델에는 원문만 전달하고 응답의 본문만 사용한다. */
async function rewritePromptText(input: {
  source: string
  pictures?: string
  modelName?: string
  dialogue?: string
  duration: number
  aspectRatio?: AspectRatio
  signal?: AbortSignal
}): Promise<string> {
  let issue = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await callLLM({
    disableThinking: true,
    messages: [
      {
        role: 'system',
        content: `${importedDirectorPrefix()}Optimize this prompt for ${input.modelName || 'the selected video model'}. Write only English video direction suited to that model. Avoid other models' proprietary sections and tags, such as the H3 six-section format. Return only the revised prompt, without JSON, a title, or explanations.
${DIRECTOR_TIMELINE_SPEC}
Duration: ${input.duration}s. Aspect ratio: ${input.aspectRatio || 'use the node setting'}. Preserve the existing direction, visual style, cast, action, and exact dialogue with original speakers and order. Do not summarize the direction or add new characters, events or lines. Image assignments come from the runtime. Do not guess speakers.`
      },
      {
        role: 'user',
        content: `${input.pictures ? `Submitted reference image order:\n${input.pictures}\n\n` : ''}${input.dialogue ? `Original dialogue and speakers:\n${input.dialogue}\n\n` : ''}Source:\n${input.source}${issue ? `\nPrevious validation issue: ${issue}. Rewrite the entire prompt.` : ''}`
      }
    ],
    temperature: 0.5,
    useProviderOutputLimit: true,
    timeoutMs: 300_000,
    signal: input.signal
  })
  const text = stripReasoningLeak(
    String(resp.content || '')
      .replace(/^```(?:json|text|markdown)?\s*/i, '')
      .replace(/\s*```$/, '')
  )
    issue = resp.finishReason === 'length' ? '응답이 중간에 끊겼어요.' :
      directorTimelineIssue(text, input.duration) ||
      (!preservesScreenText(withVideoReferenceBlock(input.source, []), text) ? '화면 문구가 빠졌거나 순서가 바뀌었어요.' : '')
    if (!issue) return text
  }
  throw new Error(`연출 프롬프트를 만들지 못했어요. ${issue} 기존 프롬프트를 보관했어요.`)
}

/** 노드에 저장된 프롬프트를 모델로 보내고 본문을 반환한다. */
export async function optimizeShotVideoPrompt(shot: Shot, signal?: AbortSignal, rewrittenPerformance?: string): Promise<string> {
  const project = useProjectStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  shot = refreshShot(shot.id)
  const p = project.current
  const packed = packVideoRefEntries(collectShotVideoEntries(shot, p))
  const imageSlots = buildH3ImageSlots(packed)
  const box = (shot.compiledVideoPrompt || '').trim()
  const performance = (shot.videoPrompt || '').trim()
  const source = rewrittenPerformance || box || performance
  if (!source) throw new Error('먼저 프롬프트를 작성하세요.')
  const videoModel = canvasVideoModelForShot(shot)
  const profile = videoProfileById(canvasVideoNodeForShot(shot)?.data.videoProfileId || shot.videoProfileId)
  let compiled: string
  if (await resolveH3PromptProfile(profile, videoModel, signal)) {
    const cast = subjectsForShot(shot, p)
    const scene = sceneForShot(shot, p)
    const place = resolveShotPlace(shot, scene)
    const spoken = spokenTextOnly(shot.voiceover || '')
    const onScreenNames = cast.map((subject) => subject.name)
    const voiceMode = spoken
      ? resolveH3VoiceMode(shot, onScreenNames)
      : h3VoiceMode(shot) === 'none'
        ? 'none'
        : undefined
    compiled = await compileH3NodePrompt({
      source,
      referenceIds: packed.map((entry) => entry.id),
      imageSlots,
      duration: clampVideoDuration(shot.duration, videoModel),
      aspectRatio: shotNodeAspect(p, shot.id, 'shotVideo'),
      mode: shotUsesFl2va(shot, videoModel) ? 'FL2VA' : 'R2VA',
      aesthetic: p.script?.visualStyleOverride || p.script?.h3Aesthetic || p.script?.aesthetic,
      audioDescription: shot.audioDescription,
      voiceover: shot.voiceover || spoken,
      voiceMode,
      speakerVoice: resolveShotSpeakerVoice(shot, p),
      speakerName: (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim(),
      onScreenNames,
      sceneName: place.name,
      sceneDescription: scene?.description,
      sceneLighting: place.lighting,
      sceneAnchor: place.anchor,
      shotTitle: shot.title,
      cameraMovement: shot.cameraMovement,
      signal
    })
  } else {
    const pictures = imageSlots
      .map((slot) => `Picture ${slot.index}: ${slot.sourceName || slot.name}`)
      .join('\n')
    compiled = await rewritePromptText({ source, pictures, modelName: videoModel === 'wan-prime' ? 'Wan 3.0 Prime' : [profile?.name, profile?.workflowId].filter(Boolean).join(' / '), dialogue: shot.voiceover, duration: clampVideoDuration(shot.duration, videoModel), aspectRatio: shotNodeAspect(p, shot.id, 'shotVideo'), signal })
  }
  const currentShot = refreshShot(shot.id)
  const currentProfile = videoProfileById(canvasVideoNodeForShot(currentShot)?.data.videoProfileId || currentShot.videoProfileId)
  if (currentProfile?.id !== profile?.id || currentProfile?.workflowId !== profile?.workflowId || canvasVideoModelForShot(currentShot) !== videoModel) {
    throw new Error('최적화 중 영상 모델이 바뀌었어요. 다시 최적화하세요.')
  }
  if ((currentShot.compiledVideoPrompt || '').trim() !== box || (currentShot.videoPrompt || '').trim() !== performance || JSON.stringify(packVideoRefEntries(collectShotVideoEntries(currentShot, project.current!))) !== JSON.stringify(packed)) {
    throw new Error('최적화 중 프롬프트나 참조 이미지가 바뀌었어요. 다시 최적화하세요.')
  }
  compiled = withVideoReferenceBlock(compiled, packed)
  if (rewrittenPerformance) project.updateShot(shot.id, { videoPrompt: rewrittenPerformance })
  project.setShotVideoPrompt(shot.id, compiled)
  await project.save()
  return compiled
}

/**
 * 이 샷의 화자 음색은 캐릭터 카드에 저장한 최신 voicePrompt를 우선한다.
 * 카드에 설명이 없으면 shot.speakerVoice를 사용해 영상 생성에 전달한다.
 */
function resolveShotSpeakerVoice(shot: Shot, p: Project): string | undefined {
  const fromCard = speakerSubject(shot, p)?.voicePrompt?.trim()
  if (fromCard) return fromCard
  return shot.speakerVoice?.trim() || undefined
}

/** 내레이션의 화자 이름을 음성 설정이 있는 캐릭터 카드와 연결한다. */
function speakerSubject(shot: Shot, p: Project): Subject | undefined {
  const speaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  if (!speaker) return undefined
  const subjects = p.subjects ?? []
  const exact = subjects.find((s) => s.name.trim() === speaker)
  if (exact) return exact
  return subjects.find((s) => {
    const name = s.name.trim()
    return name && (speaker.includes(name) || name.includes(speaker))
  })
}

export async function generateShotAudio(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  if (!needsExternalTts(shot, project.current)) throw new Error('이 샷에 후반 작업용 TTS가 선택되지 않아 별도의 더빙이 필요 없습니다.')
  const text = spokenTextOnly(shot.voiceover || '')
  if (!text) throw new Error('이 샷에 내레이션 원고가 없습니다.')
  const p = project.current
  const speaker = speakerSubject(shot, p)
  let blob: Blob
  if (speaker?.voiceRefAssetId || speaker?.clonedVoiceId) {
    // 참조 오디오가 있으면 Bailian Qwen3-TTS-VC로 처음 한 번 음성을 복제하고 음색 ID를 저장한다.
    let voiceId = speaker.clonedVoiceId
    let voiceModel = speaker.clonedVoiceModel || 'qwen3-tts-vc-2026-01-22'
    if (!voiceId) {
      onProgress?.(`‘${speaker.name}’의 음색을 복제하는 중…`)
      const sampleBlob = await assets.getBlob(speaker.voiceRefAssetId!)
      if (!sampleBlob) throw new Error(`‘${speaker.name}’의 참조 오디오를 읽지 못했습니다. 캐릭터 카드에서 다시 업로드하세요.`)
      const cloned = await cloneVoiceFromSample(
        sampleBlob,
        `subj${speaker.id.replace(/[^a-z0-9]/gi, '').slice(-10) || 'voice'}`,
        signal
      )
      voiceId = cloned.voiceId
      voiceModel = cloned.model
      project.updateSubject(speaker.id, { clonedVoiceId: voiceId, clonedVoiceModel: voiceModel })
      await project.save()
    }
    onProgress?.(`‘${speaker.name}’의 음색으로 내레이션을 합성하는 중…`)
    blob = await synthesizeClonedSpeech(text, voiceId, voiceModel, signal)
  } else {
    onProgress?.('내레이션을 합성하는 중…')
    const instruction = [
      speaker?.voicePrompt?.trim(),
      `Read the narration naturally in its original language. Finish within ${shot.duration} seconds. Pause naturally at punctuation. Avoid an announcer voice or exaggerated emotion.`
    ]
      .filter(Boolean)
      .join('；')
    const result = await generateSpeech({
      text,
      voice: p.settings.ttsVoice,
      instruction,
      signal
    })
    blob = result.blob
  }
  const quality = await reviewSpeechQuality(blob, text, shot.duration)
  if (!quality.passed) throw new Error(`더빙 파일 또는 길이 검사에 실패했습니다. ${quality.issues.join(uiPunctuation.semicolon)}${uiPunctuation.sentenceSeparator}${quality.retryHint || ''}`)
  const asset = await assets.add(blob, 'audio', 'ai-generated', {
    filename: `voice_${shot.index + 1}_${Date.now().toString(36)}`,
    prompt: text,
    projectId: p.id,
    shotId: shot.id
  })
  project.assignShotAudio(shot.id, asset.id)
  await project.save()
  return asset
}

export async function generateFreeformAudio(
  nodeId: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  const node = p?.canvas?.nodes.find((n) => n.id === nodeId)
  if (!p || !node || node.type !== 'audioGen') throw new Error('오디오 노드를 찾을 수 없어요.')
  const text = spokenTextOnly(node.data.prompt || '').trim() || (node.data.prompt || '').trim()
  if (!text) throw new Error('말할 내용을 먼저 적어 주세요.')
  const model = node.data.ttsModel?.trim() || useSettingsStore().config.tts.model
  const wantsClone = modelAcceptsReferenceAudio(model)
  let blob: Blob
  if (wantsClone) {
    if (!node.data.referenceAudioAssetId && !node.data.clonedVoiceId) {
      throw new Error('이 모델에 사용할 목소리 샘플을 먼저 업로드하세요.')
    }
    let voiceId = node.data.clonedVoiceId
    let voiceModel = node.data.clonedVoiceModel || 'qwen3-tts-vc-2026-01-22'
    if (!voiceId) {
      onProgress?.('참조 음색을 복제하는 중…')
      const sample = await assets.getBlob(node.data.referenceAudioAssetId!)
      if (!sample) throw new Error('참조 오디오를 읽지 못했어요. 다시 업로드하세요.')
      const cloned = await cloneVoiceFromSample(
        sample,
        `node${nodeId.replace(/[^a-z0-9]/gi, '').slice(-10) || 'voice'}`,
        signal
      )
      voiceId = cloned.voiceId
      voiceModel = cloned.model
      project.patchCanvasNode(nodeId, { clonedVoiceId: voiceId, clonedVoiceModel: voiceModel })
      await project.save()
    }
    onProgress?.('참조 음색으로 합성하는 중…')
    blob = await synthesizeClonedSpeech(text, voiceId, voiceModel, signal)
  } else {
    onProgress?.('오디오 합성…')
    const result = await generateSpeech({
      text,
      model,
      language: 'Chinese',
      signal
    })
    blob = result.blob
  }
  const asset = await assets.add(blob, 'audio', 'ai-generated', {
    filename: `audio_${Date.now().toString(36)}`,
    prompt: text,
    projectId: p.id
  })
  project.assignCanvasNodeAsset(nodeId, asset.id)
  await project.save()
  return asset
}

/**
 * 작성한 대본을 로컬 Markdown으로 저장하고 리소스 라이브러리에 등록한다.
 * 보관에 실패하면 알림만 표시하고 생성 흐름을 유지한다.
 */
export async function archivePlayToScriptLibrary(
  project: Project,
  options: {
    mode?: 'write' | 'continue'
    prompt?: string
    onLog?: (msg: string) => void
  } = {}
): Promise<void> {
  try {
    const scripts = useScriptsStore()
    await scripts.saveFromProject(project, {
      mode: options.mode ?? 'write',
      prompt: options.prompt
    })
    options.onLog?.(translate('canvasRunner.savedScript'))
  } catch (e: any) {
    console.warn('[script-library] Could not archive screenplay', e)
    options.onLog?.(translate('canvasRunner.saveScriptFailed', { reason: e?.message ?? String(e) }))
  }
}

export async function runGeneratePlay(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  model?: string,
  opts?: { mode?: 'write' | 'continue'; hint?: string; brief?: string }
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const continueMode = opts?.mode === 'continue'
  const brief = opts?.brief?.trim()
  if (continueMode && !isPlayReady(project.current?.script)) {
    throw new Error('전체 대본을 먼저 작성한 뒤 이어 쓰세요.')
  }
  // brief는 이번 요청의 입력이다. 생성이 성공하기 전에는 기존 대본을 새 요청으로 덮어쓰지 않는다.
  const requestTopic =
    brief && !continueMode
      ? topicFromBrief(brief) || project.current?.script?.topic || project.current?.name || ''
      : project.current?.script?.topic || project.current?.name || ''
  const requestContent = brief && !continueMode ? brief : project.current?.script?.content || ''
  const requestStyle =
    (brief && !continueMode ? inferVisualStyleFromText(brief) : undefined) ||
    project.current?.script?.style ||
    'cinematic'
  if (
    !continueMode &&
    project.current?.pipelineMode === 'remake' &&
    project.current.sourceVideoAssetId &&
    !isPlayReady(project.current.script)
  ) {
    return rerunVideoRemake(onProgress, signal)
  }
  const assets = useAssetsStore()
  if (!project.current?.script) throw new Error('먼저 원고를 입력하세요.')
  const productImages: string[] = []
  for (const id of (project.current.script.referenceAssetIds ?? []).slice(0, 5)) {
    const blob = await assets.getBlob(id)
    if (!blob) continue
    try {
      productImages.push(await blobToChatImageUrl(blob))
    } catch {
      /* skip */
    }
  }
  const look = lookFromTexts(
    requestStyle,
    requestTopic,
    requestContent,
    project.current.script.keywords
  )
  if (look.matched && look.matched !== project.current.script.style) {
    onProgress?.(`사용자가 지정한 그림체를 적용했습니다. ${styleLabel(look.matched)}`)
    project.setScript({ ...project.current.script, style: look.matched })
  } else if (!look.matched && look.userNamed) {
    onProgress?.(`사용자가 지정한 그림체를 적용했습니다. ${look.medium}`)
  }
  const previousPlay = project.current.script.content || ''
  onProgress?.(continueMode ? '대본을 이어 쓰는 중…' : '전체 대본을 작성하는 중…')
  const run = await generatePlay(
    {
      topic: requestTopic,
      content: requestContent,
      style: look.style,
      shotDuration: project.current.script.shotDuration,
      maxShotDuration: videoMaxSeconds(storyboardVideoModel()),
      aspectRatio: project.current.settings.aspectRatio,
      productImages,
      keywords: project.current.script.keywords,
      targetDurationSec: resolveTargetDurationSec(project.current.script, requestTopic, requestContent),
      model: resolveLlmModel(model),
      playMode: continueMode ? 'continue' : 'write',
      continueHint: opts?.hint,
      workflowMode: project.current.script.workflowMode
    },
    onProgress,
    signal
  )
  if (!continueMode) {
    project.setShots([])
    project.setSubjects([])
    project.setScenes([])
  }
  // 이후 스토리보드 샷 수를 계산하려고 목표 영상 길이를 저장한다.
  const playTargetSec = resolveTargetDurationSec(project.current.script, requestTopic, requestContent)
  project.setScript({
    ...project.current.script,
    topic: run.result.topic || requestTopic || project.current.script.topic,
    content: run.result.playMarkdown,
    origin: continueMode ? project.current.script.origin : 'generated',
    playReady: true,
    ...(playTargetSec ? { targetDurationSec: playTargetSec } : {}),
    ...(look.matched ? { style: look.matched } : {}),
    ...(run.result.aesthetic ? { aesthetic: run.result.aesthetic } : {}),
    ...(run.result.styleBrief ? { styleBrief: run.result.styleBrief } : {}),
    ...(run.result.colorPalette ? { colorPalette: run.result.colorPalette } : {}),
    ...(run.result.lightingNote ? { lightingNote: run.result.lightingNote } : {})
  })
  project.applyPlayTitle(
    playTitleOf({
      topic: run.result.topic || project.current.script.topic,
      content: run.result.playMarkdown
    })
  )
  if (!continueMode) {
    project.setCanvas(rebuildCanvasGraph(project.current, false))
  }
  if (project.current.pipelineMode !== 'img2video') project.setPlayApproved(false)
  await project.save()
  await archivePlayToScriptLibrary(project.current, {
    mode: continueMode ? 'continue' : 'write',
    prompt: brief || opts?.hint,
    onLog: onProgress
  })
  if (continueMode) {
    const added = countAddedPlayScenes(previousPlay, run.result.playMarkdown)
    onProgress?.(
      added > 0
        ? translate('canvasRunner.continuedCount', { count: added })
        : translate('canvasRunner.updatedScript')
    )
  }
  return run
}

/** 최신 사용자 메시지부터 확인해 요청한 영상 길이를 찾는다. */
function recentUserDurationTexts(): string[] {
  const messages = useProjectStore().current?.agentState?.messages || []
  return messages
    .filter((message) => message.role === 'user' && message.content.trim())
    .slice(-8)
    .map((message) => message.content)
    .reverse()
}

/**
 * 최신 요청, 프로젝트에 저장한 목표, 대본에서 찾은 길이 순으로 적용한다.
 * 길이는 대본과 샷 수의 상한을 정한다. 찾지 못하면 undefined로 반환한다.
 */
function resolveTargetDurationSec(
  script: { targetDurationSec?: number; topic?: string; content?: string } | undefined,
  ...extraTexts: Array<string | undefined>
): number | undefined {
  const fromUser = extractTargetDurationSec(...extraTexts, ...recentUserDurationTexts())
  if (fromUser >= 10) return fromUser
  const explicit = Number(script?.targetDurationSec) || 0
  if (explicit >= 10) return explicit
  const parsed = extractTargetDurationSec(script?.topic, script?.content)
  return parsed || undefined
}

function normExtractName(name: string) {
  return String(name || '').replace(/\s+/g, '').toLowerCase()
}

function mergeByName<T extends { id: string; name: string }>(
  next: T[],
  prev: T[],
  prefix: string,
  take: (fresh: T, old: T) => T
): T[] {
  const leftover = [...prev]
  const out: T[] = []
  for (const item of next) {
    const idx = leftover.findIndex((row) => normExtractName(row.name) === normExtractName(item.name))
    if (idx >= 0) out.push(take(item, leftover.splice(idx, 1)[0]))
    else out.push(item)
  }
  const seen = new Set<string>()
  return out.map((item) => {
    if (!seen.has(item.id)) {
      seen.add(item.id)
      return item
    }
    let i = 1
    while (seen.has(`${prefix}_${i}`)) i += 1
    const id = `${prefix}_${i}`
    seen.add(id)
    return { ...item, id }
  })
}

function mergePropAssets(next: StoryProp[], prev: StoryProp[]): StoryProp[] {
  return mergeByName(next, prev, 'prop', (fresh, old) => ({
    ...fresh,
    id: old.id,
    designSheetAssetId: old.designSheetAssetId,
    designSheetHistoryIds: old.designSheetHistoryIds,
    referenceAssetIds: old.referenceAssetIds,
    sheetPrompt: old.sheetPrompt || fresh.sheetPrompt
  }))
}

function mergeSubjectAssets(next: Subject[], prev: Subject[]): Subject[] {
  return mergeByName(next, prev, 'sub', (fresh, old) => ({
    ...fresh,
    // 모델이 기본 음색만 반환하면 사용자가 이전에 입력한 음색을 유지한다.
    voicePrompt:
      fresh.voicePrompt && fresh.voicePrompt !== FALLBACK_VOICE_PROMPT
        ? fresh.voicePrompt
        : old.voicePrompt || fresh.voicePrompt,
    id: old.id,
    designSheetAssetId: old.designSheetAssetId,
    designSheetHistoryIds: old.designSheetHistoryIds,
    propSheetAssetId: old.propSheetAssetId,
    propSheetHistoryIds: old.propSheetHistoryIds,
    referenceAssetIds: old.referenceAssetIds,
    propReferenceAssetIds: old.propReferenceAssetIds
  }))
}

function mergeSceneAssets(next: Scene[], prev: Scene[]): Scene[] {
  return mergeByName(next, prev, 'scn', (fresh, old) => ({
    ...fresh,
    id: old.id,
    plateAssetId: old.plateAssetId,
    plateHistoryIds: old.plateHistoryIds,
    propSheetAssetId: old.propSheetAssetId,
    propSheetHistoryIds: old.propSheetHistoryIds,
    referenceAssetIds: old.referenceAssetIds,
    propReferenceAssetIds: old.propReferenceAssetIds
  }))
}

function mergeShotAssets(next: Shot[], prev: Shot[]): Shot[] {
  return next.map((shot, i) => {
    const old = prev[i]
    if (!old) return shot
    return {
      ...shot,
      id: old.id,
      boardAssetId: old.boardAssetId,
      boardHistoryIds: old.boardHistoryIds,
      imageAssetId: old.imageAssetId,
      videoAssetId: old.videoAssetId,
      audioAssetId: old.audioAssetId,
      imageHistoryIds: old.imageHistoryIds,
      videoHistoryIds: old.videoHistoryIds,
      audioHistoryIds: old.audioHistoryIds,
      referenceAssetIds: old.referenceAssetIds,
      captionOverride: old.captionOverride,
      notes: old.notes,
      status: old.videoAssetId ? 'video-generated' : old.imageAssetId ? 'image-generated' : shot.status
    }
  })
}

/** 완성 대본에서 캐릭터, 장면과 스토리보드를 추출한다. 일부만 다시 추출해도 기존 생성물은 이름이나 샷 번호로 유지한다. */
export async function runExtractStoryboard(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  model?: string,
  stage?: ExtractStage
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current?.script) throw new Error('먼저 원고를 입력하세요.')
  if (!isPlayReady(project.current.script) && !project.current.script.content?.trim()) {
    throw new Error('전체 대본을 작성한 뒤 노드를 추출하세요.')
  }
  const existingSubjects = project.current.subjects ?? []
  const existingScenes = project.current.scenes ?? []
  const extractStartAt = stage || nextExtractStage(project.current)
  if (!extractStartAt) {
    throw new Error('캐릭터, 장면, 스토리보드를 모두 추출했습니다. 특정 그룹을 바꾸려면 해당 그룹에서 ‘다시 추출’을 선택하세요.')
  }
  if (extractStartAt === 'shots' && !existingSubjects.length) {
    throw new Error('캐릭터를 먼저 추출한 뒤 스토리보드를 만드세요.')
  }
  if (extractStartAt === 'shots' && !existingScenes.length) {
    throw new Error('장면의 기준 정보를 먼저 추출한 뒤 스토리보드를 만드세요.')
  }
  const productImages: string[] = []
  for (const id of (project.current.script.referenceAssetIds ?? []).slice(0, 5)) {
    const blob = await assets.getBlob(id)
    if (!blob) continue
    try {
      productImages.push(await blobToChatImageUrl(blob))
    } catch {
      /* skip */
    }
  }
  const look = lookFromScript(project.current.script)
  const keepApproved = Boolean(stage && isPlayApproved(project.current))
  // 같은 대본에서 다시 실행할 때 완료한 작업 그룹의 결과를 재사용한다.
  const playKey = `shot-plan-v4:${scriptPlayKey(project.current.script.content || '')}:${resolveTargetDurationSec(project.current.script) || 0}:${videoMaxSeconds(storyboardVideoModel())}`
  const savedBatches = project.current.script.shotBatches
  const resumeBatches: Array<Record<string, unknown>[] | undefined> | undefined =
    savedBatches?.playKey === playKey
      ? Array.from({ length: 64 }, (_, i) => {
          const rows = savedBatches.batches[String(i)]
          return Array.isArray(rows)
            ? (rows.filter((row) => row && typeof row === 'object') as unknown as Record<string, unknown>[])
            : undefined
        })
      : undefined
  const resumeCount = resumeBatches
    ? Object.values(resumeBatches).filter((rows) => Array.isArray(rows) && rows.length).length
    : 0
  onProgress?.(
    extractStartAt === 'subjects'
      ? `${stage ? '캐릭터를 다시 추출하고 있어요.' : '캐릭터를 먼저 추출하고 있어요.'} 기존 장면과 스토리보드는 유지돼요…`
      : extractStartAt === 'scenes'
        ? `${stage ? '장면 기준물을 다시 추출하고 있어요.' : '캐릭터를 저장했고 장면을 추출하고 있어요.'} 기존 캐릭터와 스토리보드는 유지돼요…`
        : resumeCount
          ? `${stage ? '스토리보드를 다시 추출하고 있어요.' : '스토리보드를 계속 추출하고 있어요.'} 완료한 작업 그룹 ${resumeCount}개의 결과를 재사용해요…`
          : `${stage ? '스토리보드를 다시 추출하고 있어요.' : '캐릭터와 장면을 저장했고 스토리보드를 추출하고 있어요.'} 기존 개요판, 샷 이미지, 영상은 샷 번호별로 유지돼요…`
  )
  let finalStagePersisted = false
  const persistStage = async (
    done: ExtractStage,
    partial: import('@/services/ai/storyboard').StoryboardResult,
    meta?: { partial?: boolean; completed?: number; total?: number }
  ) => {
    if (!project.current) return
    if (done === 'subjects') {
      project.setSubjects(mergeSubjectAssets(partial.subjects ?? [], project.current.subjects ?? []))
      if (Array.isArray(partial.props)) {
        project.setProps(mergePropAssets(partial.props, project.current.props ?? []))
      }
    } else if (done === 'scenes') {
      project.setScenes(mergeSceneAssets(partial.scenes ?? [], project.current.scenes ?? []))
      if (project.current.script) {
        const script = { ...project.current.script }
        applyAestheticToScript(script, partial)
        project.setScript(script)
      }
    } else {
      finalStagePersisted = !meta?.partial
      const stageShots = storyboardToShots(partial)
      if (project.current.pipelineMode === 'remake') {
        for (const shot of stageShots) shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
      }
      // 스토리보드만 다시 추출하면 전체 캐릭터 정보가 없어 프로젝트 카드의 음색을 다시 연결한다.
      const voiceBound = bindShotVoiceHints(stageShots, project.current.subjects ?? [])
      if (voiceBound) {
        onProgress?.(`✓ 샷 ${voiceBound}개의 화자 음색을 캐릭터 카드에 연결했습니다.`)
      }
      project.setShots(mergeShotAssets(stageShots, project.current.shots))
      rebindShotScenes()
    }
    project.setCanvas(rebuildCanvasGraph(project.current, true))
    const landed =
      done === 'subjects'
        ? translate('canvasRunner.subjectsAdded', { characters: project.current.subjects?.length || 0, props: project.current.props?.length || 0 })
        : done === 'scenes'
          ? translate('canvasRunner.scenesAdded', { count: project.current.scenes?.length || 0 })
          : meta?.partial
            ? translate('canvasRunner.partialShotsAdded', { current: meta.completed || 0, total: meta.total || 0, count: project.current.shots.length })
            : translate('canvasRunner.shotsAdded', { count: project.current.shots.length })
    onProgress?.(landed)
    await project.save()
  }
  const run = await generateStoryboard(
    {
      topic: project.current.script.topic,
      content: project.current.script.content,
      style: look.style,
      shotDuration: project.current.script.shotDuration,
      maxShotDuration: videoMaxSeconds(storyboardVideoModel()),
      aspectRatio: project.current.settings.aspectRatio,
      productImages,
      keywords: project.current.script.keywords,
      targetDurationSec: resolveTargetDurationSec(project.current.script),
      mode: 'extract',
      model: resolveLlmModel(model),
      extractStartAt,
      extractStopAfter: extractStartAt,
      existingSubjects,
      existingScenes,
      workflowMode: project.current.script.workflowMode,
      verbatim: project.current.script.origin === 'imported',
      resumeBatchShots: resumeBatches,
      onBatchDone: (index, rows) => {
        if (!project.current?.script) return
        const script = { ...project.current.script }
        script.shotBatches = {
          playKey,
          batches: {
            ...(script.shotBatches?.playKey === playKey ? script.shotBatches.batches : {}),
            [index]: rows
          }
        }
        project.setScript(script)
      },
      onExtractStage: persistStage
    },
    onProgress,
    signal
  )
  if (extractStartAt === 'shots' && !finalStagePersisted) {
    const shots = storyboardToShots(run.result)
    if (project.current.pipelineMode === 'remake') {
      for (const shot of shots) shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
    }
    project.setShots(mergeShotAssets(shots, project.current.shots))
    rebindShotScenes()
  }
  if (project.current.script) {
    const durationSec = resolveTargetDurationSec(project.current.script, ...recentUserDurationTexts())
    project.setScript({
      ...project.current.script,
      playReady: true,
      // 모든 그룹을 저장했으면 다음 수정에 영향을 주지 않도록 재개 지점을 삭제한다.
      shotBatches: undefined,
      ...(durationSec ? { targetDurationSec: durationSec } : {}),
      ...(look.matched ? { style: look.matched } : {}),
      ...(run.result.aesthetic ? { aesthetic: run.result.aesthetic } : {}),
      ...(run.result.h3Aesthetic ? { h3Aesthetic: run.result.h3Aesthetic } : {}),
      ...(run.result.styleBrief ? { styleBrief: run.result.styleBrief } : {}),
      ...(run.result.colorPalette ? { colorPalette: run.result.colorPalette } : {}),
      ...(run.result.lightingNote ? { lightingNote: run.result.lightingNote } : {})
    })
  }
  if (!finalStagePersisted || extractStartAt !== 'shots') {
    project.setCanvas(rebuildCanvasGraph(project.current, true))
  }
  if (!keepApproved) project.setPlayApproved(false)
  if (project.dirty) await project.save()
  return run
}

const GROUP_GEN_TYPES = new Set([
  'subject',
  'prop',
  'scene',
  'shotBoard',
  'shotImage',
  'shotFrames',
  'sceneProps',
  'shotVideo'
])
const IMAGE_GEN_CONCURRENCY = 3

export function groupGenerateJobId(groupId: string) {
  return `${groupId}:gen`
}

function groupChildNodeIds(groupId: string): string[] {
  const nodes = useProjectStore().current?.canvas?.nodes ?? []
  return nodes.filter((n) => n.parentGroupId === groupId && GROUP_GEN_TYPES.has(n.type)).map((n) => n.id)
}

/** 그룹의 한 번에 생성 작업으로 해당 그룹의 모든 생성 노드를 실행한다. */
export async function runGenerateGroup(
  groupId: string,
  onProgress?: RunProgress,
  signal?: AbortSignal
) {
  if (
    groupId !== 'group-subjects' &&
    groupId !== 'group-props' &&
    groupId !== 'group-scenes' &&
    groupId !== 'group-shots' &&
    groupId !== 'group-frames' &&
    groupId !== 'group-videos'
  ) {
    throw new Error('이 그룹은 일괄 생성을 지원하지 않습니다.')
  }
  const project = useProjectStore()
  const p = project.current
  if (!p?.canvas) throw new Error('캔버스가 비어 있습니다.')
  // 대본 승인 확인은 샷과 영상에만 적용한다. 캐릭터와 장면 에셋은 먼저 생성할 수 있다.
  if (
    (groupId === 'group-shots' || groupId === 'group-frames' || groupId === 'group-videos') &&
    !isPlayApproved(p)
  ) {
    throw new Error(playGateMessage())
  }
  const ids = groupChildNodeIds(groupId)
  if (!ids.length) throw new Error('이 그룹에 생성할 수 있는 노드가 없습니다.')
  const pending = ids.filter((id) => !isNodeRunning(id))
  if (!pending.length) throw new Error('이 그룹을 이미 생성하고 있습니다.')
  return withNodeJob(groupGenerateJobId(groupId), async () => {
    ensureNotCancelled(signal)
    const source = onProgress ? 'agent' : 'canvas'
    const noun =
      groupId === 'group-subjects'
        ? translate('canvasRunner.characterViews')
        : groupId === 'group-props'
          ? translate('canvasRunner.propViews')
        : groupId === 'group-scenes'
          ? translate('canvasRunner.sceneAnchor')
          : groupId === 'group-videos'
            ? translate('canvasRunner.shotVideo')
            : groupId === 'group-frames'
              ? translate('canvasRunner.firstLast')
              : translate('canvasRunner.shotKeyframe')
    const activity = trackActivity(groupId, translate('canvasRunner.batchGenerate', { name: noun }), source, (msg) => onProgress?.(groupId, msg))
    try {
      // 시작·끝 프레임 모드의 일괄 영상 생성은 누락된 프레임을 먼저 생성한다.
      // 이 단계를 건너뛰면 영상 생성에 두 프레임이 전달되지 않는다.
      if (groupId === 'group-videos') {
        await ensureShotFrames((msg) => onProgress?.(groupId, msg), signal)
      }
      // 다음 두 작업은 순차 실행한다.
      // 1. 프레임 연결 영상 생성에서는 다음 샷이 이전 영상의 끝 프레임을 사용한다.
      // 2. 시작·끝 프레임 생성에서는 현재 시작 프레임에 이전 끝 프레임을 참고한다.
      const chain =
        groupId === 'group-frames' || (groupId === 'group-videos' && isFl2vaChainActive(p))
      const ordered = chain ? sortNodeIdsByShotIndex(p, pending) : pending
      activity.progress(
        groupId === 'group-frames'
          ? translate('canvasRunner.batchFrames', { count: ordered.length })
          : chain
            ? translate('canvasRunner.batchChain', { count: ordered.length })
            : translate('canvasRunner.batchParallel', { count: ordered.length })
      )
      await mapPool(
        ordered,
        chain ? 1 : groupId === 'group-videos' ? VIDEO_GEN_CONCURRENCY : IMAGE_GEN_CONCURRENCY,
        (id) => runCanvasNode(id, (nid, msg) => onProgress?.(nid, msg), signal)
      )
      activity.done(chain ? translate('canvasRunner.batchOrderedDone', { name: noun }) : translate('canvasRunner.batchSubmitted', { name: noun }))
    } catch (e: any) {
      activity.fail(e)
      throw e
    }
  })
}

/** 다시 추출은 선택한 그룹만 갱신하고 나머지 그룹을 유지한다. */
export async function runExtractGroup(
  groupId: string,
  onProgress?: RunProgress,
  signal?: AbortSignal,
  model?: string
) {
  const stage: ExtractStage | undefined =
    groupId === 'group-subjects'
      ? 'subjects'
      : groupId === 'group-scenes'
        ? 'scenes'
        : groupId === 'group-shots' || groupId === 'group-videos'
          ? 'shots'
          : undefined
  if (!stage) throw new Error('이 그룹은 다시 추출할 수 없습니다.')
  return withNodeJob(groupId, async () => {
    ensureNotCancelled(signal)
    const project = useProjectStore()
    const source = onProgress ? 'agent' : 'canvas'
    const label = translate('canvasRunner.extractAgain', { stage: extractStageNoun(stage) })
    const activity = trackActivity(groupId, label, source, (msg) => onProgress?.(groupId, msg))
    patchNode(project, groupId, 'running')
    try {
      await runExtractStoryboard(activity.progress, signal, model, stage)
      patchNode(project, groupId, 'success')
      activity.done(translate('canvasRunner.extractionUpdated', { stage: extractStageNoun(stage) }))
    } catch (e: any) {
      patchNode(project, groupId, 'failed', e?.message ?? String(e))
      activity.fail(e)
      throw e
    }
  })
}

/** 대본 노드는 기본으로 대본만 쓴다. 노드를 추출하려면 extract를 지정한다. */
export async function runScriptNode(
  kind: 'play' | 'extract' | 'continue' = 'play',
  onProgress?: RunProgress,
  signal?: AbortSignal,
  model?: string,
  continueHint?: string,
  extractStage?: ExtractStage
) {
  return withNodeJob('script', async () => {
    ensureNotCancelled(signal)
    const project = useProjectStore()
    const source = onProgress ? 'agent' : 'canvas'
    const label = scriptActivityLabel(kind, extractStage)
    const activity = trackActivity('script', label, source, (msg) => onProgress?.('script', msg))
    patchNode(project, 'script', 'running')
    try {
      if (kind === 'extract') {
        await runExtractStoryboard(activity.progress, signal, model, extractStage)
      } else if (kind === 'continue') {
        await runGeneratePlay(activity.progress, signal, model, { mode: 'continue', hint: continueHint })
      } else {
        await runGeneratePlay(activity.progress, signal, model)
      }
      patchNode(project, 'script', 'success')
      activity.done(
        kind === 'extract'
          ? translate('canvasRunner.canvasWritten', { label: label })
          : kind === 'continue'
            ? translate('canvasRunner.continuedSaved')
            : translate('canvasRunner.scriptWritten')
      )
    } catch (e: any) {
      patchNode(project, 'script', 'failed', e?.message ?? String(e))
      activity.fail(e)
      throw e
    }
  })
}

/** @deprecated 이전 이름과 호환하기 위해 대본 작성만 실행한다. */
export async function runStoryboard(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  return runGeneratePlay(onProgress, signal)
}

/** 영상 재현은 참조 영상과 제품 이미지를 저장하고 샷을 분석해 대본과 노드를 만든다. */
export async function runVideoRemake(
  input: {
    videoFile: File | Blob
    productFiles?: File[]
    productIds?: string[]
    skipSaveAssets?: boolean
    onProgress?: (msg: string) => void
    signal?: AbortSignal
  }
) {
  ensureNotCancelled(input.signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('열려 있는 프로젝트가 없습니다.')
  if (!input.videoFile) throw new Error('재현할 참조 영상을 업로드하세요.')

  project.current.pipelineMode = 'remake'
  const topic = project.current.script?.topic?.trim() || translate('canvasRunner.remake')
  let productIds = [...(input.productIds ?? [])]

  if (!input.skipSaveAssets) {
    if (!input.productFiles?.length) throw new Error('영상 재현에는 제품 이미지가 한 장 이상 필요합니다.')
    input.onProgress?.('참조 영상을 저장하는 중…')
    const videoAsset = await assets.add(input.videoFile, 'video', 'uploaded', {
      filename:
        (input.videoFile instanceof File && input.videoFile.name) ||
        `remake_source_${Date.now().toString(36)}`,
      projectId: project.current.id
    })
    project.current.sourceVideoAssetId = videoAsset.id

    input.onProgress?.('제품 이미지를 저장하는 중…')
    productIds = []
    for (const file of input.productFiles.slice(0, 8)) {
      const asset = await assets.add(file, 'image', 'uploaded', {
        filename: file.name || `product_${Date.now().toString(36)}`,
        projectId: project.current.id
      })
      productIds.push(asset.id)
    }
  }

  if (!productIds.length) throw new Error('영상 재현에는 제품 이미지가 한 장 이상 필요합니다.')
  if (!project.current.script) throw new Error('먼저 프로젝트 주제를 입력하세요.')

  project.setScript({
    ...project.current.script,
    topic,
    referenceAssetIds: productIds,
    playReady: false
  })
  await project.save()

  try {
    input.onProgress?.('참조 영상을 분석하는 중…')
    const analysis = await analyzeRemakeVideo({
      videoBlob: input.videoFile,
      topic,
      aspectRatio: project.current.settings.aspectRatio,
      style: project.current.script.style,
      productCount: productIds.length,
      signal: input.signal,
      onProgress: input.onProgress
    })
    const shots = remakeShotsFromAnalysis(analysis)
    for (const shot of shots) {
      shot.referenceAssetIds = productIds
      shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
    }
    project.setShots(shots)
    project.setSubjects(analysis.result.subjects ?? [])
    project.setScenes(analysis.result.scenes ?? [])
    rebindShotScenes()
    project.setScript({
      ...project.current.script,
      topic: analysis.topic || topic,
      content: analysis.playMarkdown,
      playReady: true,
      ...(analysis.aesthetic ? { aesthetic: analysis.aesthetic } : {}),
      ...(analysis.result.h3Aesthetic ? { h3Aesthetic: analysis.result.h3Aesthetic } : {}),
      ...(analysis.result.styleBrief ? { styleBrief: analysis.result.styleBrief } : {}),
      ...(analysis.result.colorPalette ? { colorPalette: analysis.result.colorPalette } : {}),
      ...(analysis.result.lightingNote ? { lightingNote: analysis.result.lightingNote } : {})
    })
    project.applyPlayTitle(
      playTitleOf({
        topic: analysis.topic || topic,
        content: analysis.playMarkdown
      })
    )
    project.setCanvas(rebuildCanvasGraph(project.current, false))
    project.setPlayApproved(false)
    await project.save()
    return analysis
  } catch (e) {
    await project.save()
    throw e
  }
}

/** 프로젝트에 저장된 참조 영상과 제품 이미지로 다시 분석한다. */
export async function rerunVideoRemake(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current?.sourceVideoAssetId) {
    throw new Error('참조 영상이 없습니다. 영상 재현 프로젝트를 다시 만드세요.')
  }
  const videoBlob = await assets.getBlob(project.current.sourceVideoAssetId)
  if (!videoBlob) throw new Error('참조 영상을 읽지 못했습니다.')
  const productIds = [...(project.current.script?.referenceAssetIds ?? [])]
  if (!productIds.length) throw new Error('제품 이미지를 업로드한 뒤 분석하세요.')
  return runVideoRemake({
    videoFile: videoBlob,
    productIds,
    skipSaveAssets: true,
    onProgress,
    signal
  })
}

export async function generateFreeformImage(
  nodeId: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  if (!p) throw new Error('열려 있는 프로젝트가 없습니다.')
  const node = p.canvas?.nodes.find((n) => n.id === nodeId)
  if (!node) throw new Error('노드를 찾을 수 없습니다.')
  const prompt = node.data.prompt ?? ''
  if (!prompt.trim()) throw new Error('먼저 프롬프트를 작성하세요.')
  onProgress?.('참조 이미지를 준비하는 중…')
  const library = useLibraryStore()
  const blobs: Blob[] = []
  for (const id of resolvedCanvasReferenceAssetIds(p, node)) {
    const b = (await assets.getBlob(id)) || (await library.getBlob(id))
    if (b) blobs.push(b)
  }
  const look = lookFromScript(p.script)
  const aspectRatio = canvasNodeAspect(node, p.settings.aspectRatio)
  const size = imageGenSize('shot', aspectRatio)
  onProgress?.('이미지를 생성하는 중…')
  const result = await generateImage({
    prompt,
    style: look.style,
    width: size.width,
    height: size.height,
    aspectRatio,
    resolution: docImageResolution(node),
    referenceImages: blobs.length ? blobs : undefined,
    model: imageModelForProject(p.pipelineMode),
    signal
  }, onProgress)
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `${node.data.label || translate('canvasRunner.image')}.png`,
    prompt,
    projectId: p.id
  })
  await saveGeneratedImageToSharedLibrary(result.blob, 'other', asset.filename, prompt, onProgress)
  project.patchCanvasNode(nodeId, { outputAssetId: asset.id })
  await project.save()
  return asset
}

export async function generateFreeformVideo(
  nodeId: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  if (!p) throw new Error('열려 있는 프로젝트가 없습니다.')
  const node = p.canvas?.nodes.find((n) => n.id === nodeId)
  if (!node) throw new Error('노드를 찾을 수 없습니다.')
  const prompt = node.data.prompt ?? ''
  const profile = videoProfileById(node.data.videoProfileId)
  const resumingLtx = isLtxTask(node.data.videoTaskId)
  if (resumingLtx || (normalizeVideoGenModel(node.data.videoModel) === 'h3' && isLtxProfile(profile))) {
    const ids = resolvedCanvasReferenceAssetIds(p, node)
    const aspectRatio = canvasNodeAspect(node, p.settings.aspectRatio)
    const result = await generateVideo({
      prompt,
      imageBlob: resumingLtx ? undefined : await tryLoadRefImageBlob(node.data.firstFrameAssetId || ids[0]),
      lastFrameBlob: resumingLtx ? undefined : await tryLoadRefImageBlob(node.data.lastFrameAssetId),
      duration: node.data.duration ?? 8,
      ...aspectToSize(aspectRatio),
      aspectRatio,
      videoProfileId: node.data.videoProfileId || profile?.id,
      videoResolution: node.data.videoResolution ?? p.settings.defaultVideoResolution,
      generateAudio: node.data.generateAudio,
      signal,
      resumeTaskId: node.data.videoTaskId,
      onTaskSubmitted: async (videoTaskId) => {
        if (project.current?.id !== p.id) return
        project.patchCanvasNode(nodeId, { videoTaskId, videoProfileId: profile?.id })
        await project.save()
      },
      onTaskTerminalFailure: async () => {
        if (project.current?.id !== p.id) return
        project.patchCanvasNode(nodeId, { videoTaskId: undefined })
        await project.save()
      }
    }, onProgress)
    ensureNotCancelled(signal)
    if (project.current?.id !== p.id) throw new DOMException(translate('ltx.projectChanged'), 'AbortError')
    if (p.folderPath) setActiveProjectDir(p.folderPath)
    const asset = await assets.add(result.blob, 'video', 'ai-generated', {
      filename: `${node.data.label || translate('canvasRunner.video')}.mp4`,
      prompt: result.prompt,
      projectId: p.id
    })
    if (project.current?.id === p.id) {
      project.patchCanvasNode(nodeId, { outputAssetId: asset.id, videoTaskId: undefined })
      await project.save()
    }
    return asset
  }
  if (!prompt.trim()) throw new Error('먼저 프롬프트를 작성하세요.')
  const ids = resolvedCanvasReferenceAssetIds(p, node)
  const videoModel = normalizeVideoGenModel(node.data.videoModel)
  const useFl2va = isH3VideoFamily(videoModel) && normalizeH3GenMode(node.data.h3GenMode) === 'fl2va'
  const requireLast = videoProfileById(node.data.videoProfileId)?.options?.lastFrameRequired === true
  const firstId = node.data.firstFrameAssetId || ids[0]
  const lastId = node.data.lastFrameAssetId || ids[1]
  if (useFl2va) {
    if (!firstId) throw new Error('먼저 시작 프레임을 선택하세요.')
    if (!lastId && requireLast) throw new Error('먼저 끝 프레임을 선택하세요.')
  } else if (!ids.length) {
    throw new Error('먼저 참조 이미지를 한 장 이상 선택하세요.')
  }
  onProgress?.(useFl2va && lastId ? '시작·끝 프레임을 읽는 중…' : '참조 이미지를 읽는 중…')
  const library = useLibraryStore()
  const blobs: Blob[] = []
  if (useFl2va) {
    blobs.push(await loadRefImageBlob(firstId, translate('canvasRunner.firstFrameShort')))
    if (lastId) blobs.push(await loadRefImageBlob(lastId, translate('canvasRunner.lastFrameShort')))
  } else {
    for (const id of ids) {
      const b = (await assets.getBlob(id)) || (await library.getBlob(id))
      if (!b) throw new Error(`참조 이미지 ${blobs.length + 1}번을 읽지 못했어요. 다시 추가한 뒤 생성하세요.`)
      blobs.push(b)
    }
  }
  if (p.folderPath) setActiveProjectDir(p.folderPath)
  const duration = clampVideoDuration(node.data.duration, videoModel, 8)
  const aspectRatio = canvasNodeAspect(node, p.settings.aspectRatio)
  const videoSize = aspectToSize(aspectRatio)
  const slotEntries = canvasReferenceSlotEntries(p, node)
  const imageSlots = buildH3ImageSlots(
    slotEntries.length
      ? slotEntries
      : blobs.map((_, i) => ({ kind: 'extra' as const, name: `reference ${i + 1}` }))
  )
  onProgress?.(`영상을 생성하는 중(참조 이미지 ${blobs.length}장)…`)
  // 자유 이미지→영상 노드는 입력란의 프롬프트를 수정 없이 사용한다.
  const sendPrompt = prompt
  const result = await generateVideo(
    {
      prompt: sendPrompt,
      promptAsIs: true,
      imageBlob: blobs[0],
      referenceImages: useFl2va ? [] : blobs.slice(1, videoMaxRefImages(videoModel)),
      lastFrameBlob: useFl2va && blobs[1] ? blobs[1] : undefined,
      generateAudio: docGenerateAudio(node.data.videoProfileId, node.data.generateAudio),
      imageSlots,
      duration,
      width: videoSize.width,
      height: videoSize.height,
      aspectRatio,
      voiceMode: 'none',
      promptStyle: 'scene-narrative',
      videoModel,
      videoProfileId: node.data.videoProfileId,
      videoResolution: node.data.videoResolution ?? p.settings.defaultVideoResolution,
      h3GenMode: useFl2va && blobs[1] ? 'fl2va' : 'reference',
      mode: 'R2VA',
      signal,
      resumeTaskId: node.data.videoTaskId,
      onTaskSubmitted: async (taskId) => {
        project.patchCanvasNode(nodeId, { videoTaskId: taskId })
        await project.save()
      }
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'video', 'ai-generated', {
    filename: `${node.data.label || translate('canvasRunner.video')}.mp4`,
    prompt: result.prompt,
    projectId: p.id
  })
  project.patchCanvasNode(nodeId, { outputAssetId: asset.id, videoTaskId: undefined })
  onProgress?.('노드에 영상을 저장했습니다.')
  await project.save()
  return asset
}

export async function optimizeFreeformVideoPrompt(nodeId: string, signal?: AbortSignal): Promise<string> {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const p = project.current
  if (!p) throw new Error('열려 있는 프로젝트가 없습니다.')
  const node = p.canvas?.nodes.find((n) => n.id === nodeId)
  if (!node || node.type !== 'videoGen') throw new Error('이미지→영상 노드를 찾을 수 없습니다.')
  const source = (node.data.prompt || '').trim()
  if (!source) throw new Error('먼저 프롬프트를 작성하세요.')
  const slotEntries = canvasReferenceSlotEntries(p, node)
  const videoModel = normalizeVideoGenModel(node.data.videoModel)
  const profile = videoProfileById(node.data.videoProfileId)
  let compiled: string
  if (await resolveH3PromptProfile(profile, videoModel, signal)) {
    const imageSlots = buildH3ImageSlots(slotEntries)
    const sceneSlot = slotEntries.find((entry) => entry.kind === 'scene')
    compiled = await compileH3NodePrompt({
      source,
      referenceIds: resolvedCanvasReferenceAssetIds(p, node),
      imageSlots,
      duration: clampVideoDuration(node.data.duration, videoModel, 8),
      aspectRatio: canvasNodeAspect(node, p.settings.aspectRatio),
      mode: normalizeH3GenMode(node.data.h3GenMode) === 'fl2va' ? 'FL2VA' : 'R2VA',
      aesthetic: p.script?.visualStyleOverride || p.script?.h3Aesthetic || p.script?.aesthetic,
      sceneName: sceneSlot?.name,
      signal
    })
  } else {
    const pictures = slotEntries
      .map((entry, index) => `Picture ${index + 1}: ${entry.name || 'Reference image'}`)
      .join('\n')
    compiled = await rewritePromptText({ source, pictures, modelName: videoModel === 'wan-prime' ? 'Wan 3.0 Prime' : [profile?.name, profile?.workflowId].filter(Boolean).join(' / '), duration: clampVideoDuration(node.data.duration, videoModel, 8), aspectRatio: canvasNodeAspect(node, p.settings.aspectRatio), signal })
    compiled = withVideoReferenceBlock(compiled, slotEntries)
  }
  const currentNode = project.current?.canvas?.nodes.find((item) => item.id === nodeId)
  const currentProfile = videoProfileById(currentNode?.data.videoProfileId)
  if (!currentNode || currentProfile?.id !== profile?.id || currentProfile?.workflowId !== profile?.workflowId || normalizeVideoGenModel(currentNode.data.videoModel) !== videoModel) {
    throw new Error('최적화 중 영상 모델이 바뀌었어요. 다시 최적화하세요.')
  }
  if ((currentNode.data.prompt || '').trim() !== source || JSON.stringify(canvasReferenceSlotEntries(project.current!, currentNode)) !== JSON.stringify(slotEntries)) {
    throw new Error('최적화 중 프롬프트나 참조 이미지가 바뀌었어요. 다시 최적화하세요.')
  }
  project.setCanvasNodePrompt(nodeId, compiled)
  await project.save()
  return compiled
}

const ltxNodeWaits = new Map<string, AbortController>()
const drawThingsNodeWaits = new Map<string, AbortController>()

export function canStopDrawThingsNodeWait(nodeId: string) {
  return isNodeRunning(nodeId) && drawThingsNodeWaits.has(nodeId)
}

export function stopDrawThingsNodeWait(nodeId: string) {
  drawThingsNodeWaits.get(nodeId)?.abort(new DOMException(translate('drawThings.cancelled'), 'AbortError'))
}

export function stopLtxNodeWait(nodeId: string) {
  ltxNodeWaits.get(nodeId)?.abort(new DOMException(translate('ltx.stopped'), 'AbortError'))
}

export async function runCanvasNode(
  nodeId: string,
  onProgress?: RunProgress,
  signal?: AbortSignal,
  opts?: NodeRunOpts
) {
  const current = useProjectStore().current
  const drawThings = useSettingsStore().config.image.provider === DRAW_THINGS_PROVIDER
  const captureNode = current?.canvas?.nodes.find((node) => node.id === nodeId && node.data.captureId)
  if (captureNode) {
    const { runCaptureNode } = await import('@/services/continuous/capture')
    const ltx = captureNode.type === 'videoGen' &&
      (isLtxTask(captureNode.data.videoTaskId) ||
        (normalizeVideoGenModel(captureNode.data.videoModel) === 'h3' &&
          isLtxProfile(videoProfileById(captureNode.data.videoProfileId || current?.continuousCapture?.profileId))))
    const drawThingsImage = drawThings && captureNode.type === 'imageGen'
    if ((!ltx && !drawThingsImage) || isNodeRunning(nodeId)) {
      return runCaptureNode(nodeId, msg => onProgress?.(nodeId, msg), signal, { manual: true })
    }
    const controller = new AbortController()
    const waits = drawThingsImage ? drawThingsNodeWaits : ltxNodeWaits
    waits.set(nodeId, controller)
    try {
      return await runCaptureNode(nodeId, msg => onProgress?.(nodeId, msg),
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, { manual: true })
    } finally {
      waits.delete(nodeId)
    }
  }
  return withNodeJob(nodeId, async () => {
    pendingRun = { hd: Boolean(opts?.hd) }
    ensureNotCancelled(signal)
    const project = useProjectStore()
    const p = project.current
    if (!p?.canvas) throw new Error('캔버스가 비어 있습니다.')
    const node = p.canvas.nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error('노드를 찾을 수 없습니다.')
    const source = onProgress ? 'agent' : 'canvas'
    const label = nodeActivityLabel(node, p)
    const activity = trackActivity(nodeId, label, source, (msg) => onProgress?.(nodeId, msg))
    const report = activity.progress
    if (
      node.type !== 'script' &&
      node.type !== 'export' &&
      node.type !== 'final' &&
      node.type !== 'imageGen' &&
      node.type !== 'videoGen' &&
      node.type !== 'audioGen' &&
      node.type !== 'subject' &&
      node.type !== 'prop' &&
      node.type !== 'scene' &&
      node.type !== 'sceneProps' &&
      !isPlayApproved(p)
    ) {
      throw new Error(playGateMessage())
    }
    const shot = node.type === 'shotVideo' ? p.shots.find((item) => item.id === node.data.shotId) : undefined
    const profile = videoProfileById(node.data.videoProfileId || shot?.videoProfileId)
    const ltx = (node.type === 'videoGen' || node.type === 'shotVideo') &&
      ([node.data.videoTaskId, shot?.videoTaskId].some(isLtxTask) ||
        (normalizeVideoGenModel(node.data.videoModel) === 'h3' && isLtxProfile(profile)))
    const drawThingsImage = drawThings && canvasNodeProducesImage(node)
    const local = ltx || drawThingsImage ? new AbortController() : undefined
    const waits = drawThingsImage ? drawThingsNodeWaits : ltxNodeWaits
    if (local) {
      waits.set(nodeId, local)
      signal = signal ? AbortSignal.any([signal, local.signal]) : local.signal
    }
    patchNode(project, nodeId, 'running')
    if (node.type === 'export' || node.type === 'final') {
      patchNode(project, node.type === 'export' ? 'final' : 'export', 'running')
    }
    try {
      if (node.type === 'script') {
        await runGeneratePlay(report, signal)
      } else if (node.type === 'subject' && node.data.subjectId) {
        const sub = (p.subjects ?? []).find((s) => s.id === node.data.subjectId)
        if (!sub) throw new Error('캐릭터를 찾을 수 없습니다.')
        await generateSubjectSheet(sub, report, signal)
      } else if (node.type === 'prop' && node.data.propId) {
        const prop = (p.props ?? []).find((item) => item.id === node.data.propId)
        if (!prop) throw new Error('소품을 찾을 수 없습니다.')
        await generatePropSheet(prop, report, signal)
      } else if (node.type === 'sceneProps' && node.data.sceneId) {
        const scn = (p.scenes ?? []).find((s) => s.id === node.data.sceneId)
        if (!scn) throw new Error('장면을 찾을 수 없습니다.')
        await generateScenePropSheet(scn, report, signal)
      } else if (node.type === 'shotBoard' && node.data.shotId) {
        const shot = p.shots.find((s) => s.id === node.data.shotId)
        if (!shot) throw new Error('스토리보드 샷을 찾을 수 없습니다.')
        await generateShotBoard(shot, report, signal)
      } else if (node.type === 'scene' && node.data.sceneId) {
        const scn = (p.scenes ?? []).find((s) => s.id === node.data.sceneId)
        if (!scn) throw new Error('장면을 찾을 수 없습니다.')
        await generateScenePlate(scn, report, signal)
      } else if (node.type === 'shotImage' && node.data.shotId) {
        const shot = p.shots.find((s) => s.id === node.data.shotId)
        if (!shot) throw new Error('스토리보드 샷을 찾을 수 없습니다.')
        await generateShotImage(shot, report, signal)
      } else if (node.type === 'shotFrames' && node.data.shotId) {
        const shot = project.current?.shots.find((s) => s.id === node.data.shotId)
        if (!shot) throw new Error('스토리보드 샷을 찾을 수 없습니다.')
        await generateShotFramePair(shot, report, signal)
      } else if (node.type === 'shotVideo' && node.data.shotId) {
        const shot = project.current?.shots.find((s) => s.id === node.data.shotId)
        if (!shot) throw new Error('스토리보드 샷을 찾을 수 없습니다.')
        await generateShotVideo(shot, report, signal)
      } else if (node.type === 'audio' && node.data.shotId) {
        const shot = p.shots.find((s) => s.id === node.data.shotId)
        if (!shot) throw new Error('스토리보드 샷을 찾을 수 없습니다.')
        await generateShotAudio(shot, report, signal)
      } else if (node.type === 'export' || node.type === 'final') {
        await generateFinalCut(report)
      } else if (node.type === 'imageGen') {
        await generateFreeformImage(node.id, report, signal)
      } else if (node.type === 'videoGen') {
        await generateFreeformVideo(node.id, report, signal)
      } else if (node.type === 'audioGen') {
        await generateFreeformAudio(node.id, report, signal)
      } else {
        throw new Error(`알 수 없는 노드 유형 ${node.type}`)
      }
      patchNode(project, nodeId, 'success')
      if (node.type === 'export') patchNode(project, 'final', 'success')
      if (node.type === 'final') patchNode(project, 'export', 'success')
      activity.done(translate('canvasRunner.completed', { label: label }))
    } catch (e: any) {
      if (local?.signal.aborted && (drawThingsImage || e?.name === 'AbortError')) {
        const message = translate(drawThingsImage ? 'drawThings.cancelled' : isLtxDesktop(profile) ? 'ltxDesktop.cancelRequested' : 'ltx.stopped')
        patchNode(project, nodeId, 'idle', message)
        await project.save()
        onProgress?.(nodeId, message)
      } else {
        patchNode(project, nodeId, 'failed', e?.message ?? String(e))
      }
      if (node.type === 'export') patchNode(project, 'final', 'failed', e?.message ?? String(e))
      if (node.type === 'final') patchNode(project, 'export', 'failed', e?.message ?? String(e))
      activity.fail(e)
      throw e
    } finally {
      if (local) waits.delete(nodeId)
      pendingRun = {}
    }
  })
}

export async function generateMissingSheets(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const four = (p.subjects ?? [])
    .filter((s) => !s.designSheetAssetId)
    .map((s) => `subject:${s.id}`)
  await mapPool(four, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}

export async function generateMissingPropSheets(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const props = (p.scenes ?? [])
    .filter((s) => sceneHasKeyProps(s) && !s.propSheetAssetId)
    .map((s) => `sceneProps:${s.id}`)
  await mapPool(props, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}

export async function generateMissingBoards(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const boardIds = shotsMissingStoryboard(p).map((s) => `shotBoard:${s.id}`)
  if (boardIds.length) {
    await mapPool(boardIds, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
  }
  await generateMissingImages(onProgress, signal)
}

export async function generateMissingPlates(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const ids = (p.scenes ?? []).filter((s) => !s.plateAssetId).map((s) => `scene:${s.id}`)
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}

export async function generateMissingImages(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const ids = shotsMissingKeyframe(p).map((s) => `shotImage:${s.id}`)
  if (!ids.length) return
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}

/**
 * 시작·끝 프레임 모드에서는 영상 생성 전에 누락된 프레임을 샷 순서대로 만든다.
 * 일부 프레임을 생성하지 못하면 실패를 기록하고 영상 생성을 계속한다.
 */
export async function ensureShotFrames(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<number> {
  const p = useProjectStore().current
  if (!p || !needsShotFrames(p)) return 0
  // 혼합 모드에서는 시작·끝 프레임 입력이 필요한 샷만 보완한다.
  const missing = [...(p.shots ?? [])]
    .filter((s) => shotUsesFrames(s, p) && (!s.firstFrameAssetId || !s.lastFrameAssetId))
    .sort((a, b) => a.index - b.index)
  if (!missing.length) return 0
  onProgress?.(`시작·끝 프레임 모드입니다. 샷 ${missing.length}개의 시작·끝 프레임을 샷 번호 순서대로 생성하는 중…`)
  let done = 0
  for (const shot of missing) {
    ensureNotCancelled(signal)
    try {
      await generateShotFramePair(shot, (msg) => onProgress?.(msg), signal)
      done += 1
    } catch (e: any) {
      onProgress?.(`${shot.index + 1}번 샷의 시작·끝 프레임 생성에 실패했습니다(${e?.message || '알 수 없는 원인'}). 영상 생성은 계속합니다.`)
    }
  }
  return done
}

export async function generateMissingVideos(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  await ensureShotFrames(onProgress, signal)
  const ids = p.shots
    .filter((s) => !s.videoAssetId)
    .map((s) => `shotVideo:${s.id}`)
  // 다음 샷의 시작 프레임은 이전 끝 프레임을 쓰므로 샷 순서대로 실행한다.
  const chain = isFl2vaChainActive(p)
  const ordered = chain ? sortNodeIdsByShotIndex(p, ids) : ids
  await mapPool(ordered, chain ? 1 : VIDEO_GEN_CONCURRENCY, (id) =>
    runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal)
  )
}

export async function generateMissingAudio(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const ids = p.shots.filter((s) => needsExternalTts(s, p) && !s.audioAssetId).map((s) => `audio:${s.id}`)
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}
