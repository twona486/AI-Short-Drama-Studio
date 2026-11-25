<script setup lang="ts">
import { t as translate } from '@/i18n'

import { t } from '@/i18n'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useSettingsStore, uniqueProfileName } from '@/stores'
import { desktop, isDesktop } from '@/services/desktop'
import { isLtxDesktop, LTX_DESKTOP_DEFAULT_URL, LTX_DESKTOP_MODELS, ltxDesktopError } from '@/services/ai/ltxDesktopOptions'
import { LTX_MODELS, isLtxProfile } from '@/services/ai/ltxOptions'
import { TTS_VOICES } from '@/services/ai/tts'
import EndpointForm from '@/components/settings/EndpointForm.vue'
import AdapterFields from '@/components/settings/AdapterFields.vue'
import ProfileLibrary from '@/components/settings/ProfileLibrary.vue'
import type { AdapterConfig } from '@/services/ai/adapters'
import { type VideoStillMode } from '@/types/canvas'
import { syncH3ShotStillModes } from '@/services/canvas/videoModel'
import { zealmanImageProfileLabel, zealmanImageWorkflowLabel, zealmanVideoProfileLabel, zealmanVideoWorkflowLabel } from '@/services/ai/zealman'
import { normalizeRouterBaseUrl } from '@/services/ai/openAiRouter'
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

defineProps<{
  module: 'llm' | 'vision' | 'image' | 'tts' | 'video'
}>()

const settings = useSettingsStore()
const project = useProjectStore()
const router = useRouter()
const showVideoKey = ref(false)
const ltxVideo = computed(() => isLtxProfile(settings.config.video))
const ltxDesktop = computed(() => isLtxDesktop(settings.config.video))
const pairingLink = ref('')
const pairingStatus = ref('')
const pairingBusy = ref(false)
const desktopHostOverride = computed({
  get: () => settings.config.video.ltxHostOverride || '',
  set: (value: string) => {
    pairingStatus.value = ''
    settings.patchVideo({ ltxHostOverride: value || undefined })
  }
})
const desktopAddress = computed({
  get: () => settings.config.video.baseUrl,
  set: (value: string) => {
    if (value === settings.config.video.baseUrl) return
    pairingStatus.value = ''
    pairingLink.value = ''
    settings.patchVideo({ baseUrl: value, apiKey: '' })
  }
})

watch(() => settings.config.activeVideoId, () => {
  pairingLink.value = ''
  pairingStatus.value = ''
})

async function pairOrCheckLtxDesktop(pair: boolean) {
  if (pairingBusy.value) return
  if (!isDesktop() || !desktop().ltxDesktopRequest) {
    pairingStatus.value = t('ltx.desktopOnly')
    return
  }
  const id = settings.config.activeVideoId
  const { baseUrl, apiKey, ltxHostOverride } = settings.config.video
  const code = pairingLink.value.trim()
  if (pair && !code) {
    pairingStatus.value = t('ltxDesktop.codeError')
    return
  }
  pairingBusy.value = true
  pairingStatus.value = ''
  try {
    const reply = await desktop().ltxDesktopRequest({
      baseUrl, hostOverride: ltxHostOverride, token: apiKey, operation: pair ? { kind: 'pair', code } : { kind: 'check' }
    })
    if (settings.config.activeVideoId !== id || settings.config.video.baseUrl !== baseUrl ||
      settings.config.video.ltxHostOverride !== ltxHostOverride) return
    if (reply.kind === 'paired') {
      settings.patchVideo({ apiKey: reply.token })
      pairingLink.value = ''
      pairingStatus.value = t('ltxDesktop.paired')
    } else {
      if (reply.kind === 'http' && reply.status === 401 && !pair) settings.patchVideo({ apiKey: '' })
      pairingStatus.value = t(reply.kind === 'ready' ? 'ltxDesktop.ready' : ltxDesktopError(reply, pair))
    }
  } catch {
    pairingStatus.value = t('ltxDesktop.offline')
  } finally {
    pairingBusy.value = false
  }
}
const llmRouterUrl = ref('')
const llmRouterKey = ref('')
const llmRouterModel = ref('')
const llmRouterStatus = ref('')
const llmRouterFailed = ref(false)

