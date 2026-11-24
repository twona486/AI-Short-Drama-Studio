<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import TopBar from './TopBar.vue'
import StepNav from './StepNav.vue'

const route = useRoute()
/** The script library has its own layout. */
const showSteps = computed(() => route.name !== 'scripts')
</script>

<template>
  <div class="layout">
    <TopBar />
    <div class="main">
      <StepNav v-if="showSteps" />
      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}
.main {
  display: flex;
  flex: 1;
  min-height: 0;
}
.content {
  flex: 1;
  overflow-y: auto;
  position: relative;
}
</style>
