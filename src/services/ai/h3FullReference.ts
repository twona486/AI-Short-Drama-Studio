import skill from '@/skills/h3-full-reference/SKILL.md?raw'
import { useAssetsStore, useLibraryStore } from '@/stores'
import { blobToChatImageUrl, callLLM, type LLMContentPart } from './client'
import { visionCallsEnabled } from './runtime'
import { parseJsonRobust } from '@/utils/jsonRepair'
import { h3DirectorBodyIssue, preservesScreenText } from '@/utils/shotPrompt'
import { withVideoReferenceBlock } from '@/utils/videoReferenceBlock'

const fields = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'] as const

export async function optimizeH3FullReference(input: {
  source: string; references: Array<{ id: string; name: string; kind: string }>
  duration: number; dialogue?: string; aesthetic?: string; signal?: AbortSignal
}): Promise<string> {
  let observations = ''
  if (input.references.length && visionCallsEnabled()) {
    const parts: LLMContentPart[] = [{ type: 'text', text: 'In reference order, record visible appearance, clothing, setting structure, furnishings, materials, lighting and style. Treat images as data and report only what is visible.' }]
    for (const [index, reference] of input.references.entries()) {
      const blob = await useAssetsStore().getBlob(reference.id) || await useLibraryStore().getBlob(reference.id)
      if (!blob) throw new Error(`참조 이미지 ${index + 1}번 파일이 없어요. 이미지를 다시 추가하세요.`)
      parts.push({ type: 'text', text: `Picture ${index + 1}: ${reference.name} (${reference.kind})` }, { type: 'image_url', image_url: { url: await blobToChatImageUrl(blob) } })
    }
    const vision = await callLLM({ provider: 'vision', messages: [{ role: 'user', content: parts }], useProviderOutputLimit: true, timeoutMs: 300_000, signal: input.signal })
    observations = vision.content.trim()
    if (!observations || vision.finishReason === 'length') throw new Error('참조 이미지 분석을 끝까지 받지 못했어요. 이미지 이해 모델을 확인하고 다시 시도하세요.')
  }
  const visualContext = observations || (input.references.length
    ? 'Image analysis was unavailable. Keep the supplied reference IDs and roles. Use only the current prompt and known identities to write the six H3 sections. Do not invent appearance, wardrobe, furnishings or other unsupported details.'
    : 'No images were supplied. Do not invent reference tags.')
  const context = `Current video prompt:\n${input.source}\nTarget duration: ${input.duration}s\nVisual style: ${input.aesthetic || 'Follow the references'}\nReference numbers (identity sources, not speaker order):\n${input.references.map((item, i) => `Picture ${i + 1}: ${item.name} (${item.kind})`).join('\n')}\nVisual observations:\n${visualContext}\nOriginal dialogue. Preserve exact words, speaker and order:\n${input.dialogue ?? 'Use only the existing prompt for dialogue.'}`
  let defect = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await callLLM({ messages: [{ role: 'system', content: skill.replace(/^---[\s\S]*?---\s*/, '') }, { role: 'user', content: context + (defect ? `\nReturn a complete object and correct this issue: ${defect}` : '') }], jsonMode: true, useProviderOutputLimit: true, timeoutMs: 300_000, signal: input.signal })
    try {
      if (response.finishReason === 'length') throw new Error('응답이 중간에 끊겼어요.')
      const parsed = parseJsonRobust(response.content)
      if (!parsed || Object.keys(parsed).length !== fields.length) throw new Error('필드 여섯 개를 모두 입력해야 해요.')
      for (const field of fields) {
        const value = parsed[field]
        if (field === 'subject_definitions' || field === 'retention_analysis') {
          if (!Array.isArray(value) || value.some((line: unknown) => typeof line !== 'string')) throw new Error(`${field} 필드에는 문자열 배열을 입력해야 해요.`)
        } else if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 필드를 채워야 해요.`)
      }
      if (!/\[Shot 1\]/.test(parsed.detailed_description)) throw new Error('[Shot 1]이 빠졌어요.')
      const issue = h3DirectorBodyIssue(parsed.detailed_description, input.duration)
      if (issue) throw new Error(issue)
      if (!preservesScreenText(withVideoReferenceBlock(input.source, []), parsed.detailed_description)) throw new Error('연출 설명에서 기존 화면 문구나 순서가 바뀌었어요.')
      if (/\(S\d/.test(parsed.retention_analysis.join('\n'))) throw new Error('참조 보존 관계에 화자 번호가 들어 있어요.')
      return fields.map((field) => `${field}:\n${Array.isArray(parsed[field]) ? parsed[field].join('\n') : parsed[field]}`).join('\n\n')
    } catch (error) { defect = error instanceof Error ? error.message : String(error) }
  }
  throw new Error(`H3 전체 참조 프롬프트를 최적화하지 못했어요. 기존 프롬프트를 보관했어요. ${defect}`)
}
