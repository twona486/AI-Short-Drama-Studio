/**
 * 설정 도우미는 언어 모델을 사용해 비전, 이미지, 더빙 및 영상 연결을 구성한다.
 */

import { callLLM } from '@/services/ai/client'
import { getLlmConfig } from '@/services/ai/runtime'
import {
  IMAGE_PROVIDERS,
  LLM_PROVIDERS,
  TTS_PROVIDERS,
  VIDEO_PROVIDERS,
  VISION_PROVIDERS,
  applyProviderPreset,
  findProvider,
  matchProviderId,
  type ProviderPreset
} from '@/services/ai/providers'
import { parseJsonRobust } from '@/utils/jsonRepair'
import { normalizeModelNodeOptions } from '@/services/ai/modelOptions'
import {
  endpointReady,
  uniqueProfileName,
  useSettingsStore,
  type SetupKind
} from '@/stores/settings'
import { stillModeForVideoModel } from '@/types/canvas'
import settingsSkillRaw from '@/skills/settings-setup.md?raw'
import {
  normalizeAdapterInput,
  testEndpointConnection,
  type AdapterConfig
} from '@/services/ai/adapters'
import {
  addComfyUiProfiles,
  extractComfyMention,
  normalizeComfyBaseUrl
} from '@/services/settings/comfyQuickAdd'
import {
  discoverComfyWorkflows,
  fetchComfyUserdataWorkflow,
  parseComfyWorkflowJson
} from '@/services/settings/comfyWorkflows'
import {
  analyzeWorkflowWithLlm,
  describeInputMap,
  describeWorkflowKind,
  validateInputMap
} from '@/services/ai/comfyInputMap'

export interface SetupMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SetupEvent {
  kind?: 'think' | 'step' | 'log'
  label: string
  step?: string
  status?: 'running' | 'done' | 'fail'
}

export interface SetupTurnResult {
  reply: string
  chips: { label: string; text: string }[]
  opened?: SetupKind
}

function catalog(presets: ProviderPreset[]) {
  return presets
    .filter((p) => p.id !== 'custom')
    .map((p) => `${p.id}｜${p.name}｜${p.baseUrl}｜기본값 ${p.defaultModel}｜${p.models.join(', ')}`)
    .join('\n')
}

function maskKey(key: string) {
  const k = key.trim()
  if (!k) return '미입력'
  if (k.length <= 6) return '입력됨'
  return `${k.slice(0, 3)}…${k.slice(-4)}`
}

function snapshot() {
  const cfg = useSettingsStore().config
  const named = (kind: string, list: { id: string; name: string; baseUrl: string; apiKey: string; model: string; models?: string[]; adapter?: AdapterConfig }[]) =>
    list
      .map(
        (p) =>
          `- [${kind}] ${p.name} (${p.id}) url=${p.baseUrl || '없음'} key=${maskKey(p.apiKey)} model=${p.model || '없음'} adapter=${p.adapter?.type || '기본값'} models=${(p.models || []).join(', ') || '없음'}`
      )
      .join('\n')
  const videos = cfg.videos
    .map(
      (p) =>
        `- [video] ${p.name} (${p.id}) url=${p.baseUrl || '없음'} key=${maskKey(p.apiKey)} workflow=${p.workflowId || '없음'} adapter=${p.adapter?.type || '기본값'} style=${p.promptStyle} still=${p.stillMode || 'identity'}`
    )
    .join('\n')
  return `현재 기기의 설정(API 키 마스킹 적용)
LLM 사용 가능 여부 ${endpointReady(cfg.llm) ? '가능' : '불가'}
${named('llm', cfg.llms)}
${named('vision', cfg.visions)}
${named('image', cfg.images)}
${named('tts', cfg.ttsProfiles)}
${videos}`
}

