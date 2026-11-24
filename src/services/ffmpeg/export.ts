/**
 * 영상 내보내기
 *
 * 타임라인의 클립을 장면 전환 및 자막과 함께 합성한다.
 *
 * 합성 시 적용하는 조건
 * 다양한 WebM, MP4, MOV 입력을 처리하도록 H.264와 AAC를 사용한다.
 * 이미지에는 무음 오디오를 추가해 이어 붙이기가 실패하는 일을 방지한다.
 * 각 단계에서 진행 로그와 오류를 반환한다.
 */

import { t } from "@/i18n"
import { getFFmpeg, writeFile, readFile, toBlob, clearFS } from './client'
import { renderCaptionPng, type SubtitleCue } from './subtitle'
import type { CaptionStyle, TimelineClip, TransitionType } from '@/types'

export interface ExportInput {
  timeline: TimelineClip[]
  mediaMap: Map<string, { blob: Blob; kind: 'video' | 'image' }>
  voiceoverMap: Map<string, string>
  width: number
  height: number
  fps: number
  captionStyle: CaptionStyle
  burnCaptions?: boolean
  captionCues?: Array<SubtitleCue & { style?: Partial<CaptionStyle> }>
  captionBg?: boolean
  captionHighlight?: boolean
  captionHighlightColor?: string
  captionHighlightScale?: number
  bgm?: Blob
  bgmVolume?: number
  bgmStartTime?: number
  bgmSourceIn?: number
  bgmDuration?: number
  /** 스토리보드 원본 환경음 볼륨(0은 무음, 권장 범위 0.35~0.7) */
  originalVolume?: number
  /** 샷 ID별 내레이션 오디오를 해당 클립에 합성한다. */
  voiceoverAudioMap?: Map<string, Blob>
  voiceoverVolume?: number
  /** 클립의 환경음을 유지할지 지정한다. 기본값은 true다. */
  keepAmbientAudio?: boolean
  /** 샷별 오디오 설정은 전역 환경음 설정보다 우선할 수 있다. */
  sourceAudioMap?: Map<string, boolean>
  format?: 'mp4' | 'webm'
  onProgress?: (msg: string) => void
}

const log = (msg: string) =>
  console.log('%c[export]', 'color:#f59e0b;font-weight:600', msg)

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message)
  }
  return String(e)
}

function wrapError(e: unknown, extra = ''): Error {
  return new Error(errorMessage(e) + extra)
}

function even(n: number): number {
  const v = Math.max(2, Math.round(n))
  return v % 2 === 0 ? v : v - 1
}

