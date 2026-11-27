<script setup lang="ts">
import { onMounted, computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useProjectStore, useAssetsStore, useSettingsStore } from '@/stores'
import AppLayout from '@/components/layout/AppLayout.vue'
import TitleBar from '@/components/layout/TitleBar.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import ToastContainer from '@/components/common/ToastContainer.vue'
import ImageLightbox from '@/components/common/ImageLightbox.vue'
import NoticeBanner from '@/components/common/NoticeBanner.vue'

const route = useRoute()
const project = useProjectStore()
const assets = useAssetsStore()
const settings = useSettingsStore()
const storageRecovery = ref<'usingRecovery' | 'unavailable' | null>(null)

const showLayout = computed(
  () =>
    route.name !== 'home' &&
    route.name !== 'studio' &&
    route.name !== 'edit' &&
    route.name !== 'smart-speech' &&
    route.name !== 'scripts' &&
    route.name !== 'settings'
)

watch(
  () => settings.config.theme,
  (theme) => {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
  },
  { immediate: true }
)

onMounted(async () => {
  void window.desktop?.getStorageRecovery()
    .then((status) => { storageRecovery.value = status })
    .catch((error) => console.warn('Could not read the storage recovery status', error))
  await settings.ensureHydrated()
  await project.ensureLoaded()
  await assets.refresh()
  project.startAutoSave()
})
</script>

<template>
  <div class="app-root">
    <TitleBar />
    <NoticeBanner />
    <section v-if="storageRecovery" class="storage-recovery" role="status">
      <p>{{ $t(`storageRecovery.${storageRecovery}`) }}</p>
      <GradientButton v-if="storageRecovery === 'usingRecovery'" type="ghost" @click="storageRecovery = null">
        {{ $t('storageRecovery.continue') }}
      </GradientButton>
      <GradientButton type="ghost" @click="$router.push('/settings/system?chooseStorage=1')">
        {{ $t('storageRecovery.choose') }}
      </GradientButton>
    </section>
    <div class="app-body">
      <ToastContainer />
      <ImageLightbox />
      <template v-if="settings.diskReady && showLayout">
        <AppLayout>
          <router-view v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </AppLayout>
      </template>
      <template v-else-if="settings.diskReady">
        <router-view />
      </template>
    </div>
  </div>
</template>

<style scoped>
.app-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.storage-recovery {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  flex-shrink: 0;
  padding: 8px 16px;
  border-bottom: 1px solid currentColor;
}
.storage-recovery p {
  flex: 1;
  margin: 0;
  font-size: 13px;
}
.app-body {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
}
</style>