// 연결 설정 도구의 입력과 한국어 답변 규칙.
const SYSTEM = `${settingsSkillRaw}

Return JSON only: { "say": "User-facing message in Korean (한국어)", "actions": [ ... ] }.
Return at most eight actions. If required information is missing, ask in say and return actions=[]. When the documentation provides enough information, produce actions.

可用工具：
{ "tool": "add_profile", "kind": "vision|image|tts|video|llm", "name": "显示名", "provider": "预设id，可选", "baseUrl": "", "apiKey": "", "model": "", "models": ["可选"], "voice": "tts可选", "workflowId": "video可选", "promptStyle": "scene-narrative|formatted", "stillMode": "identity|keyframe|storyboard，video可选。H3用人设+场景填 identity，其它模型要关键帧填 keyframe", "options": { "imageResolutions": ["1k","2k"], "videoResolutions": ["480p","720p","1080p"], "videoAudio": true, "lastFrameRequired": false, "audioField": "audio" }, "adapter": { "type": "openai-compatible|openai-images|http-custom|comfyui-workflow|comfyui-prompt", "path": "可选", "pollPath": "可选含{id}", "resultJsonPath": "可选", "authHeader": "可选", "authPrefix": "可选，Bearer 或空", "workflowTemplate": "ComfyUI /prompt JSON，可用{{prompt}}{{image}}" } }
{ "tool": "update_profile", "kind": "…", "id": "profile_id", "name": "可选", "baseUrl": "可选", "apiKey": "可选", "model": "可选", "models": ["可选"], "voice": "可选", "workflowId": "可选", "promptStyle": "可选", "options": "可选，同上", "adapter": "可选，同上" }
{ "tool": "select_profile", "kind": "…", "id": "…", "model": "可选，设为当前模型" }
{ "tool": "add_model", "kind": "llm|vision|image|tts", "id": "profile_id，可省略表示当前套", "model": "模型名" }
{ "tool": "test_connection", "kind": "llm|vision|image|tts|video", "id": "可选，默认当前套" }
{ "tool": "add_comfyui", "baseUrl": "http://127.0.0.1:8188", "apiKey": "可选", "kinds": ["image","video"], "test": true }
{ "tool": "list_comfy_workflows", "kind": "image|video", "id": "可选 profile id" }
{ "tool": "set_workflow_template", "kind": "image|video", "id": "可选", "workflowTemplate": "{...API Format JSON...}", "path": "可选，从 list 结果里的 path 拉取" }

Presets (id | name | URL | default model | common models):
LLM
${catalog(LLM_PROVIDERS)}
Vision
${catalog(VISION_PROVIDERS)}
Image
${catalog(IMAGE_PROVIDERS)}
Dubbing
${catalog(TTS_PROVIDERS)}
Video
${catalog(VIDEO_PROVIDERS)}

注意：
- 用户贴 API 文档或中转地址时：provider 必须是 custom，按文档原文抽 Base URL 和模型名，立刻 add_profile。禁止拒绝。
- 文档同时含聊天 / 看图 / 生图时，每种 kind 各写一条，可共用同一套 Key 和地址。
- Base URL 写到 /v1 这一层即可，不要带 /chat/completions 或 /images/generations。
- 只有用户没给任何文档、只说「帮我配」时，才从上面的大厂预设里选。
- 视频的 model 若没单独给 workflowId，就当作 workflowId。
- 配音默认音色 longanhuan_v3.6，用户没提音色就用这个。
- provider 对得上大厂预设、且用户没另给第三方地址时，用预设补全；用户给的 URL 与预设域名不一致时一律当 custom，不要改写成官方地址。
- 自建 ComfyUI（如 http://127.0.0.1:8188）：优先用 add_comfyui 一次加生图+视频。用户只说「我的 ComfyUI 在 xxx」或只贴地址时立刻添加，不要追问模型名。
- 有工作流 JSON 再写入 adapter.workflowTemplate；没有也不要拒绝添加，提醒出片前在设置页适配器粘贴。不要编造 AutoDL 生命周期或假工作流。
- OpenAI 兼容中转：LLM/视觉用默认；生图若不是 /images/generations，设 adapter.type=http-custom 并填 path、resultJsonPath。
- 写完接入后，若用户要求「测一下」，调用 test_connection。
- options 只写文档里明确出现的节点参数，禁止编造。生图文档列出 1K/2K/4K 时，imageResolutions 只收录文档有的档位，写成小写 1k、2k、4k。文档没写分辨率就不要填 imageResolutions。
- 视频文档列出 480P、720P、768P、1080P 时，videoResolutions 只收录文档有的档位，写成小写 480p、720p、768p、1080p。文档没写视频分辨率就不要填 videoResolutions。
- 视频文档有音频开关时 videoAudio 才写 true，并把文档里的字段名写入 audioField（必须含 audio，例如 audio 或 generate_audio）。没有音频开关就不要写 videoAudio。
- 尾帧默认不是必填。只有文档写明尾帧、结束帧或 last frame 必填时，lastFrameRequired 才写 true。文档没提尾帧，就不要写这个字段。`

function providersFor(kind: SetupKind): ProviderPreset[] {
  if (kind === 'llm') return LLM_PROVIDERS
  if (kind === 'vision') return VISION_PROVIDERS
  if (kind === 'image') return IMAGE_PROVIDERS
  if (kind === 'tts') return TTS_PROVIDERS
  return VIDEO_PROVIDERS
}

function parseKind(raw: unknown): SetupKind | null {
  const k = String(raw || '')
  if (k === 'llm' || k === 'vision' || k === 'image' || k === 'tts' || k === 'video') {
    return k
  }
  return null
}

function normalizeBaseUrl(url: string) {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/completions$/i, '')
    .replace(/\/images\/(generations|edits)$/i, '')
    .replace(/\/audio\/speech$/i, '')
    .replace(/\/+$/, '')
}

function mergePreset(kind: SetupKind, action: Record<string, unknown>) {
  const providerId = String(action.provider || '').trim()
  const presets = providersFor(kind)
  const preset = providerId ? findProvider(providerId, presets) : undefined
  const current = {
    baseUrl: normalizeBaseUrl(String(action.baseUrl || '')),
    model: String(action.model || action.workflowId || ''),
    models: Array.isArray(action.models) ? action.models.map(String) : []
  }
  if (!preset || preset.id === 'custom') {
    return {
      provider: 'custom',
      baseUrl: current.baseUrl,
      model: current.model,
      models: current.models
    }
  }
  if (current.baseUrl && matchProviderId(current.baseUrl, presets) === 'custom') {
    return {
      provider: 'custom',
      baseUrl: current.baseUrl,
      model: current.model || preset.defaultModel,
      models: current.models.length ? current.models : current.model ? [current.model] : []
    }
  }
  return applyProviderPreset(current, preset)
}

