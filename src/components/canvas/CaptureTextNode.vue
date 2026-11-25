<script setup lang="ts">
import { t, uiPunctuation } from '@/i18n'
import { computed, ref } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useProjectStore } from '@/stores'

const props = defineProps<{ id: string; selected?: boolean; data: { label?: string; prompt?: string; captureJson?: string; height?: number } }>()
const store = useProjectStore()
const nodeData = computed(() => store.current?.canvas?.nodes.find(n => n.id === props.id)?.data)
const plain = computed({
  get: () => nodeData.value?.prompt || props.data.prompt || '',
  set: (value: string) => store.setCanvasNodePrompt(props.id, value)
})

function readPlan(raw?: string) {
  if (!raw?.trim().startsWith('{')) return null
  try {
    const value = JSON.parse(raw)
    if (!value?.plan?.title || !Array.isArray(value.plan.scenes)) return null
    return value as {
      phase?: string
      sceneIndex?: number
      modelName?: string
      maxSeconds?: number
      plan: {
        title: string
        aesthetic: string
        assets: Array<{ id: string; name: string; kind: string }>
        scenes: Array<{ id: string; name: string; assetIds: string[]; segments: Array<{ duration: number; title?: string; dialogue?: Array<{ speaker: string; text: string }> }> }>
      }
    }
  } catch {
    return null
  }
}

const plan = computed(() => readPlan(nodeData.value?.captureJson) || readPlan(plain.value))
const seconds = computed(() => plan.value?.plan.scenes.reduce((sum, scene) => sum + scene.segments.reduce((n, seg) => n + seg.duration, 0), 0) || 0)
const shotCount = computed(() => plan.value?.plan.scenes.reduce((sum, scene) => sum + scene.segments.length, 0) || 0)
const nextStep = computed(() => {
  const state = plan.value
  if (!state) return ''
  if (state.phase === 'complete') return t('timelineTracks.complete')
  if (state.phase === 'videos') return t('timelineTracks.shootScenes')
  const scene = state.plan.scenes[state.sceneIndex || 0]
  return scene ? t('continuousCapture.preparingScene', { name: scene.name }) : t('timelineTracks.shoot')
})
const kindLabel = computed<Record<string, string>>(() => ({ character: t('timelineTracks.character'), prop: t('timelineTracks.prop'), scene: t('timelineTracks.scene') }))
function assetsOf(ids: string[]) {
  const assets = plan.value?.plan.assets || []
  return ids.map(id => assets.find(asset => asset.id === id)).filter((asset): asset is { id: string; name: string; kind: string } => Boolean(asset))
}
function linesOf(scene: { segments: Array<{ dialogue?: Array<{ speaker: string; text: string }> }> }) {
  return scene.segments.flatMap(seg => seg.dialogue || [])
}
const copied = ref(false)
async function copy() {
  const text = plan.value ? (nodeData.value?.prompt || plain.value) : plain.value
  try { await navigator.clipboard.writeText(text); copied.value = true } catch { copied.value = false }
}
</script>
<template>
  <section class="capture-text" :class="{ selected, plan: Boolean(plan) }" :style="plan ? { height: `${data.height || 720}px` } : undefined">
    <header>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7" /></svg>
      <strong>{{ plan?.plan.title || data.label }}</strong>
      <button class="nodrag" @click.stop="copy">{{ copied ? $t('common.copied') : $t('common.copy') }}</button>
    </header>
    <div v-if="plan" class="sheet nodrag nowheel">
      <p class="overview">
        <span>{{ $t('continuousCapture.duration', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }) }}</span>
        <span>{{ $t('continuousCapture.sceneStats', { scenes: plan.plan.scenes.length, shots: shotCount }) }}</span>
      </p>
      <p class="next">{{ nextStep }}</p>
      <p v-if="plan.plan.aesthetic" class="look">{{ plan.plan.aesthetic }}</p>
      <ol>
        <li v-for="(scene, index) in plan.plan.scenes" :key="scene.id" :class="{ current: plan.phase !== 'complete' && index === (plan.sceneIndex || 0) && plan.phase !== 'videos' }">
          <div class="scene-head">
            <strong>{{ index + 1 }}. {{ scene.name }}</strong>
            <span>{{ $t('continuousCapture.seconds', { count: scene.segments.reduce((n, seg) => n + seg.duration, 0) }) }}</span>
          </div>
          <p class="beats">{{ scene.segments.map(seg => $t('continuousCapture.seconds', { count: seg.duration })).join(' + ') }}</p>
          <p v-if="assetsOf(scene.assetIds).length" class="cast">
            <span v-for="asset in assetsOf(scene.assetIds)" :key="asset.id">{{ kindLabel[asset.kind] || $t('timelineTracks.asset') }} {{ asset.name }}</span>
          </p>
          <p v-for="(line, lineIndex) in linesOf(scene)" :key="lineIndex" class="line">{{ line.speaker }}{{ uiPunctuation.colon }}{{ line.text }}</p>
        </li>
      </ol>
      <p v-if="plan.modelName" class="model">{{ plan.modelName }} · {{ $t('timelineTracks.clipRange', { min: Math.min(6, plan.maxSeconds || 6), max: plan.maxSeconds }) }}</p>
    </div>
    <textarea v-else v-model="plain" class="nodrag nowheel" :aria-label="$t('timelineTracks.shotText')" />
    <footer>{{ plan ? $t('timelineTracks.planHint') : $t('timelineTracks.shotHint') }}</footer>
    <Handle id="out" type="source" :position="Position.Right" />
  </section>
