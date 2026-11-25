<script setup lang="ts">
import { computed, ref } from 'vue'
import { t, uiPunctuation } from '@/i18n'
import { confirmAction } from '@/utils/confirmAction'
import { useSettingsStore } from '@/stores'
import ComfyWorkflowPanel from './ComfyWorkflowPanel.vue'
import { normalizeComfyBaseUrl } from '@/services/settings/comfyQuickAdd'
import type { AdapterConfig } from '@/services/ai/adapters'

const settings = useSettingsStore()
const url = ref('http://127.0.0.1:8188')
const token = ref('')
const name = ref('')
const kind = ref<'image' | 'video' | 'other'>('video')
const adapter = ref<AdapterConfig>({ type: 'comfyui-prompt', authPrefix: '' })
const message = ref('')
const feedback = ref<'error' | 'success' | 'info'>('info')
const editing = ref('')
const confirmed = ref(false)
const dirty = ref(false)
const otherKey = 'ai-cut:comfy-other-workflows'
const other = ref<Array<{ id: string; name: string; baseUrl: string; adapter: AdapterConfig }>>([])
try { other.value = JSON.parse(localStorage.getItem(otherKey) || '[]') } catch { /* empty catalog */ }
const workflows = computed(() => [
  ...settings.config.images.filter(p => p.adapter?.type === 'comfyui-prompt').map(p => ({ ...p, kind: 'image' as const })),
  ...settings.config.videos.filter(p => p.adapter?.type === 'comfyui-prompt').map(p => ({ ...p, kind: 'video' as const })),
  ...other.value.map(p => ({ ...p, apiKey: '', kind: 'other' as const }))
])
const labels = computed(() => ({ image: t('comfySettings.image'), video: t('comfySettings.video'), other: t('comfySettings.other') }))
const normalized = computed(() => {
  try {
    const u = new URL(normalizeComfyBaseUrl(url.value))
    return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash ? u.href.replace(/\/$/, '') : ''
  } catch { return '' }
})
function load(id: string) {
  const row = workflows.value.find(p => p.id === id)
  if (!row) return
  editing.value = id
  confirmed.value = false
  dirty.value = false
  url.value = row.baseUrl
  token.value = row.apiKey
  name.value = row.name
  kind.value = row.kind
  adapter.value = { ...row.adapter, type: 'comfyui-prompt' }
  message.value = ''
}
function reset() {
  editing.value = ''
  confirmed.value = false
  dirty.value = false
  name.value = ''
  adapter.value = { type: 'comfyui-prompt', authPrefix: '' }
  message.value = ''
}
async function remove(id: string) {
  const row = workflows.value.find(p => p.id === id)
  if (!row || !await confirmAction(t('comfySettings.removeConfirm', { name: row.name }))) return
  if (row.kind === 'image') settings.removeImage(id, true)
  else if (row.kind === 'video') settings.removeVideo(id, true)
  else {
    other.value = other.value.filter(p => p.id !== id)
    localStorage.setItem(otherKey, JSON.stringify(other.value))
  }
  if (editing.value === id) reset()
  feedback.value = 'success'
  message.value = t('comfySettings.removed')
}
function onImported(suggested: string) {
  if (!name.value.trim()) name.value = suggested || t('comfySettings.defaultName')
  feedback.value = 'info'
  message.value = t('comfySettings.imported')
}
function onConfirmed() {
  confirmed.value = true
  feedback.value = 'success'
  message.value = t('comfySettings.confirmed')
}
function save(): boolean {
  const fail = (reason: string) => { feedback.value = 'error'; message.value = reason; return false }
  if (!normalized.value) return fail(t('comfySettings.invalidAddress'))
  if (!adapter.value.workflowTemplate) return fail(t('comfySettings.jsonRequired'))
  if (!name.value.trim()) return fail(t('comfySettings.nameRequired'))
  const draft = { name: name.value.trim(), baseUrl: normalized.value, apiKey: token.value.trim(), adapter: adapter.value, provider: 'custom' }
  if (kind.value === 'video' && (!confirmed.value || !adapter.value.inputMap?.bindings.some(b => b.role === 'length' && b.durationUnit))) {
    return fail(t('comfySettings.durationRequired'))
  }
  let id = editing.value
  if (kind.value === 'image') {
    if (id) { settings.selectImage(id); settings.patchImage(draft) }
    else id = settings.addImage({ ...draft, model: 'comfyui', models: ['comfyui'] })
  } else if (kind.value === 'video') {
    if (id) { settings.selectVideo(id); settings.patchVideo(draft) }
    else id = settings.addVideo({ ...draft, workflowId: 'comfyui-local', stillMode: 'keyframe' })
  } else {
    id ||= crypto.randomUUID()
    other.value = [...other.value.filter(p => p.id !== id), { id, name: draft.name, baseUrl: draft.baseUrl, adapter: draft.adapter }]
    localStorage.setItem(otherKey, JSON.stringify(other.value))
  }
  editing.value = id
  dirty.value = false
  feedback.value = 'success'
  message.value = kind.value === 'video' ? t('comfySettings.videoSaved') : t('comfySettings.workflowSaved')
  return true
}
defineExpose({ savePending: () => !dirty.value || save() })
</script>