function nextName(kind: SetupKind, wanted: string) {
  const settings = useSettingsStore()
  const names =
    kind === 'llm'
      ? settings.config.llms.map((p) => p.name)
      : kind === 'vision'
        ? settings.config.visions.map((p) => p.name)
        : kind === 'image'
          ? settings.config.images.map((p) => p.name)
          : kind === 'tts'
            ? settings.config.ttsProfiles.map((p) => p.name)
            : kind === 'video'
              ? settings.config.videos.map((p) => p.name)
              : settings.config.ttsProfiles.map((p) => p.name)
  return uniqueProfileName(names, wanted || kind)
}

async function runAction(action: Record<string, unknown>): Promise<{ ok: boolean; detail: string; kind?: SetupKind }> {
  const settings = useSettingsStore()
  const tool = String(action.tool || '')
  const kind = parseKind(action.kind)
  if (!kind) return { ok: false, detail: '유효한 kind가 없습니다.' }

  if (tool === 'list_comfy_workflows') {
    if (kind !== 'image' && kind !== 'video') {
      return { ok: false, detail: 'list_comfy_workflows는 image와 video를 지원합니다.', kind: kind || undefined }
    }
    const id = String(action.id || '').trim()
    const ep =
      kind === 'image'
        ? id
          ? settings.config.images.find((p) => p.id === id)
          : settings.config.image
        : id
          ? settings.config.videos.find((p) => p.id === id)
          : settings.config.video
    if (!ep?.baseUrl) return { ok: false, detail: 'ComfyUI 주소가 없습니다. 먼저 add_comfyui를 실행하세요.', kind }
    const res = await discoverComfyWorkflows({
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      adapter: ep.adapter
    })
    // set_workflow_template이 파일을 읽을 수 있도록 경로에 디렉터리 접두사를 추가한다.
    const names = res.workflows
      .slice(0, 30)
      .map((w) => `- ${w.name} (${w.root ? `${w.root}/${w.path}` : w.path})`)
      .join('\n')
    return {
      ok: res.reachable,
      detail: `${res.message}${names ? '\n' + names : ''}`,
      kind
    }
  }

  if (tool === 'set_workflow_template') {
    if (kind !== 'image' && kind !== 'video') {
      return { ok: false, detail: 'set_workflow_template은 image와 video를 지원합니다.', kind: kind || undefined }
    }
    const id = String(action.id || '').trim()
    if (id) {
      if (kind === 'image') settings.selectImage(id)
      else settings.selectVideo(id)
    }
    const ep = kind === 'image' ? settings.config.image : settings.config.video
    let template = String(action.workflowTemplate || '').trim()
    const path = String(action.path || '').trim()
    if (!template && path) {
      const fetched = await fetchComfyUserdataWorkflow({
        baseUrl: ep.baseUrl,
        path,
        apiKey: ep.apiKey,
        adapter: ep.adapter
      })
      if (!fetched.ok || !fetched.template) {
        return { ok: false, detail: fetched.detail, kind }
      }
      template = fetched.template
    }
    if (!template) {
      // 최근 사용자 메시지에서 찾지 못한 필드를 요청한다.
      return { ok: false, detail: 'workflowTemplate JSON 또는 list_comfy_workflows의 path를 제공하세요.', kind }
    }
    const parsed = parseComfyWorkflowJson(template)
    if (!parsed.ok || !parsed.template) return { ok: false, detail: parsed.detail, kind }
    const payload = parsed.payload || JSON.parse(parsed.template)
    const adapter = {
      ...(ep.adapter || {}),
      type: 'comfyui-prompt' as const,
      path: ep.adapter?.path || '/prompt',
      pollPath: ep.adapter?.pollPath || '/history/{id}',
      workflowTemplate: parsed.template
    }
    if (kind === 'image') settings.patchImage({ adapter })
    else settings.patchVideo({ adapter })
    // 도우미가 프롬프트와 참조 입력 위치를 파악하도록 하고 매핑을 함께 저장한다.
    try {
      const { map, error } = await analyzeWorkflowWithLlm(payload)
      const checked = validateInputMap(payload, map)
      const withMap = { ...adapter, inputMap: checked }
      if (kind === 'image') settings.patchImage({ adapter: withMap })
      else settings.patchVideo({ adapter: withMap })
      return {
        ok: true,
        detail: checked.bindings.length
          ? `${kind}의 workflowTemplate을 저장했습니다. 유형은 ${describeWorkflowKind(checked.kind)}입니다. 입력 매핑 ${describeInputMap(checked)}${error ? `（${error}）` : ''}`
          : `${kind}의 workflowTemplate을 저장했지만 값을 주입할 입력 노드를 찾지 못했습니다(${error || '알 수 없는 원인'}). 생성 시 워크플로의 고정값을 사용합니다.`,
        kind
      }
    } catch {
      return { ok: true, detail: `${kind}의 workflowTemplate을 저장했습니다. 분석하려면 설정의 ‘도우미로 워크플로 분석’을 누르세요.`, kind }
    }
  }

  if (tool === 'add_comfyui') {
    const baseUrl = normalizeComfyBaseUrl(String(action.baseUrl || ''))
    if (!baseUrl) return { ok: false, detail: 'add_comfyui에는 baseUrl이 필요합니다.' }
    const kindsRaw = Array.isArray(action.kinds) ? action.kinds.map(String) : ['image', 'video']
    const kinds = kindsRaw.filter((k): k is 'image' | 'video' => k === 'image' || k === 'video')
    const result = await addComfyUiProfiles({
      baseUrl,
      apiKey: String(action.apiKey || '').trim(),
      kinds: kinds.length ? kinds : ['image', 'video'],
      select: true,
      test: action.test !== false
    })
    const opened = result.videoId ? 'video' : result.imageId ? 'image' : undefined
    return { ok: result.ok, detail: result.notes.join('；'), kind: opened }
  }

  if (tool === 'test_connection') {
    const id = String(action.id || '').trim()
    let ep: { baseUrl?: string; apiKey?: string; model?: string; workflowId?: string; adapter?: AdapterConfig; provider?: string } | undefined
    if (kind === 'llm') ep = id ? settings.config.llms.find((p) => p.id === id) : settings.config.llm
    else if (kind === 'vision') ep = id ? settings.config.visions.find((p) => p.id === id) : settings.config.vision
    else if (kind === 'image') ep = id ? settings.config.images.find((p) => p.id === id) : settings.config.image
    else if (kind === 'tts') ep = id ? settings.config.ttsProfiles.find((p) => p.id === id) : settings.config.tts
    else if (kind === 'video') ep = id ? settings.config.videos.find((p) => p.id === id) : settings.config.video
    if (!ep) return { ok: false, detail: '시험할 연결을 찾을 수 없습니다.', kind }
    if (id) {
      if (kind === 'llm') settings.selectLlm(id)
      else if (kind === 'vision') settings.selectVision(id)
      else if (kind === 'image') settings.selectImage(id)
      else if (kind === 'tts') settings.selectTts(id)
      else if (kind === 'video') settings.selectVideo(id)
    }
    const result = await testEndpointConnection(kind, ep)
    return { ok: result.ok, detail: result.ok ? `연결 테스트 통과 ${result.detail}` : `연결 테스트 실패 ${result.detail}`, kind }
  }

  if (tool === 'add_profile') {
    const merged = mergePreset(kind, action)
    const name = nextName(kind, String(action.name || merged.provider || kind))
    const apiKey = String(action.apiKey || '').trim()
    const baseUrl = normalizeBaseUrl(String(action.baseUrl || merged.baseUrl))
    const models = Array.isArray(action.models) && action.models.length
      ? action.models.map(String)
      : merged.models
    const model = String(action.model || merged.model || models[0] || '').trim()
    if (!baseUrl) return { ok: false, detail: `${name}의 API 주소가 없습니다.`, kind }
    let adapter = normalizeAdapterInput(action.adapter)
    const pastedWf = String(
      action.workflowTemplate ||
        (action.adapter && typeof action.adapter === 'object'
          ? (action.adapter as Record<string, unknown>).workflowTemplate
          : '') ||
        ''
    ).trim()
    if (pastedWf && (!adapter || !adapter.workflowTemplate)) {
      adapter = { ...(adapter || {}), type: adapter?.type || 'comfyui-prompt', workflowTemplate: pastedWf }
    }
    if (kind === 'video') {
      let workflowId = String(action.workflowId || model || merged.model).trim()
      const isComfyPrompt =
        adapter?.type === 'comfyui-prompt' ||
        /localhost|127\.0\.0\.1/i.test(baseUrl)
      if (!workflowId && isComfyPrompt) workflowId = 'comfyui-local'
      if (!workflowId) return { ok: false, detail: `${name}의 워크플로 ID가 없습니다.`, kind }
      const stillRaw = String(action.stillMode || '').trim()
      const stillMode =
        stillRaw === 'keyframe' || stillRaw === 'storyboard' || stillRaw === 'identity'
          ? stillRaw
          : stillModeForVideoModel('h3', { workflowId, provider: merged.provider, stillMode: stillRaw })
      const resolvedAdapter =
        adapter ||
        (isComfyPrompt ? { type: 'comfyui-prompt' as const } : undefined)
      const id = settings.addVideo({
        name,
        baseUrl,
        apiKey,
        workflowId,
        promptStyle: action.promptStyle === 'formatted' ? 'formatted' : 'scene-narrative',
        provider: merged.provider,
        stillMode,
        adapter: resolvedAdapter,
        options: normalizeModelNodeOptions(action.options)
      })
      return { ok: true, detail: `영상 연결 ‘${name}’을 저장했습니다.(${id})`, kind }
    }
    if (!model && adapter?.type !== 'comfyui-prompt') return { ok: false, detail: `${name}의 모델 이름이 없습니다.`, kind }
    const seed = {
      name,
      baseUrl,
      apiKey,
      model: model || (adapter?.type === 'comfyui-prompt' ? 'comfyui' : ''),
      models: models.length ? models : model ? [model] : ['comfyui'],
      provider: merged.provider,
      adapter:
        adapter ||
        (kind === 'image' && /localhost|127\.0\.0\.1/i.test(baseUrl)
          ? { type: 'comfyui-prompt' as const }
          : undefined),
      options: normalizeModelNodeOptions(action.options)
    }
    if (kind === 'llm') settings.addLlm(seed)
    else if (kind === 'vision') settings.addVision(seed)
    else if (kind === 'image') settings.addImage(seed)
    else if (kind === 'tts') {
      settings.addTts({ ...seed, voice: String(action.voice || 'longanhuan_v3.6') })
    }
    return { ok: true, detail: `${labelOf(kind)} 연결 ‘${name}’을 저장했습니다.`, kind }
  }

  if (tool === 'update_profile') {
    const id = String(action.id || '').trim()
    if (!id) return { ok: false, detail: '갱신하려면 id가 필요합니다.', kind }
    const patch: Record<string, unknown> = {}
    if (action.name) patch.name = String(action.name).trim()
    if (action.baseUrl) patch.baseUrl = normalizeBaseUrl(String(action.baseUrl))
    if (action.apiKey) patch.apiKey = String(action.apiKey).trim()
    if (action.model) patch.model = String(action.model).trim()
    if (action.provider) patch.provider = String(action.provider).trim()
    if (Array.isArray(action.models)) patch.models = action.models.map(String)
    if (action.options) {
      const options = normalizeModelNodeOptions(action.options)
      if (options) patch.options = options
    }
    if (action.adapter) {
      const adapter = normalizeAdapterInput(action.adapter)
      if (adapter) patch.adapter = adapter
    }
    if (kind === 'tts' && action.voice) patch.voice = String(action.voice)
    if (kind === 'video') {
      if (action.workflowId || action.model) patch.workflowId = String(action.workflowId || action.model).trim()
      if (action.promptStyle) patch.promptStyle = action.promptStyle === 'formatted' ? 'formatted' : 'scene-narrative'
      if (action.stillMode === 'identity' || action.stillMode === 'keyframe' || action.stillMode === 'storyboard') {
        patch.stillMode = action.stillMode
      }
      const cur = settings.config.videos.find((p) => p.id === id)
      if (!cur) return { ok: false, detail: '이 영상 연결을 찾을 수 없습니다.', kind }
      settings.selectVideo(id)
      settings.patchVideo(patch)
      return { ok: true, detail: `영상 연결 ‘${cur.name}’을 갱신했습니다.`, kind }
    }
    const list =
      kind === 'llm'
        ? settings.config.llms
        : kind === 'vision'
          ? settings.config.visions
          : kind === 'image'
            ? settings.config.images
            : settings.config.ttsProfiles
    const cur = list.find((p) => p.id === id)
    if (!cur) return { ok: false, detail: '이 연결을 찾을 수 없습니다.', kind }
    if (kind === 'llm') {
      settings.selectLlm(id)
      settings.patchLlm(patch)
    } else if (kind === 'vision') {
      settings.selectVision(id)
      settings.patchVision(patch)
    } else if (kind === 'image') {
      settings.selectImage(id)
      settings.patchImage(patch)
    } else {
      settings.selectTts(id)
      settings.patchTts(patch)
    }
    return { ok: true, detail: `${labelOf(kind)} 연결 ‘${cur.name}’을 갱신했습니다.`, kind }
  }

  if (tool === 'select_profile') {
    const id = String(action.id || '').trim()
    const model = String(action.model || '').trim()
    if (!id) return { ok: false, detail: '선택하려면 id가 필요합니다.', kind }
    if (kind === 'llm') {
      if (model) settings.selectLlmModel(id, model)
      else settings.selectLlm(id)
    } else if (kind === 'vision') {
      if (model) settings.selectVisionModel(id, model)
      else settings.selectVision(id)
    } else if (kind === 'image') {
      if (model) settings.selectImageModel(id, model)
      else settings.selectImage(id)
    } else if (kind === 'tts') {
      if (model) settings.selectTtsModel(id, model)
      else settings.selectTts(id)
    } else if (kind === 'video') settings.selectVideo(id)
    return { ok: true, detail: `이 ${labelOf(kind)} 연결로 전환했습니다.`, kind }
  }

  if (tool === 'add_model') {
    const model = String(action.model || '').trim()
    if (!model) return { ok: false, detail: '모델 이름이 없습니다.', kind }
    if (kind === 'video' || kind === 'music') return { ok: false, detail: '영상 연결에서는 워크플로 ID를 변경하세요.', kind }
    const id = String(action.id || '').trim()
    if (id) {
      if (kind === 'llm') settings.selectLlm(id)
      else if (kind === 'vision') settings.selectVision(id)
      else if (kind === 'image') settings.selectImage(id)
      else if (kind === 'tts') settings.selectTts(id)
    }
    settings.addModel(kind, model)
    return { ok: true, detail: `모델 ${model}을 추가했습니다.`, kind }
  }

  return { ok: false, detail: `알 수 없는 도구 ${tool}` }
}

