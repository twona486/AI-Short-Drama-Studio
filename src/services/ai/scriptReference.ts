/** Built-in technique cards with original dialogue examples. */
const cards = [
  { id: 'family', legacyName: '家庭关系', label: '가족 관계', words: ['家庭', '婆婆', '婆媳', '婚姻', '离婚', '夫妻', '亲情', '父母', '孩子', '伦理', '가족', '부모', '결혼', '이혼', '아이'], body: "Anchor family conflict in a concrete everyday task such as a meal, clothing, a promise, or childcare. Show power through who handles it, who avoids it, and who protects whom. Let dialogue confront the immediate issue through interruptions, changed wording, silence and visible reactions.", example: '유진이 도시락을 밀어요. “또 안 먹었어요?” 지민은 문 쪽을 봐요. “남겨 둔 거예요.” 유진이 뚜껑을 열어요. “다음엔 먼저 먹어요.”' },
  { id: 'urban', legacyName: '都市情感与豪门', label: '도시 로맨스와 재벌', words: ['都市', '豪门', '总裁', '职场', '闪婚', '婚恋', '前夫', '老板', '合同', '재벌', '도시', '직장', '계약', '전남편'], body: "Use inequalities in status, resources or knowledge as concrete obstacles. Change the relationship through a negotiation, invitation or choice. Give each character a practical goal and reveal subtext through distance, wording and responses. Plant evidence for reversals.", example: '유진이 서류를 덮어요. “이 조건 누가 넣었어요?” 지민이 손을 내밀어요. “아직 확정 전이에요.” 유진은 종이 끝을 눌러요. “그럼 서명도 나중에 해요.”' },
  { id: 'rebirth', legacyName: '穿越重生', label: '시간 이동과 회귀', words: ['穿越', '重生', '穿书', '古代', '太子', '古装', '王爷', '宫廷', '皇帝', '仙侠', '회귀', '타임슬립', '궁중', '황제', '전생', '선협'], body: "Show identity mismatch through the situation and others' responses. Reveal rules through the protagonist's choices. Their knowledge should create a concrete opening and a new obstacle. Follow the requested historical or fantasy world without imposing a system narrator.", example: '유진이 소매를 더듬어요. “제 휴대폰은요?” 지민이 눈을 깜빡여요. “휴대 뭐요?” 유진이 둘러보고 다시 물어요. “일단 오늘이 며칠이에요?”' },
  { id: 'revenge', legacyName: '复仇与逆袭', label: '복수와 역전', words: ['复仇', '报仇', '逆袭', '打脸', '翻身', '复仇者', '归来', '陷害', '복수', '역전', '누명', '귀환'], body: "Establish the protagonist's current situation and a visible obstacle. Build a feasible goal, an opponent's response and a tangible cost. Let earlier choices, evidence and actions cause the reversal instead of declaring victory in narration.", example: '유진이 영수증을 내려놔요. “이 돈 누가 받았어요?” 지민이 웃어요. “이제 와서 그게 중요해요?” 유진이 뒷장을 넘겨요. “날짜부터 봐요.”' },
  { id: 'mystery', legacyName: '悬疑推理', label: '서스펜스와 추리', words: ['悬疑', '推理', '凶手', '案件', '秘密', '线索', '失踪', '真相', '调查', '미스터리', '추리', '범인', '단서', '실종', '사건', '비밀'], body: "Build around a specific question the character wants answered. Discover clues through action while keeping other interpretations plausible. Pace when the audience learns each fact. Make the reveal account for evidence already shown.", example: '유진이 자물쇠를 봐요. “어젯밤에 안 왔다고 했죠?” 지민이 고개를 끄덕여요. “그럼 신발에 묻은 흙은요?” 지민은 발을 뒤로 빼요.' },
  { id: 'romance', legacyName: '甜宠与情感拉扯', label: '로맨스와 감정의 변화', words: ['甜宠', '爱情', '恋爱', '暧昧', '暗恋', '竹马', '虐恋', '修罗场', '感情', '연애', '로맨스', '짝사랑', '소꿉친구', '썸'], body: "Change relationships through a shared task, tentative gestures and choices. Actions and words may conflict, while individual motives and limits remain clear. Use concrete replies, pauses and actions instead of repeated descriptions of feelings.", example: '유진이 우산을 건네요. “먼저 가요.” 지민이 빗줄기를 봐요. “그럼 유진 씨는요?” 유진이 어깨를 움츠려요. “좀 더 기다릴게요.” 지민이 옆으로 비켜서요. “이쪽으로 와요. 다 젖겠어요.”' }
]

export const SCRIPT_REFERENCE_OPTIONS = [
  { value: 'auto', label: '자동 선택' },
  { value: 'off', label: '사용 안 함' },
  ...cards.map((card) => ({ value: card.id, label: card.label }))
]

export function normalizeScriptReference(value: unknown): string {
  return SCRIPT_REFERENCE_OPTIONS.some((item) => item.value === value)
    ? String(value)
    : cards.find((card) => card.legacyName === value)?.id ?? 'auto'
}

export function scriptReferenceBrief(selection: string, ...parts: Array<string | undefined>): string {
  const selected = normalizeScriptReference(selection)
  if (selected === 'off') return ''
  const text = parts.filter(Boolean).join('\n')
  const matched = cards.map((card, index) => ({ card, index, score: card.words.reduce((n, word) => n + (text.includes(word) ? 1 : 0), 0) }))
    .filter((item) => selected === 'auto' ? item.score > 0 : item.card.id === selected)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
  const specific = matched.map(({ card }) => `${card.id}: ${card.body}\nOriginal Korean dialogue example for technique only: ${card.example}`).join('\n')
  return `Use these references for technique. Follow the user's genre, style, duration and dialogue requirements. Write natural, speakable Korean, adapting formality to each character and situation. Give characters distinct motives and speech habits. Make replies address the previous line. Allow avoidance, questions, interruptions, changes of mind and silence when motivated. Skip information all speakers already know. Use visible actions and reactions instead of speeches, parallel slogans or exposition. Let consequential exchanges develop rather than summarizing a conflict in one line. Make positions, actions and changes clear. Use suspense when the story calls for it.\n${specific}\nUse original characters, lines and events. Treat the examples as technique only and preserve user-supplied events, dialogue and continuation boundaries.`
}
