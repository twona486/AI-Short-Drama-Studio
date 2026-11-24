/**
 * 자막 처리
 *
 * SRT 읽기 및 생성
 * FFmpeg drawtext 또는 ASS를 이용한 영상 자막 합성
 *
 * 기본 FFmpeg.wasm에는 libass가 없어 drawtext로 자막을 한 줄씩 그린다.
 *     자막이 많으면 WebVTT와 Canvas 오버레이를 사용하면 처리 성능이 향상된다.
 */

import type { CaptionStyle } from '@/types'
import { t } from '@/i18n'

export interface SubtitleCue {
  id: number
  start: number
  end: number
  text: string
}

export function parseSRT(srt: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const blocks = srt
    .replace(/\r/g, '')
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean)

  for (const block of blocks) {
    const lines = block.split('\n')
    if (lines.length < 2) continue

    let id = cues.length + 1
    let timeLineIdx = 0
    if (/^\d+$/.test(lines[0])) {
      id = parseInt(lines[0], 10)
      timeLineIdx = 1
    }

    const timeLine = lines[timeLineIdx]
    const m = timeLine.match(
      /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/
    )
    if (!m) continue

    const start =
      parseInt(m[1]) * 3600 +
      parseInt(m[2]) * 60 +
      parseInt(m[3]) +
      parseInt(m[4]) / 1000
    const end =
      parseInt(m[5]) * 3600 +
      parseInt(m[6]) * 60 +
      parseInt(m[7]) +
      parseInt(m[8]) / 1000

    const text = lines.slice(timeLineIdx + 1).join('\n')

    cues.push({ id, start, end, text })
  }

  return cues
}

export function toSRT(cues: SubtitleCue[]): string {
  return cues
    .map((c) => {
      return `${c.id}\n${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${c.text}\n`
    })
    .join('\n')
}

function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.round((sec - Math.floor(sec)) * 1000)
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

/** 클립마다 자막 큐 하나를 배정한다. */
export function buildCuesFromClips(
  clips: Array<{ startTime: number; duration: number; text: string }>
): SubtitleCue[] {
  return clips.map((c, i) => ({
    id: i + 1,
    start: c.startTime,
    end: c.startTime + c.duration,
    text: c.text
  }))
}

/** FFmpeg drawtext의 특수 문자를 이스케이프한다. */
export function escapeDrawText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\n/g, '\\n')
}

/** 자막 큐와 스타일을 drawtext 필터로 변환해 여러 구간에 합성한다. */
export function cuesToDrawTextFilter(
  cues: SubtitleCue[],
  style: CaptionStyle,
  videoHeight: number
): string {
  const fontSize = Math.round(videoHeight * style.fontSizeRatio)
  const y = calcY(style.position, videoHeight, fontSize)
  const fontFile = ''
  // 글자 크기, 색상, 외곽선, 위치
  const base = (text: string) =>
    [
      `text='${escapeDrawText(text)}'`,
      `fontsize=${fontSize}`,
      `fontcolor=${style.color}`,
      style.strokeWidth > 0
        ? `borderw=${style.strokeWidth}:bordercolor=${style.strokeColor}`
        : '',
      `x=(w-text_w)/2`,
      `y=${y}`,
      style.bold ? 'bold=true' : ''
    ]
      .filter(Boolean)
      .join(':')

  return cues
    .map((c) => {
      const enable = `enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'`
      return `drawtext=${base(c.text)}:${enable}`
    })
    .join(',')
}

const CJK_FONT =
  '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Noto Sans CJK KR", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Noto Sans CJK SC", "Hiragino Sans GB", sans-serif'

export interface CaptionHighlightOptions {
  enabled?: boolean
  color?: string
  scale?: number
  /** 직접 강조할 단어를 지정한다. 비어 있으면 자동으로 찾는다. */
  words?: string[]
}

