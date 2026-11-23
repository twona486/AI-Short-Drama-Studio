<script setup lang="ts">
import { t as translate } from '@/i18n'
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { llmSetupReady, runSetupAgentTurn, type SetupEvent, type SetupMessage } from '@/services/settings/setupAgent'
import { friendlyAiError, isAbortError, isTimeoutAbort } from '@/services/ai/abort'
import { namedModelGroups } from '@/stores/settings'
import { useSettingsStore, endpointReady } from '@/stores'

const emit = defineEmits<{
  open: [section: string]
}>()

type TraceRow = { key: string; label: string; status?: 'running' | 'done' | 'fail'; detail?: string }
type FeedItem =
  | { id: string; type: 'msg'; role: 'user' | 'assistant'; content: string }
  | { id: string; type: 'run'; rows: TraceRow[] }

const settings = useSettingsStore()
const ready = computed(() => llmSetupReady())
const llmLabel = computed(() => {
  const p = settings.config.llms.find((x) => x.id === settings.config.activeLlmId)
  if (!p) return translate('setupAgent.notConfigured')
  return p.model ? `${p.name} · ${p.model}` : p.name
})

const feed = ref<FeedItem[]>([
  {
    id: 'welcome',
    type: 'msg',
    role: 'assistant',
    content: translate('setupAgent.welcome')
  }
])
const input = ref('')
const busy = ref(false)
const log = ref('')
const trace = ref<TraceRow[]>([])
const setupChips = [
  { id: 'vision', get label() { return translate('setupAgent.setupVision') }, get text() { return translate('setupAgent.setupVisionCommand') } },
  { id: 'image', get label() { return translate('setupAgent.setupImage') }, get text() { return translate('setupAgent.setupImageCommand') } },
  { id: 'tts', get label() { return translate('setupAgent.setupTts') }, get text() { return translate('setupAgent.setupTtsCommand') } },
  { id: 'video', get label() { return translate('setupAgent.setupVideo') }, get text() { return translate('setupAgent.setupVideoCommand') } },
  { id: 'docs', get label() { return translate('setupAgent.fromDocs') }, get text() { return translate('setupAgent.fromDocsCommand') } }
]
const chips = ref<{ label: string; text: string }[]>(setupChips)
const box = ref<HTMLElement | null>(null)
let controller: AbortController | null = null

const messages = computed<SetupMessage[]>(() =>
  feed.value
    .filter((item): item is Extract<FeedItem, { type: 'msg' }> => item.type === 'msg')
    .map((item) => ({ role: item.role, content: item.content }))
)

const llmGroups = computed(() => namedModelGroups(settings.config.llms ?? []))
const abilityRows = computed(() => [
  { id: 'vision', get label() { return translate('common.vision') }, ready: endpointReady(settings.config.vision), get hint() { return translate('setupAgent.visionHint') } },
  { id: 'image', get label() { return translate('common.imageGeneration') }, ready: endpointReady(settings.config.image), get hint() { return translate('setupAgent.imageHint') } },
  { id: 'video', get label() { return translate('setupAgent.video') }, ready: endpointReady(settings.config.video), get hint() { return translate('setupAgent.videoHint') } },
  { id: 'tts', get label() { return translate('setupAgent.tts') }, ready: endpointReady(settings.config.tts), get hint() { return translate('setupAgent.ttsHint') } }
])

async function scrollToEnd() {
  await nextTick()
  box.value?.scrollTo({ top: box.value.scrollHeight, behavior: 'smooth' })
}

function onProgress(ev: SetupEvent) {
  log.value = ev.label
  if (ev.kind === 'think') {
    const i = trace.value.findIndex((s) => s.key === 'think')
    const row: TraceRow = { key: 'think', label: ev.label, status: 'running' }
    if (i >= 0) trace.value[i] = row
    else trace.value = [row, ...trace.value]
  } else if (ev.kind === 'step' && ev.step) {
    const i = trace.value.findIndex((s) => s.key === ev.step)
    const row: TraceRow = { key: ev.step, label: ev.label, status: ev.status || 'running' }
    if (i >= 0) trace.value[i] = { ...trace.value[i], ...row }
    else trace.value = [...trace.value, row]
  }
  void scrollToEnd()
}

function openSection(section: string) {
  emit('open', section)
}

function useChip(c: { label: string; text: string }) {
  if (c.text.endsWith(':\n') || c.text.endsWith('：\n')) {
    input.value = c.text
    return
  }
  void sendText(c.text)
}

function configureAbility(id: string) {
  const chip = setupChips.find((candidate) => candidate.id === id)
  if (chip) useChip(chip)
}

