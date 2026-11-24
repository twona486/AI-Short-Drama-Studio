<script setup lang="ts">
import { t as translate } from '@/i18n'

import { computed, ref } from 'vue'
import { endpointReady, useSettingsStore, useToastStore } from '@/stores'
import { AUTODL_BASE_URL, AUTODL_WORKFLOWS, autodlWorkflowById } from '@/services/ai/autodl'

const settings = useSettingsStore()
const toast = useToastStore()
const token = ref(settings.config.autodlToken || '')
const existing = computed(() =>
  settings.config.videos.filter((item) => item.provider === 'autodl' && Boolean(item.apiKey))
)
function profileDisplayName(profile: (typeof existing.value)[number]) {
  const workflow = autodlWorkflowById(profile.workflowId || '')
  return workflow && profile.name === workflow.name ? workflow.displayName : profile.name
}

const configured = computed(() => Boolean(settings.config.autodlToken) && existing.value.length > 0)

function apply() {
  const key = token.value.trim()
  if (!key) {
    toast.error(translate('autodlSettings.requireToken'))
    return
  }
  settings.setAutodlToken(key)
  const previous = settings.config.activeVideoId
  for (const workflow of AUTODL_WORKFLOWS) {
    const profile = settings.config.videos.find(
      (item) => item.provider === 'autodl' && item.workflowId === workflow.id
    )
    const values = {
      name: workflow.name,
      baseUrl: AUTODL_BASE_URL,
      apiKey: key,
      workflowId: workflow.id,
      provider: 'autodl',
      stillMode: 'identity' as const,
      promptStyle: 'scene-narrative' as const,
      adapter: { type: 'comfyui-workflow' as const }
    }
    if (profile) {
      settings.selectVideo(profile.id)
      settings.patchVideo(values)
    } else settings.addVideo(values)
  }
  // 현재 연결을 쓸 수 있으면 유지한다. API 키가 비어 있는 등 사용할 수 없으면 H3 기본 워크플로로 바꾼다.
  const previousProfile = settings.config.videos.find((item) => item.id === previous)
  if (previousProfile && endpointReady(previousProfile)) {
    settings.selectVideo(previous)
  } else {
    const fallback = settings.config.videos.find(
      (item) => item.provider === 'autodl' && item.workflowId === AUTODL_WORKFLOWS[0].id
    )
    if (fallback) settings.selectVideo(fallback.id)
  }
  toast.success(translate('autodlSettings.configured'))
}
</script>

<template>
  <div class="autodl-settings">
    <section class="panel">
      <div class="heading">
        <div><h2>{{ $t('autodlSettings.heading') }}</h2><p>{{ $t('autodlSettings.h3Hint') }}</p></div>
        <span class="badge" :class="{ ok: configured }">{{ configured ? $t('common.configured') : $t('common.unconfigured') }}</span>
      </div>
      <label for="autodl-token">AutoDL Token</label>
      <div class="url-row">
        <input
          id="autodl-token"
          v-model="token"
          type="password"
          autocomplete="off"
          :placeholder="$t('autodlSettings.copyToken')"
          @keyup.enter="apply"
        />
        <button type="button" @click="apply">{{ $t('common.applyConfig') }}</button>
      </div>
      <p class="hint">
        {{ $t('autodlSettings.tokenStorage') }}
        <a href="https://www.autodl.com" target="_blank" rel="noopener">autodl.com</a>
        {{ $t('autodlSettings.tokenSteps') }}
      </p>
    </section>
    <section class="panel">
      <h2>{{ $t('autodlSettings.builtIn') }}</h2>
      <div class="workflow-list">
        <article v-for="workflow in AUTODL_WORKFLOWS" :key="workflow.id">
          <strong>{{ workflow.name }}</strong>
          <span>{{ workflow.mode === 'fl2va' ? '首尾帧' : workflow.mode === 'audio-sync' ? '口播' : workflow.mode === 'multi-audio' ? '多图多音频' : '图生视频' }}</span>
          <small>{{ workflow.note }} · 最长 {{ workflow.maxDuration }} 秒</small>
        </article>
      </div>
    </section>
    <section v-if="configured" class="panel">
      <h2>{{ $t('common.connected') }}</h2>
      <ul class="ready-list">
        <li v-for="profile in existing" :key="profile.id">
          <b>{{ profileDisplayName(profile) }}</b>
          <span>{{ profile.workflowId }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.autodl-settings{display:grid;gap:16px;max-width:820px}.panel{padding:20px;border:1px solid var(--color-border);border-radius:12px;background:var(--color-bg-1)}.heading{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}h2{margin:0 0 7px;font-size:16px}p{margin:0;color:var(--color-text-3);font-size:12px;line-height:1.6}.badge{padding:5px 9px;border-radius:999px;background:rgba(255,255,255,.08);color:var(--color-text-3);font-size:11px;white-space:nowrap}.badge.ok{background:rgba(66,199,124,.16);color:#57d08b}label{display:block;margin:18px 0 7px;color:var(--color-text-2);font-size:12px}.url-row{display:flex;gap:8px}input{flex:1;min-width:0;height:38px;padding:0 12px;border:1px solid var(--color-border);border-radius:8px;background:var(--color-bg-2);color:var(--color-text-1);outline:none}input:focus{border-color:#6792ff}button{height:38px;padding:0 16px;border:0;border-radius:8px;background:#5686f5;color:#fff;cursor:pointer}.hint{margin-top:9px}.hint a{color:#7fa7ff}.workflow-list{display:grid;gap:8px;margin-top:12px}article{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;padding:13px 14px;border:1px solid var(--color-border);border-radius:9px;background:var(--color-bg-2)}article strong{overflow-wrap:anywhere;font-size:12px}article span{color:#83a8ff;font-size:11px}article small{grid-column:1/-1;color:var(--color-text-4)}.ready-list{display:grid;gap:6px;margin:10px 0 0;padding:0;list-style:none}.ready-list li{display:flex;justify-content:space-between;gap:12px;padding:9px 12px;border:1px solid var(--color-border);border-radius:8px;background:var(--color-bg-2);font-size:12px}.ready-list span{color:var(--color-text-4);overflow-wrap:anywhere}
</style>