<template>
  <section class="comfy-page" @input="dirty = true">
    <h2>{{ $t('comfySettings.heading') }}</h2>
    <p>{{ $t('comfySettings.steps') }}</p>
    <label>{{ $t('comfySettings.address') }}<input v-model="url" placeholder="http://127.0.0.1:8188" /></label>
    <label>{{ $t('comfySettings.token') }}<input v-model="token" type="password" autocomplete="off" /></label>
    <label>{{ $t('comfySettings.name') }}<input v-model="name" :placeholder="$t('comfySettings.nameExample')" /></label>
    <label>{{ $t('comfySettings.kind') }}<select v-model="kind" :disabled="!!editing"><option v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</option></select></label>
    <ComfyWorkflowPanel v-if="normalized" :key="editing || 'new'" draft-only :adapter="adapter" :base-url="normalized" :api-key="token" @patch="adapter = $event; confirmed = false; dirty = true; message = ''" @imported="onImported" @confirmed="onConfirmed" />
    <p v-if="adapter.workflowTemplate && !editing">{{ $t('comfySettings.draftHint') }}</p>
    <p>{{ $t('comfySettings.uploadHint') }}</p>
    <div class="actions"><button type="button" @click="save">{{ $t('comfySettings.save') }}</button><button type="button" @click="reset">{{ $t('comfySettings.new') }}</button></div>
    <p v-if="message" class="feedback" :class="feedback" :role="feedback === 'error' ? 'alert' : 'status'"><strong>{{ feedback === 'error' ? $t('common.unsaved') : feedback === 'success' ? $t('common.generationComplete') : $t('canvasGuide.next') }}{{ uiPunctuation.colon }}</strong>{{ message }}</p>
    <h3>{{ $t('comfySettings.configured') }}</h3>
    <p v-if="!workflows.length">{{ $t('comfySettings.empty') }}</p>
    <div v-for="p in workflows" :key="p.id" class="actions">
      <button class="workflow-name" type="button" @click="load(p.id)">{{ labels[p.kind] }} · {{ p.name }}</button>
      <button type="button" :aria-label="$t('comfySettings.removeLabel', { name: p.name })" @click="remove(p.id)">{{ $t('common.delete') }}</button>
    </div>
  </section>
</template>

<style scoped>
.comfy-page { display: grid; gap: 12px; max-width: 760px; }
.comfy-page h2, .comfy-page h3, .comfy-page p { margin: 0; }
.comfy-page p { color: var(--color-text-3); }
label { display: grid; gap: 4px; }
input, select, button { padding: 8px 10px; color: inherit; background: var(--color-bg-2); border: 1px solid var(--color-border); border-radius: 6px; }
button { cursor: pointer; text-align: left; }
button:disabled { opacity: .5; cursor: default; }
.actions { display: flex; gap: 8px; }
.comfy-page .feedback { padding: 10px 12px; border: 1px solid currentColor; border-radius: 8px; color: #93c5fd; background: #3b82f620; }
.comfy-page .feedback.error { color: #fca5a5; background: #ef444423; }
.comfy-page .feedback.success { color: #86efac; background: #22c55e20; }
.workflow-name { flex: 1; }
</style>
