/** Vercel AI SDK tool plans run through the shared canvas registry. */
import { generateText, tool, type ModelMessage } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'
import { desktop, isDesktop, providerRequest } from '@/services/desktop'
import { getLlmConfig } from '@/services/ai/runtime'
import { finalAnswerText } from '@/services/ai/finalAnswer'
import { adaptOpenAiChatBody } from '@/services/ai/openAiChat'
import { canvasVisionReady } from './agentMedia'
import type { AgentToolName } from './toolRegistry'

const text = z.string().describe('Original story, production prompt, continuation direction, or preference')
const shotId = z.string().describe('Storyboard shot ID, such as shot_xxx')
const subjectId = z.string().describe('Character ID')
const sceneId = z.string().describe('Scene ID')
const nodeId = z.string().describe('Canvas node ID')
const sourceNodeId = z.string().describe('Upstream node ID, required for continuation from an existing node')
const targetNodeId = z.string().describe('Downstream node ID')
const nodeLabel = z.string().describe('User-facing node label in Korean')
const visualPrompt = z.string().describe('English still frame description')
const imagePrompt = z.string().describe('English image generation prompt')
const videoPrompt = z.string().describe('English video direction with opening composition, action, camera movement and final frame')
const voiceover = z.string().describe('Speaker: exact spoken line. Use Korean for new dialogue.')
const duration = z.number().describe('Duration in seconds')
const cameraMovement = z.enum(['static', 'push', 'pull', 'pan', 'tilt', 'orbit']).describe('Camera movement')
const extractStage = z.enum(['subjects', 'scenes', 'shots']).describe('Extract this stage only')
const regenerate = z.boolean().optional().describe('True only when the user explicitly asks to regenerate an existing asset. Otherwise generate missing assets only.')

function canvasTool(description: string, shape: Record<string, z.ZodType>) {
  return tool({
    description,
    inputSchema: z.object(shape)
  })
}

export const studioAgentTools = {
  seed_script: canvasTool('Write the original story from recent user turns into the draft before writing a new script.', { text }),
  generate_play: canvasTool('Write a complete Markdown screenplay in Korean. Do not extract the cast or shots in this action.', { text: text.optional() }),
  continue_play: canvasTool('Append new Korean scenes while preserving existing scenes and any supplied dialogue.', { text: text.optional() }),
  extract_cast: canvasTool('Extract characters, locations or storyboard text from the script. Use extractStage only for explicit extraction or re-extraction. Do not use it to redraw images.', { extractStage: extractStage.optional() }),
  set_visual_style: canvasTool('Apply the confirmed visual style to the project for future characters, locations and shots. Put only the confirmed style in text. Do not rewrite the script or generate assets.', { text }),
  generate_storyboard: canvasTool('Legacy tool name for writing the complete script. Use extract_cast to break it into nodes.', {}),
  approve_play: canvasTool('Approve the script after user confirmation so downstream generation can proceed.', {}),
  revise_shot: canvasTool('Revise the image, video prompt, voiceover or duration of one storyboard shot.', {
    shotId,
    visualPrompt: visualPrompt.optional(),
    imagePrompt: imagePrompt.optional(),
    videoPrompt: videoPrompt.optional(),
    voiceover: voiceover.optional(),
    duration: duration.optional(),
    cameraMovement: cameraMovement.optional()
  }),
  generate_sheet: canvasTool('Generate a reference sheet for one character.', { subjectId }),
  generate_all_sheets: canvasTool('Fill missing character sheets. Set regenerate:true only when the user asks to redo existing sheets.', { regenerate }),
  generate_scene: canvasTool('Generate the location anchor image for one scene.', { sceneId }),
  generate_all_scenes: canvasTool('Fill missing scene anchors. Set regenerate:true when explicitly redrawing existing anchors.', { regenerate }),
  generate_shot_board: canvasTool('Generate a storyboard panel for one shot.', { shotId, regenerate }),
  generate_all_boards: canvasTool('Fill missing storyboard panels.', { regenerate }),
  generate_shot_image: canvasTool('Generate a keyframe for one shot.', { shotId, regenerate }),
  generate_all_images: canvasTool('Fill missing shot keyframes.', { regenerate }),
  generate_shot_frames: canvasTool('Generate the opening and closing frames of one shot.', { shotId, regenerate }),
  generate_all_frames: canvasTool('Fill every missing opening and closing frame pair.', { regenerate }),
  generate_video: canvasTool('Generate video for one shot.', { shotId, regenerate }),
  generate_all_videos: canvasTool('Generate video for shots that have none.', { regenerate }),
  generate_audio: canvasTool('Generate narration or dialogue audio for one shot.', { shotId, regenerate }),
  generate_all_audio: canvasTool('Fill missing narration or dialogue audio.', { regenerate }),
  sync_canvas: canvasTool('Synchronize canvas nodes with the current script.', {}),
  focus_node: canvasTool('Move the viewport to the given node.', { nodeId }),
  create_image_node: canvasTool('Create a freeform image node. Include sourceNodeId to attach it to an upstream node.', {
    text,
    sourceNodeId: sourceNodeId.optional()
  }),
  create_video_node: canvasTool('Create a freeform video node. Include sourceNodeId to attach it to an upstream node.', {
    text,
    duration: duration.optional(),
    sourceNodeId: sourceNodeId.optional()
  }),
  connect_nodes: canvasTool('Connect two existing nodes and use the upstream output as a downstream reference.', { sourceNodeId, targetNodeId }),
  delete_node: canvasTool('Remove one freeform image or video node.', { nodeId }),
  arrange_canvas: canvasTool('Rearrange the canvas.', {}),
  check_project: canvasTool('Inspect missing project elements without generating new content.', {}),
  update_node: canvasTool('Edit an image or video node, or replace the full prompt of subject:<id> or scene:<id> in text. Use run_node to generate after editing. Do not re-extract the script.', {
    nodeId,
    text: text.optional(),
    nodeLabel: nodeLabel.optional(),
    duration: duration.optional()
  }),
  run_node: canvasTool('Run an existing canvas node. Wait for the next planning round to obtain the real ID of a newly created node.', { nodeId }),
  optimize_node_prompt: canvasTool('Optimize the prompt of one freeform node without generating media.', {
    nodeId,
    text: text.optional()
  }),
  inspect_canvas_image: canvasTool('Read the actual image at a canvas node. Use a one-based referenceIndex to inspect a numbered reference. Omit it for the current output. Inspect before planning corrections; never guess identity.', {
    nodeId, referenceIndex: z.number().int().positive().optional(), text: text.optional()
  }),
  continue_from_video_tail: canvasTool('When explicitly asked, use the actual last frame of the generated video to create and connect a follow-on node and write its prompt. Do not submit generation.', { nodeId, text: text.optional() }),
  remember: canvasTool('Remember a long-term user preference.', { text }),
  forget: canvasTool('Forget one remembered item.', { text })
}

