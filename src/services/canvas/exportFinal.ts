/**
 * 캔버스에서 최종 영상을 합성한다.
 */

import { exportVideo, parseSRT, buildCuesFromClips, probeMedia, trimTimelineBySpeech } from '@/services/ffmpeg'
import { useAssetsStore, useProjectStore } from '@/stores'
import { canBuildExport, ensureTimelineFromShots, timelineClipAssetId } from '@/utils/timeline'
import { effectiveShotAudioMode, isDigitalHumanSpeechProject, needsExternalTts } from '@/utils/shot'

export async function generateFinalCut(onProgress?: (msg: string) => void) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  if (!p) throw new Error('열려 있는 프로젝트가 없습니다.')
  if (!canBuildExport(p)) {
    throw new Error('내보낼 영상이나 이미지가 없습니다. 먼저 스토리보드 샷 영상을 생성하세요.')
  }

  const { built, clips } = ensureTimelineFromShots(p)
  if (built) {
    project.setTimeline(clips)
  }
  const timeline = project.current!.timeline.filter((c) => c.enabled)
  if (!timeline.length) {
    throw new Error('타임라인이 비어 있어 합성할 수 없습니다.')
  }

  onProgress?.('소재를 준비하고 있어요…')
  const digitalHuman = isDigitalHumanSpeechProject(p)
  const mediaMap = new Map<string, { blob: Blob; kind: 'video' | 'image' }>()
  for (const clip of timeline) {
    if (mediaMap.has(clip.shotId)) continue
    const shot = p.shots.find((s) => s.id === clip.shotId)
    const assetId = timelineClipAssetId(p, clip)
    if (!assetId) continue
    const blob = await assets.getBlob(assetId)
    if (!blob) continue
    mediaMap.set(clip.shotId, {
      blob,
      kind: (assets.getMeta(assetId)?.kind || (shot?.videoAssetId ? 'video' : 'image')) as 'video' | 'image'
    })
  }
  if (mediaMap.size === 0) throw new Error('사용 가능한 스토리보드 자료가 없습니다.')

  let working = timeline
  if (digitalHuman && p.speechWorkflow?.options.removePauses !== false) {
    onProgress?.('문장 앞뒤의 숨소리를 잘라내고 있어요…')
    working = await trimTimelineBySpeech(working, async (shotId) => mediaMap.get(shotId)?.blob)
    project.setTimeline(working)
  }

  const voiceoverMap = new Map<string, string>()
  for (const clip of working) {
    const shot = p.shots.find((s) => s.id === clip.shotId)
    voiceoverMap.set(clip.shotId, shot?.voiceover ?? '')
  }

  const baseCaptionCues = (() => {
    if (digitalHuman) {
      return buildCuesFromClips(
        working.map((c) => {
          const shot = p.shots.find((s) => s.id === c.shotId)
          return {
            startTime: c.startTime,
            duration: c.duration,
            text: shot?.voiceover ?? ''
          }
        })
      ).filter((c) => c.text.trim())
    }
    const srt = p.captionSrt?.trim()
    if (srt) return parseSRT(srt).filter((c) => c.text.trim())
    return buildCuesFromClips(
      working.map((c) => {
        const shot = p.shots.find((s) => s.id === c.shotId)
        return {
          startTime: c.startTime,
          duration: c.duration,
          text: shot?.voiceover ?? ''
        }
      })
    ).filter((c) => c.text.trim())
  })()
  const captionCues = [
    ...baseCaptionCues,
    ...(p.textOverlays || []).map((item, index) => ({
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

  let bgmBlob: Blob | undefined
  if (p.pipelineMode !== 'smart-speech' && p.bgmAssetId) {
    bgmBlob = await assets.getBlob(p.bgmAssetId)
  }

  const isSpeech = p.pipelineMode === 'smart-speech'
  const voiceoverAudioMap = new Map<string, Blob>()
  const sourceAudioMap = new Map<string, boolean>()
  for (const clip of working) {
    if (voiceoverAudioMap.has(clip.shotId)) continue
    const shot = p.shots.find((s) => s.id === clip.shotId)
    if (!shot) continue
    const audioMode = effectiveShotAudioMode(shot)
    sourceAudioMap.set(
      clip.shotId,
      isSpeech ||
        audioMode === 'h3-dialogue' ||
        audioMode === 'h3-voiceover' ||
        p.settings.keepAmbientAudio !== false
    )
    if (digitalHuman || !needsExternalTts(shot, p) || !shot.audioAssetId) continue
    const blob = await assets.getBlob(shot.audioAssetId)
    if (blob) voiceoverAudioMap.set(clip.shotId, blob)
  }
  for (const clip of working) {
    if (!clip.voiceAssetId) continue
    const blob = await assets.getBlob(clip.voiceAssetId)
    if (blob) voiceoverAudioMap.set(clip.id, blob)
  }

  let width = p.settings.width
  let height = p.settings.height
  if (isSpeech) {
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
  const exportTimeline = isSpeech
    ? working.map((clip) => ({ ...clip, transitionIn: 'none' as const, transitionDuration: 0 }))
    : working

  const keepAmbient = isSpeech ? true : p.settings.keepAmbientAudio !== false
  const blob = await exportVideo({
    timeline: exportTimeline,
    mediaMap,
    voiceoverMap,
    width,
    height,
    fps: p.settings.fps,
    captionStyle: p.settings.captionStyle,
    burnCaptions: p.settings.burnCaptions !== false,
    captionCues,
    captionBg: p.settings.captionBg,
    captionHighlight: p.settings.captionHighlight,
    captionHighlightColor: p.settings.captionHighlightColor,
    captionHighlightScale: p.settings.captionHighlightScale,
    bgm: bgmBlob,
    bgmVolume: p.settings.bgmVolume,
    bgmStartTime: p.bgmClip?.startTime,
    bgmSourceIn: p.bgmClip?.sourceIn,
    bgmDuration: p.bgmClip?.duration,
    originalVolume: isSpeech ? 1 : p.settings.originalVolume ?? 0.55,
    keepAmbientAudio: keepAmbient,
    sourceAudioMap,
    voiceoverAudioMap,
    format: 'mp4',
    onProgress
  })

  onProgress?.('영상을 저장하고 있어요…')
  const asset = await assets.add(blob, 'video', 'ai-generated', {
    filename: `final_${p.name || 'cut'}_${Date.now().toString(36)}.mp4`,
    prompt: `영상 · ${p.script?.topic || p.name || ''}`,
    projectId: p.id
  })
  project.setFinalVideo(asset.id)

  // 캔버스 노드 상태를 갱신한다.
  if (project.current?.canvas) {
    const nodes = project.current.canvas.nodes.map((n) => {
      if (n.id === 'export' || n.id === 'final' || n.type === 'final') {
        return { ...n, status: 'success' as const, error: undefined }
      }
      return n
    })
    project.setCanvas({ ...project.current.canvas, nodes })
  }
  await project.save()
  return asset
}
