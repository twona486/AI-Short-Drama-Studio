/**
 * 整片背景音乐（纯音乐，无人声）
 *
 * 分镜视频自带的配乐切来切去不流畅，导出时会丢掉。
 * 这里按主题/风格生成一段 BGM，循环铺满视频，再叠口播。
 *
 * MiniMax Music 3.0：
 *   POST https://api.minimaxi.com/v1/music_generation
 *   is_instrumental: true  → 纯音乐，不跟口播抢人声
 * （lyrics_generation 只写词，不出音频）
 */

import { getAIMode, callLLM } from './client'
import { getMusicConfig } from './runtime'
import type { Project, VisualStyle } from '@/types'

export interface MusicGenInput {
  prompt: string
  /** 目标时长（秒），生成结果会在导出时循环/裁切对齐 */
  duration?: number
}

export interface MusicGenOutput {
  blob: Blob
  mimeType: string
  prompt: string
  model: string
}

const log = (msg: string) =>
  console.log('%c[music]', 'color:#10b981;font-weight:600', msg)

const STYLE_MUSIC: Record<VisualStyle, string> = {
  cinematic: 'Cinematic music. Warm strings and a light electronic bed at a steady pace.',
  anime: 'Bright Japanese-animation-inspired piano and synth, upbeat and restrained.',
  photorealistic: 'Modern documentary score with acoustic guitar and ambient pads.',
  '3d-render': 'Futuristic electronic ambience with clean bass and restrained rhythm.',
  'oil-painting': 'Gentle strings and piano with a classical oil-painting mood.',
  watercolor: 'Light acoustic guitar and flute with a fresh watercolor mood.',
  'pixel-art': 'Upbeat retro game chiptune, mixed quietly.',
  'ink-wash': 'Sparse Chinese ink-wash mood with restrained guzheng and flutes.'
}

export function buildMusicPrompt(project: Project): string {
  const topic = project.script?.topic || project.name || 'short video'
  const style = project.script?.style ?? 'cinematic'
  const aesthetic = (project.script?.aesthetic || '').replace(/\s+/g, ' ').slice(0, 180)
  const titles = project.shots
    .slice(0, 8)
    .map((s) => s.title)
    .filter(Boolean)
    .join('、')
  const mood = STYLE_MUSIC[style] || STYLE_MUSIC.cinematic
  return [
    `Instrumental background music only, with no voices, lyrics, or dialogue.`,
    `Topic: ${topic}.`,
    titles ? `Visual sequence: ${titles}.` : '',
    `Music style: ${mood}.`,
    aesthetic ? `Overall mood: ${aesthetic}.` : '',
    `Mix quietly under narration. Keep a continuous loopable rhythm and use natural fades.`
  ]
    .filter(Boolean)
    .join('')
}

export async function refineMusicPrompt(project: Project): Promise<string> {
  const fallback = buildMusicPrompt(project)
  if (getAIMode() !== 'real') return fallback
  try {
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content:
            'You are a music director for short-form video. From the project context, write an 80–180-character instrumental music prompt in English for the generation model. Specify instruments only, no vocals or lyrics, and a mix suitable under narration. Return only the prompt.'
        },
        { role: 'user', content: fallback }
      ],
      temperature: 0.7,
      maxTokens: 400
    })
    const text = (resp.content || '').replace(/```[\s\S]*?```/g, '').trim()
    if (text.length >= 20 && text.length <= 2000) return text
  } catch (e) {
    log(`프롬프트를 다듬지 못해 기본 프롬프트를 사용합니다. ${e}`)
  }
  return fallback
}