function labelOf(kind: SetupKind) {
  return {
    llm: '언어 모델',
    vision: '비전',
    image: '이미지 생성',
    tts: '더빙',
    video: '영상',
    music: '배경음악'
  }[kind]
}

function looksLikePlaceholderKey(key: string) {
  return /^(sk-)?(xxx+|your[_-]?api[_-]?key|changeme|placeholder|<.+>|\{.+\})$/i.test(key.trim())
}

function extractComfyWorkflowTemplate(text: string): string {
  const trimmed = text.trim()
  // 응답 전체가 JSON인 경우
  if (trimmed.startsWith('{') && trimmed.includes('class_type')) {
    try {
      const obj = JSON.parse(trimmed)
      return JSON.stringify(obj, null, 2)
    } catch { /* fall through */ }
  }
  // Markdown 코드 블록에서 JSON을 추출한다.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1] && /class_type|"prompt"\s*:/.test(fence[1])) {
    try {
      const obj = JSON.parse(fence[1].trim())
      return JSON.stringify(obj, null, 2)
    } catch { /* ignore */ }
  }
  // 가장 바깥의 중괄호를 찾는다.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start && /class_type/.test(text.slice(start, end + 1))) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1))
      return JSON.stringify(obj, null, 2)
    } catch { /* ignore */ }
  }
  return ''
}

