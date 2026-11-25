import assert from 'node:assert/strict'
import { posix } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/services/storage/scripts'; export * from './src/services/storage/fs'",
    resolveDir: process.cwd()
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm'
})
const storage = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'))

function desktopFixture(entries) {
  const files = new Map(Object.entries(entries))
  const writes = []
  globalThis.window = {
    desktop: {
      isDesktop: true,
      getRoot: async () => '/test',
      listProjectDirs: async () => ['/test/project'],
      join: async (...parts) => posix.join(...parts),
      exists: async path => files.has(path),
      readText: async path => files.get(path),
      writeText: async (path, text, atomic) => {
        files.set(path, text)
        writes.push([path, atomic])
      }
    }
  }
  return { files, writes }
}

test('대본과 회차 기본 이름을 한 번 저장하고 경로와 본문을 보존한다', async () => {
  const index = '/test/_scripts/index.json'
  const path = '/test/_scripts/legacy.md'
  const legacy = {
    id: 'legacy', title: '未命名剧本 7', filename: '未命名剧本 7.md',
    source: 'manual', fileRelPath: 'legacy.md', episodeCount: 3, totalWords: 42, updatedAt: 10
  }
  const custom = { id: 'custom', title: '未命名剧本 5 (초안)', source: 'manual' }
  const imported = { id: 'imported', title: '未命名剧本', source: 'imported' }
  const markdown = [
    '\uFEFF# 未命名剧本 7', '', '## 第 2 集  ', '대사 未命名剧本 7', '~~~md',
    '## 第 5 集', '~~~', '## 未命名', '', '## 第 3 集 후일담', '', ''
  ].join('\r\n')
  const { files, writes } = desktopFixture({
    [index]: JSON.stringify([legacy, custom, imported]),
    [path]: markdown,
    '/test/_scripts/imported.md': '# 未命名剧本\n## 第 1 集\n'
  })

  const [first, second] = await Promise.all([storage.listScriptDocs(), storage.listScriptDocs()])
  assert.deepEqual(first, second)
  assert.deepEqual(first[0], { ...legacy, title: '제목 없는 대본 7', defaultNamesLocalized: true })
  assert.equal(first[1].title, custom.title)
  assert.equal(first[2].title, imported.title)
  assert.equal(await storage.loadScriptMarkdown(legacy.id),
    markdown.replace('# 未命名剧本 7', '# 제목 없는 대본 7').replace('## 第 2 集', '## 2화').replace('## 未命名', '## 제목 없음'))
  assert.equal(files.get('/test/_scripts/imported.md'), '# 未命名剧本\n## 第 1 集\n')
  assert.deepEqual(writes, [[path, true], [index, true]])

  await storage.saveScript({ ...first[0], title: '未命名剧本', updatedAt: 11 }, '# 未命名剧本\n## 第 1 集\n')
  assert.equal((await storage.listScriptDocs())[0].title, '未命名剧本')
  const fresh = await storage.saveScript({ ...legacy, id: 'fresh', title: '未命名剧本 5', updatedAt: 12 }, '# 未命名剧本 5\n')
  assert.deepEqual((await storage.listScriptDocs())[0], fresh)
})

test('인덱스 저장이 실패해도 다시 불러오면 남은 메타데이터를 저장한다', async () => {
  const index = '/test/_scripts/index.json'
  const path = '/test/_scripts/legacy.md'
  const { files, writes } = desktopFixture({
    [index]: JSON.stringify([{ id: 'legacy', title: '未命名剧本' }]),
    [path]: '# 未命名剧本\n## 第 1 集\n'
  })
  const write = window.desktop.writeText
  window.desktop.writeText = async (...args) => {
    if (args[0] === index) throw new Error('인덱스 쓰기 실패')
    return write(...args)
  }
  await assert.rejects(storage.listScriptDocs(), /인덱스 쓰기 실패/)
  assert.equal(files.get(path), '# 제목 없는 대본\n## 1화\n')
  assert.equal(JSON.parse(files.get(index))[0].title, '未命名剧本')

  window.desktop.writeText = write
  assert.equal((await storage.listScriptDocs())[0].title, '제목 없는 대본')
  assert.deepEqual(writes, [[path, true], [index, true]])
})

test('프로젝트와 노드에서 확인된 기본 이름만 저장한다', async () => {
  const path = '/test/project/project.json'
  const makeNode = (id, type, label) => ({ id, type, data: { label, prompt: '图片 1' } })
  const original = {
    id: 'project', name: '新项目 8-2 06:03', updatedAt: 12,
    script: { topic: '新项目 8-2 06:03', content: '第 1 集' },
    chapters: [{ title: '第 3 章', content: '未命名' }, { title: '第 1 章 · 서막' }],
    canvas: {
      nodes: [
        makeNode('script', 'script', '新项目 8-2 06:03'),
        makeNode('image', 'imageGen', '图片 1'),
        makeNode('audio', 'audioGen', '音频 3'),
        makeNode('custom', 'videoGen', '视频 2 최종'),
        makeNode('other', 'script', '图片 1'),
        makeNode('group-audio', 'groupFrame', '口播')
      ],
      groups: [{ id: 'group-audio', label: '口播' }]
    }
  }
  const { files, writes } = desktopFixture({ [path]: JSON.stringify(original) })
  const [opened, [listed]] = await Promise.all([
    storage.loadProjectFromDir('/test/project'), storage.listProjects()
  ])
  assert.deepEqual(opened, listed)
  assert.equal(opened.name, '새 프로젝트 8-2 06:03')
  assert.deepEqual(opened.script, { ...original.script, topic: opened.name })
  assert.equal(opened.folderPath, '/test/project')
  assert.equal(opened.updatedAt, original.updatedAt)
  assert.deepEqual(opened.chapters, [{ title: '챕터 3', content: '未命名' }, original.chapters[1]])
  assert.deepEqual(opened.canvas.nodes.map(node => node.data.label),
    [opened.name, '이미지 1', '오디오 3', '视频 2 최종', '图片 1', '내레이션'])
  assert.ok(opened.canvas.nodes.every(node => node.data.prompt === '图片 1'))
  assert.equal(opened.canvas.groups[0].label, '내레이션')
  assert.deepEqual(writes, [[path, true]])

  await storage.saveProject({ ...opened, name: '未命名项目' })
  assert.equal((await storage.loadProjectFromDir('/test/project')).name, '未命名项目')
  assert.equal(JSON.parse(files.get(path)).defaultNamesLocalized, true)
  assert.equal(writes.length, 2)
})

test('이전 프로젝트 이름의 날짜 형식을 구분한다', async () => {
  const path = '/test/project/project.json'
  const { files } = desktopFixture({})
  const cases = [
    ['未命名项目', '제목 없는 프로젝트'],
    ['新项目 2-29 23:59', '새 프로젝트 2-29 23:59'],
    ['视频复刻 11-30 08:04', '영상 재현 11-30 08:04'],
    ['自由剪辑 3-31 1706', '자유 편집 3-31 1706'],
    ['项目 01/02 03:04', '프로젝트 01. 02. 오전 03:04'],
    ['新项目', '新项目'],
    ['新项目 2-30 23:59', '新项目 2-30 23:59'],
    ['新项目 2-29 23:59 · 후속', '新项目 2-29 23:59 · 후속']
  ]
  for (const [name, expected] of cases) {
    files.set(path, JSON.stringify({ id: 'project', name }))
    assert.equal((await storage.loadProjectFromDir('/test/project')).name, expected)
  }
})
