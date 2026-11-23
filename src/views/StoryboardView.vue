<script setup lang="ts">
import { t as translate } from '@/i18n'
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useToastStore, useAssetsStore } from '@/stores'
import { generateStoryboard, storyboardToShots } from '@/services/ai'
import { blobToChatImageUrl } from '@/services/ai/client'
import { lookFromScript } from '@/utils/visualStyle'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingDots from '@/components/common/LoadingDots.vue'
import Tag from '@/components/common/Tag.vue'
import type { Shot } from '@/types'

const router = useRouter()
const project = useProjectStore()
const toast = useToastStore()
const assets = useAssetsStore()

const generating = ref(false)
const editing = ref<string | null>(null)

onMounted(() => {
  if (!project.current?.script) {
    toast.warn(translate('storyboard.enterScriptFirst'))
    router.push('/script')
  }
})

const shots = computed(() => project.current?.shots ?? [])
const totalDuration = computed(() =>
  shots.value.reduce((sum, s) => sum + s.duration, 0).toFixed(1)
)
const subjects = computed(() => project.current?.subjects ?? [])
const scenes = computed(() => project.current?.scenes ?? [])

function kindLabel(k: string) {
  return k === 'animal' ? translate('storyboard.animal') : k === 'other' ? translate('storyboard.object') : translate('storyboard.person')
}

function shotCastLabel(s: Shot) {
  const names = (s.subjectIds ?? [])
    .map((id) => subjects.value.find((x) => x.id === id)?.name)
    .filter(Boolean)
  const scene = scenes.value.find((x) => x.id === s.sceneId)?.name
  return [names.join('、') || null, scene].filter(Boolean).join(' · ')
}

const editingAesthetic = ref(false)
const aestheticDraft = ref('')
const styleBriefDraft = ref('')
const colorPaletteDraft = ref('')
const lightingNoteDraft = ref('')
/** 展开导演备注的分镜 id 集合 */
const directingOpen = ref<Record<string, boolean>>({})

function startEditAesthetic() {
  const script = project.current?.script
  aestheticDraft.value = script?.aesthetic ?? ''
  styleBriefDraft.value = script?.styleBrief ?? ''
  colorPaletteDraft.value = script?.colorPalette ?? ''
  lightingNoteDraft.value = script?.lightingNote ?? ''
  editingAesthetic.value = true
}
function saveAesthetic() {
  if (!project.current?.script) return
  project.setScript({
    ...project.current.script,
    aesthetic: aestheticDraft.value,
    styleBrief: styleBriefDraft.value || undefined,
    colorPalette: colorPaletteDraft.value || undefined,
    lightingNote: lightingNoteDraft.value || undefined
  })
  editingAesthetic.value = false
}

function toggleDirecting(id: string) {
  directingOpen.value = {
    ...directingOpen.value,
    [id]: !directingOpen.value[id]
  }
}

function hasDirectingNotes(s: Shot) {
  return Boolean(
    s.blocking || s.eyeline || s.continuity || s.propFocus || s.purpose || s.shotSize
  )
}

async function generate() {
  if (!project.current?.script) return
  if (shots.value.some((s) => s.imageAssetId || s.videoAssetId)) {
    const ok = confirm(
      translate('storyboard.regenerateConfirm')
    )
    if (!ok) return
  }
  generating.value = true
  try {
    const productImages: string[] = []
    for (const id of (project.current.script.referenceAssetIds ?? []).slice(0, 5)) {
      const blob = await assets.getBlob(id)
      if (!blob) continue
      try {
        productImages.push(await blobToChatImageUrl(blob))
      } catch (e) {
        console.warn('产品图转码失败', id, e)
      }
    }
    if (productImages.length) {
      toast.info(translate('storyboard.referenceSent', { p0: productImages.length }), 2000)
    }
    const look = lookFromScript(project.current.script)
    const runResult = await generateStoryboard(
      {
        topic: project.current.script.topic,
        content: project.current.script.content,
        style: look.style,
        shotDuration: project.current.script.shotDuration,
        aspectRatio: project.current.settings.aspectRatio,
        keywords: project.current.script.keywords,
        targetDurationSec: project.current.script.targetDurationSec || undefined,
        productImages
      },
      (msg) => toast.info(msg, 2000)
    )
    const newShots = storyboardToShots(runResult.result)
    project.setShots(newShots)
    project.setSubjects(runResult.result.subjects ?? [])
    project.setScenes(runResult.result.scenes ?? [])
    await project.save()
    // 把项目级导演字段存到 Script
    if (project.current?.script) {
      const r = runResult.result
      project.setScript({
        ...project.current.script,
        ...(look.matched ? { style: look.matched } : {}),
        ...(r.aesthetic ? { aesthetic: r.aesthetic } : {}),
        ...(r.styleBrief ? { styleBrief: r.styleBrief } : {}),
        ...(r.colorPalette ? { colorPalette: r.colorPalette } : {}),
        ...(r.lightingNote ? { lightingNote: r.lightingNote } : {})
      })
    }
    toast.success(
      translate('storyboard.generationSummary', { p0: newShots.length, p1: runResult.result.subjects?.length ?? 0, p2: runResult.result.scenes?.length ?? 0 })
    )
  } catch (e: any) {
    toast.error(translate('storyboard.failed', { error: e.message }), 8000)
  } finally {
    generating.value = false
  }
}