function extractApiKey(text: string) {
  const patterns = [
    /\b(sk-[A-Za-z0-9_-]{12,})\b/,
    /(?:api[_-]?key|secret[_-]?key|Authorization)[：:=\s]+(?:Bearer\s+)?([A-Za-z0-9._-]{12,})/i
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m?.[1] && !looksLikePlaceholderKey(m[1])) return m[1]
  }
  return ''
}

function extractBaseUrls(text: string) {
  const urls = [...text.matchAll(/https?:\/\/[^\s"'<>`]+/gi)].map((m) =>
    normalizeBaseUrl(m[0].replace(/[),.;]+$/g, ''))
  )
  const unique = [...new Set(urls)].filter((u) => {
    try {
      const host = new URL(u).hostname
      const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(host)
      return (host.includes('.') || local) && !/example\.com/i.test(host)
    } catch {
      return false
    }
  })
  unique.sort((a, b) => Number(/\/v\d+$/i.test(b)) - Number(/\/v\d+$/i.test(a)))
  return unique
}

function extractModels(text: string) {
  const found: string[] = []
  const push = (raw: string) => {
    const s = raw.trim()
    if (s.length < 2 || s.length > 80 || /\s/.test(s) || /^https?:/i.test(s)) return
    found.push(s)
  }
  for (const m of text.matchAll(/"models?"\s*:\s*"([^"]+)"/gi)) push(m[1])
  for (const m of text.matchAll(/"models?"\s*:\s*\[([^\]]+)\]/gi)) {
    for (const item of m[1].matchAll(/"([^"]+)"/g)) push(item[1])
  }
  for (const m of text.matchAll(/模型[名]?[：:\s]+`?([A-Za-z0-9._:-]+)`?/g)) push(m[1])
  for (const m of text.matchAll(/`([A-Za-z0-9._:-]{3,60})`/g)) {
    if (/gpt|qwen|deepseek|claude|gemini|glm|kimi|dall|seedream|flux|wan|hailuo|tts|vl-|minimax|doubao/i.test(m[1])) {
      push(m[1])
    }
  }
  return [...new Set(found)]
}

