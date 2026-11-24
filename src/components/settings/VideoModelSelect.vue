<script setup lang="ts">
import { computed } from 'vue'
import ParamSelect from '@/components/common/ParamSelect.vue'
import { normalizeVideoGenModel, stillModeForVideoModel, type VideoGenModel } from '@/types'
import { useSettingsStore } from '@/stores'

const props = defineProps<{
  modelValue?: VideoGenModel | string
  profileId?: string
  label?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: VideoGenModel]
  'selectProfile': [profileId: string]
}>()
const settings = useSettingsStore()
const comfyWorkflows = computed(() => settings.config.videos.filter(p => p.adapter?.type === 'comfyui-prompt' && p.adapter.workflowTemplate?.trim()))
const otherProfiles = computed(() => settings.config.videos.filter(p => p.adapter?.type !== 'comfyui-prompt'))
const missingProfile = computed(() => Boolean(props.profileId && !settings.config.videos.some(p => p.id === props.profileId)))

const value = computed(() => {
  const m = normalizeVideoGenModel(props.modelValue)
  if (m === 'wan-prime' || m === 'h3-v5') return m
  if (missingProfile.value) return '__missing__'
  if (props.profileId && settings.config.videos.some((profile) => profile.id === props.profileId)) {
    return props.profileId
  }
  return settings.config.activeVideoId || 'h3'
})

function profileLabel(profile: { name: string; provider?: string; baseUrl?: string; adapter?: { type?: string } }) {
  const zealman = profile.provider === 'zealman' || profile.adapter?.type === 'zealman-workflow'
  const autodl = !zealman && (profile.provider === 'autodl' || /autodl\.art/i.test(profile.baseUrl || ''))
  const tag = zealman ? 'Zealman' : autodl ? 'AutoDL' : ''
  return tag ? `${tag} · ${profile.name}` : profile.name
}

function onPick(v: string) {
  if (v === 'wan-prime' || v === 'h3-v5' || v === 'h3') {
    emit('update:modelValue', v)
    return
  }
  emit('selectProfile', v)
}
</script>

<template>
  <ParamSelect :label="label" max-width="260px" :model-value="value" @update:model-value="onPick">
    <option v-if="missingProfile" value="__missing__" disabled>原工作流已删除，请重新选择</option>
    <optgroup v-if="comfyWorkflows.length" label="ComfyUI 工作流">
      <option v-for="p in comfyWorkflows" :key="p.id" :value="p.id">{{ p.name }}</option>
    </optgroup>
    <optgroup v-if="otherProfiles.length" :label="$t('common.configuredVideo')">
      <option v-for="p in otherProfiles" :key="p.id" :value="p.id">
        {{ profileLabel(p) }}{{ stillModeForVideoModel('h3', p) === 'keyframe' ? $t('videoModelSelect.keyframeSuffix') : stillModeForVideoModel('h3', p) === 'storyboard' ? $t('videoModelSelect.boardSuffix') : '' }}
      </option>
    </optgroup>
    <optgroup :label="$t('common.autoDlWorkflow')">
      <option value="h3">
        {{ $t('videoModelSelect.h3') }}{{ stillModeForVideoModel('h3', settings.config.video) === 'keyframe' ? $t('videoModelSelect.requiresKeyframe') : stillModeForVideoModel('h3', settings.config.video) === 'storyboard' ? $t('videoModelSelect.requiresBoard') : $t('videoModelSelect.identity') }}
      </option>
      <option value="h3-v5">{{ $t('videoModelSelect.h3v5') }}</option>
      <option value="wan-prime">{{ $t('videoModelSelect.wan') }}</option>
    </optgroup>
  </ParamSelect>
</template>