function updateField(id: string, field: keyof Shot, value: any) {
  project.updateShot(id, { [field]: value })
}

function addShot() {
  if (!project.current) return
  const newShot: Shot = {
    id: 'shot_' + Date.now().toString(36),
    index: shots.value.length,
    title: translate('common.shotNumber', { p0: shots.value.length + 1 }),
    visualPrompt: '',
    audioDescription: '',
    voiceover: '',
    audioMode: 'h3-dialogue',
    duration: project.current.script?.shotDuration ?? 5,
    cameraMovement: 'static',
    status: 'draft'
  }
  project.setShots([...shots.value, newShot])
  editing.value = newShot.id
}

function removeShot(id: string) {
  if (!project.current) return
  if (!confirm(translate('storyboard.deleteConfirm'))) return
  const list = shots.value
    .filter((s) => s.id !== id)
    .map((s, i) => ({ ...s, index: i }))
  project.setShots(list)
  toast.success(translate('storyboard.deleted'))
}

function moveShot(id: string, dir: -1 | 1) {
  if (!project.current) return
  const list = [...shots.value]
  const idx = list.findIndex((s) => s.id === id)
  const target = idx + dir
  if (target < 0 || target >= list.length) return
  ;[list[idx], list[target]] = [list[target], list[idx]]
  list.forEach((s, i) => (s.index = i))
  project.setShots(list)
}

function next() {
  if (shots.value.length === 0) {
    toast.warn(translate('storyboard.needOne'))
    return
  }
  router.push('/images')
}