export async function exportVideo(input: ExportInput): Promise<Blob> {
  const ffmpeg = await getFFmpeg(input.onProgress)
  const format = input.format ?? 'mp4'
  const mimeType = `video/${format}`
  const width = even(input.width)
  const height = even(input.height)

  const recentLog: string[] = []
  const logHandler = ({ message }: { message: string }) => {
    recentLog.push(message)
    if (recentLog.length > 40) recentLog.shift()
  }
  ffmpeg.on('log', logHandler)

  try {
    await clearFS(ffmpeg)
    log(`Export started: ${format.toUpperCase()} ${width}×${height}@${input.fps}fps`)
    input.onProgress?.(t('ffmpegExport.prepare'))

    const enabled = input.timeline.filter((c) => c.enabled)
    const totalDur = enabled.reduce((s, c) => s + Math.max(0.1, c.duration), 0)
    await writeFile(ffmpeg, 'silence.wav', makeSilentWav(Math.max(totalDur, 8) + 2))

    let cursor = 0
    const concatLines: string[] = []
    const cues: SubtitleCue[] = []

    for (let i = 0; i < enabled.length; i++) {
      const clip = enabled[i]
      const media = input.mediaMap.get(clip.shotId)
      if (!media) {
        console.warn(`[export] clip ${clip.id} has no media; skipping`)
        continue
      }

      const inExt = guessExt(media.blob.type, media.kind)
      const inName = `clip_${i}_in.${inExt}`
      let outName = `clip_${i}.mp4`
      await writeFile(ffmpeg, inName, media.blob)
      log(
        `[${i}] Writing ${inName} (${(media.blob.size / 1024 / 1024).toFixed(2)} MB, ${media.blob.type || media.kind})`
      )

      const duration = Math.max(0.1, clip.duration)
      const sourceIn = Math.max(0, clip.sourceIn || 0)
      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1
      const keepAmbient =
        (input.sourceAudioMap?.get(clip.shotId) ?? input.keepAmbientAudio !== false) &&
        media.kind === 'video'
      const ambientVol = keepAmbient
        ? Math.max(0, Math.min(2, clip.volume ?? input.originalVolume ?? 0.55))
        : 0
      const videoFilter = buildVideoFilter(width, height, input.fps, speed)

      input.onProgress?.(
        keepAmbient
          ? t('ffmpegExport.convertAmbient', { current: i + 1, total: enabled.length })
          : t('ffmpegExport.convertWithoutMusic', { current: i + 1, total: enabled.length })
      )
      await transcodeClip(ffmpeg, {
        kind: media.kind,
        inName,
        outName,
        duration,
        sourceIn,
        fps: input.fps,
        videoFilter,
        speed,
        volume: ambientVol,
        keepAmbient
      })
      log(`[${i}] ✓ Transcoded → ${outName}${keepAmbient ? ' (with ambient audio)' : ''}`)

      try {
        await ffmpeg.deleteFile(inName)
      } catch {
        /* ignore */
      }

      const voBlob = input.voiceoverAudioMap?.get(clip.id) || input.voiceoverAudioMap?.get(clip.shotId)
      if (voBlob && voBlob.size > 200) {
        input.onProgress?.(t('ffmpegExport.addNarration', { current: i + 1, total: enabled.length }))
        const mixedName = `clip_${i}_vo.mp4`
        const voiceVolume = clip.voiceAssetId
          ? Math.max(0, Math.min(2, clip.voiceVolume ?? input.voiceoverVolume ?? 1))
          : input.voiceoverVolume ?? 1
        try {
          await mixVoiceover(
            ffmpeg,
            outName,
            mixedName,
            voBlob,
            duration,
            // 변환 단계에서 환경음 볼륨을 조정했으므로 여기서는 기존 볼륨으로 내레이션과 믹싱한다.
            keepAmbient ? 1 : 0,
            voiceVolume
          )
          try {
            await ffmpeg.deleteFile(outName)
          } catch {
            /* ignore */
          }
          outName = mixedName
          log(`[${i}] ✓ Mixed narration${keepAmbient ? ' (with ambient audio)' : ''}`)
        } catch (e) {
          log(`[${i}] Narration mix failed; keeping source audio: ${errorMessage(e)}`)
        }
      }

      let concatName = outName
      if (clip.transitionIn !== 'none' && clip.transitionDuration > 0) {
        const fadeName = `clip_${i}_fade.mp4`
        await applyTransition(
          ffmpeg,
          outName,
          fadeName,
          clip.transitionIn,
          clip.transitionDuration,
          duration
        )
        concatName = fadeName
      }
      concatLines.push(`file '${concatName}'`)

      if (input.burnCaptions) {
        const text = (input.voiceoverMap.get(clip.shotId) ?? '').trim()
        if (text) {
          cues.push({
            id: i + 1,
            start: cursor,
            end: cursor + duration,
            text
          })
        }
      }

      cursor += duration
    }

    if (concatLines.length === 0) {
      throw new Error('타임라인에 내보낼 자료가 없습니다.')
    }

    log(`✓ Prepared concat list:\n${concatLines.join('\n')}`)
    await writeFile(ffmpeg, 'list.txt', concatLines.join('\n'))

    const concatName = 'concated.mp4'
    input.onProgress?.(t('ffmpegExport.joinClips'))
    await concatClips(ffmpeg, concatName)
    log(`✓ Concatenated → ${concatName}`)

    let finalName = concatName
    const captionCues: Array<SubtitleCue & { style?: Partial<CaptionStyle> }> = (
      input.captionCues && input.captionCues.length > 0
        ? input.captionCues
        : cues
    ).filter((c) => c.text.trim())
    if (input.burnCaptions && captionCues.length > 0) {
      input.onProgress?.(t('ffmpegExport.burnCount', { count: captionCues.length }))
      finalName = await burnCaptionsOverlay(
        ffmpeg,
        concatName,
        captionCues,
        input.captionStyle,
        width,
        height,
        !!input.captionBg,
        {
          enabled: !!input.captionHighlight,
          color: input.captionHighlightColor,
          scale: input.captionHighlightScale
        },
        input.onProgress
      )
      log(`✓ Burned ${captionCues.length} subtitle cues`)
    } else if (input.burnCaptions) {
      log(t('ffmpegExport.missingCaptionText'))
      input.onProgress?.(t('ffmpegExport.noCaptions'))
    }

    if (input.bgm) {
      const bgmName = 'bgm.' + guessExt(input.bgm.type, 'audio')
      await writeFile(ffmpeg, bgmName, input.bgm)
      const withBGM = 'with_bgm.mp4'
      input.onProgress?.(t('ffmpegExport.addMusic'))
      const speechVol = 1
      const bgmVol = input.bgmVolume ?? 0.22
      const bgmStart = Math.max(0, input.bgmStartTime || 0)
      const bgmSourceIn = Math.max(0, input.bgmSourceIn || 0)
      const bgmDuration = Math.max(0.1, Math.min(input.bgmDuration || totalDur, totalDur - bgmStart))
      const fadeOut = Math.max(0, bgmDuration - 1.2)
      const delay = Math.round(bgmStart * 1000)
      await safeExec(
        ffmpeg,
        [
          '-i',
          finalName,
          '-stream_loop',
          '-1',
          '-i',
          bgmName,
          '-filter_complex',
          `[0:a]volume=${speechVol}[a0];[1:a]atrim=start=${bgmSourceIn.toFixed(3)}:duration=${bgmDuration.toFixed(3)},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${bgmVol},afade=t=in:st=0:d=${Math.min(0.6, bgmDuration / 3).toFixed(2)},afade=t=out:st=${fadeOut.toFixed(2)}:d=${Math.min(1.2, bgmDuration).toFixed(2)},adelay=${delay}|${delay}[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[a]`,
          '-map',
          '0:v:0',
          '-map',
          '[a]',
          '-t',
          String(totalDur),
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ar',
          '44100',
          '-ac',
          '2',
          '-y',
          withBGM
        ],
        t('ffmpegExport.mixMusic')
      )
      finalName = withBGM
    }

    const outName = `final.${format}`
    if (finalName !== outName) {
      input.onProgress?.(t('ffmpegExport.finalFormat', { format: format }))
      if (format === 'webm') {
        try {
          await safeExec(
            ffmpeg,
            [
              '-i',
              finalName,
              '-c:v',
              'libvpx-vp9',
              '-b:v',
              '1M',
              '-c:a',
              'libopus',
              '-y',
              outName
            ],
            t('ffmpegExport.convertFormat', { format: format })
          )
        } catch {
          log(t('ffmpegExport.webmFallback'))
          await safeExec(
            ffmpeg,
            ['-i', finalName, '-c', 'copy', '-y', 'final.mp4'],
            t('ffmpegExport.convertMp4')
          )
          const data = await readFile(ffmpeg, 'final.mp4')
          return toBlob(data, 'video/mp4')
        }
      } else {
        await safeExec(ffmpeg, ['-i', finalName, '-c', 'copy', '-y', outName], t('ffmpegExport.mux'))
      }
    }

    const data = await readFile(ffmpeg, outName)
    const blob = toBlob(data, mimeType)
    log(`✓ Exported: ${(blob.size / 1024 / 1024).toFixed(2)} MB`)
    return blob
  } catch (e) {
    const ctx = `\n\n[Recent FFmpeg log]\n${recentLog.slice(-20).join('\n') || '(none)'}`
    throw wrapError(e, ctx)
  } finally {
    ffmpeg.off('log', logHandler)
    try {
      await clearFS(ffmpeg)
    } catch {
      /* ignore */
    }
  }
}