function musicConfig() {
  return getMusicConfig()
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '').replace(/\s/g, '')
  if (clean.length < 8 || clean.length % 2 !== 0) {
    throw new Error('[music] 16진수 오디오 데이터가 유효하지 않습니다.')
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function mockBgm(durationSec: number): Blob {
  const duration = Math.min(48, Math.max(12, durationSec || 24))
  const sampleRate = 22050
  const n = Math.ceil(duration * sampleRate)
  const dataSize = n * 2
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataSize, true)
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const env = Math.min(1, t * 0.6) * Math.min(1, (duration - t) * 0.6)
    const s =
      Math.sin(2 * Math.PI * 110 * t) * 0.07 +
      Math.sin(2 * Math.PI * 164.81 * t) * 0.05 +
      Math.sin(2 * Math.PI * 196 * t) * 0.035
    view.setInt16(44 + i * 2, Math.round(s * env * 32767), true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

async function downloadAudio(url: string): Promise<Blob> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`[music] 다운로드에 실패했습니다. ${resp.status}`)
  const buf = await resp.arrayBuffer()
  const ct = (resp.headers.get('content-type') || '').toLowerCase()
  return new Blob([buf], {
    type: ct.includes('wav') ? 'audio/wav' : 'audio/mpeg'
  })
}

function audioFromPayload(audio: string, format: string): Promise<Blob> | Blob {
  if (/^https?:\/\//i.test(audio)) {
    return downloadAudio(audio)
  }
  const bytes = hexToBytes(audio)
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  const mime = format === 'wav' ? 'audio/wav' : 'audio/mpeg'
  return new Blob([copy], { type: mime })
}

async function realMinimaxMusic(prompt: string, model: string): Promise<MusicGenOutput> {
  const { apiKey, baseUrl } = musicConfig()
  if (!apiKey) {
    throw new Error(
      '[music] VITE_MUSIC_API_KEY(MiniMax API 키)가 설정되지 않았습니다.\n' +
        '.env에 입력한 뒤 npm run dev를 다시 실행하세요.'
    )
  }

  const format = 'mp3'
  log(`→ MiniMax ${model} instrumental`)
  const resp = await fetch(`${baseUrl}/music_generation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      prompt: prompt.slice(0, 2000),
      is_instrumental: true,
      output_format: 'hex',
      audio_setting: {
        sample_rate: 44100,
        bitrate: 256000,
        format
      }
    })
  })
  const raw = await resp.text()
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`[music] ${resp.status} ${raw.slice(0, 240)}`)
  }

  const code = data.base_resp?.status_code
  if (code !== 0 && code !== undefined) {
    throw new Error(
      `[music] MiniMax ${code} ${data.base_resp?.status_msg || raw.slice(0, 200)}`
    )
  }
  if (!resp.ok) {
    throw new Error(`[music] ${resp.status} ${raw.slice(0, 240)}`)
  }

  const audio = data.data?.audio ?? data.audio
  const status = data.data?.status
  if (status === 1) {
    throw new Error('[music] 배경음악을 합성하고 있습니다. 잠시 후 다시 시도하세요.')
  }
  if (!audio) {
    throw new Error(`[music] 응답에 오디오가 없습니다. ${raw.slice(0, 240)}`)
  }

  const blob = await audioFromPayload(String(audio), format)
  if (blob.size < 400) throw new Error('[music] 오디오가 너무 짧습니다. 생성이 실패했을 수 있습니다.')
  log(`✓ ${(blob.size / 1024).toFixed(1)} KB`)
  return { blob, mimeType: blob.type, prompt, model }
}

export async function generateMusic(input: MusicGenInput): Promise<MusicGenOutput> {
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('배경음악 프롬프트가 없습니다.')

  if (getAIMode() !== 'real') {
    log('데모 모드에서 임시 배경음악을 생성합니다.')
    const blob = mockBgm(input.duration ?? 24)
    return { blob, mimeType: blob.type, prompt, model: 'mock-music' }
  }

  const preferred = musicConfig().model
  const models = [...new Set([preferred, 'music-3.0', 'music-3.0-free'])]
  const errors: string[] = []
  for (const model of models) {
    try {
      return await realMinimaxMusic(prompt, model)
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      errors.push(`${model}: ${msg}`)
      log(`${model} 실패 ${msg}`)
    }
  }
  throw new Error(errors.join('\n'))
}