function movementLabel(m: Shot['cameraMovement']): string {
  return {
    push: translate('storyboard.push'),
    pull: translate('storyboard.pull'),
    pan: translate('storyboard.pan'),
    tilt: translate('storyboard.tilt'),
    static: translate('storyboard.static'),
    orbit: translate('storyboard.orbit')
  }[m]
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>{{ $t('storyboard.breakdown') }}</h1>
        <p>{{ $t('storyboard.lockSubjects') }}</p>
      </div>
      <div class="head-actions">
        <GradientButton type="ghost" @click="router.push('/script')">{{ $t('common.previousStep') }}</GradientButton>
        <GradientButton
          icon="✨"
          :loading="generating"
          @click="generate"
        >
          {{ shots.length > 0 ? $t('common.regenerateStoryboard') : $t('common.generateStoryboard') }}
        </GradientButton>
        <GradientButton icon="+" type="secondary" @click="addShot">{{ $t('common.manualAdd') }}</GradientButton>
        <GradientButton icon="→" @click="next">{{ $t('storyboard.next') }}</GradientButton>
      </div>
    </header>

    <!-- 项目级制作计划（风格锚点） -->
    <GlassCard
      v-if="project.current?.script && (project.current.script.aesthetic || project.current.script.styleBrief || shots.length)"
      padding="md"
      class="aesthetic-card"
    >
      <div class="aes-head">
        <h3>{{ $t('storyboard.plan') }}</h3>
        <span class="aes-hint">{{ $t('storyboard.moodHint') }}</span>
        <button class="aes-toggle" @click="editingAesthetic ? saveAesthetic() : startEditAesthetic()">
          {{ editingAesthetic ? $t('common.doneWithCheck') : $t('common.editWithIcon') }}
        </button>
      </div>
      <template v-if="!editingAesthetic">
        <pre v-if="project.current.script.aesthetic" class="aes-readonly">{{ project.current.script.aesthetic }}</pre>
        <div class="plan-grid">
          <div v-if="project.current.script.styleBrief" class="plan-item">
            <span class="plan-label">{{ $t('storyboard.styleBrief') }}</span>
            <p>{{ project.current.script.styleBrief }}</p>
          </div>
          <div v-if="project.current.script.colorPalette" class="plan-item">
            <span class="plan-label">{{ $t('storyboard.palette') }}</span>
            <p>{{ project.current.script.colorPalette }}</p>
          </div>
          <div v-if="project.current.script.lightingNote" class="plan-item">
            <span class="plan-label">{{ $t('storyboard.lightingNotes') }}</span>
            <p>{{ project.current.script.lightingNote }}</p>
          </div>
        </div>
      </template>
      <template v-else>
        <label class="shot-field">
          <span>{{ $t('storyboard.mood') }}</span>
          <textarea v-model="aestheticDraft" class="aes-edit" rows="4" />
        </label>
        <div class="plan-grid edit">
          <label class="shot-field">
            <span>{{ $t('storyboard.styleBrief') }}</span>
            <textarea v-model="styleBriefDraft" class="aes-edit" rows="2" />
          </label>
          <label class="shot-field">
            <span>{{ $t('storyboard.palette') }}</span>
            <textarea v-model="colorPaletteDraft" class="aes-edit" rows="2" />
          </label>
          <label class="shot-field">
            <span>{{ $t('storyboard.lightingNotes') }}</span>
            <textarea v-model="lightingNoteDraft" class="aes-edit" rows="2" />
          </label>
        </div>
        <button class="aes-toggle" style="margin-top: 8px" @click="saveAesthetic">{{ $t('common.savedWithCheck') }}</button>
      </template>
    </GlassCard>

    <GlassCard v-if="subjects.length || scenes.length" padding="md" class="cast-card">
      <div class="cast-col">
        <h3>{{ $t('storyboard.subject') }}{{ subjects.length }}）</h3>
        <p class="cast-hint">{{ $t('storyboard.subjectConsistency') }}</p>
        <div v-for="sub in subjects" :key="sub.id" class="cast-item">
          <div class="cast-name">
            {{ sub.name }}
            <Tag size="sm">{{ kindLabel(sub.kind) }}</Tag>
            <Tag v-if="sub.role" type="info" size="sm">{{ sub.role }}</Tag>
            <Tag v-if="sub.fromReference" type="accent" size="sm">{{ $t('storyboard.derivedFromReference') }}</Tag>
          </div>
          <textarea
            class="cast-desc"
            rows="3"
            :value="sub.description"
            @blur="project.updateSubject(sub.id, { description: ($event.target as HTMLTextAreaElement).value })"
          />
          <div class="cast-meta">
            <label class="shot-field">
              <span>{{ $t('storyboard.role') }}</span>
              <input
                class="shot-input"
                :value="sub.role ?? ''"
                :placeholder="$t('storyboard.subjectRoleExample')"
                @blur="project.updateSubject(sub.id, { role: ($event.target as HTMLInputElement).value || undefined })"
              />
            </label>
            <label class="shot-field">
              <span>{{ $t('storyboard.variants') }}</span>
              <input
                class="shot-input"
                :value="sub.stateVariants ?? ''"
                :placeholder="$t('storyboard.costumeExample')"
                @blur="project.updateSubject(sub.id, { stateVariants: ($event.target as HTMLInputElement).value || undefined })"
              />
            </label>
          </div>
        </div>
      </div>
      <div class="cast-col">
        <h3>{{ $t('storyboard.scene') }}{{ scenes.length }}）</h3>
        <p class="cast-hint">{{ $t('storyboard.sceneAnchorHint') }}</p>
        <div v-for="scn in scenes" :key="scn.id" class="cast-item">
          <div class="cast-name">{{ scn.name }}</div>
          <textarea
            class="cast-desc"
            rows="3"
            :value="scn.description"
            @blur="project.updateScene(scn.id, { description: ($event.target as HTMLTextAreaElement).value })"
          />
          <div class="cast-meta">
            <label class="shot-field">
              <span>{{ $t('storyboard.anchor') }}</span>
              <input
                class="shot-input"
                :value="scn.mainAnchor ?? ''"
                :placeholder="$t('storyboard.anchorExample')"
                @blur="project.updateScene(scn.id, { mainAnchor: ($event.target as HTMLInputElement).value || undefined })"
              />
            </label>
            <label class="shot-field">
              <span>{{ $t('common.sceneLight') }}</span>
              <input
                class="shot-input"
                :value="scn.lighting ?? ''"
                :placeholder="$t('storyboard.lightingExample')"
                @blur="project.updateScene(scn.id, { lighting: ($event.target as HTMLInputElement).value || undefined })"
              />
            </label>
          </div>
        </div>
      </div>
    </GlassCard>

    <GlassCard v-if="!generating && shots.length > 0" padding="md" class="stats">
      <div class="stat-item">
        <div class="stat-num gradient-text">{{ shots.length }}</div>
        <div class="stat-label">{{ $t('storyboard.count') }}</div>
      </div>
      <div class="stat-item">
        <div class="stat-num gradient-text">{{ totalDuration }}s</div>
        <div class="stat-label">{{ $t('common.totalLength') }}</div>
      </div>
      <div class="stat-item">
        <div class="stat-num">
          <Tag type="success" size="sm">{{ shots.filter(s => s.imageAssetId).length }} {{ $t('common.imageReady') }}</Tag>
        </div>
        <div class="stat-label">{{ $t('common.imageReady') }}</div>
      </div>
      <div class="stat-item">
        <div class="stat-num">
          <Tag type="success" size="sm">{{ shots.filter(s => s.videoAssetId).length }} {{ $t('common.videoReady') }}</Tag>
        </div>
        <div class="stat-label">{{ $t('common.generated') }}</div>
      </div>
    </GlassCard>

    <div v-if="generating" class="generating">
      <LoadingDots :text="$t('storyboard.writing')" />
    </div>

    <EmptyState
      v-if="shots.length === 0"
      icon="🎬"
      :title="$t('common.noStoryboard')"
      :description="$t('storyboard.emptyHint')"
    >
      <template #action>
        <GradientButton icon="✨" @click="generate">{{ $t('common.generateStoryboard') }}</GradientButton>
      </template>
    </EmptyState>

    <div v-else class="shots">
      <GlassCard
        v-for="(s, i) in shots"
        :key="s.id"
        padding="md"
        :class="['shot', { editing: editing === s.id }]"
        hoverable
      >
        <div class="shot-head">
          <div class="shot-num">{{ i + 1 }}</div>
          <div class="shot-meta">
            <input
              v-model="s.title"
              class="shot-title"
              @blur="updateField(s.id, 'title', s.title)"
            />
            <div class="shot-tags">
              <Tag v-if="shotCastLabel(s)" size="sm" type="accent">{{ shotCastLabel(s) }}</Tag>
              <Tag v-if="s.shotSize" size="sm">{{ s.shotSize }}</Tag>
              <Tag v-if="s.purpose" size="sm" type="info">{{ s.purpose }}</Tag>
              <Tag size="sm" type="info">{{ movementLabel(s.cameraMovement) }}</Tag>
              <input
                v-model.number="s.duration"
                type="number"
                min="0.5"
                max="30"
                step="0.5"
                class="shot-dur"
                @blur="updateField(s.id, 'duration', s.duration)"
              />
              <span class="dur-unit">s</span>
            </div>
          </div>
          <div class="shot-actions">
            <button :disabled="i === 0" @click="moveShot(s.id, -1)" :title="$t('common.moveUp')">↑</button>
            <button :disabled="i === shots.length - 1" @click="moveShot(s.id, 1)" :title="$t('common.moveDown')">↓</button>
            <button @click="editing = editing === s.id ? null : s.id" :title="$t('common.edit')">
              {{ editing === s.id ? $t('common.done') : '✎' }}
            </button>
            <button class="del" @click="removeShot(s.id)" :title="$t('common.delete')">🗑</button>
          </div>
        </div>

        <div class="shot-body">
          <label class="shot-field">
            <span>{{ $t('storyboard.visualDescription') }}</span>
            <textarea
              v-model="s.visualPrompt"
              rows="3"
              class="shot-input"
              :readonly="editing !== s.id"
              @blur="updateField(s.id, 'visualPrompt', s.visualPrompt)"
              :placeholder="$t('storyboard.visualExample')"
            />
          </label>

          <div v-if="hasDirectingNotes(s) || editing === s.id" class="directing">
            <button type="button" class="directing-toggle" @click="toggleDirecting(s.id)">
              {{ directingOpen[s.id] || editing === s.id ? '▾' : '▸' }} {{ $t('storyboard.directorNotes') }}
              <span class="directing-hint">{{ $t('storyboard.continuitySummary') }}</span>
            </button>
            <div v-if="directingOpen[s.id] || editing === s.id" class="directing-body">
              <div class="directing-row">
                <label class="shot-field">
                  <span>{{ $t('storyboard.beat') }}</span>
                  <input
                    class="shot-input"
                    :value="s.purpose ?? ''"
                    :readonly="editing !== s.id"
                    :placeholder="$t('storyboard.beatExample')"
                    @blur="updateField(s.id, 'purpose', ($event.target as HTMLInputElement).value || undefined)"
                  />
                </label>
                <label class="shot-field">
                  <span>{{ $t('storyboard.shotSize') }}</span>
                  <input
                    class="shot-input"
                    :value="s.shotSize ?? ''"
                    :readonly="editing !== s.id"
                    :placeholder="$t('storyboard.shotSizeExample')"
                    @blur="updateField(s.id, 'shotSize', ($event.target as HTMLInputElement).value || undefined)"
                  />
                </label>
              </div>
              <label class="shot-field">
                <span>{{ $t('storyboard.position') }}</span>
                <textarea
                  class="shot-input"
                  rows="2"
                  :value="s.blocking ?? ''"
                  :readonly="editing !== s.id"
                  :placeholder="$t('storyboard.positionHint')"
                  @blur="updateField(s.id, 'blocking', ($event.target as HTMLTextAreaElement).value || undefined)"
                />
              </label>
              <label class="shot-field">
                <span>{{ $t('storyboard.gaze') }}</span>
                <input
                  class="shot-input"
                  :value="s.eyeline ?? ''"
                  :readonly="editing !== s.id"
                  :placeholder="$t('storyboard.gazeExample')"
                  @blur="updateField(s.id, 'eyeline', ($event.target as HTMLInputElement).value || undefined)"
                />
              </label>
              <label class="shot-field">
                <span>{{ $t('storyboard.continuity') }}</span>
                <textarea
                  class="shot-input"
                  rows="2"
                  :value="s.continuity ?? ''"
                  :readonly="editing !== s.id"
                  :placeholder="$t('storyboard.continuityExample')"
                  @blur="updateField(s.id, 'continuity', ($event.target as HTMLTextAreaElement).value || undefined)"
                />
              </label>
              <label class="shot-field">
                <span>{{ $t('storyboard.propFocus') }}</span>
                <input
                  class="shot-input"
                  :value="s.propFocus ?? ''"
                  :readonly="editing !== s.id"
                  :placeholder="$t('storyboard.propExample')"
                  @blur="updateField(s.id, 'propFocus', ($event.target as HTMLInputElement).value || undefined)"
                />
              </label>
            </div>
          </div>

          <label class="shot-field">
            <span>{{ $t('storyboard.soundEffects') }}</span>
            <input
              :value="s.audioDescription"
              @input="updateField(s.id, 'audioDescription', ($event.target as HTMLInputElement).value)"
              @blur="updateField(s.id, 'audioDescription', s.audioDescription)"
              class="shot-input"
              :readonly="editing !== s.id"
              :placeholder="$t('storyboard.soundExample')"
            />
          </label>
          <label class="shot-field">
            <span>{{ $t('storyboard.narrationCaption') }}</span>
            <textarea
              v-model="s.voiceover"
              rows="2"
              class="shot-input"
              :readonly="editing !== s.id"
              @blur="updateField(s.id, 'voiceover', s.voiceover)"
            />
          </label>
          <div v-if="editing === s.id" class="shot-extra">
            <label class="shot-field">
              <span>{{ $t('common.cameraMovement') }}</span>
              <select
                v-model="s.cameraMovement"
                class="shot-input"
                @change="updateField(s.id, 'cameraMovement', s.cameraMovement)"
              >
                <option value="push">{{ $t('common.cameraPush') }}</option>
                <option value="pull">{{ $t('common.cameraPull') }}</option>
                <option value="pan">{{ $t('common.cameraPan') }}</option>
                <option value="tilt">{{ $t('common.cameraTrack') }}</option>
                <option value="orbit">{{ $t('common.cameraOrbit') }}</option>
                <option value="static">{{ $t('common.cameraFixed') }}</option>
              </select>
            </label>
          </div>
        </div>
      </GlassCard>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--space-6);
  max-width: 1100px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--space-5);
  gap: var(--space-4);
  flex-wrap: wrap;
}
.page-head h1 {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 var(--space-1);
}
.page-head p {
  font-size: 13px;
  color: var(--color-text-3);
  margin: 0;
}
.head-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.stats {
  display: flex;
  gap: var(--space-6);
  margin-bottom: var(--space-4);
}
.cast-card {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}
.cast-col h3 {
  font-size: 13px;
  margin: 0 0 4px;
}
.cast-hint {
  font-size: 11px;
  color: var(--color-text-3);
  margin: 0 0 10px;
  line-height: 1.5;
}
.cast-item {
  margin-bottom: 10px;
}
.cast-name {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.cast-desc {
  width: 100%;
  resize: vertical;
  min-height: 64px;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-2);
  font-size: 12px;
  line-height: 1.5;
  padding: 8px;
  font-family: inherit;
}
@media (max-width: 800px) {
  .cast-card {
    grid-template-columns: 1fr;
  }
}
.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
}
.stat-num {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 2px;
}
.stat-label {
  font-size: 11px;
  color: var(--color-text-3);
}