async function burnCaptionsOverlay(
  ffmpeg: Parameters<typeof writeFile>[0],
  videoName: string,
  cues: Array<SubtitleCue & { style?: Partial<CaptionStyle> }>,
  style: CaptionStyle,
  width: number,
  height: number,
  captionBg: boolean,
  highlight: {
    enabled: boolean
    color?: string
    scale?: number
  },
  onProgress?: (msg: string) => void
): Promise<string> {
  const outName = 'with_caption.mp4'
  const layers: { file: string; start: number; end: number }[] = []

  for (let i = 0; i < cues.length; i++) {
    const text = cues[i].text.trim()
    if (!text) continue
    onProgress?.(t('ffmpegExport.drawCaptions', { current: layers.length + 1, total: cues.length }))
    const cueStyle = { ...style, ...(cues[i].style || {}) }
    const png = await renderCaptionPng(text, cueStyle, width, height, captionBg, highlight)
    if (!png.size) continue
    const file = `cap_${i}.png`
    await writeFile(ffmpeg, file, png)
    layers.push({ file, start: cues[i].start, end: cues[i].end })
  }

  if (layers.length === 0) {
    log(t('ffmpegExport.emptyPng'))
    return videoName
  }

  const filters: string[] = []
  let last = '0:v'
  layers.forEach((layer, i) => {
    const next = i === layers.length - 1 ? 'vcap' : `vc${i}`
    filters.push(
      `[${last}][${i + 1}:v]overlay=0:0:enable='between(t,${layer.start.toFixed(3)},${layer.end.toFixed(3)})'[${next}]`
    )
    last = next
  })
  filters.push(`[vcap]format=yuv420p[vout]`)

  onProgress?.(t('ffmpegExport.overlayCaptions'))
  const overlayBase = [
    '-i',
    videoName,
    ...layers.flatMap((l) => ['-i', l.file]),
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '0:a',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p'
  ]
  const copied = await execCode(ffmpeg, [...overlayBase, '-c:a', 'copy', '-y', outName])
  if (copied !== 0) {
    await safeExec(
      ffmpeg,
      [...overlayBase, '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-y', outName],
      t('ffmpegExport.burnCaptions')
    )
  }
  return outName
}

