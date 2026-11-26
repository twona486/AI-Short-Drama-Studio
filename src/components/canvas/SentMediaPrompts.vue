<script setup lang="ts">
defineProps<{ prompts?: string[] }>()
</script>

<template>
  <details v-if="prompts?.length" class="sent-prompts">
    <summary>{{ $t('mediaPrompt.viewSent') }}</summary>
    <pre v-for="(prompt, index) in prompts" :key="index" tabindex="0">{{ prompt }}</pre>
  </details>
</template>

<style scoped>
.sent-prompts { margin: 6px 0; font-size: 12px; }
summary { cursor: pointer; }
pre {
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
  font: inherit;
}
</style>
