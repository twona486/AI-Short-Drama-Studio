import { clearFS, getFFmpeg, readFile, toBlob, writeFile } from './client'
import { probeMedia } from './probe'

function extension(mime: string, fallback: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  return fallback
}

/** 임시 오디오를 복제 음성으로 교체해 편집 미리보기와 내보내기에 동일하게 사용한다. */
export async function replaceVideoAudio(
  video: Blob,
  audio: Blob,
  onProgress?: (message: string) => void
): Promise<Blob> {
  const ffmpeg = await getFFmpeg(onProgress)
  await clearFS(ffmpeg)
  const videoName = `talking.${extension(video.type, 'mp4')}`
  const audioName = `cloned.${extension(audio.type, 'mp3')}`
  const outputName = 'talking_cloned.mp4'
  await writeFile(ffmpeg, videoName, video)
  await writeFile(ffmpeg, audioName, audio)
  onProgress?.('복제한 음성을 인물 영상에 합성하고 있어요…')
  const exitCode = await ffmpeg.exec([
    '-i', videoName,
    '-i', audioName,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '44100',
    '-shortest',
    '-movflags', '+faststart',
    '-y', outputName
  ])
  if (exitCode !== 0) throw new Error(`디지털 휴먼 오디오 트랙을 교체하지 못했습니다.（FFmpeg ${exitCode}）`)
  return toBlob((await readFile(ffmpeg, outputName)) as Uint8Array, 'video/mp4')
}

/** 전체 내레이션에서 이 샷의 오디오 구간을 잘라 H3 립싱크에 전달한다. */
export async function sliceAudio(
  audio: Blob,
  start: number,
  duration: number,
  onProgress?: (message: string) => void
): Promise<Blob> {
  const ffmpeg = await getFFmpeg(onProgress)
  await clearFS(ffmpeg)
  const inputName = `src.${extension(audio.type, 'mp3')}`
  const outputName = 'slice.m4a'
  await writeFile(ffmpeg, inputName, audio)
  onProgress?.('대사 길이에 맞춰 오디오를 나누고 있어요…')
  const exitCode = await ffmpeg.exec([
    '-ss', String(Math.max(0, start)),
    '-t', String(Math.max(0.4, duration)),
    '-i', inputName,
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '44100',
    '-y',
    outputName
  ])
  if (exitCode !== 0) throw new Error(`오디오를 자르지 못했습니다.（FFmpeg ${exitCode}）`)
  return toBlob((await readFile(ffmpeg, outputName)) as Uint8Array, 'audio/mp4')
}

/**
 * 디지털 휴먼 립싱크는 5~15초 WAV나 MP3만 받는다.
 * AAC, m4a 또는 5초 미만 클립은 공급자에서 거부한다.
 */
export async function toDigitalHumanWav(
  audio: Blob,
  onProgress?: (message: string) => void
): Promise<{ blob: Blob; duration: number }> {
  if ((audio.type || '').includes('wav')) {
    const info = await probeMedia(audio).catch(() => ({ duration: 0 }))
    const duration = Number(info.duration) || 0
    if (duration >= 4.8 && duration <= 15.2) {
      return { blob: audio, duration: Math.max(5, Math.min(15, Math.round(duration))) }
    }
  }
  const ffmpeg = await getFFmpeg(onProgress)
  await clearFS(ffmpeg)
  const inputName = `src.${extension(audio.type, 'mp3')}`
  await writeFile(ffmpeg, inputName, audio)
  onProgress?.('내레이션을 WAV로 변환하고 길이를 5~15초로 맞추고 있어요…')
  const exitCode = await ffmpeg.exec([
    '-i', inputName,
    '-af', 'apad=whole_dur=5',
    '-t', '15',
    '-c:a', 'pcm_s16le',
    '-ar', '44100',
    '-ac', '1',
    '-y',
    'out.wav'
  ])
  if (exitCode !== 0) throw new Error(`내레이션 오디오를 변환하지 못했습니다.（FFmpeg ${exitCode}）`)
  const blob = toBlob((await readFile(ffmpeg, 'out.wav')) as Uint8Array, 'audio/wav')
  const info = await probeMedia(blob).catch(() => ({ duration: 5 }))
  const duration = Math.max(5, Math.min(15, Math.round(info.duration || 5)))
  return { blob, duration }
}

