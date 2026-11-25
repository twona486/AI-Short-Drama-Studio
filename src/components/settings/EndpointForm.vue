<script setup lang="ts">
import { runEnterShortcut } from '@/utils/enterShortcut'
import { computed, ref, watch } from 'vue'
import type { ProviderPreset } from '@/services/ai/providers'
import { applyProviderPreset, findProvider, matchProviderId, suggestedPresetModels } from '@/services/ai/providers'
import { DRAW_THINGS_PROVIDER, drawThingsModelLabel } from '@/services/ai/drawThingsOptions'

const props = defineProps<{
  title: string
  hint?: string
  presets: ProviderPreset[]
  baseUrl: string
  apiKey: string
  model: string
  models: string[]
  provider?: string
}>()

const emit = defineEmits<{
  patch: [
    patch: {
      provider?: string
      baseUrl?: string
      apiKey?: string
      model?: string
      models?: string[]
    }
  ]
  addModel: [name: string]
  removeModel: [name: string]
}>()

const draft = ref('')
const showKey = ref(false)
const providerId = computed({
  get() {
    if (props.provider && props.presets.some((p) => p.id === props.provider)) return props.provider
    return matchProviderId(props.baseUrl, props.presets)
  },
  set(id: string) {
    const preset = findProvider(id, props.presets)
    // 공급업체를 바꿀 때 새 공급업체의 기본 모델 이름만 유지한다. 다른 카탈로그 모델은 사용자가 직접 추가한다.
    const base =
      preset.id === 'custom' ? props : { ...props, model: '', models: [] as string[] }
    emit('patch', applyProviderPreset(base, preset))
  }
})

const baseUrlModel = computed({
  get: () => props.baseUrl,
  set: (v: string) => emit('patch', { baseUrl: v })
})

const apiKeyModel = computed({
  get: () => props.apiKey,
  set: (v: string) => emit('patch', { apiKey: v })
})

const currentPreset = computed(() => findProvider(providerId.value, props.presets))
const drawThings = computed(() => currentPreset.value.id === DRAW_THINGS_PROVIDER)

watch(
  () => props.baseUrl,
  (url) => {
    const matched = matchProviderId(url, props.presets)
    if (props.provider && props.provider !== matched && matched !== 'custom') {
      emit('patch', { provider: matched })
    }
  }
)

const suggested = computed(() =>
  suggestedPresetModels(currentPreset.value, props.models)
)

function onAdd() {
  const name = draft.value.trim()
  if (!name) return
  emit('addModel', name)
  draft.value = ''
}
</script>

<template>
  <section class="form">
    <header class="head">
      <h3>{{ title }}</h3>
      <p v-if="hint" class="hint">{{ hint }}</p>
    </header>

    <label>{{ $t('endpointForm.provider') }}</label>
    <select v-model="providerId">
      <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
    <p class="hint">{{ $t('endpointForm.providerHint') }}</p>
    <p class="hint">{{ currentPreset.hint }}</p>

    <label>{{ $t('endpointForm.baseUrl') }}</label>
    <input
      v-model="baseUrlModel"
      :placeholder="currentPreset.baseUrl || 'https://…/v1'"
    />

    <label v-if="!currentPreset.noApiKey">API Key</label>
    <div v-if="!currentPreset.noApiKey" class="secret">
      <input
        :type="showKey ? 'text' : 'password'"
        autocomplete="off"
        v-model="apiKeyModel"
        :placeholder="currentPreset.keyPlaceholder || 'sk-…'"
      />
      <button type="button" class="eye" @click="showKey = !showKey">
        {{ showKey ? $t('common.hide') : $t('common.show') }}
      </button>
    </div>

    <label>{{ $t('endpointForm.modelName') }}</label>
    <p class="hint">
      {{ $t(drawThings ? 'drawThings.modelHint' : 'endpointForm.modelHint') }}
    </p>
    <div class="chips">
      <button
        v-for="m in models"
        :key="m"
        type="button"
        class="chip"
        :class="{ on: m === model }"
        :title="drawThings ? m : undefined"
        @click="emit('patch', { model: m })"
      >
        {{ drawThings ? drawThingsModelLabel(m) : m }}
        <span
          v-if="models.length > 1"
          class="x"
          :title="$t('endpointForm.removeModel')"
          @click.stop="emit('removeModel', m)"
        >×</span>
      </button>
      <span v-if="!models.length" class="hint">{{ $t('endpointForm.noModels') }}</span>
    </div>
    <div v-if="suggested.length" class="suggest">
      <span>{{ $t('endpointForm.popularModels') }}</span>
      <button
        v-for="m in suggested"
        :key="m"
        type="button"
        class="chip ghost"
        @click="emit('addModel', m)"
      >
        + {{ drawThings ? drawThingsModelLabel(m) : m }}
      </button>
    </div>

    <label>{{ $t('endpointForm.addModel') }}</label>
    <div class="add-row">
      <input
        v-model="draft"
        :placeholder="currentPreset.id === 'custom' || !currentPreset.models.length
          ? $t('endpointForm.modelPlaceholder')
          : $t('endpointForm.modelExample', { p0: currentPreset.models[0] })"
        @keydown.enter="runEnterShortcut($event, onAdd)"
      />
      <button class="mini" type="button" @click="onAdd">{{ $t('endpointForm.addToList') }}</button>
    </div>

    <slot />
  </section>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 560px;
}
.head h3 {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 700;
}
.hint {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--color-text-4);
  line-height: 1.5;
}
label {
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
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  font-size: 11px;
  cursor: pointer;
}
.chip.on {
  border-color: var(--color-accent);
  color: var(--color-text-1);
  background: rgba(124, 58, 237, 0.18);
}
.chip.ghost {
  border-style: dashed;
  opacity: 0.85;
}
.suggest {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.suggest > span {
  width: 100%;
  font-size: 11px;
  color: var(--color-text-4);
}
.chip .x {
  opacity: 0.55;
  font-size: 13px;
  line-height: 1;
}
.chip .x:hover {
  opacity: 1;
  color: var(--color-error, #f87171);
}
.add-row {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.add-row input {
  flex: 1;
  min-width: 0;
}
.mini {
  font-size: 12px;
  padding: 0 12px;
  border-radius: 4px;
  color: var(--color-text-2);
  background: var(--color-bg-3);
  white-space: nowrap;
}
.mini:hover {
  color: var(--color-text-1);
}
</style>
