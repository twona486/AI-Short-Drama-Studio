/** Exercise the real upload -> input injection -> submit path with an offline ComfyUI transport. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve, basename } from 'node:path'

const built = await build({
  stdin: { contents: `export { comfyPromptGenerate } from './src/services/ai/adapters';
    export { fitComfyReferenceImages } from './src/services/ai/comfyInputMap';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'offline-comfy', setup(b) {
    b.onResolve({ filter: /.*/ }, args => {
      const name=basename(args.path).replace(/\.ts$/, '')
      if (['desktop','zealman','client'].includes(name)) return { path:name, namespace:'mock' }
      if ((!args.path.startsWith('.') && !args.path.startsWith('@/')) || /[\\/]node_modules[\\/]/.test(args.resolveDir)) return
      return { path:resolve(args.path.startsWith('@/')?'src':args.resolveDir,args.path.replace(/^@\//,'')+'.ts') }
    })
    b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:{
      desktop:`export const isDesktop=()=>true; export const desktop=()=>({autodlFetch:req=>globalThis.__comfyTest.request(req)});`,
      zealman:`export const zealmanWorkflowById=()=>undefined;`,
      client:`export const callLLM=()=>{throw Error('Unexpected LLM call in offline test')};`
    }[args.path],loader:'js'}))
  } }]
})
const {comfyPromptGenerate,fitComfyReferenceImages}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'))
const image=i=>'data:image/png;base64,'+Buffer.from('test-image-'+i).toString('base64')
let tests=0
function fixture(count=9, h3=false) {
  const prompt={text:{class_type:'CR Prompt Text',inputs:{prompt:'default prompt'}}}
  const ids=Array.from({length:count},(_,i)=>String(100-i)) // not object-key order
  for(const [i,id] of ids.entries()) prompt[id]={class_type:'LoadImage',inputs:{image:`black-${i+1}.png`}}
  prompt.condition={class_type:h3?'MiniMaxH3AudioConditioningT8':'CustomVideoConditioning',inputs:{task_type:'ref2va'}}
  ids.forEach((id,i)=>{prompt.condition.inputs[`ref_images.ref_image_${i}`]=[id,0]})
  const bindings=[{role:'prompt',nodeId:'text',field:'prompt'},...ids.map(id=>({role:'image',nodeId:id,field:'image',mediaMode:'upload'}))]
  return {payload:{prompt},map:{version:1,kind:'image-to-video',summary:'test',source:'heuristic',bindings},ids}
}
async function generate(f, count, extra={}) {
  const uploads=[], submissions=[], logs=[]
  globalThis.__comfyTest={request:async req=>{
    assert.equal(new URL(req.url).origin,'http://127.0.0.1:8188')
    const pathname=new URL(req.url).pathname
    const response=(data,status=200)=>({ok:status===200,status,text:JSON.stringify(data)})
    if(pathname==='/upload/image') {
      uploads.push(Buffer.from(req.bodyBase64,'base64').toString())
      if(extra.failUpload) return response({error:'upload failed'},500)
      return response({name:`uploaded-${uploads.length}.png`,subfolder:'inputs'})
    }
    if(pathname==='/prompt') { submissions.push(JSON.parse(req.body));return response({prompt_id:'test-job'}) }
    if(pathname==='/history/test-job') return response({'test-job':{outputs:{video:{videos:[{filename:'test.mp4',type:'output'}]}}}})
    if(pathname==='/view') return {ok:true,status:200,text:'',contentType:'video/mp4',dataBase64:Buffer.from('test-video').toString('base64')}
    throw Error('Unexpected request: '+req.url)
  }}
  const template=JSON.stringify(f.payload)
  const opts={baseUrl:'http://127.0.0.1:8188',kind:'video',prompt:'本次提示词',
    imageDataUrl:count?image(1):undefined, referenceImageDataUrls:Array.from({length:Math.max(0,count-1)},(_,i)=>image(i+2)),
    adapter:{workflowTemplate:template,inputMap:f.map},onProgress:m=>logs.push(m),...extra}
  delete opts.failUpload
  try { await comfyPromptGenerate(opts) }
  catch(error) { return {error,uploads,submissions,logs} }
  assert.equal(JSON.stringify(f.payload),template,'stored workflow must stay unchanged')
  return {uploads,submissions,logs}
}
async function test(name,fn) { await fn(); tests++;console.log('PASS',name) }