async function sendText(text: string) {
  const t = text.trim()
  if (!t || busy.value) return
  if (t.startsWith('__open_')) {
    openSection(t.replace('__open_', '').replace(/_+$/, ''))
    return
  }
  if (!ready.value) {
    openSection('llm')
    return
  }
  input.value = ''
  feed.value.push({ id: `u-${Date.now()}`, type: 'msg', role: 'user', content: t })
  busy.value = true
  log.value = translate('setupAgent.starting')
  trace.value = [{ key: 'think', get label() { return translate('setupAgent.thinking') }, status: 'running' }]
  chips.value = []
  const turnController = new AbortController()
  controller = turnController
  await scrollToEnd()
  try {
    const result = await runSetupAgentTurn(messages.value, t, onProgress, turnController.signal)
    const think = trace.value.find((s) => s.key === 'think' && s.status === 'running')
    if (think) think.status = 'done'
    if (trace.value.some((s) => s.key !== 'think')) {
      feed.value.push({ id: `run-${Date.now()}`, type: 'run', rows: trace.value.map((row) => ({ ...row })) })
    }
    feed.value.push({ id: `a-${Date.now()}`, type: 'msg', role: 'assistant', content: result.reply })
    chips.value = result.chips
  } catch (e: unknown) {
    const cancelled = turnController.signal.aborted || (isAbortError(e) && !isTimeoutAbort(e))
    feed.value.push({
      id: `a-${Date.now()}`,
      type: 'msg',
      role: 'assistant',
      content: cancelled
        ? translate('setupAgent.turnStopped')
        : translate('agentChat.turnFailed', { error: friendlyAiError(e) })
    })
  } finally {
    busy.value = false
    log.value = ''
    trace.value = []
    controller = null
    await scrollToEnd()
  }
}

function cancel() {
  controller?.abort()
}

onBeforeUnmount(() => controller?.abort())

function pickLlm(profileId: string, model: string) {
  settings.selectLlmModel(profileId, model)
}

const statusText = computed(() => {
  if (!ready.value) return translate('setupAgent.llmFirst')
  if (busy.value) return log.value || translate('setupAgent.writing')
  return llmLabel.value
})
</script>

<template>
  <section class="agent">
    <header class="head">
      <div>
        <h2>{{ $t('common.setupAssistant') }}</h2>
        <p>{{ $t('setupAgent.hint') }}</p>
      </div>
      <span class="status" :class="{ live: busy, warn: !ready }">{{ statusText }}</span>
    </header>

    <div v-if="!ready" class="gate">
      <p>{{ $t('setupAgent.noLlm') }}</p>
      <button type="button" class="go" @click="openSection('llm')">{{ $t('setupAgent.configureLlm') }}</button>
    </div>

    <template v-else>
      <div class="ability-checklist">
        <div v-for="item in abilityRows" :key="item.id" class="ability-item" :class="{ done: item.ready }">
          <i>{{ item.ready ? '✓' : '○' }}</i>
          <span><b>{{ item.label }}</b><small>{{ item.hint }}</small></span>
          <button v-if="!item.ready" type="button" @click="configureAbility(item.id)">{{ $t('setupAgent.delegate') }}</button>
          <em v-else>{{ $t('common.configured') }}</em>
        </div>
      </div>

      <details v-if="llmGroups.reduce((n, g) => n + g.models.length, 0) > 1" class="model-switch">
        <summary>{{ $t('setupAgent.defaultModel') }}<b>{{ llmLabel }}</b><span>{{ $t('setupAgent.switch') }}</span></summary>
        <label class="llm-pick">
          <span>{{ $t('setupAgent.switchModel') }}</span>
          <select :value="`${settings.config.activeLlmId}::${settings.config.llm.model}`" @change="(e) => {
            const v = (e.target as HTMLSelectElement).value
            const i = v.indexOf('::')
            if (i > 0) pickLlm(v.slice(0, i), v.slice(i + 2))
          }">
            <optgroup v-for="g in llmGroups" :key="g.id" :label="g.name">
              <option v-for="m in g.models" :key="g.id + m" :value="`${g.id}::${m}`">{{ m }}</option>
            </optgroup>
          </select>
        </label>
      </details>
      <p v-else class="current-model">{{ $t('setupAgent.defaultModel') }}<b>{{ llmLabel }}</b></p>

      <div ref="box" class="msgs">
        <template v-for="item in feed" :key="item.id">
          <div v-if="item.type === 'msg'" class="msg" :class="item.role">
            {{ item.id === 'welcome' ? $t('setupAgent.welcome') : item.content }}
          </div>
          <ol v-else class="trace">
            <li v-for="s in item.rows.filter((row) => row.key !== 'think')" :key="s.key" :class="s.status">
              {{ s.label }}
            </li>
          </ol>
        </template>
        <ol v-if="busy && trace.length" class="trace live">
          <li v-for="s in trace.filter((row) => row.key !== 'think')" :key="s.key" :class="s.status">
            {{ s.label }}
          </li>
        </ol>
      </div>

      <div v-if="chips.length" class="chips">
        <button v-for="c in chips" :key="c.label" type="button" @click="useChip(c)">{{ c.label }}</button>
      </div>

      <form class="composer" @submit.prevent="sendText(input)">
        <textarea
          v-model="input"
          rows="3"
          :disabled="busy"
          :placeholder="$t('setupAgent.placeholder')"
          @keydown.ctrl.enter.prevent="sendText(input)"
          @keydown.meta.enter.prevent="sendText(input)"
        />
        <div class="actions">
          <span class="hint">{{ $t('setupAgent.keyboardHint') }}</span>
          <button v-if="busy" type="button" class="stop" @click="cancel">{{ $t('common.stop') }}</button>
          <button v-else type="submit" class="go" :disabled="!input.trim()">{{ $t('common.send') }}</button>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped>
