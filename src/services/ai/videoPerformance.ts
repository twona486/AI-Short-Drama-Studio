import type { Scene, Shot, Subject } from '@/types'
import { callLLM, getAIMode } from './client'
import { getVideoPromptStyle } from './runtime'
import {
  composeVideoPerformance,
  isVideoPerformanceTemplate,
  isVideoPerformanceThin,
  lacksEnsembleBlocking,
  stripFrameLead,
  thisShotAction,
  videoPerformanceSpec
} from '@/utils/shotPrompt'
import { parseJsonRobust } from '@/utils/jsonRepair'
import { importedDirectorPrefix } from '@/services/settings/directorSkill'

function shotLine(shot?: Shot): string {
  if (!shot) return '（없음）'
  const action = thisShotAction(shot.continuity) || shot.title || ''
  return `${shot.title || '제목 없음'}。${action}`
}

/**
 * 出视频前的内容表现：你亲手写过、且不像套话的原文原样用。
 * 空着、过短、缺少时间轴、或旧套话稿，按本镜剧情重写。
 */
export async function enrichVideoPerformance(opts: {
  shot: Shot
  prevShot?: Shot
  nextShot?: Shot
  subjects?: Array<Pick<Subject, 'name' | 'description' | 'role'>>
  scene?: Pick<Scene, 'name' | 'description' | 'lighting' | 'mainAnchor'>
  chapterNotes?: string
  sceneExcerpt?: string
  force?: boolean
  signal?: AbortSignal
}): Promise<string> {
  const own = stripFrameLead((opts.shot.videoPrompt || '').trim())
  const names = (opts.subjects || []).map((s) => s.name).filter(Boolean)
  if (
    !opts.force &&
    own &&
    !isVideoPerformanceThin(own) &&
    !isVideoPerformanceTemplate(own) &&
    !lacksEnsembleBlocking(own, names)
  ) {
    return own
  }

  const current = composeVideoPerformance(opts.shot, {
    ignoreStored: opts.force || isVideoPerformanceTemplate(own) || lacksEnsembleBlocking(own, names)
  })
  if (getAIMode() === 'mock') return current

  const roster = (opts.subjects || [])
    .map((s) => `${s.name}${s.role ? `（${s.role}）` : ''}：${(s.description || '').slice(0, 180)}`)
    .join('\n')
  const scene = opts.scene
    ? `${opts.scene.name}。${opts.scene.description || ''} 광원 ${opts.scene.lighting || ''} 주요 기준물 ${opts.scene.mainAnchor || ''}`
    : ''

  try {
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content: `${importedDirectorPrefix()}Write image-to-video direction. Write the final videoPrompt in English for the video generation model, retaining verbatim dialogue and requested Korean on-screen text. ${videoPerformanceSpec(getVideoPromptStyle())}
Return JSON only: {"videoPrompt":"..."}.
Direct the actors. Cover only the ${opts.shot.duration} seconds of this shot.
Divide zero through ${opts.shot.duration} seconds into 2–5 ranges by the story's actual beats. Do not divide the time mechanically. In each range specify current actions and expressions, the speaker and their original words, other actors' blocking and eyelines, a motivated camera move, and its endpoint. Each range must add visible progression.
For each visible person, state foreground or background position, profile or three-quarter orientation, and their eyeline. A speaker can be farther back. Foreground characters look back or sideways toward the speaker or the indicated object. Do not reproduce the frontal character-sheet pose as a group portrait.
Weak: Lin Yao points at the ridge and talks. The farmer and constable are present. They look at something within the scene.
Better: In the foreground, the farmer and constable face sideways on the stone path. Behind them, Lin Yao rises partway from his knees and points a muddy hand at the ridge. The farmer squints back at Lin Yao and the constable follows his hand toward the ridge. None looks at the camera.
Treat still-frame notes as set context. When continuity uses arrows, perform only the middle part of the chain. Do not replay the previous or next shot.
Follow the script's adaptation rules, exclusions, period, and weather. Older-character narration is off screen. People in the frame keep their mouths closed. Show kindness through small actions ordinary people take.`
        },
        {
          role: 'user',
          content: `Characters
${roster || '(Use the characters already in frame.)'}

Scene
${scene || '(Follow the reference frame.)'}

Previous shot (continuity only, do not replay) ${shotLine(opts.prevShot)}
Next shot (exclude from the current shot) ${shotLine(opts.nextShot)}

Current shot title ${opts.shot.title}
Duration ${opts.shot.duration} seconds
Camera movement ${opts.shot.cameraMovement}
Blocking ${opts.shot.blocking || ''}
Eyeline ${opts.shot.eyeline || 'Specify what each person is looking at and have them keep their eyes off the camera.'}
Current cast (include each person’s position and eyeline) ${names.join('、') || '(Use the characters already in frame.)'}
Current action (film only this beat) ${thisShotAction(opts.shot.continuity) || opts.shot.blocking || opts.shot.title || ''}
Props ${opts.shot.propFocus || 'none'}
Verbatim dialogue ${opts.shot.voiceover || '(none)'}
Existing draft (rewrite if it relies on clichés)
${own || current}

Mandatory chapter constraints
${opts.chapterNotes || '(none)'}

Original scene excerpt (follow it without inventing events)
${opts.sceneExcerpt || '(None. Follow the current shot’s continuity notes.)'}

Reference still (use as set context only, do not describe it again)
${(opts.shot.visualPrompt || '').slice(0, 400)}`
        }
      ],
      jsonMode: true,
      temperature: 0.7,
      maxTokens: 1600,
      signal: opts.signal
    })
    const parsed = parseJsonRobust(resp.content) as { videoPrompt?: string }
    const rich = stripFrameLead(String(parsed.videoPrompt || ''))
    if (!rich || rich === (opts.shot.visualPrompt || '').trim()) return current
    if (isVideoPerformanceTemplate(rich)) return current
    return rich
  } catch {
    return current
  }
}
