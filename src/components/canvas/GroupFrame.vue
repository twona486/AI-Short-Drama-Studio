<script setup lang="ts">
import { t as translate } from '@/i18n'
import zh from '@/locales/zh'
import { computed } from 'vue'
import { useProjectStore, useToastStore } from '@/stores'
import { groupGenerateJobId, runExtractGroup, runGenerateGroup } from '@/services/canvas/runner'
import { isNodeRunning } from '@/services/canvas/jobs'
import { isPlayReady } from '@/services/ai'
import { friendlyAiError, shouldToastAiError } from '@/services/ai/abort'
import { isPlayApproved } from '@/services/canvas/playGate'
import NodeBusyOverlay from '@/components/canvas/NodeBusyOverlay.vue'

const props = defineProps<{
  id: string
  data: {
    label?: string
    kind?: string
  }
}>()

const project = useProjectStore()
const toast = useToastStore()
const label = computed(() => {
  const name = props.data.label
  if (!name) return translate('groupFrame.group')
  const entry = Object.entries(zh.groupFrame.names).find(([, value]) => value === name)
  return entry ? translate(`groupFrame.names.${entry[0]}`) : name
})

const extractable = computed(() => {
  if (props.data.kind === 'subject' || props.data.kind === 'scene' || props.data.kind === 'shot') return true
  return props.data.kind === 'video' && !project.current?.canvas?.nodes.some((n) => n.id === 'group-shots')
})
const generatable = computed(
  () =>
    props.data.kind === 'subject' ||
    props.data.kind === 'prop' ||
    props.data.kind === 'scene' ||
    props.data.kind === 'shot' ||
    props.data.kind === 'frames' ||
    props.data.kind === 'video'
)
const running = computed(() => isNodeRunning(props.id))
const generating = computed(() => isNodeRunning(groupGenerateJobId(props.id)))
const busy = computed(() => running.value || generating.value)
const playReady = computed(
  () => isPlayReady(project.current?.script) || Boolean((project.current?.script?.content || '').trim())
)
const hasItems = computed(() => {
  if (props.data.kind === 'subject') return Boolean(project.current?.subjects?.length)
  if (props.data.kind === 'prop') return Boolean(project.current?.props?.length)
  if (props.data.kind === 'scene') return Boolean(project.current?.scenes?.length)
  return Boolean(project.current?.shots.length)
})
const childCount = computed(
  () =>
    project.current?.canvas?.nodes.filter(
      (n) =>
        n.parentGroupId === props.id &&
        (n.type === 'subject' ||
          n.type === 'prop' ||
          n.type === 'scene' ||
          n.type === 'shotBoard' ||
          n.type === 'shotImage' ||
          n.type === 'shotFrames' ||
          n.type === 'shotVideo' ||
          n.type === 'sceneProps')
    ).length ?? 0
)
const runningChildCount = computed(
  () =>
    project.current?.canvas?.nodes.filter(
      (n) => n.parentGroupId === props.id && isNodeRunning(n.id)
    ).length ?? 0
)
const btnLabel = computed(() => {
  if (running.value) return translate('groupFrame.extracting')
  if (props.data.kind === 'subject') return hasItems.value ? translate('groupFrame.extractAgain') : translate('groupFrame.extractCharacters')
  if (props.data.kind === 'scene') return hasItems.value ? translate('groupFrame.extractAgain') : translate('groupFrame.extractScenes')
  return hasItems.value ? translate('groupFrame.extractAgain') : translate('groupFrame.extractShots')
})
const genLabel = computed(() => (generating.value ? translate('groupFrame.generating') : translate('groupFrame.generateAll')))
const overlayLabel = computed(() => {
  if (running.value) return btnLabel.value
  if (generating.value && childCount.value) return translate('groupFrame.progress', { p0: runningChildCount.value, p1: childCount.value })
  return genLabel.value
})

async function reextract(ev: Event) {
  ev.stopPropagation()
  if (busy.value || !extractable.value) return
  if (!playReady.value) {
    toast.warn(translate('groupFrame.scriptRequired'))
    return
  }
  try {
    await runExtractGroup(props.id)
    toast.success(
      props.data.kind === 'subject'
        ? translate('groupFrame.charactersUpdated')
        : props.data.kind === 'scene'
          ? translate('groupFrame.scenesUpdated')
          : translate('groupFrame.shotsUpdated')
    )
  } catch (e) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e))
  }
}

async function generateAll(ev: Event) {
  ev.stopPropagation()
  if (busy.value || !generatable.value || !hasItems.value) return
  if (
    (props.data.kind === 'shot' || props.data.kind === 'frames' || props.data.kind === 'video') &&
    !isPlayApproved(project.current)
  ) {
    toast.warn(translate('common.reviewScript'))
    return
  }
  try {
    await runGenerateGroup(props.id)
    toast.success(
      props.data.kind === 'subject'
        ? translate('groupFrame.charactersReady')
        : props.data.kind === 'prop'
          ? translate('groupFrame.propsReady')
        : props.data.kind === 'scene'
          ? translate('groupFrame.scenesReady')
          : props.data.kind === 'video'
            ? translate('groupFrame.videosReady')
            : translate('groupFrame.keyframesReady')
    )
  } catch (e) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e))
  }
}
</script>

<template>
  <div class="gframe" :class="[data.kind ? `tint-${data.kind}` : '', { busy }]">
    <div class="gframe-h">
      <span>{{ label }}</span>
      <div v-if="extractable || generatable" class="gframe-actions nodrag nopan">
        <button
          v-if="extractable"
          type="button"
          class="gframe-btn"
          :disabled="busy || !playReady"
          :title="hasItems ? $t('groupFrame.extractHint') : $t('groupFrame.extract')"
          @click="reextract"
          @mousedown.stop
          @pointerdown.stop
        >
          {{ btnLabel }}
        </button>
        <button
          v-if="generatable"
          type="button"
          class="gframe-btn gen"
          :disabled="busy || !hasItems"
          :title="$t('groupFrame.generateHint')"
          @click="generateAll"
          @mousedown.stop
          @pointerdown.stop
        >
          {{ genLabel }}
        </button>
      </div>
    </div>
    <NodeBusyOverlay v-if="busy" :label="overlayLabel" />
  </div>
</template>

<style scoped>
.gframe {
  width: 100%;
  height: 100%;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: color-mix(in srgb, var(--nb-bg-2) 28%, transparent);
  pointer-events: none;
}
.gframe-h {
  position: relative;
  z-index: 4;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 12px 0 16px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--color-text-2);
  pointer-events: none;
}
.gframe-h > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gframe-actions {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.gframe-btn {
  pointer-events: auto;
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 650;
  padding: 5px 10px;
  border-radius: 8px;
  background: var(--color-bg-3);
  color: var(--color-text-1);
  border: 1px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
}
.gframe-btn.gen {
  border-color: rgba(255, 255, 255, 0.22);
}
.gframe-btn:hover:not(:disabled) {
  background: var(--color-accent);
  color: #fff;
  border-color: transparent;
}
.gframe-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.tint-script,
.tint-subject,
.tint-scene,
.tint-shot,
.tint-video,
.tint-audio,
.tint-export {
  background: color-mix(in srgb, var(--nb-bg-2) 28%, transparent);
  border-color: rgba(255, 255, 255, 0.08);
}
</style>
