/** Built-in storyboard styles and genres layered over storyboard-director. */

export type StorySkillGroup = 'style' | 'genre'

export interface StorySkill {
  id: string
  name: string
  group: StorySkillGroup
  summary: string
  body: string
}

export const GENERAL_STORY_SKILL_ID = 'storyboard-director'
export const CUSTOM_STORY_SKILL_ID = 'custom'

export const STORY_SKILLS: StorySkill[] = [
  {
    id: 'style-fast-cut',
    name: '빠른 세로형 편집',
    group: 'style',
    summary: '첫 샷으로 시선을 끌고 샷마다 한 가지 사건에 집중해요.',
    body: `# Fast vertical cuts

Open on a conflict, contrast, or unanswered question. Introduce the setting or character first when the story needs it. Focus each shot on one readable beat and set its length by action, dialogue, and model limits. Place reversals where the story motivates them. Frame speakers in medium close-up with readable lips and keep reaction shots shorter where appropriate. End on an urgent open question. Give videoPrompt timed cuts instead of describing one continuous move.
Write any newly generated audience-facing dialogue and descriptions in natural, polite conversational Korean. Preserve supplied dialogue verbatim; write image and video generation prompts in English.`
  },
  {
    id: 'style-long-take',
    name: '한 장면 한 샷',
    group: 'style',
    summary: '동선과 초점 변화로 한 장면을 이어 가요.',
    body: `# One take per scene

Keep entrances, exits, exchanges, and confrontations in the same space and take when possible. Adjust length to action, dialogue, and model limits. Use blocking, pauses, turns and focus shifts to tell the story. Specify who speaks, turns, and obstructs entrances in blocking. Start a new shot for real changes of space or time. Show opening composition in visualPrompt and describe the unbroken action from zero to the last frame in videoPrompt.
Write any newly generated audience-facing dialogue and descriptions in natural, polite conversational Korean. Preserve supplied dialogue verbatim; write image and video generation prompts in English.`
  },
  {
    id: 'style-emotion',
    name: '감정 클로즈업',
    group: 'style',
    summary: '표정, 손짓과 침묵으로 감정을 보여 줘요.',
    body: `# Emotional close-ups

Start with the face, hands, breath and pauses. Retain the one environmental detail that reinforces emotion. Allow reaction shots time and leave silences in duration. Avoid narration that explains emotions. Vary profiles, lowered faces and partially obscured faces according to relationships. Direct eyelines toward someone or an object, never arbitrarily toward the lens. Include a hand or object close-up to carry an unspoken feeling.
Write any newly generated audience-facing dialogue and descriptions in natural, polite conversational Korean. Preserve supplied dialogue verbatim; write image and video generation prompts in English.`
  },
  {
    id: 'style-montage',
    name: '몽타주',
    group: 'style',
    summary: '여러 화면을 이어 시간을 압축하고 대사는 줄여요.',
    body: `# Montage

Compress time with concrete actions showing preparation, travel, repeated work, seasons, or a changing relationship. Adjust each shot's duration and speech to the content. Use environmental sounds such as steps, doors, rain or tools. Repeat a prop or action with visible changes to show progress. End on a character's face or decision. Keep a framing shot on both sides to show where the montage begins and what changes.
Write any newly generated audience-facing dialogue and descriptions in natural, polite conversational Korean. Preserve supplied dialogue verbatim; write image and video generation prompts in English.`
  },
  {
    id: 'genre-sweet',
    name: '로맨틱 코미디',
    group: 'genre',
    summary: '눈길과 작은 행동으로 관계가 달라지는 모습을 보여 줘요.',
    body: `# Sweet romance

Advance relationships through proximity, eyelines, avoidance, exchanges and altered wording. Show the source and resolution of misunderstandings and a change of attitude within the episode. Use reactions and mismatched expectations for humor. Favor medium close-ups and specify who looks first or looks away. End on an unfinished gesture or an unanswered line.
Write any newly generated audience-facing dialogue and descriptions in natural, polite conversational Korean. Preserve supplied dialogue verbatim; write image and video generation prompts in English.`
  },
  {
    id: 'genre-revenge',
    name: '통쾌한 역전극',
    group: 'genre',
    summary: '무시당한 순간을 보여 주고 행동으로 판을 뒤집어요.',
    body: `# Comeback drama

Show specific evidence of disrespect when needed, such as seating, a bill, exact words or a look. Build the reversal on prior facts, an object, a document, or behavior. Show a concrete action by the lead, such as opening or reading evidence, and include witnesses' reactions. Let buildup breathe and keep the reveal short and sharp. End on a reaction or the next obstacle.
Write any newly generated audience-facing dialogue and descriptions in natural, polite conversational Korean. Preserve supplied dialogue verbatim; write image and video generation prompts in English.`
  },
  {
    id: 'genre-suspense',
    name: '서스펜스와 반전',
    group: 'genre',
    summary: '샷마다 단서 하나를 보여 주고 새로운 질문을 남겨요.',
    body: `# Suspense and twist

Reveal one clue per shot, such as an object, a slip, a timing mismatch or an absence. In purpose, state what the audience knows that a character does not, or vice versa. Anchor clues in close-ups and contrast visible evidence with unreliable speech. Revisit established objects or lines for the twist. End on a larger question and preserve causality between the beats already shown.
Write any newly generated audience-facing dialogue and descriptions in natural, polite conversational Korean. Preserve supplied dialogue verbatim; write image and video generation prompts in English.`
  },
  {
    id: 'genre-family',
    name: '가족 드라마',
    group: 'genre',
    summary: '집 안의 거리와 일상 대화로 갈등을 보여 줘요.',
    body: `# Family drama

Use the dinner table, threshold, kitchen or old album. Show relationships through seats, who serves food first and who stays outside. Use short everyday exchanges, pauses and chores. Show generational dynamics through gestures, avoidance, mediation and reactions from listeners. Use medium framing to keep the space visible. Reserve close-ups for unspoken beats and end on an untouched object or unanswered address.
Write any newly generated audience-facing dialogue and descriptions in natural, polite conversational Korean. Preserve supplied dialogue verbatim; write image and video generation prompts in English.`
  },
  {
    id: 'genre-rebirth',
    name: '시간 이동과 회귀',
    group: 'genre',
    summary: '달라진 신분과 세계의 규칙을 행동으로 보여 줘요.',
    body: `# Time travel and rebirth

Open with evidence of an altered identity, such as a name, a scar, a date, or unexpected clothes or phone. Contrast past and present through one object's changed state. Show rules through actions and their consequences, with at most one short explanatory line and an immediate interruption. Show who acts first using their knowledge of the future. Resolve one specific past regret in this episode.
Write any newly generated audience-facing dialogue and descriptions in natural, polite conversational Korean. Preserve supplied dialogue verbatim; write image and video generation prompts in English.`
  },
  {
    id: 'genre-ceo',
    name: '도시 재벌 드라마',
    group: 'genre',
    summary: '거리, 자리와 말하는 순서로 권력 관계를 드러내요.',
    body: `# Urban CEO drama

Stage power through seating, standing, distance across a desk, who speaks or arrives first. Favor offices, elevators, banquets and cars. Use clothing and accessories to identify status. Keep lines short and cut to reactions rather than repeating motives. Motivate proximity with a document, a blocked door or a seat change. End on an identity or contractual complication.
Write any newly generated audience-facing dialogue and descriptions in natural, polite conversational Korean. Preserve supplied dialogue verbatim; write image and video generation prompts in English.`
  },
  {
    id: 'genre-commerce',
    name: '제품 시연',
    group: 'genre',
    summary: '진행자와 제품, 직접 사용하는 모습을 함께 보여 줘요.',
    body: `# Product demonstration

Define the presenter as a character, the product as a prop, and the location as a scene. Put exact spoken copy in voiceover. Show a product close-up and a clear demonstration with a visible result. Keep the presenter's mouth readable and the product in hand or in the foreground. Organize separate shots for comparison, problem, use and result. End with a speakable call to action and the product still visible.
Write any newly generated audience-facing dialogue and descriptions in natural, polite conversational Korean. Preserve supplied dialogue verbatim; write image and video generation prompts in English.`
  }
]

const BY_ID = new Map(STORY_SKILLS.map((skill) => [skill.id, skill]))

export function storySkillById(id: string): StorySkill | undefined {
  return BY_ID.get(id)
}

export function normalizeStorySkillId(id: unknown, hasCustom: boolean): string {
  if (id === CUSTOM_STORY_SKILL_ID && hasCustom) return CUSTOM_STORY_SKILL_ID
  if (id === GENERAL_STORY_SKILL_ID) return GENERAL_STORY_SKILL_ID
  if (typeof id === 'string' && BY_ID.has(id)) return id
  return GENERAL_STORY_SKILL_ID
}
