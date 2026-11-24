<script setup lang="ts">
/**
 * 노드 패널과 목록의 비율, 이미지 모델, 영상 모델 선택에 같은 스타일을 사용한다.
 * 모서리, 화살표, 글자 크기를 일관되게 유지한다.
 */
withDefaults(
  defineProps<{
    label?: string
    modelValue?: string
    /** 비율처럼 좁은 목록은 고정 너비를 지정하고 콘텐츠에 맞추려면 'auto'를 쓴다. */
    width?: string
    maxWidth?: string
    title?: string
  }>(),
  { label: '', modelValue: '', width: 'auto', maxWidth: '', title: '' }
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

function onPick(event: Event) {
  emit('update:modelValue', (event.target as HTMLSelectElement).value)
}
</script>

<template>
  <label
    class="psel"
    :style="{
      ...(width === 'auto' ? {} : { flex: `0 0 ${width}` }),
      ...(maxWidth ? { maxWidth } : {})
    }"
  >
    <span v-if="label" class="psel-k">{{ label }}</span>
    <select :value="modelValue" :title="title || label" @change="onPick">
      <slot />
    </select>
  </label>
</template>

<style scoped>
.psel {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
}
.psel-k {
  flex: 0 0 auto;
  font-size: 10px;
  line-height: 1;
  color: var(--color-text-4);
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.psel select {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  height: 28px;
  padding: 0 24px 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background-color: var(--color-bg-2);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1.4 2.2L6 6.2l4.6-4' fill='none' stroke='%2394a3b8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 10px;
  color: var(--color-text-1);
  font-size: 12px;
  line-height: 1;
  font-family: inherit;
  appearance: none;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s, background-color 0.15s, box-shadow 0.15s;
}
.psel select:hover {
  border-color: var(--color-text-4, #64748b);
  background-color: var(--color-bg-3);
}
.psel select:focus-visible {
  border-color: #60a5fa;
  box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.24);
}
.psel select:disabled {
  opacity: 0.55;
  cursor: default;
}
/* Windows의 option에 화면 테마를 적용한다. 기본 시스템 스타일은 어두운 UI에서도 밝게 표시될 수 있다. */
.psel select option,
.psel select optgroup {
  background: var(--color-bg-2);
  color: var(--color-text-1);
}
.psel select optgroup {
  font-style: normal;
  color: var(--color-text-4);
}
</style>