</template>
<style scoped>
.capture-text { width: 360px; height: 350px; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden; color: #c8c8ce; background: color-mix(in srgb, var(--nb-bg-2) 62%, transparent); border: none; border-radius: 4px; }
.capture-text.plan { width: 440px; }
.capture-text.selected { outline: 1px solid rgba(255, 255, 255, 0.28); }
header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: transparent; font-size: 13px; }
header strong { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d8d8de; font-weight: 600; }
svg { width: 16px; height: 16px; fill: none; stroke: #9a9aa3; stroke-width: 1.5; }
button { color: #c8c8ce; background: #2a2a2e; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; }
.sheet { flex: 1; min-height: 0; overflow: auto; padding: 14px 14px 8px; }
.overview { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
.overview span, .cast span { padding: 3px 7px; border-radius: 4px; background: #222226; color: #b7b7bc; font-size: 11px; }
.next { margin: 0 0 8px; color: #d4d4d8; font-size: 13px; }
.look, .model { margin: 0 0 12px; color: #8d8d93; font-size: 12px; line-height: 1.5; }
ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
li { padding: 10px 12px; border-radius: 4px; background: transparent; }
li.current { background: transparent; }
.scene-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.scene-head strong { color: #dedee3; font-size: 13px; font-weight: 600; }
.scene-head span, .beats { color: #9a9aa3; font-size: 12px; }
.beats, .cast, .line { margin: 6px 0 0; }
.cast { display: flex; flex-wrap: wrap; gap: 6px; }
.line { color: #c8c8ce; font-size: 12px; line-height: 1.55; }
textarea { flex: 1; min-height: 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; padding: 14px; border: none; resize: none; background: transparent; color: inherit; line-height: 1.7; font-family: inherit; font-size: 12px; outline: none; }
footer { padding: 8px 14px; color: #8d8d93; font-size: 11px; background: transparent; }
/* LUMEN: solid white card and dark body text. Dark theme keeps the rules above. */
:root[data-theme='light'] .capture-text {
  background: #ffffff;
  color: var(--nb-t1);
}
:root[data-theme='light'] .capture-text.selected { outline-color: var(--nb-line-4); }
:root[data-theme='light'] header strong,
:root[data-theme='light'] .next,
:root[data-theme='light'] .scene-head strong,
:root[data-theme='light'] .line { color: var(--nb-t1); }
:root[data-theme='light'] .look,
:root[data-theme='light'] .model,
:root[data-theme='light'] .scene-head span,
:root[data-theme='light'] .beats,
:root[data-theme='light'] footer { color: var(--nb-t2); }
:root[data-theme='light'] svg { stroke: var(--nb-t3); }
</style>