const EMPHASIS_WORDS = [
  '超级工厂', '产业带', '运营中心', '诚信通', '外贸版', '黑五', '圣诞',
  '出海', '合规', '现货', '利润', '增长', '机会', '资源', '流量', 'AI能力',
  '关键', '核心', '重点', '第一', '必须', '一定', '直接', '提前', '稳定出货',
  '售后保障', '点击下方', '锁定席位', '不见不散',
  '핵심', '중요', '성장', '기회', '수익', '필수', '예약', '혜택',
  'essential', 'growth', 'key point', 'profit', 'opportunity', 'reserve'
]

const HIGHLIGHT_STOP_WORDS = new Set([
  '这个', '那个', '这些', '那些', '我们', '你们', '他们', '自己', '一个', '一些',
  '就是', '还是', '已经', '现在', '今年', '这里', '这样', '那样', '如果', '因为',
  '所以', '但是', '而且', '可以', '可能', '开始', '之后', '之前', '时候', '怎么',
  '什么', '很多', '越来越', '一下', '一条', '一波', '起来', '下来', '出来',
  '이것', '그것', '저것', '우리', '지금', '그리고', '하지만', '그래서',
  'a', 'an', 'the', 'and', 'this', 'that', 'there', 'with', 'they', 'have'
])

interface HighlightCandidate {
  word: string
  score: number
  start: number
}

/**
 * 자막 한 줄에서 강조할 단어를 최대 두 개 선택한다.
 * 날짜와 시간 및 수치, 홍보 관련 키워드, 정보량이 큰 단어 순으로 찾는다.
 */
export function pickCaptionHighlights(text: string, limit = 2): string[] {
  const source = /\p{Script=Han}/u.test(text) && !/\p{Script=Hangul}/u.test(text)
    ? text.replace(/\s+/g, '')
    : text.trim()
  if (source.length < 4 || limit <= 0) return []
  const candidates: HighlightCandidate[] = []
  const add = (word: string, score: number, start = source.indexOf(word)) => {
    const clean = word.replace(/^[，。！？；：、,.!?;:]+|[，。！？；：、,.!?;:]+$/g, '')
    if (!clean || clean.length > 12 || start < 0 || HIGHLIGHT_STOP_WORDS.has(clean.toLowerCase())) return
    if (clean.length >= Math.max(8, Math.ceil(source.length * 0.65))) return
    candidates.push({ word: clean, score, start })
  }

  const priorityPatterns = [
    /\d{2,4}年\d{1,2}月\d{1,2}[日号]?/g,
    /\d{1,2}月\d{1,2}[日号]/g,
    /\d{1,2}[点时]\s*\d{0,2}分?/g,
    /\d+(?:\.\d+)?(?:%|％|万|亿|千|百|元|天|月|年|号|日|点|分|秒|个|条|家|次|倍|成|以上|以下)/g,
    /(?:AI|AIGC|Q[1-4]|B2B|B2C|1688|Amazon|亚马逊|아마존)/gi,
    /\d{2,4}년\s*\d{1,2}월\s*\d{1,2}일/g,
    /\d+(?:\.\d+)?\s*(?:원|초|분|시간|일|개월|년|개|명|배|seconds?\b|minutes?\b|hours?\b|days?\b|months?\b|years?\b)/gi
  ]
  priorityPatterns.forEach((pattern, patternIndex) => {
    for (const match of source.matchAll(pattern)) {
      add(match[0], 120 - patternIndex * 5 + Math.min(match[0].length, 8), match.index ?? 0)
    }
  })

  const searchable = source.toLowerCase()
  EMPHASIS_WORDS.forEach((word) => {
    const term = word.toLowerCase()
    let start = searchable.indexOf(term)
    while (start >= 0) {
      add(source.slice(start, start + word.length), 88 + Math.min(word.length, 8), start)
      start = searchable.indexOf(term, start + word.length)
    }
  })

  try {
    const Segmenter = (Intl as typeof Intl & {
      Segmenter?: new (locale?: string, options?: { granularity: 'word' }) => {
        segment(input: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }>
      }
    }).Segmenter
    if (Segmenter) {
      const language = /\p{Script=Hangul}/u.test(source) ? 'ko' : /\p{Script=Han}/u.test(source) ? 'zh-CN' : 'en'
      const segmenter = new Segmenter(language, { granularity: 'word' })
      for (const part of segmenter.segment(source)) {
        const word = part.segment.replace(/[，。！？；：、,.!?;:]/g, '')
        if (part.isWordLike === false || word.length < 2 || word.length > 7) continue
        const verbBoost = /增长|提升|降低|决定|锁定|发布|成立|出海|下单|备货|发货|성장|향상|감소|결정|출시|주문|배송|\b(?:grow|launch|order|ship)\b/i.test(word) ? 12 : 0
        add(word, 42 + word.length * 3 + verbBoost, part.index)
      }
    }
  } catch {
    /* Intl.Segmenter가 없으면 숫자와 키워드 규칙만 적용한다. */
  }

  const ranked = candidates.sort((a, b) => b.score - a.score || a.start - b.start)
  const selected: HighlightCandidate[] = []
  for (const candidate of ranked) {
    if (selected.some((item) => item.word === candidate.word)) continue
    const end = candidate.start + candidate.word.length
    const overlaps = selected.some((item) => {
      const itemEnd = item.start + item.word.length
      return candidate.start < itemEnd && end > item.start
    })
    if (overlaps) continue
    selected.push(candidate)
    if (selected.length >= limit) break
  }
  return selected.sort((a, b) => a.start - b.start).map((item) => item.word)
}