function addLlmRouter() {
  llmRouterStatus.value = ''
  llmRouterFailed.value = false
  try {
    const baseUrl = normalizeRouterBaseUrl(llmRouterUrl.value)
    const apiKey = llmRouterKey.value.trim().replace(/^Bearer\s+/i, '').trim()
    if (!apiKey || /[^\x21-\x7e]/.test(apiKey)) throw new Error(t('studioUpdate.invalidKey'))
    const model = llmRouterModel.value.trim()
    if (!model) throw new Error(t('studioUpdate.modelRequired'))
    const existing = settings.config.llms.find(p => p.baseUrl.replace(/\/+$/, '') === baseUrl && p.apiKey === apiKey)
    if (existing) {
      settings.selectLlmModel(existing.id, model)
    } else {
      settings.addLlm({ name: uniqueProfileName(settings.config.llms.map(p => p.name), new URL(baseUrl).host), baseUrl, apiKey, model, models: [model], provider: 'custom' })
    }
    llmRouterKey.value = ''
    llmRouterStatus.value = t('studioUpdate.modelSelected', { model })
  } catch (error) {
    llmRouterFailed.value = true
    llmRouterStatus.value = error instanceof Error ? error.message : t('studioUpdate.invalidRouter')
  }
}
const zealmanImage = computed(
  () =>
    settings.config.image.provider === 'zealman' ||
    settings.config.image.adapter?.type === 'zealman-workflow'
)
const zealmanVideo = computed(
  () =>
    settings.config.video.provider === 'zealman' ||
    settings.config.video.adapter?.type === 'zealman-workflow'
)

const llmName = computed({
  get: () => settings.config.llms.find((p) => p.id === settings.config.activeLlmId)?.name ?? '',
  set: (v: string) => settings.renameLlm(v)
})
const visionName = computed({
  get: () => settings.config.visions.find((p) => p.id === settings.config.activeVisionId)?.name ?? '',
  set: (v: string) => settings.renameVision(v)
})
const imageName = computed({
  get: () => settings.config.images.find((p) => p.id === settings.config.activeImageId)?.name ?? '',
  set: (v: string) => settings.renameImage(v)
})
const ttsName = computed({
  get: () => settings.config.ttsProfiles.find((p) => p.id === settings.config.activeTtsId)?.name ?? '',
  set: (v: string) => settings.renameTts(v)
})
const videoName = computed({
  get: () => settings.config.videos.find((p) => p.id === settings.config.activeVideoId)?.name ?? '',
  set: (v: string) => settings.renameVideo(v)
})
const videoUrl = computed({
  get: () => settings.config.video.baseUrl,
  set: (v: string) => settings.patchVideo({ baseUrl: v })
})
const videoWorkflow = computed({
  get: () => settings.config.video.workflowId,
  set: (v: string) => settings.patchVideo({ workflowId: v })
})
const videoKey = computed({
  get: () => settings.config.video.apiKey,
  set: (v: string) => settings.patchVideo({ apiKey: v })
})
const ttsVoice = computed({
  get: () => settings.config.tts.voice,
  set: (v: string) => onVoice(v)
})

function onVoice(v: string) {
  settings.patchTts({ voice: v })
  if (project.current) project.setSettings({ ttsVoice: v })
}

function subtitle(p: { models?: string[]; model?: string }) {
  const n = p.models?.length || 0
  if (n) return t('studioSettings.modelCount', { count: n, model: p.model || t('studioSettings.noModelSelected') })
  return p.model || t('studioSettings.noModel')
}

function imageProfile(p: (typeof settings.config.images)[number]) {
  const model = zealmanImageWorkflowLabel(p.model)
  const name = zealmanImageProfileLabel(p.name, p.model)
  return { id: p.id, name, subtitle: subtitle({ model, models: p.models }) }
}

