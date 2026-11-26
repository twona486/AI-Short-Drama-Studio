<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '@/stores'
import {
  DRAW_THINGS_PROVIDER, drawThingsEditAlternative, drawThingsInputError, isDrawThingsGrpc
} from '@/services/ai/drawThingsOptions'

const props = defineProps<{ count: number }>()
const settings = useSettingsStore()
const image = computed(() => settings.config.image)
const grpc = computed(() => isDrawThingsGrpc(image.value.baseUrl))
const problem = computed(() => {
  if (image.value.provider !== DRAW_THINGS_PROVIDER || !image.value.model) return undefined
  const error = drawThingsInputError(image.value.model, props.count, grpc.value)
  if (error === 'drawThings.unsupportedModel') return undefined
  return error === 'drawThings.referenceRequired' ? 'drawThings.referenceNeededHint' : error
})
const alternative = computed(() => {
  if (problem.value !== 'drawThings.textOnly') return undefined
  const { drawThingsServerModels, models, model } = image.value
  return drawThingsEditAlternative(drawThingsServerModels ?? models, model, props.count, grpc.value)
})

function switchModel() {
  if (alternative.value) settings.selectImageModel(settings.config.activeImageId, alternative.value)
}
</script>

<template>
  <div v-if="problem" class="reference-hint">
    <small role="status">{{ $t(problem) }}</small>
    <button v-if="alternative" type="button" :title="alternative" @click.stop="switchModel">
      {{ $t('drawThings.switchToEdit') }}
    </button>
  </div>
</template>

<style scoped>
.reference-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  flex-basis: 100%;
  color: var(--color-text-2);
}
</style>
