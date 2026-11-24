<script setup lang="ts">
import { t as translate } from '@/i18n'
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    agentOpen?: boolean
    agentWidth?: number
    rightWidth?: number
  }>(),
  { agentOpen: true, agentWidth: 440, rightWidth: 0 }
)

const emit = defineEmits<{ (e: 'done'): void }>()

type GuideArea = 'agent' | 'canvas' | null

const steps = [
  {
    area: 'agent' as GuideArea,
    get title() { return translate('canvasGuide.agentSide') },
    get sub() { return translate('canvasGuide.agentIntro') },
    items: [
      'canvasGuide.agentExample',
      'canvasGuide.agentTasks',
      'canvasGuide.memoryTip',
      'canvasGuide.shotTip'
    ]
  },
  {
    area: 'canvas' as GuideArea,
    get title() { return translate('canvasGuide.canvasSide') },
    get sub() { return translate('canvasGuide.manualIntro') },
    items: [
      'canvasGuide.contextMenu',
      'canvasGuide.independentNodes',
      'canvasGuide.inspector',
      'canvasGuide.edges'
    ]
  },
  {
    area: null as GuideArea,
    get title() { return translate('canvasGuide.tips') },
    get sub() { return translate('canvasGuide.combineIntro') },
    items: [
      '左右两边可以随时混用：先让 AI 打底，再手动改细节，反过来也成立。',
      '左侧最上面可以新建画布，接着是剧本和经典步骤，文件夹和设置在最下方。'
    ]
  }
]

const index = ref(0)
const step = computed(() => steps[index.value])

const highlight = computed(() => {
  const area = step.value.area
  if (!area) return null
  const rail = 46
  const agentWidth = props.agentOpen ? props.agentWidth : 0
  if (area === 'agent') {
    if (!props.agentOpen) return null
    return { left: `${rail}px`, right: 'auto', width: `${props.agentWidth}px` }
  }
  return { left: `${rail + agentWidth}px`, right: `${props.rightWidth}px`, width: 'auto' }
})

function next() {
  if (index.value < steps.length - 1) index.value++
  else finish()
}
function prev() {
  if (index.value > 0) index.value--
}
function finish() {
  emit('done')
}
</script>

<template>
  <div class="guide">
    <template v-if="highlight">
      <div class="hl" :style="highlight">
        <div class="card">
          <div class="step-dot">
            <i v-for="(s, i) in steps" :key="s.title" :class="{ on: i === index, past: i < index }" />
          </div>
          <h3>{{ step.title }}</h3>
          <p class="sub">{{ step.sub }}</p>
          <ul>
            <li v-for="item in step.items" :key="item">{{ $t(item) }}</li>
          </ul>
          <div class="foot">
            <span class="count">{{ index + 1 }} / {{ steps.length }}</span>
            <div class="btns">
              <button v-if="index > 0" type="button" class="ghost" @click="prev">{{ $t('canvasGuide.previous') }}</button>
              <button type="button" class="ghost" @click="finish">{{ $t('canvasGuide.skip') }}</button>
              <button type="button" class="primary" @click="next">
                {{ index === steps.length - 1 ? $t('canvasGuide.start') : $t('canvasGuide.next') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
    <div v-else class="card float">
      <div class="step-dot">
        <i v-for="(s, i) in steps" :key="s.title" :class="{ on: i === index, past: i < index }" />
      </div>
      <h3>{{ step.title }}</h3>
      <p class="sub">{{ step.sub }}</p>
      <ul>
        <li v-for="item in step.items" :key="item">{{ $t(item) }}</li>
      </ul>
      <div class="foot">
        <span class="count">{{ index + 1 }} / {{ steps.length }}</span>
        <div class="btns">
          <button type="button" class="ghost" @click="prev">{{ $t('canvasGuide.previous') }}</button>
          <button type="button" class="primary" @click="next">{{ $t('canvasGuide.start') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.guide {
  position: absolute;
  inset: 0;
  z-index: 60;
  pointer-events: none;
}
.hl {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 16px;
  border: 1px solid rgba(126, 180, 255, 0.55);
  box-shadow: 0 0 0 9999px rgba(6, 7, 10, 0.66);
  pointer-events: auto;
  animation: hl-in 0.28s ease;
}
@keyframes hl-in {
  from {
    opacity: 0.4;
  }
  to {
    opacity: 1;
  }
}
.card {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(440px, calc(100% - 40px));
  max-height: calc(100% - 40px);
  overflow: auto;
  padding: 18px 20px 16px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-bg-1);
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.45);
  pointer-events: auto;
  animation: card-in 0.24s ease;
}
.card.float {
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.55);
}
@keyframes card-in {
  from {
    opacity: 0;
    transform: translate(-50%, calc(-50% + 10px));
  }
  to {
    opacity: 1;
    transform: translate(-50%, -50%);
  }
}
.step-dot {
  display: flex;
  gap: 5px;
  margin-bottom: 11px;
}
.step-dot i {
  width: 18px;
  height: 3px;
  border-radius: 99px;
  background: var(--color-fill-strong);
}
.step-dot i.past {
  background: rgba(126, 180, 255, 0.45);
}
.step-dot i.on {
  background: #8fb0ff;
}
h3 {
  margin: 0 0 3px;
  font-size: 16px;
  font-weight: 680;
  letter-spacing: -0.01em;
  color: var(--color-text-1);
}
.sub {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--color-text-4);
}
ul {
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
li {
  position: relative;
  padding-left: 16px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--color-text-2);
}
li::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 8px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #7eb4ff;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}
.count {
  font-size: 11px;
  color: var(--color-text-4);
  font-variant-numeric: tabular-nums;
}
.btns {
  display: flex;
  gap: 8px;
}
.btns button {
  margin: 0;
  padding: 7px 14px;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.ghost {
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-3);
}
.ghost:hover {
  color: var(--color-text-1);
  border-color: var(--color-border-strong);
}
.primary {
  border: 1px solid rgba(126, 180, 255, 0.5);
  background: rgba(126, 180, 255, 0.16);
  color: #cfe0ff;
}
.primary:hover {
  background: rgba(126, 180, 255, 0.26);
}
</style>