function videoProfile(p: (typeof settings.config.videos)[number]) {
  const workflow = zealmanVideoWorkflowLabel(p.workflowId)
  const name = zealmanVideoProfileLabel(p.name, p.workflowId)
  const provider = p.provider || matchProviderId(p.baseUrl, VIDEO_PROVIDERS)
  const kind = provider === 'zealman' ? 'Zealman'
    : p.adapter?.type === 'comfyui-prompt' ? 'ComfyUI'
    : isLtxDesktop(p) ? 'LTX Desktop' : findProvider(provider, VIDEO_PROVIDERS).name
  return { id: p.id, name, subtitle: [kind, workflow || t('studioSettings.noModel')].join(' · ') }
}

function createNamed(
  kind: 'llm' | 'vision' | 'image' | 'tts',
  providerId: string,
  presets: ProviderPreset[],
  existing: string[],
  fallbackName: string
) {
  const preset = findProvider(providerId, presets)
  const applied = applyProviderPreset({ baseUrl: '', model: '', models: [] }, preset)
  const name = uniqueProfileName(
    existing,
    preset.id === 'custom' ? fallbackName : preset.name
  )
  const seed = {
    name,
    baseUrl: applied.baseUrl,
    apiKey: '',
    model: applied.model,
    models: applied.models,
    provider: applied.provider
  }
  if (kind === 'llm') settings.addLlm(seed)
  else if (kind === 'vision') settings.addVision(seed)
  else if (kind === 'image') settings.addImage(seed)
  else settings.addTts(seed)
}

function createVideo(providerId: string) {
  const preset = findProvider(providerId, VIDEO_PROVIDERS)
  const name = uniqueProfileName(
    settings.config.videos.map((p) => p.name),
    preset.id === 'custom' ? translate('studioSettings.customVideo') : preset.name
  )
  pairingLink.value = ''
  pairingStatus.value = ''
  settings.addVideo({
    name,
    baseUrl: preset.baseUrl || '',
    apiKey: '',
    workflowId: preset.defaultModel || '',
    promptStyle: 'scene-narrative',
    provider: preset.id,
    options: preset.id === 'ltx' ? { videoAudio: true, audioField: 'generate_audio', videoResolutions: ['720p', '1080p'] } : undefined,
    stillMode: preset.id === 'autodl' || preset.id === 'apimart' ? 'identity' : 'keyframe'
  })
}

function patchVideoStillMode(mode: VideoStillMode) {
  settings.patchVideo({ stillMode: mode })
  syncH3ShotStillModes(mode)
}

function patchAdapter(
  kind: 'llm' | 'vision' | 'image' | 'tts' | 'video',
  patch: { adapter?: AdapterConfig; workflowId?: string }
) {
  if (kind === 'llm') settings.patchLlm({ adapter: patch.adapter })
  else if (kind === 'vision') settings.patchVision({ adapter: patch.adapter })
  else if (kind === 'image') settings.patchImage({ adapter: patch.adapter })
  else if (kind === 'tts') settings.patchTts({ adapter: patch.adapter })
  else settings.patchVideo({ adapter: patch.adapter, workflowId: patch.workflowId })
}
</script>