interface CaptionRun {
  text: string
  highlighted: boolean
}

function splitHighlightRuns(line: string, words: string[]): CaptionRun[] {
  if (!words.length) return [{ text: line, highlighted: false }]
  const runs: CaptionRun[] = []
  let cursor = 0
  while (cursor < line.length) {
    let nextWord = ''
    let nextAt = -1
    for (const word of words) {
      const at = line.indexOf(word, cursor)
      if (at >= 0 && (nextAt < 0 || at < nextAt || (at === nextAt && word.length > nextWord.length))) {
        nextAt = at
        nextWord = word
      }
    }
    if (nextAt < 0) {
      runs.push({ text: line.slice(cursor), highlighted: false })
      break
    }
    if (nextAt > cursor) runs.push({ text: line.slice(cursor, nextAt), highlighted: false })
    runs.push({ text: nextWord, highlighted: true })
    cursor = nextAt + nextWord.length
  }
  return runs.filter((run) => run.text.length > 0)
}

function wrapCaptionLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const paragraphs = text.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0)
  const lines: string[] = []
  for (const para of paragraphs.length ? paragraphs : [text]) {
    let current = ''
    for (const ch of para) {
      const trial = current + ch
      if (ctx.measureText(trial).width > maxWidth && current) {
        lines.push(current)
        current = ch
      } else {
        current = trial
      }
    }
    if (current) lines.push(current)
  }
  return lines.slice(0, 6)
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace('#', '')
  const n =
    m.length === 3
      ? m.split('').map((c) => parseInt(c + c, 16))
      : [
          parseInt(m.slice(0, 2), 16),
          parseInt(m.slice(2, 4), 16),
          parseInt(m.slice(4, 6), 16)
        ]
  return `rgba(${n[0] || 0},${n[1] || 0},${n[2] || 0},${alpha})`
}

/**
 * 브라우저 Canvas로 자막 한 줄을 투명한 전체 프레임 PNG로 그린다.
 * FFmpeg.wasm의 drawtext가 지원하지 않는 문자를 PNG 오버레이로 합성한다.
 */