function inferKindsFromDocs(text: string, models: string[]): SetupKind[] {
  const t = `${text}\n${models.join('\n')}`.toLowerCase()
  const found = new Set<SetupKind>()
  if (/视觉|看图|多模态|qwen-vl|\bvl-|\bgpt-4o|claude|gemini/.test(t) || models.some((m) => /vl|vision|gpt-4o/i.test(m))) {
    found.add('vision')
  }
  if (/生图|文生图|images\/generations|dall-e|seedream|flux|qwen-image|imagen|kolors/.test(t) || models.some((m) => /dall-e|seedream|flux|image|imagen|kolors/i.test(m))) {
    found.add('image')
  }
  if (/配音|\btts\b|speech|音色|cosyvoice/.test(t) || models.some((m) => /tts|speech|cosy/i.test(m))) {
    found.add('tts')
  }
  if (/视频生成|文生视频|video\/generations|hailuo|wan2|kling|runway|comfyui|8188/.test(t) || models.some((m) => /hailuo|wan|kling|video/i.test(m))) {
    found.add('video')
  }
  if (/comfyui|system_stats|\/prompt\b/.test(t) && /生图|image|图生/.test(t)) {
    found.add('image')
  }
  if (/语言模型|对话模型|聊天补全|chat\/completions|\bllm\b/.test(t) || models.some((m) => /gpt|deepseek|qwen|claude|kimi|glm|minimax|doubao/i.test(m))) {
    found.add('llm')
  }
  if (!found.size) found.add('llm')
  return [...found]
}

function nameFromUrl(url: string, kind: SetupKind) {
  try {
    return `${new URL(url).host.replace(/^www\./, '')} ${labelOf(kind)}`
  } catch {
    return `사용자 지정 ${labelOf(kind)}`
  }
}

function pickModelForKind(kind: SetupKind, models: string[]) {
  const hit = models.find((m) => {
    if (kind === 'image') return /dall-e|seedream|flux|image|imagen|kolors/i.test(m)
    if (kind === 'vision') return /vl|vision|gpt-4o/i.test(m)
    if (kind === 'tts') return /tts|speech|cosy/i.test(m)
    if (kind === 'video') return /hailuo|wan|kling|video/i.test(m)
    return /gpt|deepseek|qwen|claude|kimi|glm|minimax|doubao/i.test(m)
  })
  return hit || models[0] || ''
}

