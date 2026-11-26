<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { zealmanImageProfileLabel, zealmanImageWorkflowLabel } from '@/services/ai/zealman'
import { DRAW_THINGS_PROVIDER, drawThingsModelLabel, isDrawThingsGrpc } from '@/services/ai/drawThingsOptions'
import { refreshDrawThingsModels } from '@/services/ai/drawThings'
import ParamSelect from '@/components/common/ParamSelect.vue'
import { endpointReady, llmChoiceKey, namedModelGroups, parseLlmChoiceKey, useSettingsStore } from '@/stores'

defineProps<{ label?: string }>()

const settings = useSettingsStore()
const failure = ref('')
const checking = ref(false)
const image = computed(() => settings.config.image)
const drawThings = computed(() => image.value.provider === DRAW_THINGS_PROVIDER)
const canProbe = computed(() => drawThings.value && Boolean(image.value.baseUrl.trim()))
let probeId = 0

async function reconnect() {
  if (!canProbe.value) return
  const id = ++probeId
  const { activeImageId, image } = settings.config
  checking.value = true
  failure.value = ''
  try {
    const result = await refreshDrawThingsModels(activeImageId, image.baseUrl, image.drawThingsSharedSecret)
    if (id === probeId && !result.ok) failure.value = result.detail
  } finally {
    if (id === probeId) checking.value = false
  }
}

watch([
  () => settings.config.activeImageId,
  () => image.value.provider,
  () => image.value.baseUrl,
  () => image.value.drawThingsSharedSecret
], () => {
  ++probeId
  failure.value = ''
  checking.value = false
  if (canProbe.value) void reconnect()
}, { immediate: true })

const groups = computed(() => {
  const active = settings.config.activeImageId
  const usable = settings.config.images.filter((profile) => {
    if (profile.id === active && drawThings.value && (checking.value || failure.value)) return false
    return profile.baseUrl?.trim() && (endpointReady(profile) ||
      profile.models.some((model) => endpointReady({ ...profile, model })))
  })
  return namedModelGroups(usable.map((profile) => ({
    ...profile, name: zealmanImageProfileLabel(profile.name, profile.model)
  }))).filter((group) => group.models.length)
})
const state = computed(() => {
  if (checking.value) return 'checking'
  if (failure.value) return 'connectionFailed'
  if (canProbe.value && image.value.drawThingsServerModels?.length === 0) return 'serverEmpty'
  if (!groups.value.length || (drawThings.value && !canProbe.value)) return 'noConnection'
  return undefined
})

const model = computed({
  get() {
    const id = settings.config.activeImageId
    const name = image.value.model
    return groups.value.some((group) => group.id === id && group.models.includes(name))
      ? llmChoiceKey(id, name) : ''
  },
  set(value: string) {
    const parsed = parseLlmChoiceKey(value)
    if (parsed) settings.selectImageModel(parsed.profileId, parsed.model)
  }
})
</script>

<template>
  <div class="image-model-control">
    <div class="model-row">
      <ParamSelect :label="label ?? $t('imageModelSelect.generate')" :model-value="model" @update:model-value="model = $event">
        <option v-if="!model" value="" disabled>{{ $t(state ? `imageModelSelect.${state}` : 'imageModelSelect.chooseModel') }}</option>
        <optgroup v-for="group in groups" :key="group.id" :label="group.name">
          <option v-for="name in group.models" :key="name" :value="llmChoiceKey(group.id, name)">{{ drawThingsModelLabel(zealmanImageWorkflowLabel(name)) }}</option>
        </optgroup>
      </ParamSelect>
      <button v-if="canProbe && state !== 'checking' && (state || isDrawThingsGrpc(image.baseUrl))"
        type="button" class="model-action" @click.stop="reconnect">
        {{ $t(state ? 'imageModelSelect.reconnect' : 'drawThings.refreshModels') }}
      </button>
      <RouterLink v-if="state && state !== 'checking'" class="model-action" to="/settings/image">
        {{ $t('imageModelSelect.openSettings') }}
      </RouterLink>
    </div>
    <small v-if="state === 'connectionFailed'" class="model-error" role="status">{{ failure }}</small>
  </div>
</template>

<style scoped>
.image-model-control { flex: 1 1 auto; min-width: 0; }
.model-row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; }
.model-action {
  padding: 4px 7px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  text-decoration: none;
  white-space: nowrap;
  font-size: 11px;
  cursor: pointer;
}
.model-error { display: block; margin-top: 4px; color: var(--color-text-3); }
</style>
