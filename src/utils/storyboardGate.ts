type ProjectGate = {
  pipelineMode?: string
  script?: { workflowMode?: string } | null
} | null | undefined

/** 숏드라마와 영화 챕터는 스토리 개요판을 사용한다. 일반 제작은 캐릭터와 배경 참조로 키프레임을 만든 뒤 영상을 생성한다. */
export function videoRequiresStoryboard(project?: ProjectGate): boolean {
  if (!project) return false
  if (project.pipelineMode === 'drama') return true
  if (project.pipelineMode === 'remake' || project.pipelineMode === 'img2video') return false
  if (project.pipelineMode === 'standard' || project.pipelineMode === 'smart-speech') return false
  return project.script?.workflowMode === 'film-chapter'
}

/** 캔버스에 제작 방식에 맞는 개요판 또는 키프레임 노드를 배치한다. */
export function usesStoryboardCanvas(project?: ProjectGate): boolean {
  return videoRequiresStoryboard(project)
}
