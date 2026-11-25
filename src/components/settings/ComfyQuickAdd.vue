<script setup lang="ts">
import { runEnterShortcut } from '@/utils/enterShortcut'
import { t as translate } from '@/i18n'

import { ref } from 'vue'
import { addComfyUiProfiles, normalizeComfyBaseUrl } from '@/services/settings/comfyQuickAdd'
import { useToastStore } from '@/stores'

const toast = useToastStore()

const baseUrl = ref('http://127.0.0.1:8188')
const apiKey = ref('')
const addImage = ref(true)
const addVideo = ref(true)
const runTest = ref(true)
const busy = ref(false)
const lastNotes = ref<string[]>([])

async function onAdd() {
  if (busy.value) return
  const kinds: Array<'image' | 'video'> = []
  if (addImage.value) kinds.push('image')
  if (addVideo.value) kinds.push('video')
  if (!kinds.length) {
    toast.error(translate('comfyQuickAdd.featureRequired'))
    return
  }
  const url = normalizeComfyBaseUrl(baseUrl.value)
  if (!url) {
    toast.error(translate('comfyQuickAdd.addressRequired'))
    return
  }
  busy.value = true
  lastNotes.value = []
  try {
    const result = await addComfyUiProfiles({
      baseUrl: url,
      apiKey: apiKey.value,
      kinds,
      select: true,
      test: runTest.value
    })
    lastNotes.value = result.notes
    if (result.ok) {
      toast.success(result.test && !result.test.ok ? translate('comfyQuickAdd.testFailed') : translate('comfyQuickAdd.added'))
    } else {
      toast.error(result.notes[0] || translate('comfyQuickAdd.addFailed'))
    }
  } catch (e: any) {
    toast.error(e?.message || translate('comfyQuickAdd.addFailed'))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="comfy-quick">
    <header class="head">
      <h3>{{ $t('comfyQuickAdd.local') }}</h3>
      <p class="hint">
        {{ $t('comfyQuickAdd.localOnly') }} <code>http://127.0.0.1:8188</code>{{ $t('comfyQuickAdd.remoteHint') }}
      </p>
    </header>

    <label>{{ $t('comfyQuickAdd.address') }}</label>
    <input
      v-model="baseUrl"
      placeholder="http://127.0.0.1:8188"
      @keydown.enter="runEnterShortcut($event, onAdd)"
    />

    <label>{{ $t('comfyQuickAdd.keyOptional') }}</label>
    <input v-model="apiKey" type="password" autocomplete="off" :placeholder="$t('comfyQuickAdd.leaveBlank')" />

    <div class="checks">
      <label class="check">
        <input v-model="addImage" type="checkbox" />
        <span>{{ $t('comfyQuickAdd.addImage') }}</span>
      </label>
      <label class="check">
        <input v-model="addVideo" type="checkbox" />
        <span>{{ $t('comfyQuickAdd.addVideo') }}</span>
      </label>
      <label class="check">
        <input v-model="runTest" type="checkbox" />
        <span>{{ $t('comfyQuickAdd.testAfterAdd') }}</span>
      </label>
    </div>

    <button type="button" class="go" :disabled="busy" @click="onAdd">
      {{ busy ? $t('comfyQuickAdd.adding') : $t('comfyQuickAdd.addAndSelect') }}
    </button>

    <ul v-if="lastNotes.length" class="notes">
      <li v-for="(n, i) in lastNotes" :key="i">{{ n }}</li>
    </ul>
  </section>
</template>

<style scoped>
.comfy-quick {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 640px;
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-1);
}
.head h3 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 650;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-4);
  line-height: 1.5;
}
.hint code {
  font-size: 11px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--color-bg-3);
}
label {
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-4);
}
input[type='text'],
input:not([type]),
input[type='password'] {
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
.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  margin: 8px 0 4px;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  color: var(--color-text-2);
  cursor: pointer;
}
.check input {
  width: auto;
  margin: 0;
}
.go {
  margin-top: 6px;
  align-self: flex-start;
  padding: 8px 14px;
  border: 0;
  border-radius: 6px;
  background: var(--grad-primary, linear-gradient(90deg, #7c3aed, #2563eb));
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.go:disabled {
  opacity: 0.55;
  cursor: default;
}
.notes {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--color-text-3);
  line-height: 1.55;
}
</style>
