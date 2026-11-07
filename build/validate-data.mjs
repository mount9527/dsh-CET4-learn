/**
 * 题库体检：构建后跑一遍，把“看不出来但一定会坑使用者”的数据问题挡在发布前。
 *   node build/validate-data.mjs        # 有问题时 exit 1
 * 只读题库目录，不改任何文件。目录规则与宿主一致（CET4_DATA > ~/.dsh/dsh-cet4/data > 插件内 data/）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDataDir } from '../lib/data-dir.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_INFO = resolveDataDir()
const DATA = DATA_INFO.dir
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

const errors = []
const warns = []
const fail = (m) => errors.push(m)
const warn = (m) => warns.push(m)

const expect = (label, file) => {
  if (!fs.existsSync(file)) {
    fail(`缺 ${label}（${path.relative(ROOT, file)}）`)
    return null
  }
  return read(file)
}

/* ── 词表 ── */
const v1500 = expect('核心词表', path.join(DATA, 'vocab-1500.json'))
const vFull = expect('大纲词表', path.join(DATA, 'vocab-4500.json')) || expect('大纲词表', path.join(DATA, 'vocab-3600.json'))

for (const [label, list, min] of [
  ['核心 1500', v1500, 1400],
  ['大纲词表', vFull, 3000],
]) {
  if (!list) continue
  if (list.length < min) fail(`${label} 只有 ${list.length} 条（少于 ${min}）`)
  const bad = list.filter((w) => !w.w || !w.def)
  if (bad.length) fail(`${label} 有 ${bad.length} 条缺词或释义`)
  const noEx = list.filter((w) => !w.ex).length
  if (noEx > list.length * 0.1) warn(`${label} 有 ${noEx} 条没有例句`)
  const dup = list.length - new Set(list.map((w) => w.w.toLowerCase())).size
  if (dup) warn(`${label} 有 ${dup} 个重复词`)
}

/* ── 索引 ── */
const index = expect('索引', path.join(DATA, 'index.json'))
const media = expect('音轨索引', path.join(DATA, 'media.json'))
const papers = index?.papers || []
if (papers.length < 1) fail('index.json 里没有卷宗')

const FORBIDDEN = ['explain', 'explanation', 'analysis', 'ref', 'reference', 'model', 'modelCn', 'sample']
const deepCheck = (obj, where, depth = 0) => {
  if (!obj || depth > 6 || typeof obj !== 'object') return
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN.includes(k)) fail(`${where} 出现了不该有的字段 ${k}（题库只收答案，不收解析/范文/参考译文）`)
    if (v && typeof v === 'object') deepCheck(v, where, depth + 1)
  }
}

/**
 * 选项里混进“下一段的说明文字”是 PDF 抽文本时最隐蔽的坑：
 * 卷面看起来正常，点进去才发现 D 选项尾巴上挂着 “Questions 3 and 4 are based on…”。
 * 这类污染一律按错误处理。
 */
const POLLUTED =
  /Questions?\s+\d+\s*(?:to|and|[-–])\s*\d+|(?:are|is)\s+based\s+on|Directions\s*:|Section\s+[A-C]\s*$|Part\s+[IVX]+\b/
const optionIssues = (where, n, options, maxLen) => {
  const keys = Object.keys(options || {})
  if (keys.length !== 4) fail(`${where} 第 ${n} 题选项 ${keys.length} 个（应为 4）`)
  for (const [k, v] of Object.entries(options || {})) {
    if (!v || !String(v).trim()) fail(`${where} 第 ${n} 题选项 ${k} 为空`)
    else if (POLLUTED.test(v)) fail(`${where} 第 ${n} 题选项 ${k} 混入了说明文字：${String(v).slice(-60)}`)
    else if (/^[A-D][.、]/.test(v)) fail(`${where} 第 ${n} 题选项 ${k} 带着选项标签：${String(v).slice(0, 40)}`)
    else if (String(v).length > maxLen) warn(`${where} 第 ${n} 题选项 ${k} 偏长（${String(v).length} 字）`)
  }
}