function encodeArgs(outName: string, withAudio: boolean): string[] {
  const video = [
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p'
  ]
  if (!withAudio) return [...video, '-an', '-y', outName]
  return [
    ...video,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-y',
    outName
  ]
}

function atempoChain(speed: number): string {
  const parts: string[] = []
  let s = speed
  while (s > 2.0001) {
    parts.push('atempo=2.0')
    s /= 2
  }
  while (s < 0.5) {
    parts.push('atempo=0.5')
    s /= 0.5
  }
  parts.push(`atempo=${Math.max(0.5, Math.min(2, s)).toFixed(4)}`)
  return parts.join(',')
}

function audioFilter(_speed: number, _volume: number): string {
  return 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo'
}

/** 오디오가 없는 입력에 추가할 16비트 스테레오 PCM 무음 WAV */
function makeSilentWav(durationSec: number, sampleRate = 44100): Uint8Array {
  const numSamples = Math.max(1, Math.ceil(durationSec * sampleRate))
  const channels = 2
  const bytesPerSample = 2
  const dataSize = numSamples * channels * bytesPerSample
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataSize, true)
  return new Uint8Array(buf)
}

async function execCode(
  ffmpeg: { exec: (args: string[]) => Promise<unknown> },
  args: string[]
): Promise<number> {
  try {
    const code = await ffmpeg.exec(args)
    return typeof code === 'number' ? code : 0
  } catch {
    return 1
  }
}

async function transcodeClip(
  ffmpeg: Parameters<typeof writeFile>[0],
  opts: {
    kind: 'video' | 'image'
    inName: string
    outName: string
    duration: number
    sourceIn: number
    fps: number
    videoFilter: string
    speed: number
    volume: number
    keepAmbient?: boolean
  }
) {
  const { kind, inName, outName, duration, sourceIn, fps, videoFilter, volume, keepAmbient } =
    opts

  if (kind === 'image') {
    await safeExec(
      ffmpeg,
      [
        '-loop',
        '1',
        '-framerate',
        String(fps),
        '-i',
        inName,
        '-i',
        'silence.wav',
        '-t',
        String(duration),
        '-shortest',
        '-vf',
        videoFilter,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        ...encodeArgs(outName, true)
      ],
      t('ffmpegExport.imageToVideo')
    )
    return
  }

  // MP4 원본 영상은 그대로 복사하고 오디오만 변환해 1080p 재인코딩의 메모리 사용을 피한다.
  // AAC를 프레임 중간에서 잘라 이어 붙이면 잡음이 생길 수 있어 오디오를 다시 인코딩한다.
  if (opts.speed === 1 && (keepAmbient || volume > 0.01)) {
    if (await remuxNormalizeAudio(ffmpeg, inName, outName, duration, sourceIn, volume)) {
      log('  Copied video and resampled audio to AAC 44100 Hz stereo')
      return
    }
    log('  Stream copy failed; transcoding once with source audio')
    try {
      await encodeKeepAudio(ffmpeg, inName, outName, duration, sourceIn, videoFilter, volume)
      return
    } catch (e) {
      if (!isOom(e)) throw e
      log(`  Transcoding ran out of memory; retrying stream copy: ${errorMessage(e)}`)
      if (await remuxNormalizeAudio(ffmpeg, inName, outName, duration, sourceIn, volume)) return
      throw e
    }
  }

  log(`  Using a silent track (ambient audio is disabled)`)
  if (opts.speed === 1 && (await remuxVideoWithSilence(ffmpeg, inName, outName, duration, sourceIn))) {
    log('  Copied video and added a silent audio track')
    return
  }
  await safeExec(
    ffmpeg,
    [
      '-ss',
      String(sourceIn),
      '-i',
      inName,
      '-i',
      'silence.wav',
      '-t',
      String(duration),
      '-shortest',
      '-vf',
      videoFilter,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      ...encodeArgs(outName, true)
    ],
    t('ffmpegExport.silentTranscode')
  )
}

