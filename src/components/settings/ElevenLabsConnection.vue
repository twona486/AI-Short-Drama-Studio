<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { t } from '@/i18n'
import { desktop, isDesktop } from '@/services/desktop'
import { elevenLabsRequest } from '@/services/ai/elevenLabsDesktop'

const props = defineProps<{ profileId: string; model: string; encryptedKey?: string }>()
const emit = defineEmits<{ 'update:encryptedKey': [key: string | undefined] }>()
const keyInput = ref('')
const busy = ref(false)
const saving = ref(false)
const status = ref('')
let controller: AbortController | undefined

watch(() => [props.profileId, props.model], () => {
  controller?.abort()
  keyInput.value = ''
  status.value = ''
})
onBeforeUnmount(() => controller?.abort())

async function saveKey() {
  const profile = props.profileId
  const key = keyInput.value.trim()
  if (!key) return
  saving.value = true
  status.value = ''
  try {
    const protectedKey = isDesktop() && await desktop().protectElevenLabsKey?.(key)
    if (props.profileId !== profile) return
    if (!protectedKey) throw new Error(t('elevenLabs.keyStorageFailed'))
    keyInput.value = ''
    emit('update:encryptedKey', protectedKey)
    status.value = t('elevenLabs.keyStored')
  } catch {
    if (props.profileId === profile) status.value = t('elevenLabs.keyStorageFailed')
  } finally {
    saving.value = false
  }
}

function removeKey() {
  controller?.abort()
  emit('update:encryptedKey', undefined)
  status.value = t('elevenLabs.keyRemoved')
}

async function check() {
  const request = new AbortController()
  controller = request
  busy.value = true
  status.value = ''
  try {
    const { creditsRemaining } = await elevenLabsRequest(props.encryptedKey, {
      kind: 'connection', model: props.model
    }, request.signal)
    status.value = creditsRemaining === undefined ? t('elevenLabs.connected')
      : t('elevenLabs.connectedCredits', { count: creditsRemaining.toLocaleString() })
  } catch (cause) {
    if (!request.signal.aborted) status.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="eleven-connection" @submit.prevent="saveKey">
    <label>
      ElevenLabs API Key
      <input v-model="keyInput" type="password" autocomplete="off" :placeholder="$t('elevenLabs.keyPlaceholder')" />
    </label>
    <div class="actions">
      <button type="submit" :disabled="!keyInput.trim() || saving || busy">{{ $t('elevenLabs.saveKey') }}</button>
      <button type="button" :disabled="!encryptedKey || saving" @click="removeKey">{{ $t('elevenLabs.removeKey') }}</button>
      <button type="button" :disabled="!encryptedKey || busy || saving" @click="check">{{ $t('elevenLabs.check') }}</button>
    </div>
    <p v-if="busy" role="status">{{ $t('elevenLabs.checking') }}</p>
    <p v-else role="status">{{ status || $t(encryptedKey ? 'elevenLabs.keyStored' : 'elevenLabs.missingKey') }}</p>
  </form>
</template>

<style scoped>
.eleven-connection, label { display: grid; gap: 6px; }
label, p { font-size: 11px; margin: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
input, button {
  color: var(--color-text-1);
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 6px 8px;
  font: inherit;
}
button { cursor: pointer; }
button:disabled { opacity: .55; cursor: default; }
</style>
