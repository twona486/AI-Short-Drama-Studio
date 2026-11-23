import { clearFS, getFFmpeg, readFile, toBlob, writeFile } from './client'
import { probeMedia } from './probe'

function extension(mime: string, fallback: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  return fallback
}

/** 删除生成视频的临时声音，换成最终克隆语音，让剪辑台预览和导出听到同一音轨。 */
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

/** 按秒从整段口播里切出这一镜的音频，交给 H3 音画同步。 */
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
 * 数字人音画同步只要 WAV/MP3，时长 5–15 秒。
 * 切片若是 AAC/m4a 或不足 5 秒，提交会被判「参数值非法」。
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

