/** Line-oriented screenplay format. Episode headings are managed by the editor. */
export const SCREENPLAY_FORMAT_RULES = `Write only the episode's scene bodies, in natural Korean. Use the format below instead of Markdown headings, bold, lists or code fences. Include no outline, character bios, process notes or episode title.

Each scene follows this order with one item per line. Use a blank line only between scenes:

장면 1 · 교외 버스 정류장 · 밤 · 밖
정류장 지붕 끝에서 빗물이 떨어진다. 유진은 젖은 승차권을 펴 본다.
(이번 장면 200자 · 약 25초 · 3샷)
내레이션: 이 노선은 한 달 전에 폐지됐다.
유진(낮은 목소리): 여기 막차가 아직 와요?
정류장 안쪽에 서 있던 민수가 손전등을 켠다.
민수: 표부터 보여 주세요.
등장　유진, 민수　소품　승차권, 손전등　환경음　빗소리

Number scene headings from one. Use "장면 N · location · 낮 or 밤 · 안 or 밖". Use present tense and describe only visible or audible action. Keep camera directions out of the script body. Follow opening action with an estimate of written length, duration and number of filmable beats. Put narration on its own line with "내레이션:" and each dialogue line in "Name: dialogue" or "Name(delivery): dialogue" format. Preserve source dialogue verbatim unless asked to revise it. At the end of each scene use "등장　names　소품　objects　환경음　sounds" with full-width spaces between fields, and "없음" for an empty field. The example shows formatting only. Keep the established story when revising or continuing.`

const SCENE_LINE = /^(?:场景|장면|Scene)\s*[0-9０-９]/i

/** Normalize optional markup for the screenplay editor. */
export function normalizeScreenplayBody(raw: string) {
  let text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  text = text.replace(/^```(?:markdown|md|text)?\s*/i, '').replace(/\s*```$/, '').trim()
  const lines = text.split('\n').map((line) => {
    let next = line.replace(/^#{1,6}\s+/, '')
    next = next.replace(/^\*\*([^*]+)\*\*/, '$1')
    next = next.replace(/^\*\s*(?=（|\()/, '')
    next = next.replace(/^>\s*(?=旁白|画外音|내레이션|화면 밖 음성|OS|os)/, '')
    const spoken = next.match(/^(\s*)([\u4e00-\u9fa5가-힣A-Za-z0-9·.]{1,12})[：:]((?:（[^）]{1,40}）|\([^)]{1,40}\)))(?![：:])(.*)$/)
    if (spoken && !/^(?:旁白|画外音|내레이션|화면 밖 음성|OS|os|出场|道具|环境音|场景|등장|소품|환경음|장면)$/.test(spoken[2])) {
      next = `${spoken[1]}${spoken[2]}${spoken[3]}：${spoken[4].replace(/^\s+/, '')}`
    }
    return next
  })
  const firstScene = lines.findIndex((line) => SCENE_LINE.test(line.trim()))
  const body = (firstScene > 0 ? lines.slice(firstScene) : lines).join('\n')
  return body.replace(/\n{3,}/g, '\n\n').trim()
}
