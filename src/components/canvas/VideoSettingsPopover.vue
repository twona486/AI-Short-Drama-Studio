<script setup lang="ts">
import { ltxCost } from '@/services/ai/ltxOptions'
import { t } from '@/i18n'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AspectRatioSeg from '@/components/common/AspectRatioSeg.vue'
import DocAudioToggle from '@/components/common/DocAudioToggle.vue'
import { docVideoResolutionLabel, type DocVideoResolution } from '@/services/ai/modelOptions'
import type { AspectRatio } from '@/types'

const props = defineProps<{
  plain?: boolean
  ltxModel?: string
  ltxDesktop?: boolean
  lipSync?: boolean
  resolution: DocVideoResolution
  resolutions: DocVideoResolution[]
  aspect: AspectRatio
  duration: number
  durations: number[]
  showAudio?: boolean
  audio?: boolean
}>()

const emit = defineEmits<{
  'update:resolution': [value: DocVideoResolution]
  'update:aspect': [value: AspectRatio]
  'update:duration': [value: number]
  'update:audio': [value: boolean]
}>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

const summary = computed(() => {
  const resolution = props.resolutions.length ? docVideoResolutionLabel(props.resolution) : ''
  const duration = props.lipSync ? t('lipSync.audioLength') : t('continuousCapture.seconds', { count: props.duration })
  return [resolution, props.aspect, duration].filter(Boolean).join(' · ')
})

function onDocPointer(event: PointerEvent) {
  if (!open.value || props.plain) return
  const target = event.target
  if (target instanceof Node && root.value?.contains(target)) return
  open.value = false
}

watch(open, (value) => {
  if (value) document.addEventListener('pointerdown', onDocPointer, true)
  else document.removeEventListener('pointerdown', onDocPointer, true)
})

onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointer, true))
</script>

<template>
  <div ref="root" class="vset" :class="{ plain }" @pointerdown.stop @mousedown.stop @click.stop>
    <button v-if="!plain" type="button" class="vset-btn" @click="open = !open">
      <span>{{ $t('mediaNodes.videoSettings') }}</span>
      <b>{{ summary }}</b>
    </button>
    <div v-if="plain || open" class="vset-pop">
      <p class="vset-title">{{ $t('mediaNodes.videoSettings') }}</p>
      <div v-if="resolutions.length" class="vset-block">
        <span>{{ $t('common.resolutionLabel') }}</span>
        <div class="vset-seg">
          <button
            v-for="item in resolutions"
            :key="item"
            type="button"
            :class="{ on: item === resolution }"
            @click="emit('update:resolution', item)"
          >
            {{ docVideoResolutionLabel(item) }}
          </button>
        </div>
      </div>
      <div class="vset-block">
        <span>{{ $t('mediaNodes.aspect') }}</span>
        <AspectRatioSeg compact :choices="ltxModel ? ['16:9', '9:16'] : undefined" :model-value="aspect" @update:model-value="emit('update:aspect', $event)" />
      </div>
      <div v-if="!lipSync" class="vset-block">
        <span>{{ $t('common.length') }}</span>
        <select class="vset-select" :value="duration" @change="emit('update:duration', Number(($event.target as HTMLSelectElement).value))">
          <option v-for="n in durations" :key="n" :value="n">{{ $t('continuousCapture.seconds', { count: n }) }}</option>
        </select>
      </div>
      <p v-if="ltxModel && !ltxDesktop" class="vset-block">{{ $t('ltx.cost', { cost: ltxCost(ltxModel, resolution, duration) }) }}</p>
      <div v-if="showAudio && !ltxDesktop" class="vset-block">
        <span>{{ $t('smartSpeech.voice') }}</span>
        <DocAudioToggle :model-value="Boolean(audio)" @update:model-value="emit('update:audio', $event)" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.vset {
  position: relative;
  flex: 0 0 auto;
}
.vset.plain {
  width: 100%;
}
.vset-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  height: 32px;
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  cursor: pointer;
}
.vset-btn span {
  font-size: 10px;
  color: var(--color-text-3);
}
.vset-btn b {
  font-size: 11px;
  font-weight: 650;
}
.vset-pop {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 8;
  width: 280px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--nb-bg-1);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
}
.plain .vset-pop {
  position: static;
  width: auto;
  box-shadow: none;
}
.vset-title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 700;
}
.vset-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}
.vset-block > span {
  font-size: 11px;
  color: var(--color-text-3);
}
.vset-seg {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.vset-seg button {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  font-size: 12px;
  cursor: pointer;
}
.vset-seg button.on {
  border-color: var(--color-accent);
  color: var(--color-text-1);
}
.vset-select {
  height: 32px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  padding: 0 8px;
}
</style>
