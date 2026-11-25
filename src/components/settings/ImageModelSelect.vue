<script setup lang="ts">

import { computed } from 'vue'
import { zealmanImageProfileLabel, zealmanImageWorkflowLabel } from '@/services/ai/zealman'
import { drawThingsModelLabel } from '@/services/ai/drawThingsOptions'
import ParamSelect from '@/components/common/ParamSelect.vue'
import { llmChoiceKey, namedModelGroups, parseLlmChoiceKey, useSettingsStore } from '@/stores'

defineProps<{
  label?: string
}>()

const settings = useSettingsStore()

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
    <option v-if="!groups.some((g) => g.models.length)" value="">{{ $t('imageModelSelect.noModel') }}</option>
    <optgroup v-for="g in groups" :key="g.id" :label="g.name">
      <option v-for="m in g.models" :key="g.id + m" :value="llmChoiceKey(g.id, m)">{{ drawThingsModelLabel(zealmanImageWorkflowLabel(m)) }}</option>
    </optgroup>
  </ParamSelect>
</template>
