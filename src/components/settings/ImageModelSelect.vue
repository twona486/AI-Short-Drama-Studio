<script setup lang="ts">

import { computed, ref, watch } from 'vue'
import { zealmanImageProfileLabel, zealmanImageWorkflowLabel } from '@/services/ai/zealman'
import { DRAW_THINGS_PROVIDER, drawThingsModelLabel, isDrawThingsGrpc } from '@/services/ai/drawThingsOptions'
import { refreshDrawThingsModels } from '@/services/ai/drawThings'
import ParamSelect from '@/components/common/ParamSelect.vue'
import { llmChoiceKey, namedModelGroups, parseLlmChoiceKey, useSettingsStore } from '@/stores'

defineProps<{
  label?: string
}>()

const settings = useSettingsStore()
const catalogStatus = ref('')
const catalogBusy = ref(false)
const drawThingsGrpc = computed(() => settings.config.image.provider === DRAW_THINGS_PROVIDER &&
  isDrawThingsGrpc(settings.config.image.baseUrl))

async function refreshCatalog() {
  if (catalogBusy.value || !drawThingsGrpc.value) return
  const { activeImageId, image } = settings.config
  catalogBusy.value = true
  catalogStatus.value = ''
  try {
    const result = await refreshDrawThingsModels(activeImageId, image.baseUrl, image.drawThingsSharedSecret)
    if (settings.config.activeImageId === activeImageId && settings.config.image.baseUrl === image.baseUrl) {
      catalogStatus.value = result.ok ? '' : result.detail
    }
  } finally {
    catalogBusy.value = false
  }
}

watch([drawThingsGrpc, () => settings.config.activeImageId], () => {
  catalogStatus.value = ''
  if (drawThingsGrpc.value && settings.config.image.drawThingsServerModels === undefined) void refreshCatalog()
}, { immediate: true })

const groups = computed(() => {
  const profiles = settings.config.images ?? []
  return namedModelGroups(profiles.map((p) => ({ ...p, name: zealmanImageProfileLabel(p.name, p.model) })))
})

const model = computed({
  get() {
    const id = settings.config.activeImageId
    const name = settings.config.image.model
    return id && name ? llmChoiceKey(id, name) : ''
  },
  set(v: string) {
    const parsed = parseLlmChoiceKey(v)
    if (parsed) settings.selectImageModel(parsed.profileId, parsed.model)
  }
})
</script>

<template>
  <ParamSelect :label="label ?? $t('imageModelSelect.generate')" :model-value="model" @update:model-value="model = $event">
    <option v-if="!model || !groups.some((g) => g.models.length)" value="" disabled>{{ $t('imageModelSelect.noModel') }}</option>
    <optgroup v-for="g in groups" :key="g.id" :label="g.name">
      <option v-for="m in g.models" :key="g.id + m" :value="llmChoiceKey(g.id, m)">{{ drawThingsModelLabel(zealmanImageWorkflowLabel(m)) }}</option>
    </optgroup>
  </ParamSelect>
  <button v-if="drawThingsGrpc" type="button" :disabled="catalogBusy"
    :title="catalogStatus || $t('drawThings.refreshModels')" @click.stop="refreshCatalog">
    {{ $t('drawThings.refreshModels') }}
  </button>
</template>