for(const count of [1,6,9]) await test(`9슬롯 워크플로에서 참조 ${count}장을 순서대로 매핑해요.`,async()=>{
  const f=fixture(),r=await generate(f,count)
  assert.ifError(r.error);assert.equal(r.uploads.length,count);assert.equal(r.submissions.length,1)
  const nodes=r.submissions[0].prompt
  f.ids.forEach((id,i)=>assert.equal(nodes[id].inputs.image,i<count?`inputs/uploaded-${i+1}.png`:`black-${i+1}.png`))
  assert.deepEqual(nodes.condition,f.payload.prompt.condition)
  assert.equal(nodes.text.inputs.prompt,'本次提示词')
  r.uploads.forEach((body,i)=>assert.ok(body.includes('test-image-'+(i+1))))
})
await test('9슬롯 H3 구조의 기존 노드와 연결을 보관하고 레거시 매핑을 연결로 보완해요.',async()=>{
  const f=fixture(9,true)
  f.map.bindings=f.map.bindings.slice(0,2)
  const r=await generate(f,1)
  assert.ifError(r.error)
  assert.equal(Object.keys(r.submissions[0].prompt).length,Object.keys(f.payload.prompt).length)
  assert.deepEqual(r.submissions[0].prompt.condition,f.payload.prompt.condition)
  f.ids.slice(1).forEach((id,i)=>assert.equal(r.submissions[0].prompt[id].inputs.image,`black-${i+2}.png`))
})
await test('매핑이 없는 고정 이미지는 유지하고 요청을 제출해요.',async()=>{
  const f=fixture();f.payload.prompt.fixed={class_type:'LoadImage',inputs:{image:'fixed-black.png'}}
  const r=await generate(f,1);assert.ifError(r.error)
  assert.equal(r.submissions[0].prompt.fixed.inputs.image,'fixed-black.png')
})
await test('끝 프레임과 마스크는 참조 이미지 슬롯을 차지하지 않아요.',async()=>{
  const f=fixture()
  for(const role of ['imageEnd','mask']) {
    f.payload.prompt[role]={class_type:'LoadImage',inputs:{image:'old.png'}}
    f.map.bindings.splice(1,0,{role,nodeId:role,field:'image',mediaMode:'upload'})
  }
  const r=await generate(f,1,{imageEndDataUrl:image(99),maskDataUrl:image(98)})
  assert.ifError(r.error);assert.equal(r.uploads.length,3)
  assert.equal(r.submissions[0].prompt[f.ids[0]].inputs.image,'inputs/uploaded-3.png')
  assert.equal(r.submissions[0].prompt[f.ids[1]].inputs.image,'black-2.png')
  assert.equal(r.submissions[0].prompt.imageEnd.inputs.image,'inputs/uploaded-2.png')
})
await test('인식 가능한 H3 구조를 4슬롯에서 6슬롯으로 늘려요.',()=>{
  const f=fixture(4,true), map=fitComfyReferenceImages(f.payload,f.map,6)
  assert.equal(map.bindings.filter(b=>b.role==='image').length,6)
  assert.equal(Object.keys(f.payload.prompt.condition.inputs).filter(k=>k.startsWith('ref_images.')).length,6)
})
await test('슬롯을 늘릴 수 없는 워크플로에서 용량이 부족하면 알리고 요청을 멈춰요.',async()=>{
  const r=await generate(fixture(3),4)
  assert.match(r.error?.message,/참조 이미지 슬롯은 3개/)
  assert.equal(r.uploads.length,0);assert.equal(r.submissions.length,0)
})
await test('업로드가 실패하면 기본 이미지로 대체해 요청하지 않아요.',async()=>{
  const r=await generate(fixture(),1,{failUpload:true})
  assert.match(r.error?.message,/에셋을 올리지 못했어요/);assert.equal(r.submissions.length,0)
})
await test('같은 필드에 두 이미지를 매핑하면 요청을 제출하지 않아요.',async()=>{
  const f=fixture();f.map.bindings.push({...f.map.bindings[1]})
  const r=await generate(f,1)
  assert.match(r.error?.message,/같은 ComfyUI 노드 필드/);assert.equal(r.submissions.length,0)
})
await test('이미지 워크플로도 제공한 슬롯만 바꾸고 나머지는 기본값을 사용해요.',async()=>{
  const f=fixture(),r=await generate(f,1,{kind:'image'})
  assert.ifError(r.error);assert.equal(r.uploads.length,1)
  assert.equal(r.submissions[0].prompt[f.ids[8]].inputs.image,'black-9.png')
})
await test('연속 촬영 재개 시 저장한 작업 ID로 결과만 조회해요.',async()=>{
  let saved=''
  const first=await generate(fixture(),1,{onTaskSubmitted:id=>{saved=id}})
  assert.ifError(first.error);assert.equal(saved,'test-job')
  const resumed=await generate(fixture(),1,{resumeTaskId:saved,onTaskSubmitted:()=>{throw Error('must not resubmit')}})
  assert.ifError(resumed.error);assert.equal(resumed.uploads.length,0);assert.equal(resumed.submissions.length,0)
})
console.log(`${tests} ComfyUI reference-slot regressions passed (offline; no network or generation charges).`)