/* ── 卷宗 ── */
const seenAudio = new Set()
for (const meta of papers) {
  const p = expect(`卷宗 ${meta.id}`, path.join(DATA, 'papers', `${meta.id}.json`))
  if (!p) continue
  const where = p.id
  deepCheck(p, where)

  const ans = p.answers || {}
  const count = (o) => Object.keys(o || {}).length
  if (count(ans.reading) !== 10) fail(`${where} 仔细阅读答案 ${count(ans.reading)} 个（应为 10）`)
  if (count(ans.matching) !== 10) fail(`${where} 长篇阅读答案 ${count(ans.matching)} 个（应为 10）`)
  if (count(ans.cloze) !== 10) fail(`${where} 选词填空答案 ${count(ans.cloze)} 个（应为 10）`)
  if (count(ans.clozeWords) !== 10) warn(`${where} 选词填空原词 ${count(ans.clozeWords)} 个（应为 10）`)

  if (!p.cloze) fail(`${where} 缺选词填空`)
  else {
    if (p.cloze.bank.length !== 15) fail(`${where} 选词词库 ${p.cloze.bank.length} 个（应为 15）`)
    const blanks = (p.cloze.passage.match(/\{\{\d+\}\}/g) || []).length
    if (blanks !== 10) fail(`${where} 选词填空空位 ${blanks} 个（应为 10）`)
    for (const n of Object.keys(ans.cloze || {})) {
      const letter = ans.cloze[n]
      if (!p.cloze.bank.some((b) => b.letter === letter)) fail(`${where} 第 ${n} 空答案字母 ${letter} 不在词库里`)
    }
  }

  if (!p.matching?.statements?.length) fail(`${where} 缺长篇阅读`)
  else {
    const labels = new Set(p.matching.paragraphs.map((x) => x.label))
    for (const s of p.matching.statements) {
      if (!labels.has(s.answer)) fail(`${where} 长篇阅读第 ${s.n} 题答案 ${s.answer} 指向不存在的段落`)
    }
  }

  if (!p.reading?.length) fail(`${where} 缺仔细阅读`)
  else {
    if (p.reading.length !== 2) warn(`${where} 仔细阅读 ${p.reading.length} 篇（通常 2 篇）`)
    for (const ps of p.reading) {
      for (const q of ps.questions) {
        if (!q.answer) fail(`${where} 仔细阅读第 ${q.n} 题缺答案`)
        if (!q.stem) fail(`${where} 仔细阅读第 ${q.n} 题缺题干`)
        optionIssues(where + ' 仔细阅读', q.n, q.options, 220)
      }
    }
  }

  const ls = p.listening
  if (!ls?.passages?.length) fail(`${where} 缺听力`)
  else {
    if (ls.passages.length !== 8) fail(`${where} 听力 ${ls.passages.length} 篇（应为 8）`)
    const qs = ls.passages.flatMap((x) => x.questions)
    if (qs.length !== 25) fail(`${where} 听力 ${qs.length} 题（应为 25）`)
    for (const q of qs) {
      if (!q.answer) fail(`${where} 听力第 ${q.n} 题缺答案`)
      optionIssues(where + ' 听力', q.n, q.options, 160)
      if (q.stem && POLLUTED.test(q.stem)) warn(`${where} 听力第 ${q.n} 题题干偏长或混入说明：${q.stem.slice(0, 50)}`)
    }
    if (ls.audio) {
      if (!ls.track) fail(`${where} 有音频却没有音轨 id`)
      else if (!media?.tracks?.[ls.track]) fail(`${where} 音轨 ${ls.track} 不在 media.json 里`)
      else seenAudio.add(ls.track)
    }
    const noStem = qs.filter((q) => !q.stem).length
    if (noStem === qs.length && ls.verified) warn(`${where} 听力题都没有题干（原文里应能取到）`)
  }

  if (!p.translation?.cn) fail(`${where} 缺翻译原文`)
  if (!p.writing?.prompt) fail(`${where} 缺作文题目`)
}

/* ── 索引里的音频口径要和卷宗对得上 ── */
if (index?.audio) {
  const sets = papers.filter((p) => p.hasAudio).length
  const borrowed = papers.filter((p) => p.audioCopiedFrom).length
  const assumed = papers.filter((p) => p.hasAudio && !p.audioVerified).length
  const transcribed = papers.filter((p) => p.hasTranscript).length
  if (index.audio.sets !== sets) fail(`index.audio.sets=${index.audio.sets}，卷宗里可听的是 ${sets} 套`)
  if (index.audio.borrowed !== borrowed) fail(`index.audio.borrowed=${index.audio.borrowed}，实际沿用 ${borrowed} 套`)
  if (index.audio.assumed !== assumed) fail(`index.audio.assumed=${index.audio.assumed}，实际推定 ${assumed} 套`)
  if (index.audio.transcribed !== transcribed) fail(`index.audio.transcribed=${index.audio.transcribed}，实际带原文 ${transcribed} 套`)
  if (index.audio.sets > papers.length) fail('可听套数超过卷宗总数')
  if (index.audio.files > index.audio.sets) warn(`录音文件数 ${index.audio.files} 多于可听套数 ${index.audio.sets}`)
  const noStemSets = papers.filter((p) => p.hasAudio && !p.hasTranscript).length
  if (noStemSets) warn(`${noStemSets} 套没有听力原文，题干只能靠听（前端会显示“题干在录音里”）`)
}

/* ── 录音是否真的在资料目录里 ── */
if (media?.tracks) {
  const root = process.env.CET4_SRC || media.root
  if (!root || !fs.existsSync(root)) warn(`资料目录不可用（${root || '未设置'}），跳过录音文件检查`)
  else {
    for (const [id, t] of Object.entries(media.tracks)) {
      if (!seenAudio.has(id)) warn(`音轨 ${id} 没有被任何卷宗引用`)
      const abs = path.resolve(root, t.file)
      if (!fs.existsSync(abs)) fail(`音轨 ${id} 指向的文件不存在：${t.file}`)
    }
  }
}

/* ── 输出 ── */
if (warns.length) {
  console.log(`提示 ${warns.length} 条：`)
  for (const w of warns) console.log('  - ' + w)
}
if (errors.length) {
  console.log(`\n有 ${errors.length} 个问题：`)
  for (const e of errors) console.log('  ✗ ' + e)
  process.exit(1)
}
console.log(
  `\n题库体检通过（${DATA_INFO.source === 'plugin' ? '插件内 data/' : DATA}）：${papers.length} 套卷、${
    v1500?.length ?? 0
  } + ${vFull?.length ?? 0} 词、${seenAudio.size} 份录音。`
)
