import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { useProjectStore, useAssetsStore, useSettingsStore, endpointReady } from '@/stores'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { step: null, label: 'router.home' }
  },
  {
    path: '/studio',
    name: 'studio',
    component: () => import('@/views/StudioView.vue'),
    meta: { step: null, label: 'router.studio' }
  },
  {
    path: '/smart-speech',
    name: 'smart-speech',
    component: () => import('@/views/SmartSpeechView.vue'),
    meta: { step: null, label: 'router.smartSpeech' }
  },
  {
    path: '/script',
    name: 'script',
    component: () => import('@/views/ScriptView.vue'),
    meta: { step: 'script', label: 'router.script' }
  },
  {
    path: '/storyboard',
    name: 'storyboard',
    component: () => import('@/views/StoryboardView.vue'),
    meta: { step: 'storyboard', label: 'router.storyboard' }
  },
  {
    path: '/images',
    name: 'images',
    component: () => import('@/views/ImagesView.vue'),
    meta: { step: 'image', label: 'router.images' }
  },
  {
    path: '/videos',
    name: 'videos',
    component: () => import('@/views/VideosView.vue'),
    meta: { step: 'video', label: 'router.videos' }
  },
  {
    path: '/edit',
    name: 'edit',
    component: () => import('@/views/EditView.vue'),
    meta: { step: 'edit', label: 'router.edit' }
  },
  {
    path: '/caption',
    name: 'caption',
    component: () => import('@/views/CaptionView.vue'),
    meta: { step: 'caption', label: 'router.caption' }
  },
  {
    path: '/export',
    name: 'export',
    component: () => import('@/views/ExportView.vue'),
    meta: { step: 'export', label: 'router.export' }
  },
  {
    path: '/scripts',
    name: 'scripts',
    component: () => import('@/views/ScriptsView.vue'),
    meta: { step: null, label: 'router.scripts' }
  },
  {
    path: '/drafts',
    name: 'drafts',
    component: () => import('@/views/DraftsView.vue'),
    meta: { step: null, label: 'router.drafts' }
  },
  {
    path: '/settings/:section?',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { step: null, label: 'router.settings' }
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/'
  }
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 }
  }
})

/** 워크플로 페이지에 들어가기 전에 IndexedDB에서 프로젝트를 복원한다. 로딩 중에는 결과가 없다고 판단하지 않는다. */
router.beforeEach(async (to) => {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const settings = useSettingsStore()
  await settings.ensureHydrated()

  const llmReady = endpointReady(settings.config.llm)
  const section = String(to.params.section || '')
  if (!llmReady && to.name !== 'settings') {
    return '/settings/llm'
  }
  if (to.name === 'settings' && !section) {
    return llmReady ? '/settings/agent' : '/settings/llm'
  }

  await project.ensureLoaded()
  await assets.refresh()
  project.startAutoSave()
  if (to.name !== 'home' && to.name !== 'settings') {
    if (!project.current && project.allProjects.length > 0) {
      await project.load(project.allProjects[0].id)
    }
    project.rememberCurrent()
  }
})

/** 사이드바에 표시할 워크플로 단계 순서. */
export const workflowSteps = [
  { id: 'script', label: 'workflow.script.label', icon: '📝', route: '/script', desc: 'workflow.script.description' },
  { id: 'storyboard', label: 'workflow.storyboard.label', icon: '🎬', route: '/storyboard', desc: 'workflow.storyboard.description' },
  { id: 'image', label: 'workflow.image.label', icon: '🎨', route: '/images', desc: 'workflow.image.description' },
  { id: 'video', label: 'workflow.video.label', icon: '🎥', route: '/videos', desc: 'workflow.video.description' },
  { id: 'edit', label: 'workflow.edit.label', icon: '✂️', route: '/edit', desc: 'workflow.edit.description' },
  { id: 'caption', label: 'workflow.caption.label', icon: '💬', route: '/caption', desc: 'workflow.caption.description' },
  { id: 'export', label: 'workflow.export.label', icon: '🚀', route: '/export', desc: 'workflow.export.description' },
  { id: 'drafts', label: 'workflow.drafts.label', icon: '📦', route: '/drafts', desc: 'workflow.drafts.description' }
] as const