const TOOL_NAMES = new Set<string>(Object.keys(studioAgentTools))

function studioChatModel() {
  const { baseUrl, apiKey, model } = getLlmConfig()
  if (!baseUrl || !apiKey || !model) {
    throw new Error('설정에서 언어 모델의 주소, 키와 모델 ID를 입력하세요.')
  }
  const provider = createOpenAICompatible({
    name: 'studio',
    baseURL: baseUrl.replace(/\/+$/, ''),
    apiKey,
    fetch: studioLlmFetch,
    transformRequestBody: (body) => adaptOpenAiChatBody(baseUrl, body)
  })
  return provider.chatModel(model)
}

async function studioLlmFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isDesktop() || typeof desktop().llmFetch !== 'function') {
    return fetch(input, init)
  }
  const request = new Request(input, init)
  const body = request.method === 'GET' ? '' : await request.text()
  const res = await providerRequest(request.signal, (requestId) => desktop().llmFetch({
    requestId,
    url: request.url,
    authorization: request.headers.get('authorization') || '',
    body,
    timeoutMs: 120_000
  }))
  return new Response(res.text, {
    status: res.status,
    headers: { 'content-type': 'application/json' }
  })
}

function jsonPlan(textValue: string): { say: string; actions: Record<string, unknown>[] } {
  const start = textValue.indexOf('{')
  const end = textValue.lastIndexOf('}')
  if (start < 0 || end <= start) return { say: textValue.trim(), actions: [] }
  try {
    const obj = JSON.parse(textValue.slice(start, end + 1)) as { say?: unknown; actions?: unknown }
    const actions = Array.isArray(obj.actions)
      ? obj.actions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : []
    return { say: String(obj.say || textValue.trim() || ''), actions }
  } catch {
    return { say: textValue.trim(), actions: [] }
  }
}

export async function planStudioActions(options: {
  system: string
  messages: ModelMessage[]
  temperature?: number
  maxOutputTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** Disable tools and return only direct answers in question mode. */
  tools?: boolean
  onlyInspect?: boolean
}): Promise<{ say: string; actions: Record<string, unknown>[]; done: boolean }> {
  const available = options.onlyInspect ? ['inspect_canvas_image'] : [...TOOL_NAMES]
  const useTools = options.tools !== false
  const enabled = new Set(useTools ? available.filter(name => name !== 'inspect_canvas_image' || canvasVisionReady()) : [])
  const tools = Object.fromEntries(Object.entries(studioAgentTools).filter(([name]) => enabled.has(name)))
  const result = await generateText({
    model: studioChatModel(),
    system: options.system,
    messages: options.messages,
    ...(enabled.size ? { tools, toolChoice: 'auto' as const } : {}),
    temperature: options.temperature ?? 0.2,
    maxOutputTokens: options.maxOutputTokens ?? 2000,
    abortSignal: options.signal,
    timeout: options.timeoutMs ?? 120_000,
    maxRetries: 1
  })

  const answer = finalAnswerText(result.text)
  const calls = (useTools ? result.toolCalls : []).filter(
    (call) => enabled.has(call.toolName) && !(call as { invalid?: boolean }).invalid
  )
  if (!calls.length) {
    if (!answer) throw new Error('언어 모델이 답변이나 유효한 도구 호출을 보내지 않았어요. 다시 시도하거나 모델을 바꿔 주세요.')
    const parsed = jsonPlan(answer)
    const known = parsed.actions.filter((action) => enabled.has(String(action.tool || '')))
    return {
      say: (known.length ? parsed.say : answer).trim(),
      actions: known,
      done: known.length === 0
    }
  }
  return {
    say: answer || '작업을 시작할게요.',
    actions: calls.map((call) => {
      const input = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {}
      return { tool: call.toolName as AgentToolName, ...input }
    }),
    done: false
  }
}
