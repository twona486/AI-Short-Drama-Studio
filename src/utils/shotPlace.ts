/**
 * 샷의 실제 장소는 화면 묘사를 기준으로 결정한다.
 * 장소나 시대가 바뀌면 이전 배경 카드의 설명을 영상 프롬프트에 넣지 않는다.
 */
import type { Project, Scene, Shot } from '@/types'

const ERA_MODERN =
  /现代城市|老小区|出租屋|电梯|高架|电脑|显示器|快递箱|游戏外设|机械键盘|转椅|冲水声|空调|车灯闪过|현대 도시|아파트|임대주택|엘리베이터|컴퓨터|모니터|택배 상자|기계식 키보드|에어컨|modern city|apartment|elevator|computer|monitor|delivery box|keyboard|air conditioner/i
const ERA_PREMODERN =
  /田埂|田垄|稻田|麦田|皂衣|亭卒|差役|衙役|草鞋|竹简|木牍|斗笠|蓑衣|城头|衙门|祠堂|客栈|牛皮带|木棍|논둑|밀밭|포졸|짚신|죽간|삿갓|관아|사당|객잔|rice paddy|straw sandals|bamboo scroll|city battlements/i

const LANDMARK =
  /(?:[东西南北]边)?(?:田埂|田垄|稻田|麦田|农田|石板路|村口|村道|城门|客栈|祠堂|出租屋|客厅|厨房|巷口|街道|院子)|논둑|논길|돌길|마을 입구|성문|객잔|사당|거실|부엌|주방|골목|마당|rice paddy|stone path|village entrance|city gate|living room|kitchen|alley|courtyard/i

function shotWorldText(shot: Pick<Shot, 'title' | 'visualPrompt' | 'videoPrompt' | 'audioDescription'>): string {
  return [shot.title, shot.visualPrompt, shot.videoPrompt, shot.audioDescription].filter(Boolean).join('\n')
}

function sceneWorldText(scene: Pick<Scene, 'name' | 'description' | 'mainAnchor' | 'lighting'>): string {
  return [scene.name, scene.description, scene.mainAnchor, scene.lighting].filter(Boolean).join('\n')
}

export function sceneConflictsWithShot(
  shot: Pick<Shot, 'title' | 'visualPrompt' | 'videoPrompt' | 'audioDescription'>,
  scene: Pick<Scene, 'name' | 'description' | 'mainAnchor' | 'lighting'>
): boolean {
  const shotText = shotWorldText(shot)
  const plate = sceneWorldText(scene)
  const shotOld = ERA_PREMODERN.test(shotText)
  const shotNew = ERA_MODERN.test(shotText)
  const plateOld = ERA_PREMODERN.test(plate)
  const plateNew = ERA_MODERN.test(plate)
  if (plateNew && !plateOld && shotOld) return true
  if (plateOld && !plateNew && shotNew && !shotOld) return true
  return false
}

export function shotMentionsScene(
  shot: Pick<Shot, 'title' | 'visualPrompt' | 'videoPrompt' | 'audioDescription'>,
  scene: Pick<Scene, 'name'>
): boolean {
  const name = scene.name?.trim()
  if (!name || name.length < 2) return false
  return shotWorldText(shot).includes(name)
}

export function extractPlaceFromShot(
  shot: Pick<Shot, 'title' | 'visualPrompt' | 'videoPrompt'>
): string {
  const blob = [shot.visualPrompt, shot.videoPrompt, shot.title].filter(Boolean).join('\n')
  const hit = blob.match(LANDMARK)
  return hit?.[0]?.trim() || ''
}

export function promptMixesWorlds(text: string): boolean {
  const t = String(text || '')
  return ERA_MODERN.test(t) && ERA_PREMODERN.test(t)
}

/** 이전 대본에서 가져온 Location facts와 샷의 시공간이 일치하는지 확인한다. */
export function compiledDumpsConflictingPlate(text: string): boolean {
  return /Location facts:/i.test(text) && promptMixesWorlds(text)
}

export function resolveShotPlace(
  shot: Pick<Shot, 'title' | 'visualPrompt' | 'videoPrompt' | 'audioDescription'>,
  scene?: Scene
): {
  scene?: Scene
  name: string
  lighting: string
  anchor: string
} {
  const matched = scene && !sceneConflictsWithShot(shot, scene) ? scene : undefined
  const fromShot = extractPlaceFromShot(shot)
  return {
    scene: matched,
    name: fromShot || matched?.name?.trim() || '',
    lighting: matched?.lighting?.trim() || '',
    anchor: matched?.mainAnchor?.trim() || ''
  }
}

export function sceneForShotPlace(shot: Shot, project: Project): Scene | undefined {
  const all = project.scenes ?? []
  const bound = shot.sceneId ? all.find((item) => item.id === shot.sceneId) : undefined
  if (bound && !sceneConflictsWithShot(shot, bound)) return bound
  const mentioned = all.find((item) => shotMentionsScene(shot, item) && !sceneConflictsWithShot(shot, item))
  if (mentioned) return mentioned
  return undefined
}
