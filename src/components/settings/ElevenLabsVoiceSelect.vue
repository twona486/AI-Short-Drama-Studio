<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSettingsStore } from '@/stores'
import { elevenLabsRequest } from '@/services/ai/elevenLabsDesktop'
import { ELEVENLABS_CAST, recommendElevenLabsVoice, type ElevenLabsVoice } from '@/services/ai/elevenLabsTts'

const props = defineProps<{
  modelValue: string
  name?: string
  description?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [id: string] }>()
const settings = useSettingsStore()
const key = computed(() => settings.config.tts.encryptedElevenLabsKey)
const expanded = ref(false)
const search = ref('')
const source = ref<'account' | 'library'>('library')
const results = ref<ElevenLabsVoice[]>([])
const next = ref<string>()
const busy = ref(false)
const error = ref('')
let controller: AbortController | undefined

const automatic = computed(() => recommendElevenLabsVoice(props.description, props.name, [], settings.config.tts.voice))
const recommended = computed(() => recommendElevenLabsVoice(props.description, props.name, results.value, settings.config.tts.voice))
const options = computed(() => {
  const items = new Map([...ELEVENLABS_CAST, ...results.value].map((voice) => [voice.id, voice]))
  if (props.modelValue && !items.has(props.modelValue)) {
    items.set(props.modelValue, { id: props.modelValue, name: props.modelValue })
  }
  return [...items.values()]
})

async function load(cursor?: string) {
  controller?.abort()
  const request = new AbortController()
  controller = request
  busy.value = true
  error.value = ''
  if (!cursor) {
    results.value = []
    next.value = undefined
  }
  try {
    const reply = await elevenLabsRequest(key.value, {
      kind: 'voices', source: source.value, search: search.value.trim(), cursor
    }, request.signal)
    results.value = cursor ? [...results.value, ...reply.voices] : reply.voices
    next.value = reply.next
  } catch (cause) {
    if (!request.signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (controller === request) busy.value = false
  }
}

function toggle() {
  expanded.value = !expanded.value
  if (expanded.value && key.value) void load()
  else controller?.abort()
}
watch([key, source], () => {
  if (expanded.value) void load()
})
onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <div class="eleven-voice nodrag nowheel">
    <label>
      {{ $t(name !== undefined ? 'openAiTts.characterVoice' : 'common.voice') }}
      <select :value="modelValue" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
        <option v-if="name !== undefined" value="">
          {{ $t('openAiTts.automaticVoice') }} · {{ automatic.name }}
        </option>
        <option v-for="voice in options" :key="voice.id" :value="voice.id">{{ voice.name }}</option>
      </select>
    </label>
    <button type="button" @click="toggle">{{ $t(expanded ? 'common.hide' : 'elevenLabs.browse') }}</button>
    <template v-if="expanded">
      <p v-if="!key">{{ $t('elevenLabs.missingKey') }}</p>
      <template v-else>
        <select v-model="source" :aria-label="$t('elevenLabs.source')">
          <option value="library">{{ $t('elevenLabs.library') }}</option>
          <option value="account">{{ $t('elevenLabs.account') }}</option>
        </select>
        <form class="search" @submit.prevent="load()">
          <input v-model="search" :aria-label="$t('elevenLabs.search')" :placeholder="$t('elevenLabs.searchPlaceholder')" />
          <button type="submit" :disabled="busy">{{ $t('elevenLabs.search') }}</button>
        </form>
        <p v-if="error" role="alert">{{ error }}</p>
        <p v-else-if="busy" role="status">{{ $t('elevenLabs.loading') }}</p>
        <p v-else-if="!results.length">{{ $t('elevenLabs.empty') }}</p>
        <button
          v-if="name !== undefined && recommended.id !== automatic.id"
          type="button"
          @click="emit('update:modelValue', recommended.id)"
        >{{ $t('elevenLabs.useRecommendation', { voice: recommended.name }) }}</button>
        <button v-if="next" type="button" :disabled="busy" @click="load(next)">{{ $t('elevenLabs.more') }}</button>
      </template>
    </template>
  </div>
</template>

<style scoped>
.eleven-voice, label { display: grid; gap: 6px; }
.search { display: flex; gap: 6px; }
input, select { min-width: 0; width: 100%; }
input, select, button {
  color: var(--color-text-1);
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 6px;
  font: inherit;
}
button { cursor: pointer; }
p { margin: 0; overflow-wrap: anywhere; }
</style>
