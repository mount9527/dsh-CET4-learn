/**
 * 内置示例题库的发版护栏。
 *   node build/check-starter.mjs
 *
 * 为什么单列一个脚本：`starter/` 是唯一随包分发的「内容」，一旦有人把音频或真题片段塞进去，
 * 整个包就从「代码」变成「内容分发」。这个检查放在 npm test 与 release workflow 里，
 * 拦的是下面这几类事故：
 *   1. 音频文件混进 starter/（示例卷必须靠语音合成，不能带录音）；
 *   2. index.json 忘了标 kind=starter（前端就不认示例模式了）；
 *   3. 卷宗里写了 audio 路径（说明有人把真人录音接回来了）；
 *   4. index.json 声明的词数与实际词表对不上（卡片会显示错的数字）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'starter')
const fail = (msg) => {
  console.error(`✗ ${msg}`)
  process.exitCode = 1
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

if (!fs.existsSync(DIR)) {
  fail('没有 starter/ 目录：内置示例题库不见了（装完就没东西可看）')
  process.exit(1)
}

/* 1. 递归列出文件 */
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  )
const files = walk(DIR)
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/')

/* 2. 不许有音频 */
const AUDIO = /\.(aac|m4a|mp3|wav|ogg|flac|opus|wma)$/i
const audio = files.filter((f) => AUDIO.test(f))
if (audio.length) fail(`starter/ 里混进了音频文件（示例卷只能用语音合成）：${audio.map(rel).join(', ')}`)

/* 3. 必须标 kind=starter */
const indexFile = path.join(DIR, 'index.json')
if (!fs.existsSync(indexFile)) {
  fail('缺 starter/index.json')
  process.exit(1)
}
const index = read(indexFile)
if (index.kind !== 'starter') fail(`starter/index.json 的 kind 应为 "starter"，实际是 ${JSON.stringify(index.kind)}`)

/* 4. 卷宗：不许写 audio、听力要有原文、答案数要齐 */
for (const meta of index.papers || []) {
  const file = path.join(DIR, 'papers', `${meta.id}.json`)
  if (!fs.existsSync(file)) {
    fail(`index 里声明了 ${meta.id}，但 starter/papers/${meta.id}.json 不存在`)
    continue
  }
  const p = read(file)
  const ls = p.listening || {}
  if (ls.audio) fail(`${meta.id} 的 listening.audio 不为空（${ls.audio}）：示例卷不该指向任何录音`)
  if (!ls.synth) fail(`${meta.id} 的 listening.synth 不为 true：示例卷要靠语音合成朗读`)
  const passages = ls.passages || []
  const qs = passages.flatMap((x) => x.questions || [])
  const noText = passages.filter((x) => !x.text).length
  if (noText) fail(`${meta.id} 有 ${noText} 篇听力没有原文（语音合成得靠原文朗读）`)
  const noAns = qs.filter((q) => !q.answer).length
  if (noAns) fail(`${meta.id} 有 ${noAns} 道听力题缺答案`)
  for (const key of ['cloze', 'matching', 'reading', 'translation', 'writing']) {
    if (!p[key] || (Array.isArray(p[key]) && !p[key].length)) fail(`${meta.id} 缺 ${key}`)
  }
}

/* 5. 词表条数与 index.json 声明一致 */
for (const [size, meta] of Object.entries(index.vocab || {})) {
  const file = path.join(DIR, `vocab-${size}.json`)
  if (!fs.existsSync(file)) {
    fail(`index.vocab 声明了 ${size}，但 starter/vocab-${size}.json 不存在`)
    continue
  }
  const list = read(file)
  if (list.length !== meta.total) fail(`vocab-${size}.json 有 ${list.length} 条，index.json 却写 ${meta.total}`)
  const units = Math.ceil(list.length / (meta.unitSize || 100))
  if (units !== meta.units) fail(`vocab-${size}.json 应分 ${units} 单元，index.json 却写 ${meta.units}`)
  const bad = list.filter((w) => !w.w || !w.def || !w.ph || !w.ex || !w.exCn).length
  if (bad) fail(`vocab-${size}.json 有 ${bad} 条缺字段（w/def/ph/ex/exCn 必须齐全）`)
}

if (process.exitCode) {
  console.error('\n内置示例题库没通过检查，先修好再发布。')
} else {
  console.log(`内置示例题库检查通过：${files.length} 个文件，无音频；${(index.papers || []).length} 套原创卷。`)
}