.generating {
  text-align: center;
  padding: var(--space-12);
}

.aesthetic-card {
  margin-bottom: var(--space-4);
  border-color: var(--color-accent-2);
  background: var(--grad-primary-soft);
}
.aes-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-2);
  flex-wrap: wrap;
}
.aes-head h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
}
.aes-hint {
  font-size: 11px;
  color: var(--color-text-3);
  flex: 1;
}
.aes-toggle {
  font-size: 11px;
  color: var(--color-accent-2);
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-accent-2);
  background: transparent;
}
.aes-toggle:hover {
  background: var(--grad-primary-soft);
}
.aes-readonly {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-2);
  white-space: pre-wrap;
  margin: 0;
  padding: var(--space-2);
  background: var(--color-bg-1);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
}
.aes-edit {
  width: 100%;
  background: var(--color-bg-1);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-1);
  outline: none;
  resize: vertical;
}
.plan-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
  margin-top: var(--space-3);
}
.plan-grid.edit {
  margin-top: var(--space-2);
}
.plan-item p {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-2);
}
.plan-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-3);
}
.cast-meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 6px;
}
.directing {
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
}
.directing-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--color-text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  padding: 2px 0;
  text-align: left;
}
.directing-hint {
  font-weight: 400;
  font-size: 11px;
  color: var(--color-text-4);
}
.directing-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: 8px;
}
.directing-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
@media (max-width: 800px) {
  .plan-grid,
  .cast-meta,
  .directing-row {
    grid-template-columns: 1fr;
  }
}

