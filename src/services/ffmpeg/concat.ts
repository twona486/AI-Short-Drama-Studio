/**
 * 영상 클립 이어 붙이기
 *
 * 클립의 코덱, 해상도와 프레임률을 통일한 뒤 이어 붙인다.
 */

import { getFFmpeg, writeFile, readFile, toBlob } from './client'

export interface ConcatSegment {
  /** 입력 Blob */
  blob: Blob
  /** 원본 소재에서 자르기 시작할 위치(초) */
  sourceIn: number
  /** 사용할 길이(초) */
  duration: number
  /** 재생 속도 배율 */
  speed?: number
  /** 클립 비활성화 여부 */
  enabled?: boolean
}

export interface ConcatOptions {
  width: number
  height: number
  fps: number
  /** 출력 형식 */
  format?: 'mp4' | 'webm'
  /** 출력 MIME 유형 */
  mimeType?: string
  onProgress?: (msg: string) => void
}

/**
 * 여러 클립을 영상 하나로 합친다.
 * 클립마다 잘라내고 공통 형식으로 인코딩한다.
 * concat 디먹서로 이어 붙인다.
 */
export async function concatVideos(
  segments: ConcatSegment[],
  opts: ConcatOptions
): Promise<Blob> {
  const ffmpeg = await getFFmpeg(opts.onProgress)
  const format = opts.format ?? 'mp4'
  const mimeType = opts.mimeType ?? `video/${format}`

  const active = segments.filter((s) => s.enabled !== false && s.duration > 0)
  if (active.length === 0) {
    throw new Error('이어 붙일 클립이 없습니다.')
  }

  // 각 클립을 공통 형식으로 변환한다.
  const listPath = 'list.txt'
  const lines: string[] = []
  for (let i = 0; i < active.length; i++) {
    const seg = active[i]
    const inName = `in_${i}.${guessExt(seg.blob.type)}`
    const outName = `seg_${i}.mp4`
    await writeFile(ffmpeg, inName, seg.blob)

    const speed = seg.speed ?? 1
    const speedFilter = speed === 1 ? '' : `setpts=${(1 / speed).toFixed(4)}*PTS,`
    const audioFilter =
      speed === 1
        ? 'anull'
        : `asetpts=${(1 / speed).toFixed(4)}*PTS,atempo=${speed}`

    const args = [
      '-ss',
      String(seg.sourceIn),
      '-i',
      inName,
      '-t',
      String(seg.duration),
      '-vf',
      `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease,pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2:black,fps=${opts.fps},format=yuv420p,${speedFilter}`.replace(
        /,$/,
        ''
      ),
      '-af',
      audioFilter,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      '-movflags',
      '+faststart',
      '-y',
      outName
    ]
    await ffmpeg.exec(args)
    lines.push(`file '${outName}'`)
  }

  await ffmpeg.writeFile(listPath, lines.join('\n'))

  // 변환한 클립을 이어 붙인다.
  const outName = `out.${format}`
  await ffmpeg.exec([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    '-y',
    outName
  ])

  const data = await readFile(ffmpeg, outName)
  return toBlob(data as Uint8Array, mimeType)
}

function guessExt(mime: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('quicktime')) return 'mov'
  return 'mp4'
}