function isOom(e: unknown) {
  return /memory access out of bounds|out of memory|Aborted\(\d+\)/i.test(errorMessage(e))
}

async function remuxNormalizeAudio(
  ffmpeg: { exec: (args: string[]) => Promise<unknown> },
  inName: string,
  outName: string,
  duration: number,
  sourceIn: number,
  volume = 1
): Promise<boolean> {
  const audioFilter =
    volume > 0.99 && volume < 1.01
      ? 'aresample=44100:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo'
      : `volume=${volume},aresample=44100:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo`
  const args = ['-fflags', '+genpts']
  if (sourceIn > 0.04) args.push('-ss', String(sourceIn))
  if (duration > 0.04) args.push('-t', String(duration))
  args.push(
    '-i',
    inName,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-af',
    audioFilter,
    '-shortest',
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    '+faststart',
    '-y',
    outName
  )
  return (await execCode(ffmpeg, args)) === 0
}

async function concatClips(
  ffmpeg: { exec: (args: string[]) => Promise<unknown> },
  concatName: string
) {
  const copyCode = await execCode(ffmpeg, [
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    'list.txt',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-af',
    'aresample=44100:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo',
    '-fflags',
    '+genpts',
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    '+faststart',
    '-y',
    concatName
  ])
  if (copyCode === 0) {
    log('  Concatenating with video stream copy and uniform audio encoding')
    return
  }
  log('  Concat stream copy failed; re-encoding the full sequence')
  await safeExec(
    ffmpeg,
    ['-f', 'concat', '-safe', '0', '-i', 'list.txt', ...encodeArgs(concatName, true)],
    t('ffmpegExport.join')
  )
}

async function remuxVideoWithSilence(
  ffmpeg: { exec: (args: string[]) => Promise<unknown> },
  inName: string,
  outName: string,
  duration: number,
  sourceIn: number
): Promise<boolean> {
  const code = await execCode(ffmpeg, [
    '-ss',
    String(sourceIn),
    '-t',
    String(duration),
    '-i',
    inName,
    '-i',
    'silence.wav',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-shortest',
    '-y',
    outName
  ])
  return code === 0
}

async function encodeKeepAudio(
  ffmpeg: Parameters<typeof writeFile>[0],
  inName: string,
  outName: string,
  duration: number,
  sourceIn: number,
  videoFilter: string,
  volume: number
) {
  const audioFilter = volume > 0.99 && volume < 1.01 ? 'anull' : `volume=${volume}`
  await safeExec(
    ffmpeg,
    [
      '-ss',
      String(sourceIn),
      '-i',
      inName,
      '-t',
      String(duration),
      '-shortest',
      '-vf',
      videoFilter,
      '-af',
      `${audioFilter},aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo`,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      ...encodeArgs(outName, true)
    ],
    t('ffmpegExport.ambientTranscode')
  )
}

function buildVideoFilter(
  width: number,
  height: number,
  fps: number,
  speed: number
): string {
  const speedFilter = speed === 1 ? '' : `setpts=${(1 / speed).toFixed(4)}*PTS,`
  return `${speedFilter}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},format=yuv420p`
}