.shots {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.shot {
  transition: all var(--duration-fast);
}
.shot.editing {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px var(--color-accent), var(--shadow-md);
}
.shot-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.shot-num {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: var(--grad-primary);
  color: white;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.shot-meta {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.shot-title {
  background: transparent;
  border: 1px solid transparent;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-1);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  flex: 1;
  min-width: 0;
}
.shot-title:hover,
.shot-title:focus {
  background: var(--color-bg-2);
  border-color: var(--color-border);
  outline: none;
}
.shot-tags {
  display: flex;
  align-items: center;
  gap: 6px;
}
.shot-dur {
  width: 50px;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  font-size: 12px;
  color: var(--color-text-1);
  text-align: right;
  outline: none;
}
.dur-unit {
  font-size: 11px;
  color: var(--color-text-4);
}
.shot-actions {
  display: flex;
  gap: 2px;
}
.shot-actions button {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  color: var(--color-text-3);
  font-size: 12px;
  transition: all var(--duration-fast);
}
.shot-actions button:hover:not(:disabled) {
  background: var(--color-fill-hover);
  color: var(--color-text-1);
}
.shot-actions button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.shot-actions .del:hover {
  background: rgba(239, 68, 68, 0.15) !important;
  color: var(--color-error) !important;
}

.shot-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.shot-field {
  display: block;
}
.shot-field > span {
  display: block;
  font-size: 11px;
  color: var(--color-text-3);
  margin-bottom: 4px;
  font-weight: 500;
}
.shot-input {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  font-size: 12px;
  color: var(--color-text-1);
  outline: none;
  font-family: inherit;
  resize: vertical;
  line-height: 1.5;
}
.shot-input:focus {
  border-color: var(--color-accent);
}
.shot-input[readonly] {
  background: transparent;
  border-color: transparent;
  color: var(--color-text-2);
}
.shot-extra {
  display: flex;
  gap: var(--space-3);
  padding-top: var(--space-2);
  border-top: 1px dashed var(--color-border);
}
.shot-extra .shot-field {
  flex: 1;
}
</style>