.agent {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: auto;
  max-width: 720px;
}
.head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 16px;
}
.head h2 {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 650;
}
.head p {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-3);
  line-height: 1.5;
}
.status {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--color-text-3);
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
}
.status.live {
  color: var(--color-accent);
  border-color: var(--color-accent);
}
.status.warn {
  color: var(--color-warning);
}
.gate {
  padding: 16px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
  border-radius: 6px;
}
.gate p {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--color-text-2);
  line-height: 1.6;
}
.ability-checklist {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 14px;
}
.ability-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 10px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-bg-2);
}
.ability-item > i { color: var(--color-text-4); font-style: normal; font-weight: 700; }
.ability-item.done > i,
.ability-item.done > em { color: #34d399; }
.ability-item > span {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}
.ability-item b { color: var(--color-text-1); font-size: 12px; }
.ability-item small { color: var(--color-text-4); font-size: 10px; }
.ability-item button {
  border: 0;
  background: transparent;
  color: #a78bfa;
  font-size: 11px;
  cursor: pointer;
}
.ability-item em { font-style: normal; font-size: 11px; }
@media (max-width: 680px) {
  .ability-checklist { grid-template-columns: 1fr; }
}
.llm-pick {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--color-text-3);
}
.model-switch {
  margin: 0 0 10px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
}
.model-switch summary {
  cursor: pointer;
  color: var(--color-text-3);
  font-size: 11px;
}
.model-switch summary b { color: var(--color-text-2); font-weight: 600; }
.model-switch summary span { float: right; color: #a78bfa; }
.model-switch .llm-pick { margin: 10px 0 0; }
.current-model {
  margin: 0 0 10px;
  color: var(--color-text-4);
  font-size: 11px;
}
.current-model b { color: var(--color-text-2); }
.llm-pick select {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
}
.msgs {
  flex: 0 1 auto;
  min-height: 140px;
  max-height: min(300px, 34vh);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 0 16px;
}
.msg {
  max-width: 92%;
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.msg.user {
  align-self: flex-end;
  background: var(--color-bg-3);
  color: var(--color-text-1);
}
.msg.assistant {
  align-self: flex-start;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  color: var(--color-text-2);
}
.trace {
  margin: 0;
  padding: 0 0 0 16px;
  font-size: 12px;
  color: var(--color-text-4);
}
.trace li.done {
  color: var(--color-success);
}
.trace li.fail {
  color: var(--color-error);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.chips button {
  margin: 0;
  padding: 5px 10px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  font-size: 12px;
}
.chips button:hover {
  color: var(--color-text-1);
  border-color: var(--color-border-strong);
}
.composer textarea {
  width: 100%;
  resize: vertical;
  min-height: 96px;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  font: inherit;
  font-size: 13px;
}
.composer {
  flex-shrink: 0;
  padding-bottom: 4px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.hint {
  margin-right: auto;
  font-size: 11px;
  color: var(--color-text-4);
}
.go,
.stop {
  margin: 0;
  padding: 7px 14px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
}
.go {
  background: var(--color-accent);
  color: var(--color-on-accent);
}
.go:disabled {
  opacity: 0.45;
}
.stop {
  border: 1px solid var(--color-border);
  color: var(--color-text-2);
}
</style>