function actionsFromDocs(text: string): Record<string, unknown>[] {
  const urls = extractBaseUrls(text)
  if (!urls.length) return []
  const baseUrl = urls[0]
  const models = extractModels(text)
  const apiKey = extractApiKey(text)
  const kinds = inferKindsFromDocs(text, models)
  const actions: Record<string, unknown>[] = []
  for (const kind of kinds) {
    const model = pickModelForKind(kind, models)
    if (!model) continue
    const local = /localhost|127\.0\.0\.1/i.test(baseUrl) || /comfyui/i.test(text)
    const adapter =
      local && (kind === 'video' || kind === 'image')
        ? { type: 'comfyui-prompt' }
        : kind === 'image' && /images\/generations|openai/i.test(text)
          ? { type: 'openai-images' }
          : kind === 'llm' || kind === 'vision'
            ? { type: 'openai-compatible' }
            : undefined
    actions.push({
      tool: 'add_profile',
      kind,
      name: nameFromUrl(baseUrl, kind),
      provider: 'custom',
      baseUrl,
      apiKey,
      model: model || (local ? 'comfyui' : model),
      models: models.length ? models : local ? ['comfyui'] : models,
      workflowId: kind === 'video' ? model || (local ? 'comfyui-local' : undefined) : undefined,
      adapter
    })
  }
  return actions.slice(0, 8)
}

function parseAgentJson(text: string): { say: string; actions: Record<string, unknown>[] } {
  try {
    const obj = parseJsonRobust(text)
    return {
      say: String(obj.say || obj.reply || '확인했습니다.'),
      actions: Array.isArray(obj.actions) ? obj.actions : []
    }
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return { say: text.slice(0, 400), actions: [] }
    try {
      const obj = JSON.parse(text.slice(start, end + 1))
      return {
        say: String(obj.say || '확인했습니다.'),
        actions: Array.isArray(obj.actions) ? obj.actions : []
      }
    } catch {
      return { say: text.slice(0, 400), actions: [] }
    }
  }
}

export function llmSetupReady() {
  try {
    const cfg = getLlmConfig()
    return Boolean(cfg.baseUrl && cfg.apiKey)
  } catch {
    return false
  }
}

