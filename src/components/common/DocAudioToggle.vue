<script setup lang="ts">
defineProps<{ modelValue?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <button
    type="button"
    class="audio-toggle"
    :class="{ on: modelValue }"
    :title="modelValue ? $t('docAudioToggle.include') : $t('docAudioToggle.exclude')"
    @click="emit('update:modelValue', !modelValue)"
  >
    {{ modelValue ? $t('docAudioToggle.withSound') : $t('docAudioToggle.muted') }}
  </button>
</template>

<style scoped>
.audio-toggle {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 12px;
  cursor: pointer;
}
.audio-toggle.on {
  color: var(--color-text-1);
  border-color: var(--color-text-3);
}
</style>