export async function renderCaptionPng(
  text: string,
  style: CaptionStyle,
  width: number,
  height: number,
  captionBg: boolean,
  highlight: CaptionHighlightOptions = {}
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('자막 캔버스를 만들 수 없습니다.')
  ctx.clearRect(0, 0, width, height)

  const fontSize = Math.max(18, Math.round(height * style.fontSizeRatio))
  const family = style.fontFamily
    ? `"${style.fontFamily.replace(/"/g, '')}", ${CJK_FONT}`
    : CJK_FONT
  ctx.font = `${style.bold ? 'bold ' : ''}${fontSize}px ${family}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const highlightScale = Math.max(1, Math.min(1.5, highlight.scale ?? 1.2))
  const highlightWords = highlight.enabled
    ? (highlight.words?.filter(Boolean) ?? pickCaptionHighlights(text))
    : []
  // 강조 단어의 크기가 커지므로 줄바꿈 시 여유 폭을 두어 안전 영역을 지킨다.
  const maxWidth = width * (highlightWords.length ? 0.82 : 0.86)
  const lines = wrapCaptionLines(ctx, text.trim(), maxWidth)
  if (lines.length === 0) {
    return new Blob([], { type: 'image/png' })
  }

  const lineHeight = fontSize * (highlightWords.length ? Math.max(1.45, highlightScale * 1.24) : 1.4)
  const blockHeight = lines.length * lineHeight
  const padX = Math.round(fontSize * 0.7)
  const padY = Math.round(fontSize * 0.35)
  const fontFor = (highlighted: boolean) =>
    `${style.bold ? 'bold ' : ''}${Math.round(fontSize * (highlighted ? highlightScale : 1))}px ${family}`
  const measureLine = (line: string) =>
    splitHighlightRuns(line, highlightWords).reduce((sum, run) => {
      ctx.font = fontFor(run.highlighted)
      return sum + ctx.measureText(run.text).width
    }, 0)
  const blockWidth = Math.max(...lines.map(measureLine))

  let midY: number
  if (style.yRatio != null) {
    midY = Math.max(blockHeight / 2, Math.min(height - blockHeight / 2, height * style.yRatio))
  } else {
    switch (style.position) {
      case 'top': midY = height * 0.1 + blockHeight / 2; break
      case 'center': midY = height / 2; break
      default: midY = height - height * 0.1 - blockHeight / 2
    }
  }
  const midX = width * Math.max(0.07, Math.min(0.93, style.xRatio ?? 0.5))

  if (captionBg && style.bgOpacity > 0) {
    ctx.fillStyle = hexToRgba(style.bgColor || '#000000', style.bgOpacity)
    const x = midX - blockWidth / 2 - padX
    const y = midY - blockHeight / 2 - padY
    const w = blockWidth + padX * 2
    const h = blockHeight + padY * 2
    const r = 8
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
    ctx.fill()
  }

  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  lines.forEach((line, i) => {
    const ly = midY - blockHeight / 2 + lineHeight * i + lineHeight / 2
    const runs = splitHighlightRuns(line, highlightWords)
    const runWidths = runs.map((run) => {
      ctx.font = fontFor(run.highlighted)
      return ctx.measureText(run.text).width
    })
    let x = midX - runWidths.reduce((sum, value) => sum + value, 0) / 2
    ctx.textAlign = 'left'
    runs.forEach((run, runIndex) => {
      ctx.font = fontFor(run.highlighted)
      if (style.strokeWidth > 0) {
        ctx.lineWidth = Math.max(2, style.strokeWidth * 2)
        ctx.strokeStyle = style.strokeColor || '#000'
        ctx.strokeText(run.text, x, ly)
      }
      ctx.fillStyle = run.highlighted ? (highlight.color || '#ffd84d') : (style.color || '#fff')
      ctx.fillText(run.text, x, ly)
      x += runWidths[runIndex]
    })
  })

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('ffmpegExport.captionPngFailed')))), 'image/png')
  })
  return blob
}

function calcY(
  position: CaptionStyle['position'],
  videoHeight: number,
  fontSize: number
): string {
  switch (position) {
    case 'top':
      return String(Math.round(videoHeight * 0.08))
    case 'center':
      return '(h-text_h)/2'
    case 'bottom':
    default:
      return String(videoHeight - Math.round(videoHeight * 0.12) - fontSize)
  }
}