<template>
  <div class="mods">
    <template v-if="module === 'llm'">
      <form class="llm-router" @submit.prevent="addLlmRouter">
        <h2>{{ $t('studioUpdate.routerTitle') }}</h2>
        <p>{{ $t('studioUpdate.routerHint') }}</p>
        <label>Base URL<input v-model.trim="llmRouterUrl" type="url" required placeholder="https://api.example.com/v1" /></label>
        <label>API Key<input v-model="llmRouterKey" type="password" required autocomplete="off" /></label>
        <label>{{ $t('studioUpdate.modelId') }}<input v-model.trim="llmRouterModel" type="text" required :placeholder="$t('studioUpdate.modelPlaceholder')" /></label>
        <button type="submit">{{ $t('comfyQuickAdd.addAndSelect') }}</button>
        <p v-if="llmRouterStatus" :role="llmRouterFailed ? 'alert' : 'status'" :class="{ 'router-error': llmRouterFailed }">{{ llmRouterStatus }}</p>
        <label v-if="settings.config.llm.models?.length">{{ $t('studioUpdate.currentModel') }}
          <select :value="settings.config.llm.model" @change="settings.selectLlmModel(settings.config.activeLlmId, ($event.target as HTMLSelectElement).value)">
            <option v-for="model in settings.config.llm.models" :key="model" :value="model">{{ model }}</option>
          </select>
        </label>
      </form>
      <details class="llm-advanced">
        <summary>{{ $t('studioUpdate.advanced') }}</summary>
      <ProfileLibrary
        :title="$t('studioSettings.savedLlm')"
        :hint="$t('studioSettings.savedLlmHint')"
        :profiles="settings.config.llms.map((p) => ({ id: p.id, name: p.name, subtitle: subtitle(p) }))"
        :active-id="settings.config.activeLlmId"
        :providers="LLM_PROVIDERS"
        @select="settings.selectLlm"
        @create="createNamed('llm', $event, LLM_PROVIDERS, settings.config.llms.map((p) => p.name), $t('studioSettings.customLlm'))"
        @remove="settings.removeLlm(settings.config.activeLlmId)"
      />
      <label class="name-label">{{ $t('common.name') }}</label>
      <input
        class="name-input"
        v-model="llmName"
        :placeholder="$t('studioSettings.exampleLlm')"
      />
      <EndpointForm
        :title="$t('studioSettings.api')"
        :hint="$t('studioSettings.llmHint')"
        :presets="LLM_PROVIDERS"
        :base-url="settings.config.llm.baseUrl"
        :api-key="settings.config.llm.apiKey"
        :model="settings.config.llm.model"
        :models="settings.config.llm.models"
        :provider="settings.config.llm.provider"
        @patch="settings.patchLlm($event)"
        @add-model="settings.addModel('llm', $event)"
        @remove-model="settings.removeModel('llm', $event)"
      />
      <AdapterFields
        kind="llm"
        :adapter="settings.config.llm.adapter"
        @patch="patchAdapter('llm', $event)"
      />
      </details>
    </template>

    <template v-else-if="module === 'vision'">
      <button type="button" class="vision-switch" role="switch" :aria-checked="settings.config.visionEnabled" :class="{ on: settings.config.visionEnabled }" @click="settings.update({ visionEnabled: !settings.config.visionEnabled })">
        <span class="vision-switch-track" aria-hidden="true"><span /></span>
        <span>{{ settings.config.visionEnabled ? $t('mediaNodes.visionOn') : $t('mediaNodes.visionOff') }}</span>
      </button>
      <p class="hint">{{ $t('mediaNodes.visionHint') }}</p>
      <ProfileLibrary
        :title="$t('studioSettings.savedVision')"
        :hint="$t('studioSettings.savedVisionHint')"
        :profiles="settings.config.visions.map((p) => ({ id: p.id, name: p.name, subtitle: subtitle(p) }))"
        :active-id="settings.config.activeVisionId"
        :providers="VISION_PROVIDERS"
        @select="settings.selectVision"
        @create="createNamed('vision', $event, VISION_PROVIDERS, settings.config.visions.map((p) => p.name), $t('studioSettings.customVision'))"
        @remove="settings.removeVision(settings.config.activeVisionId)"
      />
      <label class="name-label">{{ $t('common.name') }}</label>
      <input
        class="name-input"
        v-model="visionName"
        :placeholder="$t('studioSettings.exampleVision')"
      />
      <EndpointForm
        :title="$t('studioSettings.api')"
        :hint="$t('studioSettings.visionHint')"
        :presets="VISION_PROVIDERS"
        :base-url="settings.config.vision.baseUrl"
        :api-key="settings.config.vision.apiKey"
        :model="settings.config.vision.model"
        :models="settings.config.vision.models"
        :provider="settings.config.vision.provider"
        @patch="settings.patchVision($event)"
        @add-model="settings.addModel('vision', $event)"
        @remove-model="settings.removeModel('vision', $event)"
      />
      <AdapterFields
        kind="vision"
        :adapter="settings.config.vision.adapter"
        @patch="patchAdapter('vision', $event)"
      />
    </template>

    <template v-else-if="module === 'image'">
      <section v-if="zealmanImage" class="owned">
        <h3>{{ $t('studioSettings.zealmanImage') }}</h3>
        <p class="hint">{{ $t('studioSettings.zealmanImageHint') }}</p>
        <p class="hint">{{ $t('studioSettings.currentAddress') }}{{ settings.config.image.baseUrl || $t('studioSettings.missing') }}</p>
        <p class="hint">{{ $t('studioSettings.workflow') }}{{ zealmanImageWorkflowLabel(settings.config.image.model) || $t('studioSettings.builtinImage') }}</p>
        <button type="button" @click="router.push('/settings/zealman')">{{ $t('studioSettings.openZealman') }}</button>
      </section>
      <button type="button" @click="router.push('/settings/comfyui')">{{ $t('studioUpdate.comfySetup') }}</button>
      <ProfileLibrary
        :title="$t('studioSettings.savedImage')"
        :hint="$t('studioSettings.savedImageHint')"
        :profiles="settings.config.images.map(imageProfile)"
        :active-id="settings.config.activeImageId"
        :providers="IMAGE_PROVIDERS"
        @select="settings.selectImage"
        @create="createNamed('image', $event, IMAGE_PROVIDERS, settings.config.images.map((p) => p.name), $t('studioSettings.customImage'))"
        @remove="settings.removeImage(settings.config.activeImageId)"
      />
      <template v-if="!zealmanImage">
        <label class="name-label">{{ $t('common.name') }}</label>
        <input
          class="name-input"
          v-model="imageName"
          :placeholder="$t('studioSettings.exampleImage')"
        />
        <EndpointForm
          :title="$t('studioSettings.api')"
          :hint="settings.config.image.provider === 'apimart' ? $t('studioSettings.apimartImageHint') : $t('studioSettings.imageHint')"
          :presets="IMAGE_PROVIDERS"
          :base-url="settings.config.image.baseUrl"
          :api-key="settings.config.image.apiKey"
          :model="settings.config.image.model"
          :models="settings.config.image.models"
          :provider="settings.config.image.provider"
          @patch="settings.patchImage($event)"
          @add-model="settings.addModel('image', $event)"
          @remove-model="settings.removeModel('image', $event)"
        />
        <AdapterFields
          v-if="settings.config.image.provider !== 'apimart'"
          kind="image"
          :adapter="settings.config.image.adapter"
          :base-url="settings.config.image.baseUrl"
          :api-key="settings.config.image.apiKey"
          @patch="patchAdapter('image', $event)"
        />
      </template>
    </template>

    <template v-else-if="module === 'tts'">
      <ProfileLibrary
        :title="$t('studioSettings.savedTts')"
        :hint="$t('studioSettings.savedTtsHint')"
        :profiles="settings.config.ttsProfiles.map((p) => ({ id: p.id, name: p.name, subtitle: subtitle(p) }))"
        :active-id="settings.config.activeTtsId"
        :providers="TTS_PROVIDERS"
        @select="settings.selectTts"
        @create="createNamed('tts', $event, TTS_PROVIDERS, settings.config.ttsProfiles.map((p) => p.name), $t('studioSettings.customTts'))"
        @remove="settings.removeTts(settings.config.activeTtsId)"
      />
      <label class="name-label">{{ $t('common.name') }}</label>
      <input
        class="name-input"
        v-model="ttsName"
        :placeholder="$t('studioSettings.exampleTts')"
      />
      <EndpointForm
        :title="$t('studioSettings.api')"
        :hint="$t('studioSettings.ttsHint')"
        :presets="TTS_PROVIDERS"
        :base-url="settings.config.tts.baseUrl"
        :api-key="settings.config.tts.apiKey"
        :model="settings.config.tts.model"
        :models="settings.config.tts.models"
        :provider="settings.config.tts.provider"
        @patch="settings.patchTts($event)"
        @add-model="settings.addModel('tts', $event)"
        @remove-model="settings.removeModel('tts', $event)"
      >
        <label class="extra-label">{{ $t('common.voice') }}</label>
        <select v-model="ttsVoice">
          <option v-for="v in TTS_VOICES" :key="v.id" :value="v.id">{{ v.label }}</option>
        </select>
      </EndpointForm>
      <AdapterFields
        kind="tts"
        :adapter="settings.config.tts.adapter"
        @patch="patchAdapter('tts', $event)"
      />
    </template>

    <template v-else-if="module === 'video'">
      <section v-if="zealmanVideo" class="owned">
        <h3>{{ $t('studioSettings.zealmanVideo') }}</h3>
        <p class="hint">{{ $t('studioSettings.zealmanVideoHint') }}</p>
        <p class="hint">{{ $t('studioSettings.currentAddress') }}{{ settings.config.video.baseUrl || $t('studioSettings.missing') }}</p>
        <p class="hint">{{ $t('studioSettings.workflow') }}{{ zealmanVideoWorkflowLabel(settings.config.video.workflowId) || $t('studioSettings.builtinWorkflow') }}</p>
        <button type="button" @click="router.push('/settings/zealman')">{{ $t('studioSettings.openZealman') }}</button>
      </section>
      <button type="button" @click="router.push('/settings/comfyui')">{{ $t('studioUpdate.comfySetup') }}</button>
      <ProfileLibrary
        :title="$t('studioSettings.savedVideo')"
        :hint="$t('studioSettings.savedVideoHint')"
        :add-hint="$t('studioSettings.chooseVideoConnection')"
        :profiles="settings.config.videos.map(videoProfile)"
        :active-id="settings.config.activeVideoId"
        :providers="VIDEO_PROVIDERS"
        @select="settings.selectVideo"
        @create="createVideo"
        @remove="settings.removeVideo(settings.config.activeVideoId)"
      />
      <template v-if="!zealmanVideo">
      <label class="name-label">{{ $t('common.name') }}</label>
      <input
        class="name-input"
        v-model="videoName"
        :placeholder="$t('studioSettings.exampleAutoDl')"
      />
      <section class="video">
        <template v-if="ltxDesktop">
          <p class="hint">{{ $t('ltxDesktop.hint') }}</p>
          <p class="hint">{{ $t('ltxDesktop.memory') }}</p>
          <label for="ltx-desktop-address">{{ $t('studioSettings.baseUrl') }}</label>
          <input id="ltx-desktop-address" v-model.trim="desktopAddress" :placeholder="LTX_DESKTOP_DEFAULT_URL" />
          <details class="rule-details">
            <summary>{{ $t('ltxDesktop.advanced') }}</summary>
            <label for="ltx-desktop-host">{{ $t('ltxDesktop.hostOverride') }}</label>
            <input id="ltx-desktop-host" v-model.trim="desktopHostOverride" placeholder="localhost:41955" />
            <p class="hint">{{ $t('ltxDesktop.hostOverrideHint') }}</p>
          </details>
          <label for="ltx-desktop-model">{{ $t('ltx.model') }}</label>
          <select id="ltx-desktop-model" v-model="videoWorkflow">
            <option v-for="model in LTX_DESKTOP_MODELS" :key="model" :value="model">{{ model }}</option>
          </select>
          <label for="ltx-desktop-pairing">{{ $t('ltxDesktop.pairingLink') }}</label>
          <input id="ltx-desktop-pairing" v-model.trim="pairingLink" type="password" autocomplete="off" />
          <div class="ltx-desktop-actions">
            <button type="button" :disabled="pairingBusy" @click="pairOrCheckLtxDesktop(true)">{{ $t('ltxDesktop.pair') }}</button>
            <button type="button" :disabled="pairingBusy" @click="pairOrCheckLtxDesktop(false)">{{ $t('ltxDesktop.check') }}</button>
          </div>
          <p v-if="pairingStatus" role="status">{{ pairingStatus }}</p>
        </template>
        <template v-else-if="!ltxVideo">
        <h3>{{ $t('studioSettings.oneClick') }}</h3>
        <p class="hint">
          {{ $t('studioSettings.autoRules') }}
        </p>
        <details class="rule-details">
          <summary>{{ $t('studioSettings.advancedGeneration') }}</summary>
          <p class="hint">{{ $t('studioSettings.advancedHint') }}</p>
        <label>{{ $t('studioSettings.referenceMode') }}</label>
        <div class="style-cards">
          <button
            type="button"
            :class="{ on: (settings.config.video.stillMode || 'identity') === 'identity' }"
            @click="patchVideoStillMode('identity')"
          >
            <strong>{{ $t('studioSettings.basicReferences') }}</strong>
            <span>{{ $t('studioSettings.h3Mode') }}</span>
          </button>
          <button
            type="button"
            :class="{ on: settings.config.video.stillMode === 'keyframe' }"
            @click="patchVideoStillMode('keyframe')"
          >
            <strong>{{ $t('studioSettings.keyframeReferences') }}</strong>
            <span>{{ $t('studioSettings.keyframeStrategy') }}</span>
          </button>
          <button
            type="button"
            :class="{ on: settings.config.video.stillMode === 'storyboard' }"
            @click="patchVideoStillMode('storyboard')"
          >
            <strong>{{ $t('studioSettings.boardReferences') }}</strong>
            <span>{{ $t('studioSettings.boardStrategy') }}</span>
          </button>
        </div>
        <label>{{ $t('studioSettings.promptFormat') }}</label>
        <div class="style-cards">
          <button
            type="button"
            :class="{ on: (settings.config.video.promptStyle || 'scene-narrative') === 'scene-narrative' }"
            @click="settings.patchVideo({ promptStyle: 'scene-narrative' })"
          >
            <strong>{{ $t('studioSettings.sceneNarrative') }}</strong>
            <span>{{ $t('studioSettings.h3Rules', { tag: '<d>' }) }}</span>
          </button>
          <button
            type="button"
            :class="{ on: settings.config.video.promptStyle === 'formatted' }"
            @click="settings.patchVideo({ promptStyle: 'formatted' })"
          >
            <strong>{{ $t('studioSettings.structured') }}</strong>
            <span>{{ $t('studioSettings.directGeneration') }}</span>
          </button>
        </div>
        </details>
        <h3 class="api-title">{{ $t('studioSettings.remoteApi') }}</h3>
        <p class="hint">{{ $t('mediaNodes.remoteHint') }}</p>
        <p v-if="settings.config.video.provider === 'apimart'" class="hint">
          {{ $t('studioSettings.apimartVideo') }}
        </p>
        <label>{{ $t('studioSettings.baseUrl') }}</label>
        <input
          v-model="videoUrl"
          :placeholder="settings.config.video.provider === 'apimart' ? 'https://api.aishuch.com' : 'https://autodl.art'"
        />
        <label>{{ settings.config.video.provider === 'apimart' ? $t('studioSettings.modelName') : $t('studioSettings.modelOrWorkflow') }}</label>
        <input
          v-model="videoWorkflow"
          :placeholder="settings.config.video.provider === 'apimart' ? 'grok-imagine-1.5-video-ext' : 'minimax_h3_lightx2v_v5_15s'"
        />
        </template>
        <template v-else>
          <p class="hint">{{ $t('ltx.hint') }}</p>
          <label for="ltx-model">{{ $t('ltx.model') }}</label>
          <select id="ltx-model" v-model="videoWorkflow">
            <option v-for="model in LTX_MODELS" :key="model" :value="model">{{ model }}</option>
          </select>
        </template>
        <label v-if="!ltxDesktop">API Key / Token</label>
        <div v-if="!ltxDesktop" class="secret">
          <input
            :key="settings.config.activeVideoId"
            :type="showVideoKey ? 'text' : 'password'"
            autocomplete="off"
            v-model="videoKey"
            :placeholder="$t('studioSettings.providerKey')"
          />
          <button type="button" class="eye" @click="showVideoKey = !showVideoKey">
            {{ showVideoKey ? $t('common.hide') : $t('common.show') }}
          </button>
        </div>
        <AdapterFields
          v-if="!ltxVideo && settings.config.video.provider !== 'apimart'"
          kind="video"
          :adapter="settings.config.video.adapter"
          :base-url="settings.config.video.baseUrl"
          :api-key="settings.config.video.apiKey"
          @patch="patchAdapter('video', $event)"
        />
      </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.llm-router, .llm-advanced { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--color-border); border-radius: 12px; }