export async function runSetupAgentTurn(
  history: SetupMessage[],
  userText: string,
  onProgress?: (ev: SetupEvent) => void,
  signal?: AbortSignal
): Promise<SetupTurnResult> {
  if (!llmSetupReady()) {
    return {
      reply: '왼쪽의 ‘언어 모델’에서 API 주소와 API 키를 먼저 입력하세요. 설정을 마치면 비전, 이미지 생성, 더빙, 영상 연결을 추가할 수 있습니다.',
      chips: [{ label: '언어 모델 설정 열기', text: '__open_llm__' }]
    }
  }

  onProgress?.({ kind: 'think', label: '연결 방법을 확인하는 중…', status: 'running' })
  const recent = history.slice(-12).map((m) => ({
    role: m.role,
    content: m.content
  }))

  // ComfyUI 주소만 제공하면 이미지와 영상 연결을 바로 추가한다.
  const comfyMention = extractComfyMention(userText)
  const comfyTplEarly = extractComfyWorkflowTemplate(userText)
  if (comfyMention && !comfyTplEarly && userText.length < 400) {
    onProgress?.({ kind: 'step', step: 'comfy-quick', label: 'add_comfyui', status: 'running' })
    const onlyVideo = /只要视频|仅视频|只加视频/.test(userText)
    const onlyImage = /只要生图|仅生图|只加生图|只要出图/.test(userText)
    const kinds: Array<'image' | 'video'> = onlyVideo
      ? ['video']
      : onlyImage
        ? ['image']
        : ['image', 'video']
    const result = await addComfyUiProfiles({
      baseUrl: comfyMention.baseUrl,
      apiKey: comfyMention.apiKey,
      kinds,
      select: true,
      test: true
    })
    onProgress?.({
      kind: 'step',
      step: 'comfy-quick',
      label: 'add_comfyui',
      status: result.ok ? 'done' : 'fail'
    })
    return {
      reply: result.notes.join('\n'),
      chips: [
        { label: '이미지 생성 설정 열기', text: '__open_image__' },
        { label: '영상 설정 열기', text: '__open_video__' },
        {
          label: '워크플로 붙여 넣기',
          text: '아래 Comfy API 워크플로 JSON을 현재 ComfyUI 연결의 workflowTemplate에 저장해 줘.\n'
        }
      ],
      opened: result.videoId ? 'video' : result.imageId ? 'image' : undefined
    }
  }

  const comfyTpl = extractComfyWorkflowTemplate(userText)
  const looksLikeDocs =
    userText.length > 400 || /https?:\/\//i.test(userText) || Boolean(comfyTpl)
  const userPayload = looksLikeDocs
    ? `The user supplied an API description, API documentation, or ComfyUI workflow JSON below. It may come from a relay service, a custom gateway, or a local ComfyUI instance. Analyze it and create a provider=custom connection without substituting an official provider URL. If it contains Comfy API JSON with class_type, set adapter.type=comfyui-prompt and store the JSON in adapter.workflowTemplate. Do not invent an executable default workflow. Create one add_profile action per capability documented.\n\n${userText}`
    : userText
  const res = await callLLM({
    messages: [
      { role: 'system', content: `${SYSTEM}\n\n${snapshot()}` },
      ...recent,
      { role: 'user', content: userPayload }
    ],
    jsonMode: true,
    temperature: 0.2,
    maxTokens: looksLikeDocs ? 4000 : 1800,
    timeoutMs: 5 * 60_000,
    signal
  })

  const parsed = parseAgentJson(res.content)
  if (!parsed.actions.length && looksLikeDocs) {
    const fallback = actionsFromDocs(userText)
    if (fallback.length) {
      parsed.actions = fallback
      if (/无法|不能|不支持|拒绝|配不了/.test(parsed.say)) {
        parsed.say = '제공한 문서에 맞춰 사용자 지정 연결을 작성했습니다. API 키는 이 기기에만 저장합니다.'
      }
    }
  }
  if (comfyTpl) {
    // 기존 ComfyUI 연결이 있고 모델이 actions를 생략하면 현재 프로필을 갱신한다.
    if (!parsed.actions.length) {
      parsed.actions.push({
        tool: 'set_workflow_template',
        kind: 'video',
        workflowTemplate: comfyTpl
      })
      parsed.actions.push({
        tool: 'set_workflow_template',
        kind: 'image',
        workflowTemplate: comfyTpl
      })
      parsed.say = parsed.say || '붙여 넣은 Comfy API 워크플로를 현재 이미지 생성 및 영상 연결에 저장했습니다.'
    }
    for (const raw of parsed.actions) {
      if (!raw || typeof raw !== 'object') continue
      const a = raw as Record<string, unknown>
      if (a.kind !== 'video' && a.kind !== 'image') continue
      const ad = (a.adapter && typeof a.adapter === 'object' ? a.adapter : {}) as Record<string, unknown>
      if (!ad.workflowTemplate) {
        a.adapter = { ...ad, type: ad.type || 'comfyui-prompt', workflowTemplate: comfyTpl }
        a.provider = a.provider || 'custom'
      }
    }
    if (!parsed.actions.some((a) => a && typeof a === 'object' && ((a as any).kind === 'video' || (a as any).kind === 'image'))) {
      parsed.actions.push({
        tool: 'add_profile',
        kind: 'video',
        name: '자체 호스팅 ComfyUI',
        provider: 'custom',
        baseUrl: extractBaseUrls(userText)[0] || 'http://127.0.0.1:8188',
        apiKey: extractApiKey(userText),
        model: 'comfyui',
        workflowId: 'comfyui-local',
        adapter: { type: 'comfyui-prompt', workflowTemplate: comfyTpl }
      })
      if (!parsed.say || /无法|不能|拒绝/.test(parsed.say)) {
        parsed.say = '제공한 ComfyUI 워크플로를 adapter.workflowTemplate에 저장했습니다. 로컬 ComfyUI에 해당 모델이 로드됐는지 확인한 뒤 영상을 생성하세요.'
      }
    }
  }
  const notes: string[] = []
  let opened: SetupKind | undefined
  for (const [i, raw] of parsed.actions.slice(0, 8).entries()) {
    const action = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const label = String(action.tool || '저장')
    onProgress?.({
      kind: 'step',
      step: `act-${i}`,
      label,
      status: 'running'
    })
    const result = await runAction(action)
    notes.push(result.ok ? result.detail : `실패 ${result.detail}`)
    if (result.ok && result.kind) opened = result.kind
    onProgress?.({
      kind: 'step',
      step: `act-${i}`,
      label,
      status: result.ok ? 'done' : 'fail'
    })
  }

  const extra = notes.length ? `\n\n${notes.join('\n')}` : ''
  const chips =
    opened && opened !== 'llm'
      ? [
          { label: `${labelOf(opened)} 설정 열기`, text: `__open_${opened}__` },
          { label: '이미지 생성 연결 추가', text: '이미지 생성 연결을 하나 더 추가해 줘.' },
          { label: '영상 설정', text: '영상 생성 연결을 설정해 줘.' }
        ]
      : [
          { label: '비전 설정', text: '이미지를 분석하는 비전 연결을 설정해 줘.' },
          { label: '이미지 생성 설정', text: '이미지 생성 연결을 설정해 줘.' },
          { label: '더빙 설정', text: 'TTS 더빙 연결을 설정해 줘.' },
          { label: '영상 설정', text: '영상 생성 연결을 설정해 줘.' },
          { label: '연결 테스트', text: '현재 연결을 테스트해 줘.' },
          { label: '자체 호스팅 ComfyUI 추가', text: '내 ComfyUI 주소는 http://127.0.0.1:8188이야. 이미지 생성과 영상 연결을 추가해 줘.' },
          { label: 'ComfyUI 워크플로 목록', text: '현재 ComfyUI에 저장된 워크플로를 보여 줘.' },
          { label: '문서에서 연결 설정', text: '아래 API 문서에 맞춰 사용자 지정 연결을 만들어 줘. 중계 주소도 사용할 수 있어.\n' }
        ]

  return {
    reply: `${parsed.say}${extra}`.trim(),
    chips,
    opened
  }
}