async function safeExec(
  ffmpeg: { exec: (args: string[]) => Promise<unknown> },
  args: string[],
  stage: string
): Promise<void> {
  let code: unknown
  try {
    code = await ffmpeg.exec(args)
  } catch (e) {
    const cmd = ['ffmpeg', ...args].join(' ').slice(0, 400)
    throw new Error(`[${stage}] 실패 ${errorMessage(e)}\n명령 ${cmd}`)
  }
  if (typeof code === 'number' && code !== 0) {
    const cmd = ['ffmpeg', ...args].join(' ').slice(0, 400)
    throw new Error(`[${stage}] FFmpeg 종료 코드 ${code}\n명령 ${cmd}`)
  }
}

async function applyTransition(
  ffmpeg: { exec: (args: string[]) => Promise<unknown> },
  input: string,
  output: string,
  type: TransitionType,
  duration: number,
  clipDuration: number
) {
  const fadeDur = Math.min(duration, Math.max(0.05, clipDuration / 3))
  const fadeOutStart = Math.max(0, clipDuration - fadeDur)
  if (type === 'fade' || type === 'fade-black' || type === 'slide-left' || type === 'slide-right') {
    const color = type === 'fade' ? 'black' : 'black'
    await safeExec(
      ffmpeg,
      [
        '-i',
        input,
        '-vf',
        `fade=t=in:st=0:d=${fadeDur}:color=${color},fade=t=out:st=${fadeOutStart}:d=${fadeDur}:color=${color}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-y',
        output
      ],
      t('ffmpegExport.transition')
    )
  } else {
    await safeExec(ffmpeg, ['-i', input, '-c', 'copy', '-y', output], t('ffmpegExport.transition'))
  }
}

async function mixVoiceover(
  ffmpeg: Parameters<typeof writeFile>[0],
  videoName: string,
  outName: string,
  voBlob: Blob,
  duration: number,
  originalVolume: number,
  voiceVolume: number
) {
  const voExt = guessExt(voBlob.type, 'audio')
  const voName = videoName.replace(/\.[^.]+$/, '') + `_speech.${voExt}`
  await writeFile(ffmpeg, voName, voBlob)

  const speechDur = await blobDuration(voBlob)
  const voParts = [
    'aresample=44100',
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
    `volume=${voiceVolume}`
  ]
  if (speechDur && speechDur > duration * 1.06) {
    const tempo = Math.min(1.35, speechDur / duration)
    voParts.push(atempoChain(tempo))
  }
  voParts.push(`atrim=0:${duration.toFixed(3)}`, `apad=whole_dur=${duration.toFixed(3)}`)

  const filter =
    originalVolume < 0.01
      ? `[1:a]${voParts.join(',')}[a]`
      : `[0:a]volume=${originalVolume}[a0];[1:a]${voParts.join(',')}[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[a]`

  await safeExec(
    ffmpeg,
    [
      '-i',
      videoName,
      '-i',
      voName,
      '-filter_complex',
      filter,
      '-map',
      '0:v:0',
      '-map',
      '[a]',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-shortest',
      '-y',
      outName
    ],
    t('ffmpegExport.mixNarration')
  )
}

async function blobDuration(blob: Blob): Promise<number | null> {
  const url = URL.createObjectURL(blob)
  try {
    const el = document.createElement('audio')
    el.preload = 'metadata'
    el.src = url
    await new Promise<void>((resolve, reject) => {
      el.onloadedmetadata = () => resolve()
      el.onerror = () => reject(new Error('audio metadata'))
      setTimeout(() => reject(new Error('audio metadata timeout')), 8000)
    })
    return Number.isFinite(el.duration) ? el.duration : null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

function guessExt(mime: string, kind?: 'video' | 'image' | 'audio'): string {
  const t = (mime || '').toLowerCase()
  if (t.includes('png')) return 'png'
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  if (t.includes('webp')) return 'webp'
  if (t.includes('gif')) return 'gif'
  if (t.includes('webm')) return 'webm'
  if (t.includes('mp4')) return 'mp4'
  if (t.includes('quicktime') || t.includes('mov')) return 'mov'
  if (t.includes('audio/mpeg') || t.includes('mp3')) return 'mp3'
  if (t.includes('wav')) return 'wav'
  if (kind === 'image') return 'png'
  if (kind === 'audio') return 'mp3'
  return 'mp4'
}