.llm-router h2, .llm-router p { margin: 0; }
.llm-router p { color: var(--color-text-3); font-size: 13px; overflow-wrap: anywhere; }
.llm-router label { display: grid; gap: 5px; font-size: 13px; }
.llm-router input, .llm-router select { min-width: 0; padding: 8px 10px; color: inherit; background: var(--color-bg-2); border: 1px solid var(--color-border); border-radius: 8px; }
.llm-router button { justify-self: start; padding: 8px 12px; border-radius: 8px; background: var(--color-accent); color: #0c0b14; }
.llm-router .router-error { color: var(--color-error); }
.llm-advanced > summary { cursor: pointer; color: var(--color-text-2); }
.llm-advanced[open] > summary { margin-bottom: 12px; }
.mods {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.owned {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 640px;
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-1);
}
.owned h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
.owned button {
  align-self: flex-start;
  margin-top: 4px;
  height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  background: #5686f5;
  color: #fff;
  cursor: pointer;
}
.video {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 640px;
}
.ltx-desktop-actions { display: flex; gap: 8px; }
.video select {
  padding: 8px 10px;
  color: inherit;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 8px;
}
.video h3 {
  margin: 0 0 2px;
  font-size: 15px;
  font-weight: 650;
}
.api-title { margin-top: 14px !important; }
.rule-details { margin: 10px 0 4px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-1); }
.rule-details summary { cursor: pointer; color: var(--color-text-2); font-size: 12px; font-weight: 600; }
.rule-details[open] summary { margin-bottom: 8px; color: var(--color-text-1); }
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-4);
  line-height: 1.5;
}
.vision-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  margin: 0 0 8px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.vision-switch-track {
  display: inline-flex;
  align-items: center;
  width: 28px;
  height: 16px;
  padding: 2px;
  border-radius: 12px;
  background: var(--nb-bg-4, var(--color-bg-3));
  box-sizing: border-box;
}
.vision-switch-track > span {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--nb-t2, var(--color-text-3));
  transition: transform .15s;
}
.vision-switch.on {
  color: var(--color-text-1);
  border-color: var(--nb-accent, var(--color-accent));
}
.vision-switch.on .vision-switch-track { background: var(--nb-accent, var(--color-accent)); }
.vision-switch.on .vision-switch-track > span { transform: translateX(12px); background: var(--nb-accent-ink, #062027); }
label,
.extra-label,
.name-label {
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-4);
}
input,
select {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-1);
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.secret {
  display: flex;
  gap: 6px;
  max-width: 640px;
}
.secret input {
  flex: 1;
  min-width: 0;
}
.eye {
  flex-shrink: 0;
  margin: 0;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-3);
  color: var(--color-text-2);
  font-size: 12px;
  white-space: nowrap;
}
.eye:hover {
  color: var(--color-text-1);
}
.name-input {
  max-width: 640px;
}
.style-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 4px 0 10px;
}
.style-cards button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  text-align: left;
}
.style-cards button.on {
  border-color: var(--color-accent);
  color: var(--color-text-1);
  background: var(--color-fill);
}
.style-cards strong {
  font-size: 13px;
}
.style-cards span {
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-4);
}
</style>
