/**
 * 设置页接入助手：依赖已配置的 LLM，帮用户写入视觉 / 生图 / 配音 / 视频。
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

const SYSTEM = `${settingsSkillRaw}

JSON만 출력하세요. { "say": "사용자에게 보여 줄 한국어 메시지", "actions": [ ... ] }
한 번에 actions는 최대 8개입니다. 확신할 수 없으면 actions를 비우고 먼저 질문하세요. 문서에 필요한 정보가 충분하면 작업을 제시하세요.

사용 가능한 도구
{ "tool": "add_profile", "kind": "vision|image|tts|video|llm", "name": "표시 이름", "provider": "프리셋 ID. 선택 사항", "baseUrl": "", "apiKey": "", "model": "", "models": ["선택 사항"], "voice": "tts 선택 사항", "workflowId": "video 선택 사항", "promptStyle": "scene-narrative|formatted", "stillMode": "identity|keyframe|storyboard. video 선택 사항. 캐릭터 설정과 장면 이미지를 쓰는 H3는 identity, 키프레임이 필요한 다른 모델은 keyframe", "options": { "imageResolutions": ["1k","2k"], "videoAudio": true, "lastFrameRequired": false, "audioField": "audio" }, "adapter": { "type": "openai-compatible|openai-images|http-custom|comfyui-workflow|comfyui-prompt", "path": "선택 사항", "pollPath": "선택 사항. {id} 포함 가능", "resultJsonPath": "선택 사항", "authHeader": "선택 사항", "authPrefix": "선택 사항. Bearer 또는 빈 문자열", "workflowTemplate": "ComfyUI /prompt JSON. {{prompt}}{{image}} 사용 가능" } }
{ "tool": "update_profile", "kind": "…", "id": "profile_id", "name": "선택 사항", "baseUrl": "선택 사항", "apiKey": "선택 사항", "model": "선택 사항", "models": ["선택 사항"], "voice": "선택 사항", "workflowId": "선택 사항", "promptStyle": "선택 사항", "options": "선택 사항. 위와 같음", "adapter": "선택 사항. 위와 같음" }
{ "tool": "select_profile", "kind": "…", "id": "…", "model": "선택 사항. 현재 모델로 설정" }
{ "tool": "add_model", "kind": "llm|vision|image|tts", "id": "profile_id. 생략하면 현재 프로필", "model": "모델 이름" }
{ "tool": "test_connection", "kind": "llm|vision|image|tts|video", "id": "선택 사항. 기본값은 현재 프로필" }
{ "tool": "add_comfyui", "baseUrl": "http://127.0.0.1:8188", "apiKey": "선택 사항", "kinds": ["image","video"], "test": true }
{ "tool": "list_comfy_workflows", "kind": "image|video", "id": "선택 사항인 프로필 ID" }
{ "tool": "set_workflow_template", "kind": "image|video", "id": "선택 사항", "workflowTemplate": "{...API Format JSON...}", "path": "선택 사항. 목록 결과의 path에서 불러옴" }

프리셋 목록(ID｜이름｜주소｜기본 모델｜자주 쓰는 모델)
LLM
${catalog(LLM_PROVIDERS)}
비전
${catalog(VISION_PROVIDERS)}
이미지 생성
${catalog(IMAGE_PROVIDERS)}
더빙
${catalog(TTS_PROVIDERS)}
영상
${catalog(VIDEO_PROVIDERS)}

연결 규칙
- 사용자가 API 문서나 중계 주소를 제공하면 provider는 custom입니다. 문서 원문에서 Base URL과 모델 이름을 추출해 바로 add_profile을 사용하세요. 작업을 거절하지 마세요.
- 문서에 채팅, 이미지 분석, 이미지 생성이 함께 있으면 각 kind마다 프로필을 하나씩 작성하세요. API 키와 주소를 공유할 수 있습니다.
- Base URL에는 /v1까지 쓰세요. /chat/completions나 /images/generations는 빼세요.
- 사용자가 문서 없이 설정해 달라고만 하면 위의 공식 공급자 프리셋에서 고르세요.
- 영상에 workflowId를 따로 제공하지 않으면 model을 workflowId로 사용하세요.
- 사용자가 음색을 지정하지 않으면 더빙에 기본값 longanhuan_v3.6을 쓰세요.
- 별도 타사 주소 없이 공식 공급자와 일치하면 프리셋의 나머지 정보를 사용하세요. 제공된 URL의 도메인이 프리셋과 다르면 항상 custom으로 처리하고 공식 주소로 바꾸지 마세요.
- 자체 호스팅 ComfyUI(예 http://127.0.0.1:8188)는 add_comfyui로 이미지 생성과 영상 연결을 한 번에 추가하세요. 사용자가 ComfyUI 주소만 알려 주면 모델 이름을 묻지 말고 추가하세요.
- 워크플로 JSON이 있으면 adapter.workflowTemplate에 저장하세요. 없어도 프로필을 추가하고, 영상 생성 전에 설정의 어댑터에 붙여 넣으라고 알려 주세요. AutoDL 인스턴스 운영 방식이나 실행할 수 없는 워크플로를 만들어 내지 마세요.
- OpenAI 호환 중계의 LLM과 비전은 기본값을 사용하세요. 이미지 생성 경로가 /images/generations가 아니면 adapter.type을 http-custom으로 정하고 path와 resultJsonPath를 채우세요.
- 연결을 작성한 뒤 사용자가 테스트를 요청하면 test_connection을 사용하세요.
- options에는 문서에 명시된 노드 파라미터만 넣으세요. 이미지 생성 문서에서 1K, 2K, 4K를 지원하면 문서에 있는 옵션만 imageResolutions에 소문자 1k, 2k, 4k로 넣으세요. 해상도가 명시되지 않았으면 생략하세요.
- 영상 문서에 오디오 켜기·끄기가 명시된 경우에만 videoAudio를 true로 설정하고, 문서의 필드 이름을 audioField에 넣으세요. 이름에는 audio가 들어가야 합니다. audio나 generate_audio가 그 예입니다. 오디오 전환 옵션이 없으면 videoAudio를 생략하세요.
- 끝 프레임은 기본적으로 선택 사항입니다. 끝 프레임이나 last frame이 필수라고 문서에 명시된 경우에만 lastFrameRequired를 true로 설정하세요. 문서에 언급이 없으면 이 필드를 생략하세요.`

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
    // 带上目录前缀，set_workflow_template 用这个 path 才能取到文件
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
      // 尝试从用户最近消息不够，要求字段
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
    // 让助手读完节点图，确认提示词 / 参考图该注入到哪个节点，再把映射一起存下来
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
  // 整段就是 JSON
  if (trimmed.startsWith('{') && trimmed.includes('class_type')) {
    try {
      const obj = JSON.parse(trimmed)
      return JSON.stringify(obj, null, 2)
    } catch { /* fall through */ }
  }
  // 从 markdown/代码块里抠
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1] && /class_type|"prompt"\s*:/.test(fence[1])) {
    try {
      const obj = JSON.parse(fence[1].trim())
      return JSON.stringify(obj, null, 2)
    } catch { /* ignore */ }
  }
  // 贪婪找最外层大括号
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

  // 快捷：只说 Comfy 地址 → 直接加生图+视频
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
    ? `아래는 사용자가 제공한 API 설명, API 문서 또는 ComfyUI 워크플로 JSON입니다. 중계 서비스, 사용자 지정 게이트웨이 또는 로컬 ComfyUI에서 가져왔을 수 있습니다. 문서를 분석해 provider=custom 연결을 만들고 공식 공급자 주소로 바꾸지 마세요. class_type이 있는 Comfy API JSON이 포함되면 adapter.type=comfyui-prompt를 쓰고 adapter.workflowTemplate에 JSON을 저장하세요. 실행 가능한 기본 워크플로를 지어내지 마세요. 문서에 나온 기능 유형마다 add_profile을 하나씩 작성하세요.\n\n${userText}`
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
    timeoutMs: looksLikeDocs ? 180_000 : 120_000,
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
    // 若已有 Comfy 接入且模型没给出 actions，直接写入当前生图/视频
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
