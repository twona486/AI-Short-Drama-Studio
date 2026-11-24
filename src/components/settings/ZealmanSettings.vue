<script setup lang="ts">
import { t as translate } from '@/i18n'

import { computed, ref } from 'vue'
import { useSettingsStore, useToastStore } from '@/stores'
import { ZEALMAN_IMAGE_WORKFLOWS, ZEALMAN_WORKFLOWS, normalizeZealmanBaseUrl } from '@/services/ai/zealman'

const settings = useSettingsStore()
const toast = useToastStore()
const existing = computed(() => settings.config.videos.find((item) => item.provider === 'zealman'))
const baseUrl = ref(settings.config.zealmanBaseUrl || existing.value?.baseUrl || '')

function apply() {
  const normalized = normalizeZealmanBaseUrl(baseUrl.value)
  if (!normalized) {
    toast.error(translate('zealmanSettings.invalidUrl'))
    return
  }
  const previous = settings.config.activeVideoId
  const previousImageId = settings.config.activeImageId
  settings.setZealmanBaseUrl(normalized)
  for (const workflow of ZEALMAN_WORKFLOWS) {
    const profile = settings.config.videos.find(
      (item) => item.provider === 'zealman' && item.workflowId === workflow.id
    )
    const values = {
      name: workflow.displayName,
      baseUrl: normalized,
      apiKey: '',
      workflowId: workflow.id,
      provider: 'zealman',
      stillMode: workflow.stillMode,
      promptStyle: 'scene-narrative' as const,
      adapter: { type: 'zealman-workflow' as const }
    }
    if (profile) {
      settings.selectVideo(profile.id)
      settings.patchVideo(values)
    } else settings.addVideo(values)
  }
  if (settings.config.videos.some((item) => item.id === previous)) settings.selectVideo(previous)
  for (const workflow of ZEALMAN_IMAGE_WORKFLOWS) {
    const profile = settings.config.images.find(
      (item) =>
        item.provider === 'zealman' &&
        item.adapter?.type === 'zealman-workflow' &&
        (item.model === workflow.id || item.model === workflow.name || item.model === workflow.id.replace(/^API-/, ''))
    )
    const values = {
      get name() { return translate('zealmanSettings.imageProfileName', { p0: workflow.displayName }) },
      baseUrl: normalized,
      apiKey: '',
      model: workflow.id,
      models: [workflow.id],
      provider: 'zealman',
      adapter: { type: 'zealman-workflow' as const }
    }
    if (profile) {
      settings.selectImage(profile.id)
      settings.patchImage(values)
    } else {
      settings.addImage(values)
    }
  }
  if (settings.config.images.some((item) => item.id === previousImageId)) settings.selectImage(previousImageId)
  baseUrl.value = normalized
  toast.success(translate('zealmanSettings.configured'))
}
</script>

<template>
  <div class="zealman-settings">
    <section class="panel">
      <div class="heading">
        <div><h2>{{ $t('zealmanSettings.api') }}</h2><p>{{ $t('zealmanSettings.hint') }}</p></div>
        <span class="badge">{{ $t('common.builtinWorkflow') }}</span>
      </div>
      <label for="zealman-base-url">Base URL</label>
      <div class="url-row">
        <input id="zealman-base-url" v-model="baseUrl" placeholder="https://example.seetacloud.com:8443" @keyup.enter="apply" />
        <button type="button" @click="apply">{{ $t('common.applyConfig') }}</button>
      </div>
      <p class="hint">{{ $t('zealmanSettings.endpoints') }}</p>
    </section>
    <section class="panel">
      <h2>{{ $t('zealmanSettings.builtInImage') }}</h2>
      <div class="workflow-list">
        <article v-for="workflow in ZEALMAN_IMAGE_WORKFLOWS" :key="workflow.id">
          <strong>{{ workflow.displayName }}</strong>
          <span>{{ $t('zealmanSettings.textToImage') }}</span>
          <small>{{ $t('common.default') }} {{ workflow.defaultWidth }}×{{ workflow.defaultHeight }} {{ $t('zealmanSettings.pollResult') }}</small>
        </article>
      </div>
    </section>
    <section class="panel">
      <h2>{{ $t('zealmanSettings.builtInWorkflow') }}</h2>
      <div class="workflow-list">
        <article v-for="workflow in ZEALMAN_WORKFLOWS" :key="workflow.id">
          <strong>{{ workflow.displayName }}</strong>
          <span>{{ workflow.mode === 'fl2va' ? $t('zealmanSettings.firstLast') : $t('zealmanSettings.multiReference') }}</span>
          <small>{{ $t('zealmanSettings.maximum') }} {{ workflow.maxDuration }} {{ $t('zealmanSettings.secondsMaximum') }} {{ workflow.maxImages }} {{ $t('zealmanSettings.inputImages') }}</small>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.zealman-settings{display:grid;gap:16px;max-width:820px}.panel{padding:20px;border:1px solid var(--color-border);border-radius:12px;background:var(--color-bg-1)}.heading{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}h2{margin:0 0 7px;font-size:16px}p{margin:0;color:var(--color-text-3);font-size:12px;line-height:1.6}.badge{padding:5px 9px;border-radius:999px;background:rgba(76,130,255,.14);color:#7fa7ff;font-size:11px;white-space:nowrap}label{display:block;margin:18px 0 7px;color:var(--color-text-2);font-size:12px}.url-row{display:flex;gap:8px}input{flex:1;min-width:0;height:38px;padding:0 12px;border:1px solid var(--color-border);border-radius:8px;background:var(--color-bg-2);color:var(--color-text-1);outline:none}input:focus{border-color:#6792ff}button{height:38px;padding:0 16px;border:0;border-radius:8px;background:#5686f5;color:#fff;cursor:pointer}.hint{margin-top:9px}.workflow-list{display:grid;gap:8px;margin-top:12px}article{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;padding:13px 14px;border:1px solid var(--color-border);border-radius:9px;background:var(--color-bg-2)}article strong{overflow-wrap:anywhere;font-size:12px}article span{color:#83a8ff;font-size:11px}article small{grid-column:1/-1;color:var(--color-text-4)}
</style>
