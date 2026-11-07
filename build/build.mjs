/**
 * CET-4 题库构建脚本
 * ---------------------------------------------------------------------------
 * 输入 = 使用者自己准备的资料目录（--src 指定，默认 ./CET-4）：
 *   01 真题试卷（2023.6 - 2026.6）/<年>年<月>月/第N套/*.pdf
 *   02 答案（不含解析）/四级真题答案总表*.csv
 *   03 听力原文（录音转写）/YYYY年M月第N套_听力原文.txt
 *   04 词汇/四级核心词汇1500*.csv、四级大纲词汇4500*.csv
 *   05 听力音频/四级YYYY年M月第N套听力音频.aac
 *
 * 输出（插件运行时读的就是这些，且不进发布包；默认写 ~/.dsh/dsh-cet4/data）：
 *   index.json              卷宗与词表索引
 *   papers/<id>.json        每套卷：听力（含音频分段与原文）、选词、长篇、阅读、翻译、作文、答案
 *   vocab-1500.json         核心词表
 *   vocab-4500.json         大纲词表
 *   media.json              音轨 → 源文件相对路径（供宿主按 Range 推流）
 *   build-report.json       构建问题清单
 *
 * 原则：只收「题目 + 答案」。不生成解析、不收录参考译文与范文——答案册里没有的，
 * 这里也不臆造，避免把错误内容当标准答案发给使用者。
 *
 * 用法：
 *   node build/build.mjs --src "D:/CET-4"          # 指定资料目录
 *   node build/build.mjs --out ./data              # 指定输出目录（默认用户目录）
 *   node build/build.mjs --tracks ./tracks.json    # 指定听力分段表
 *   CET4_SRC=... node build/build.mjs --force      # 强制重抽 PDF 文本
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cacheDir, defaultDataDir } from '../lib/data-dir.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argSrc = (() => {
  const i = process.argv.indexOf('--src')
  return i > -1 ? process.argv[i + 1] : ''
})()
const argOut = (() => {
  const i = process.argv.indexOf('--out')
  return i > -1 ? process.argv[i + 1] : ''
})()
const argTracks = (() => {
  const i = process.argv.indexOf('--tracks')
  return i > -1 ? process.argv[i + 1] : ''
})()

/** 资料目录：--src > CET4_SRC > 当前目录下的 CET-4（都没有就报错，不再猜作者的机器路径） */
const SRC = path.resolve(argSrc || process.env.CET4_SRC || path.join(process.cwd(), 'CET-4'))
const OUT = argOut ? path.resolve(argOut) : defaultDataDir()
const CACHE = path.join(cacheDir(), 'extract')
const FORCE = process.argv.includes('--force') || process.argv.includes('-f')

/** PDF 抽取器：CET4_PDF_CLI > PATH 里的 workbuddy-pdf > 相对本仓库的常见位置 */
const PDF_CLI_CANDIDATES = [
  process.env.CET4_PDF_CLI,
  'workbuddy-pdf',
  path.join(ROOT, '..', '.workbuddy', 'external-packages', 'pdf-cli', 'workbuddy-pdf.exe'),
].filter(Boolean)

/** 只查存在性、不执行：用来在构建开头提示「这台机器根本没有 PDF 抽取器」 */
function cliExists(cli) {
  if (/[\\/]/.test(cli)) return fs.existsSync(cli)
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((d) => ['', '.exe', '.cmd', '.bat', '.ps1'].some((ext) => fs.existsSync(path.join(d, cli + ext))))
}

const report = {
  generatedAt: new Date().toISOString(),
  source: SRC,
  output: OUT,
  stats: {},
  notes: [],
  warnings: [],
  problems: [],
}
const problem = (scope, msg, extra) => report.problems.push({ scope, msg, ...(extra ? { extra } : {}) })
const warn = (scope, msg, extra) => report.warnings.push({ scope, msg, ...(extra ? { extra } : {}) })

const answerRecord = (a) => ({
  listening: a.listening,
  cloze: a.cloze,
  clozeWords: a.clozeWords,
  matching: a.matching,
  reading: a.reading,
})

/* ────────────────────────── 通用工具 ────────────────────────── */

const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/
const hasCJK = (s) => CJK.test(s)
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const pad2 = (n) => String(n).padStart(2, '0')

/* ────────────────────────── 音频时长 ────────────────────────── */

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

/**
 * 数 ADTS 帧算 AAC 时长：每帧固定 1024 个采样，采样率写在帧头里。
 * 不用 ffprobe、不用解码，读一遍文件即可；读不出来返回 null（调用方跳过校验）。
 */
function aacDuration(file) {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    return null
  }
  let off = 0
  let frames = 0
  let rate = 0
  while (off + 7 <= buf.length) {
    if (buf[off] !== 0xff || (buf[off + 1] & 0xf0) !== 0xf0) {
      off++ // 没对齐就往后找同步字
      continue
    }
    const srIndex = (buf[off + 2] >> 2) & 0x0f
    const frameLen = ((buf[off + 3] & 0x03) << 11) | (buf[off + 4] << 3) | ((buf[off + 5] & 0xe0) >> 5)
    if (frameLen < 7 || off + frameLen > buf.length) {
      off++
      continue
    }
    if (!rate && AAC_RATES[srIndex]) rate = AAC_RATES[srIndex]
    frames++
    off += frameLen
  }
  if (!rate || !frames) return null
  return (frames * 1024) / rate
}

/** 在资料目录里按前缀（01/02/…）找子目录，允许文件夹名字被使用者改过 */
function findDir(prefix, base = SRC) {
  let names = []
  try {
    names = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return ''
  }
  const hit = names.find((n) => n.startsWith(prefix)) || names.find((n) => new RegExp(`(^|[^0-9])${prefix}([^0-9]|$)`).test(n))
  return hit ? path.join(base, hit) : ''
}

/** 听力分段表：--tracks > CET4_TRACKS > 资料目录 > 05 音频目录 > 题库目录的上一级（用户私有，不进包） */
function resolveTracksFile(dir05) {
  const cands = [
    argTracks ? path.resolve(argTracks) : '',
    process.env.CET4_TRACKS ? path.resolve(process.env.CET4_TRACKS) : '',
    path.join(SRC, 'audio-tracks.json'),
    dir05 ? path.join(dir05, 'audio-tracks.json') : '',
    path.join(path.dirname(OUT), 'audio-tracks.json'),
  ].filter(Boolean)
  for (const f of cands) {
    try {
      if (fs.statSync(f).isFile()) return f
    } catch {
      /* 继续找下一个 */
    }
  }
  return ''
}

function walk(dir, out = []) {
  if (!dir || !fs.existsSync(dir)) return out
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** PDF → 文本；优先 md-plain（段落结构完好），结果缓存在 .cache 里 */
function readText(pdfPath, fmt = 'md-plain') {
  const base = path.basename(pdfPath, '.pdf')
  const key = `${base}.${fmt === 'md-plain' ? 'md' : 'txt'}`
  const cached = path.join(CACHE, key)
  const sidecar = path.join(path.dirname(pdfPath), `${base}.txt`)
  if (!FORCE && fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8')
  if (fs.existsSync(sidecar)) return fs.readFileSync(sidecar, 'utf8')
  for (const cli of PDF_CLI_CANDIDATES) {
    try {
      fs.mkdirSync(CACHE, { recursive: true })
      execFileSync(cli, [pdfPath, cached, '--format', fmt], { stdio: 'pipe' })
      if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8')
    } catch {
      /* 换下一个候选 */
    }
  }
  throw new Error(`无法提取 PDF 文本：${base}（缺 workbuddy-pdf，且旁边没有同名 .txt）`)
}

/* ────────────────────────── PDF 分块 ────────────────────────── */

/** 明显是新块的开头（用于判断换页处该不该合并段落） */
const NEW_BLOCK =
  /^(Section\s+[A-Z]|Part\s+[IVX]+|Passage\s+(One|Two|Three)|Questions?\s+\d|Directions\s*:|[A-O][.、]\s|\d{1,2}[.、]\s|第[一二三]套|听力$|选词$|长篇$|仔细$|段落翻译|短文写作|首句|译文|题目)/
/** 标题类结构行：自身独立成块，且其后另起新块 */
const HEADING =
  /^(Part\s+[IVX]+\b|Section\s+[A-C]\s*$|Passage\s+(One|Two|Three)\s*$|Questions?\s+\d+\s*(?:to|and|-|–)\s*\d+|Directions\s*:|听力$|选词$|长篇$|仔细$|段落翻译|短文写作|第[一二三]套)/
/** 带标签的行：选项、段落信、小题号 → 每条独立成块（长篇阅读的段落标号会印到 P） */
const LABELLED = /^([A-Z]|\d{1,2})[.、]\s*[A-Za-z"“(\[]/

/**
 * 把 PDF 逐行文本变成“块”（段落）数组。
 * - 去掉页眉页脚；页脚夹在行中间说明是折行断点，合并回上一行
 * - 标题行（Part / Section / Passage / Directions / 选项 / 题号）强制断块
 */
function toBlocks(text) {
  const raw = text.split(/\r?\n/)
  const blocks = []
  let cur = []
  let joinNext = false
  let DIRECTION_ABSORB = false
  const flush = () => {
    if (cur.length) blocks.push(cur.join(' ').replace(/\s+/g, ' ').trim())
    cur = []
  }
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i].trim()
    // 页眉页脚可能和正文粘在同一行（"...2 https://example.com/... A. affordable"）
    const pmInline = line.match(/^\d{1,3}\s+https?:\/\/\S+\s*/)
    if (pmInline) {
      line = line.slice(pmInline[0].length).trim()
      if (!line) {
        const prevBlank = i === 0 || raw[i - 1].trim() === ''
        joinNext = !prevBlank
        continue
      }
    }
    if (line === '') {
      flush()
      DIRECTION_ABSORB = false
      continue
    }
    if (joinNext) {
      joinNext = false
      if (!HEADING.test(line) && !LABELLED.test(line) && cur.length) {
        cur[cur.length - 1] += ` ${line}`
        continue
      }
    }
    if (/^Directions\s*:/.test(line)) {
      // Directions 会折行，后续续行仍属于它，必须整块吃掉
      flush()
      cur.push(line)
      DIRECTION_ABSORB = true
      continue
    }
    if (DIRECTION_ABSORB) {
      if (HEADING.test(line) || LABELLED.test(line) || hasCJK(line)) {
        DIRECTION_ABSORB = false
        flush()
      } else {
        cur.push(line)
        continue
      }
    }
    if (HEADING.test(line)) {
      flush()
      blocks.push(line.replace(/\s+/g, ' ').trim())
      continue
    }
    if (LABELLED.test(line)) {
      flush()
      cur.push(line)
      continue
    }
    cur.push(line)
  }
  flush()
  return blocks.filter(Boolean)
}

/* ────────────────────────── 真题解析 ────────────────────────── */

function sectionSlice(blocks, startRe, endRe) {
  const s = blocks.findIndex((b) => startRe.test(b))
  if (s === -1) return null
  let e = blocks.length
  for (let i = s + 1; i < blocks.length; i++) {
    if (endRe.test(blocks[i])) {
      e = i
      break
    }
  }
  return blocks.slice(s, e)
}

/** 把一段文本按 “字母/数字. ” 前缀切成若干条（用于选项、小题、段落标签） */
function splitLabelled(text, labelRe) {
  const out = []
  const re = new RegExp(labelRe.source, 'g')
  const marks = []
  let m
  while ((m = re.exec(text))) marks.push({ idx: m.index, label: m[1], cap: m[0] })
  if (!marks.length) return []
  for (let i = 0; i < marks.length; i++) {
    const seg = text.slice(marks[i].idx + marks[i].cap.length, i + 1 < marks.length ? marks[i + 1].idx : undefined)
    out.push({ label: marks[i].label, text: squash(seg) })
  }
  return out
}

/** Directions 整段丢掉；若它与选词正文粘在一起，保留尾巴 */
function stripDirections(blocks) {
  return blocks
    .map((b) => {
      if (!/^Directions\s*:/.test(b)) return b
      const cut = b.indexOf('more than once.')
      return cut > -1 ? b.slice(cut + 'more than once.'.length).trim() : ''
    })
    .filter(Boolean)
}

/** 把一段文本里挤在一起的选项拆出来（"3. A. x B. y C. z D. w"）*/
function parseInlineOptions(text, into) {
  const first = text.search(/(?:^|\s)A[.、]\s*/)
  if (first === -1) return { stemPart: text, found: false }
  for (const p of splitLabelled(text.slice(first), /(?:^|\s)([A-D])[.、]\s*/)) {
    if (!into[p.label]) into[p.label] = squash(p.text)
  }
  return { stemPart: text.slice(0, first), found: true }
}

function parseCloze(blocks) {
  let bankStart = -1
  for (let i = 0; i < blocks.length; i++) {
    if (/^A[.、]\s*[A-Za-z][A-Za-z'’\-]*\.?$/.test(blocks[i].trim())) {
      bankStart = i
      break
    }
  }
  if (bankStart === -1) return null
  const passage = blocks.slice(0, bankStart).join('\n\n')
  const bankText = blocks.slice(bankStart).join(' ')
  const bank = splitLabelled(bankText, /(?:^|\s)([A-O])[.、]\s*/).map((p) => ({
    letter: p.label,
    word: squash(p.text).replace(/[.,;]+$/, ''),
  }))
  if (bank.length !== 15) problem('cloze', `词库 ${bank.length} 个词（应为 15）`)
  const blanks = (passage.match(/\b(2[6-9]|3[0-5])\b/g) || []).length
  if (blanks !== 10) problem('cloze', `空位 ${blanks} 个（应为 10）`)
  const cut = passage.indexOf('more than once.')
  const cleanPassage = cut > -1 && cut < 900 ? passage.slice(cut + 'more than once.'.length) : passage
  return {
    passage: cleanPassage.trim().replace(/\s*\b(2[6-9]|3[0-5])\b\s*/g, ' {{$1}} ').replace(/\s+/g, ' ').trim(),
    bank,
  }
}

function parseMatching(blocks) {
  let title = ''
  const paragraphs = []
  const statements = []
  for (const b of blocks) {
    const t = b.trim()
    const pm = t.match(/^([A-Z])[.、]\s*([\s\S]+)$/)
    const sm = t.match(/^(3[6-9]|4[0-5])[.、]\s*([\s\S]+)$/)
    if (sm) {
      const items = splitLabelled(t, /(?:^|\s)(3[6-9]|4[0-5])[.、]\s*/)
      if (items.length) for (const it of items) statements.push({ n: Number(it.label), text: squash(it.text) })
      else statements.push({ n: Number(sm[1]), text: squash(sm[2]) })
      continue
    }
    if (pm) {
      paragraphs.push({ label: pm[1], text: squash(pm[2]) })
      continue
    }
    if (!paragraphs.length && !statements.length) title = squash(t)
  }
  const seenN = new Set()
  for (let i = statements.length - 1; i >= 0; i--) {
    if (seenN.has(statements[i].n)) statements.splice(i, 1)
    else seenN.add(statements[i].n)
  }
  statements.sort((a, b) => a.n - b.n)
  if (paragraphs.length < 8) problem('matching', `段落 ${paragraphs.length} 个（偏少）`)
  if (statements.length !== 10) problem('matching', `题干 ${statements.length} 条（应为 10）`)
  return { title, paragraphs, statements }
}

function parseReading(blocks) {
  const passages = []
  let cur = null
  let q = null
  let mode = 'before'

  for (const b of blocks) {
    const t = b.trim()
    const pm = t.match(/^Passage\s+(One|Two|Three)\s*$/i)
    if (pm) {
      cur = { title: `Passage ${pm[1]}`, paragraphs: [], questions: [] }
      passages.push(cur)
      mode = 'passage'
      q = null
      continue
    }
    if (!cur) continue
    const qm = t.match(/^Questions?\s+(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})/)
    if (qm) {
      cur.range = [Number(qm[1]), Number(qm[2])]
      mode = 'passage'
      continue
    }
    const qnum = t.match(/^(\d{2})[.、]\s*([\s\S]*)$/)
    if (qnum && Number(qnum[1]) >= 40) {
      const rest = squash(qnum[2])
      const options = {}
      const { stemPart } = parseInlineOptions(rest, options)
      q = { n: Number(qnum[1]), stem: squash(stemPart), options }
      cur.questions.push(q)
      mode = 'questions'
      continue
    }
    if (mode === 'questions' && q) {
      const opt = t.match(/^([A-D])[.、]\s*([\s\S]*)$/)
      if (opt) {
        q.options[opt[1]] = squash(opt[2])
        const inline = splitLabelled(t, /(?:^|\s)([A-D])[.、]\s*/)
        if (inline.length > 1) {
          for (const p of inline) if (q.options[p.label] === undefined) q.options[p.label] = squash(p.text)
        }
        continue
      }
      const keys = Object.keys(q.options)
      const last = keys[keys.length - 1]
      if (last && !/[.!?。？！]\s*$/.test(q.options[last])) q.options[last] = squash(`${q.options[last]} ${t}`)
      else if (!keys.length) q.stem = squash(`${q.stem} ${t}`)
      continue
    }
    if (mode === 'passage') cur.paragraphs.push(squash(t))
  }
  for (const p of passages) {
    p.text = p.paragraphs.join('\n\n')
    for (const q of p.questions) {
      const n = Object.keys(q.options).length
      if (n !== 4) problem('reading', `${p.title} 第 ${q.n} 题选项 ${n} 个`)
      if (!q.stem) problem('reading', `${p.title} 第 ${q.n} 题缺题干`)
    }
    if (p.questions.length !== 5) problem('reading', `${p.title} 小题 ${p.questions.length} 个（应为 5）`)
  }
  return passages
}

const LISTEN_LABEL = { A: '新闻', B: '长对话', C: '篇章' }

/** 听力题目（真题 PDF 里只有选项，题干在音频里） */
function parseListening(blocks) {
  const sections = []
  let cur = null
  let q = null
  for (const b of blocks) {
    const t = b.trim()
    const sm = t.match(/^Section\s+([A-C])\s*$/)
    if (sm) {
      cur = { key: sm[1], label: LISTEN_LABEL[sm[1]], questions: [] }
      sections.push(cur)
      q = null
      continue
    }
    if (!cur) continue
    if (/^Directions\s*:/.test(t)) continue
    if (/^Questions?\s+\d+\s*(?:and|to|-|–)\s*\d+\s*(?:are|is)\s+based on/i.test(t)) continue
    const qm = t.match(/^(\d{1,2})[.、]\s*([\s\S]*)$/)
    if (qm && Number(qm[1]) >= 1 && Number(qm[1]) <= 25) {
      const options = {}
      const { stemPart } = parseInlineOptions(squash(qm[2]), options)
      q = { n: Number(qm[1]), stem: squash(stemPart), options }
      cur.questions.push(q)
      continue
    }
    if (!q) continue
    const opt = t.match(/^([A-D])[.、]\s*([\s\S]*)$/)
    if (opt) {
      if (!q.options[opt[1]]) q.options[opt[1]] = squash(opt[2])
      const inline = splitLabelled(t, /(?:^|\s)([A-D])[.、]\s*/)
      if (inline.length > 1) for (const p of inline) if (!q.options[p.label]) q.options[p.label] = squash(p.text)
      continue
    }
    const keys = Object.keys(q.options)
    const last = keys[keys.length - 1]
    if (last && !/[.!?。？！]\s*$/.test(q.options[last])) q.options[last] = squash(`${q.options[last]} ${t}`)
    else if (!keys.length) q.stem = squash(`${q.stem} ${t}`)
  }
  const questions = sections.flatMap((s) => s.questions)
  if (!questions.length) return null // 第 3 套常只留一句“本套未重复显示”
  if (questions.length !== 25) problem('listening', `听力题 ${questions.length} 道（应为 25）`)
  for (const s of sections) {
    const missing = s.questions.filter((x) => Object.keys(x.options).length !== 4)
    if (missing.length) problem('listening', `Section ${s.key} 有 ${missing.length} 题选项不全`)
  }
  return questions.length ? questions : null
}

const MONTHS = new Set([5, 6, 11, 12])

/** 从路径/文件名里取考期与套号（新旧两套命名都认） */
function paperKeyOf(p) {
  const name = path.basename(p, '.pdf')
  const m = name.match(/(\d{4})\s*年\s*(\d{1,2})\s*月.*?第\s*([1-3])\s*套/)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (!MONTHS.has(month)) problem('paper', `月份异常 ${month}：${name}`)
  return { year, month, set: Number(m[3]), id: `${year}-${pad2(month)}-s${m[3]}` }
}

function parsePaper(file) {
  const key = paperKeyOf(file)
  if (!key) {
    problem('paper', `文件名没解析出年份/月份/套号：${path.basename(file)}`)
    return null
  }
  // 真题用 txt 抽取（每行一段，`toBlocks` 靠行尾与空行判断段落）；md-plain 会把段落揉成一行
  const blocks = toBlocks(readText(file, 'txt'))

  const rIdx = blocks.findIndex((b) => /^Part\s+III\s+Reading/i.test(b))
  const tIdx = blocks.findIndex((b) => /^Part\s+IV\s+Translation/i.test(b))
  const rBlocks = rIdx === -1 ? [] : blocks.slice(rIdx, tIdx === -1 ? undefined : tIdx)

  const listIdx = blocks.findIndex((b) => /^Part\s+II\s+Listening/i.test(b))
  const listening = listIdx === -1 ? null : parseListening(blocks.slice(listIdx + 1, rIdx === -1 ? undefined : rIdx))

  /* 第 3 套常常不重复印听力，只留一句“本套听力与第 X 套相同” */
  let listenFrom = null
  if (!listening) {
    const note = blocks.find((b) => /本套未重复显示|听力内容与/.test(b))
    if (note) {
      const m = note.match(/与第\s*([一二三])/)
      listenFrom = m ? { 一: 1, 二: 2, 三: 3 }[m[1]] : 1
    }
  }

  const secA = sectionSlice(rBlocks, /^Section\s+A\s*$/, /^Section\s+B\s*$/)
  const secB = sectionSlice(rBlocks, /^Section\s+B\s*$/, /^Section\s+C\s*$/)
  const secC = sectionSlice(rBlocks, /^Section\s+C\s*$/, /^Part\s+IV/)

  const cloze = secA ? parseCloze(stripDirections(secA.slice(1))) : null
  const matching = secB ? parseMatching(secB.slice(1).filter((b) => !/^Directions\s*:/.test(b))) : null
  const reading = secC ? parseReading(secC.slice(1).filter((b) => !/^Directions\s*:/.test(b))) : null

  let translationCn = ''
  if (tIdx !== -1) translationCn = blocks.slice(tIdx + 1).filter((b) => !/^Directions\s*:/.test(b)).join('\n').trim()

  const wIdx = blocks.findIndex((b) => /^Part\s+I\s+Writing/i.test(b))
  let writing = null
  if (wIdx !== -1) {
    const dir = blocks.slice(wIdx + 1, wIdx + 4).find((b) => /^Directions\s*:/.test(b))
    if (dir) {
      const body = squash(dir.replace(/^Directions\s*:\s*/, ''))
        .replace(/\s*You (will|should) (have|write).*$/i, '')
        .replace(/\s*You are (now )?to write an essay for submission\.?/i, '')
        .replace(/\s*You should write at least \d+ words.*$/i, '')
        .trim()
      if (body) writing = { prompt: body }
    }
  }

  for (const [k, v] of Object.entries({
    cloze,
    matching,
    reading: reading?.length ? reading : null,
    translationCn: translationCn || null,
    writing,
  })) {
    if (!v) problem(key.id, `缺 ${k}`)
  }

  return {
    ...key,
    title: `${key.year}年${key.month}月 第${key.set}套`,
    sourceFile: path.basename(file),
    listeningQuestions: listening,
    listenFrom,
    cloze,
    matching,
    reading,
    translation: translationCn ? { cn: translationCn } : null,
    writing,
  }
}

/* ────────────────────────── CSV / 词表 ────────────────────────── */

/** 极简 CSV 解析（支持双引号包裹、引号内换行与逗号） */
function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''))
}

const POS_LINE = /^(?:n|vt|vi|v|adj|adv|prep|conj|pron|num|art|int|interj|aux|pl|a)(?:\s*&\s*(?:n|vt|vi|v|adj|adv|prep|conj|pron|num|art|int|interj|aux|pl|a)\b\.?)?\s*[.&]/
const posOf = (def) => {
  const m = String(def || '').match(POS_LINE)
  return m ? m[0].replace(/[.&\s]+$/, '').toLowerCase() : ''
}

/** 「词性与释义」一列里塞了释义 + 例句 + 例句译文，这里拆开 */
function splitDefCell(raw) {
  let s = squash(raw)
  // 排版残留：句尾被塞进页脚「四级核心词汇 1500 6」
  s = s.replace(/\s*四级(?:核心)?词汇\s*(?:1500|4500)?\s*\d{0,4}\s*$/, '').trim()
  let def = s
  let ex = ''
  let exCn = ''
  const head = s.match(/^(.*?[\u4e00-\u9fff）】」’”…\)])\s+((?:\.{2,}|…)?\s*[\dA-Za-z][\s\S]*)$/)
  if (head) {
    def = head[1].trim()
    const rest = head[2].trim()
    // 例句后面跟中文译文；有的例句不以句号结尾（"the ancient civilizations of Asia 亚洲的古代文明"）
    const tail = rest.match(/^([\s\S]*?[A-Za-z.!?…'"”)])\s*([\d\u4e00-\u9fff][\s\S]*)$/)
    if (tail) {
      ex = squash(tail[1])
      exCn = squash(tail[2])
    } else ex = squash(rest)
  }
  // 排版断行留下的省略号不是正文
  const tidy = (x) => squash(x).replace(/\s*…\s*(?=\d)/g, '').replace(/\s*…\s*$/g, '').trim()
  return { def: tidy(def), ex: tidy(ex), exCn: tidy(exCn) }
}

function parseVocabCsv(file, label) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'))
  if (!rows.length) return []
  const header = rows[0].map((h) => squash(h))
  const col = (name) => header.findIndex((h) => h.includes(name))
  const iId = col('序号')
  const iWord = col('单词')
  const iPh = col('音标')
  const iDef = header.findIndex((h) => h.includes('释义'))
  const iStar = col('星级')
  const list = []
  for (const r of rows.slice(1)) {
    const w = squash(r[iWord] ?? '')
    if (!/^[A-Za-z][A-Za-z'’\- ]*$/.test(w)) continue
    const { def, ex, exCn } = splitDefCell(r[iDef] ?? '')
    const stars = (squash(r[iStar] ?? '').match(/★/g) || []).length
    list.push({
      id: Number(squash(r[iId] ?? '')) || list.length + 1,
      w,
      ph: squash(r[iPh] ?? ''),
      stars,
      def: def || '（原表未给释义）',
      pos: posOf(def),
      ex,
      exCn,
      lib: label,
    })
  }
  return list
}

/* ────────────────────────── 答案总表 ────────────────────────── */

function parseAnswerCsv(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'))
  if (!rows.length) return new Map()
  const header = rows[0].map((h) => squash(h))
  const col = (name) => header.findIndex((h) => h.includes(name))
  const iWhen = col('场次')
  const iSet = col('套数')
  const iN = col('题号')
  const iType = col('题型')
  const iAns = header.findIndex((h) => h.includes('答案'))
  const iWord = col('原词')

  const sets = new Map()
  for (const r of rows.slice(1)) {
    const when = squash(r[iWhen] ?? '').match(/(\d{4})\s*年\s*(\d{1,2})\s*月/)
    const setNo = squash(r[iSet] ?? '').match(/([1-3])/)
    const n = Number(squash(r[iN] ?? ''))
    const ans = squash(r[iAns] ?? '').toUpperCase()
    if (!when || !setNo || !n || !/^[A-Z]$/.test(ans)) continue
    const id = `${when[1]}-${pad2(when[2])}-s${setNo[1]}`
    if (!sets.has(id)) sets.set(id, { listening: {}, cloze: {}, clozeWords: {}, matching: {}, reading: {} })
    const rec = sets.get(id)
    const type = squash(r[iType] ?? '')
    if (n <= 25) rec.listening[n] = ans
    else if (n <= 35) {
      rec.cloze[n] = ans
      const w = squash(r[iWord] ?? '')
      if (w) rec.clozeWords[n] = w
    } else if (n <= 45) rec.matching[n] = ans
    else rec.reading[n] = ans
    if (!type) problem('answer', `${id} 第 ${n} 题没写题型`)
  }
  return sets
}

/* ────────────────────────── 听力原文 ────────────────────────── */

const PIECE_SLOTS = [
  { key: 'A1', section: 'A', title: 'News Report One', from: 1, to: 2 },
  { key: 'A2', section: 'A', title: 'News Report Two', from: 3, to: 4 },
  { key: 'A3', section: 'A', title: 'News Report Three', from: 5, to: 7 },
  { key: 'B1', section: 'B', title: 'Conversation One', from: 8, to: 11 },
  { key: 'B2', section: 'B', title: 'Conversation Two', from: 12, to: 15 },
  { key: 'C1', section: 'C', title: 'Passage One', from: 16, to: 18 },
  { key: 'C2', section: 'C', title: 'Passage Two', from: 19, to: 21 },
  { key: 'C3', section: 'C', title: 'Passage Three', from: 22, to: 25 },
]

/** 听力原文 → 8 篇（篇名 / 段落 / 题干） */
function parseTranscript(text) {
  const lines = String(text || '').split(/\r?\n/)
  const passages = []
  let sec = null
  let cur = null
  let buf = []

  const flushPara = () => {
    if (cur && buf.length) {
      cur.paras.push(squash(buf.join(' ')))
      buf = []
    }
  }
  const flushPassage = () => {
    flushPara()
    if (cur) passages.push(cur)
    cur = null
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flushPara()
      continue
    }
    if (/^Section\s+([A-C])\b/.test(line)) {
      flushPassage()
      sec = line.match(/^Section\s+([A-C])/)[1]
      continue
    }
    if (/^Directions\s*:/.test(line)) continue
    if (/^\(据|^大学英语四级|^College English Test|^Questions?\s+\d+\s*(?:and|to|-|–)/i.test(line)) {
      flushPara()
      continue
    }
    const qm = line.match(/^Question\s+(\d{1,2})[.、]\s*(.*)$/)
    if (qm) {
      flushPara()
      if (cur) cur.stems.push({ n: Number(qm[1]), stem: squash(qm[2]) })
      continue
    }
    const pm = line.match(/^(News Report|Conversation|Passage)\s+(One|Two|Three)\s*$/i)
    if (pm) {
      flushPassage()
      cur = { section: sec, title: squash(line), paras: [], stems: [] }
      continue
    }
    if (cur) buf.push(line)
  }
  flushPassage()
  return passages.filter((p) => p.paras.length || p.stems.length)
}

/* ────────────────────────── 音轨归属 ────────────────────────── */

const STOPWORDS = new Set(
  'the a an of to in on for and or but with is are was were be been being that this these those it its as at by from not no you your we our they their he she his her i me my do does did have has had can could will would should may might must more most than then there here what which who whom whose when where why how all any both each few some such only own same so too very just about into over after before between out up down off'.split(
    /\s+/
  )
)
const keywordsOf = (s) =>
  (String(s || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter((w) => !STOPWORDS.has(w))

/** 选项里的英文实词与原文的重合率（0–1），用来判断“这份录音是不是这套卷的听力” */
function overlapScore(transcriptSet, optionsText) {
  const words = new Set(keywordsOf(optionsText))
  if (!words.size) return 0
  let hit = 0
  for (const w of words) if (transcriptSet.has(w)) hit++
  return hit / words.size
}

const optionsSignature = (questions) =>
  (questions || []).map((q) => JSON.stringify(q.options || {})).join('|')

/**
 * 一个考期有 2 份听力录音、3 套卷（其中有整套共用同一份录音的情况）。
 * 录音文件名经常与卷宗套号对不上，所以先用听力原文做内容比对，再用“选项完全相同 = 同一份录音”补齐。
 */
function assignTracks(tracks, papers, transcripts) {
  const groupOf = new Map() // paperId → 选项签名
  const groups = new Map() // 签名 → paperId[]
  for (const p of papers) {
    const sig = optionsSignature(p.listeningQuestions)
    groupOf.set(p.id, sig)
    if (!groups.has(sig)) groups.set(sig, [])
    groups.get(sig).push(p.id)
  }

  const verdict = [] // { trackId, paperId, score }
  const trackToSig = new Map()

  for (const t of tracks) {
    const tr = transcripts.get(t.id) // 与录音同名的原文（第N套）
    if (!tr) continue
    const set = new Set(keywordsOf(tr.text))
    let best = null
    for (const p of papers) {
      const opts = (p.listeningQuestions || []).flatMap((q) => Object.values(q.options || {})).join(' ')
      const score = overlapScore(set, opts)
      if (!best || score > best.score) best = { paperId: p.id, score }
    }
    if (best && best.score >= 0.35) {
      trackToSig.set(t.id, groupOf.get(best.paperId))
      verdict.push({ trackId: t.id, paperId: best.paperId, score: Math.round(best.score * 1000) / 10 })
    } else {
      problem('audio', `音轨 ${t.id} 与同期任何一套的选项都对不上（最高 ${best ? Math.round(best.score * 100) : 0}%），按文件名推定`)
    }
  }

  // 没被原文认领的音轨 / 没被认领的选项组：按顺序配对
  const freeTracks = tracks.filter((t) => !trackToSig.has(t.id))
  const freeSigs = [...groups.keys()].filter((sig) => ![...trackToSig.values()].includes(sig))
  for (const t of freeTracks) {
    if (!freeSigs.length) break
    trackToSig.set(t.id, freeSigs.shift())
    verdict.push({ trackId: t.id, paperId: groups.get(trackToSig.get(t.id))[0], score: null })
  }

  const byPaper = new Map()
  for (const [trackId, sig] of trackToSig) for (const pid of groups.get(sig) || []) byPaper.set(pid, trackId)
  return { byPaper, verdict, groups: [...groups.values()] }
}

/* ────────────────────────── 主流程 ────────────────────────── */

function main() {
  if (!fs.existsSync(SRC)) {
    throw new Error(
      `资料目录不存在：${SRC}\n` +
        `用 --src "D:/你的/CET-4" 指定（目录里应有 01 真题试卷 / 02 答案 / 03 听力原文 / 04 词汇 / 05 听力音频）`
    )
  }
  if (!PDF_CLI_CANDIDATES.some(cliExists)) {
    report.notes.push({
      scope: 'pdf',
      msg:
        '这台机器上没有 PDF 抽取器（workbuddy-pdf）：会改用每份 PDF 旁边的同名 .txt，' +
        '只有 PDF 没有 .txt 的卷会解析失败。可用 CET4_PDF_CLI 指定，或见 README「没有 PDF 抽取器怎么构建」',
    })
  }
  fs.mkdirSync(OUT, { recursive: true })
  const papersDir = path.join(OUT, 'papers')
  fs.rmSync(papersDir, { recursive: true, force: true })
  fs.mkdirSync(papersDir, { recursive: true })
  fs.rmSync(path.join(OUT, 'audio'), { recursive: true, force: true }) // 旧版把音频拷进 data/，已经不需要

  const dir01 = findDir('01')
  const dir02 = findDir('02')
  const dir03 = findDir('03')
  const dir04 = findDir('04')
  const dir05 = findDir('05')

  /* 1. 词汇 */
  const vocFiles = walk(dir04).filter((f) => f.toLowerCase().endsWith('.csv'))
  const coreFile = vocFiles.find((f) => /1500/.test(path.basename(f)))
  const fullFile = vocFiles.find((f) => /4500/.test(path.basename(f))) || vocFiles.find((f) => /3600/.test(path.basename(f)))
  if (!coreFile) problem('vocab', '04 词汇 里找不到 1500 核心词表（*.csv）')
  if (!fullFile) problem('vocab', '04 词汇 里找不到 4500 大纲词表（*.csv）')
  const v1500 = coreFile ? parseVocabCsv(coreFile, '1500') : []
  const vFull = fullFile ? parseVocabCsv(fullFile, '4500') : []
  const fullName = /4500/.test(path.basename(fullFile || '')) ? 4500 : 3600
  if (v1500.length && v1500.length < 1400) problem('vocab', `核心词表只解析出 ${v1500.length} 条`)
  if (vFull.length && vFull.length < 3000) problem('vocab', `大纲词表只解析出 ${vFull.length} 条`)
  // 大纲表本身没有例句：把核心 1500 里同一条词的例句借过来（1500 ⊂ 4500）
  const coreByWord = new Map(v1500.map((w) => [w.w.toLowerCase(), w]))
  for (const w of vFull) {
    if (w.ex) continue
    const c = coreByWord.get(w.w.toLowerCase())
    if (!c) continue
    w.ex = c.ex
    w.exCn = c.exCn
    if (!w.stars) w.stars = c.stars
  }
  fs.writeFileSync(path.join(OUT, 'vocab-1500.json'), JSON.stringify(v1500))
  fs.writeFileSync(path.join(OUT, `vocab-${fullName}.json`), JSON.stringify(vFull))

  /* 2. 答案 */
  const ansCsv = walk(dir02).find((f) => f.toLowerCase().endsWith('.csv'))
  if (!ansCsv) problem('answer', '02 答案 里找不到答案总表（*.csv）')
  const answerSets = ansCsv ? parseAnswerCsv(ansCsv) : new Map()

  /* 3. 听力原文 */
  const transcripts = new Map() // trackId → { text, passages }
  for (const f of walk(dir03).filter((x) => x.toLowerCase().endsWith('.txt'))) {
    const m = path.basename(f).match(/(\d{4})\s*年\s*(\d{1,2})\s*月.*?第\s*([1-3])\s*套/)
    if (!m) {
      problem('transcript', `文件名没解析出考期/套号：${path.basename(f)}`)
      continue
    }
    const text = fs.readFileSync(f, 'utf8')
    const passages = parseTranscript(text)
    if (passages.length !== 8) problem('transcript', `${path.basename(f)} 解析出 ${passages.length} 篇（应为 8）`)
    const stems = passages.flatMap((p) => p.stems)
    if (stems.length !== 25) problem('transcript', `${path.basename(f)} 解析出 ${stems.length} 个题干（应为 25）`)
    for (const p of passages) {
      const slot = PIECE_SLOTS.find((s) => s.title.toLowerCase() === p.title.toLowerCase())
      if (slot && p.stems.length) {
        const ns = p.stems.map((x) => x.n).sort((a, b) => a - b)
        const want = []
        for (let n = slot.from; n <= slot.to; n++) want.push(n)
        if (ns.join(',') !== want.join(',')) problem('transcript', `${path.basename(f)} ${p.title} 题干编号 ${ns.join('/')}，应为 ${want.join('/')}`)
      }
    }
    transcripts.set(`${m[1]}-${pad2(m[2])}-${m[3]}`, { text, passages, file: path.basename(f) })
  }

  /* 4. 音轨 */
  const tracks = []
  for (const f of walk(dir05).filter((x) => /\.(aac|m4a|mp3)$/i.test(x))) {
    const m = path.basename(f).match(/(\d{4})\s*年\s*(\d{1,2})\s*月.*?第\s*([1-3])\s*套/)
    if (!m) {
      problem('audio', `文件名没解析出考期/套号：${path.basename(f)}`)
      continue
    }
    tracks.push({
      id: `${m[1]}-${pad2(m[2])}-${m[3]}`,
      per: `${m[1]}-${pad2(m[2])}`,
      file: path.relative(SRC, f).replace(/\\/g, '/'),
      bytes: fs.statSync(f).size,
      ext: path.extname(f).toLowerCase(),
    })
  }
  /* 4.1 听力分段表（可选，不进发布包）
   * 它是「某份录音第 N 篇从第几秒到第几秒」的事实数据，只对特定的音源成立。
   * 换了音源的第三方用户如果沿用旧表，跳篇会落到错误位置且毫无提示——所以：
   *   - 默认不随包分发，从资料目录或用户目录里找；
   *   - 找到后用音频实际时长校验，对不上就整份作废（退回整段播放），并记一条警告。
   */
  const tracksFile = resolveTracksFile(dir05)
  const pieceTable = {}
  if (tracksFile) {
    try {
      Object.assign(pieceTable, JSON.parse(fs.readFileSync(tracksFile, 'utf8')))
      report.tracksFile = tracksFile
    } catch (e) {
      problem('audio', `分段表读不了：${tracksFile}（${e.message}）`)
    }
  } else {
    report.notes.push({
      scope: 'audio',
      msg: '没有听力分段表（可用 --tracks 指定），录音整段播放，不提供按篇跳转',
    })
  }

  /* 4.2 用音频实际时长校验分段表：越界就整份作废，绝不带着错位的时间点发出去 */
  const durationById = new Map()
  for (const t of tracks) {
    const dur = t.ext === '.aac' ? aacDuration(path.join(SRC, t.file)) : null
    if (dur) durationById.set(t.id, dur)
  }
  for (const [id, list] of Object.entries(pieceTable)) {
    if (!durationById.has(id)) {
      warn('audio', `分段表里的 ${id} 找不到对应音频，这一段不会出现在界面里`)
      delete pieceTable[id]
      continue
    }
    if (!Array.isArray(list) || list.length !== 8) {
      warn('audio', `分段表 ${id} 不是 8 段，已改为整段播放`)
      pieceTable[id] = []
      continue
    }
    const dur = durationById.get(id)
    const bad = list.find((p) => !(Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start && p.start >= 0 && p.end <= dur + 2))
    if (bad) {
      const last = list[list.length - 1]
      warn(
        'audio',
        `分段表 ${id} 与本机音频对不上（音频 ${Math.round(dur)}s，表里最后一段到 ${Math.round(
          Number(last?.end) || 0
        )}s），已改为整段播放，不提供按篇跳转`
      )
      pieceTable[id] = []
    }
  }

  /* 5. 真题 —— 优先 PDF；只有同名 .txt（没有 .pdf）的也当成一份卷。
     这种卷不用 PDF 抽取器：readText() 会直接命中旁边那份 .txt，卷名仍按 .pdf 处理，
     下游解析逻辑不用分支。给没装 workbuddy-pdf 的使用者留一条能走通的路。 */
  const pdfFiles = walk(dir01).filter((f) => /\.pdf$/i.test(f))
  const normKey = (f) => f.replace(/\\/g, '/').toLowerCase()
  const pdfKeys = new Set(pdfFiles.map((f) => normKey(f)))
  const txtOnlyFiles = walk(dir01)
    .filter((f) => /\.txt$/i.test(f))
    .map((f) => f.replace(/\.txt$/i, '.pdf'))
    .filter((f) => !pdfKeys.has(normKey(f)))
  const paperFiles = [...pdfFiles, ...txtOnlyFiles].sort()
  if (!paperFiles.length) problem('paper', '01 真题试卷 里没有 PDF，也没有可用的同名 .txt')
  if (txtOnlyFiles.length) {
    report.notes.push({
      scope: 'paper',
      msg: `${txtOnlyFiles.length} 套卷只有 .txt、没有 PDF，已直接按文本解析（不需要 PDF 抽取器）`,
    })
  }
  const papers = []
  for (const f of paperFiles.sort()) {
    try {
      const p = parsePaper(f)
      if (p) papers.push(p)
    } catch (e) {
      problem(path.basename(f), `解析异常：${e.message}`)
    }
  }

  /* 6. 合并答案 + 音轨 */
  const byPeriod = new Map()
  for (const p of papers) {
    const per = `${p.year}-${pad2(p.month)}`
    if (!byPeriod.has(per)) byPeriod.set(per, [])
    byPeriod.get(per).push(p)
  }

  const media = { root: SRC, tracks: {} }
  let audioVerified = 0
  let audioAssumed = 0
  const audioPairs = [] // 录音 → 试卷 的归属记录，写进 build-report 便于人工复核

  for (const [per, list] of [...byPeriod]) {
    const perTracks = tracks.filter((t) => t.per === per).sort((a, b) => a.id.localeCompare(b.id))
    const perTranscripts = new Map()
    for (const t of perTracks) if (transcripts.has(t.id)) perTranscripts.set(t.id, transcripts.get(t.id))

    const res = list.some((p) => p.listeningQuestions)
      ? assignTracks(perTracks, list.filter((p) => p.listeningQuestions), perTranscripts)
      : { byPaper: new Map(), verdict: [], groups: [] }

    for (const v of res.verdict) {
      if (v.score == null) audioAssumed++
      else audioVerified++
      audioPairs.push({
        track: v.trackId,
        paper: v.paperId,
        method: v.score == null ? '按同名原文/文件名推定' : '听力原文与选项内容比对',
        match: v.score == null ? null : `${v.score}%`,
      })
    }
    for (const t of perTracks) media.tracks[t.id] = { file: t.file, bytes: t.bytes }

    for (const p of list) {
      const trackId = res.byPaper.get(p.id) || ''
      const track = perTracks.find((t) => t.id === trackId) || null
      const tr = trackId ? transcripts.get(trackId) : null

      if (p.listeningQuestions) {
        const ans = answerSets.get(p.id)
        p.answers = ans ? answerRecord(ans) : null
        if (!ans) problem(p.id, '答案总表里没有这一套')
        p.listening = buildListening(p.listeningQuestions, track, tr, pieceTable[trackId] || [], p.answers?.listening || {})
        p.listeningQuestions = undefined
        if (!track) problem(p.id, '没有对应的听力录音')
      } else if (p.listenFrom) {
        // 借用同考期那一套的听力（选项、录音完全相同），答案仍用本套答案表
        const src = list.find((x) => x !== p && x.set === p.listenFrom)
        if (src?.listening) {
          const ans = answerSets.get(p.id)
          p.answers = ans ? answerRecord(ans) : null
          p.listening = {
            ...src.listening,
            copiedFrom: src.id,
            passages: src.listening.passages.map((ps) => ({
              ...ps,
              questions: ps.questions.map((q) => ({ ...q, answer: p.answers?.listening?.[q.n] || q.answer })),
            })),
          }
          report.notes.push({ scope: p.id, msg: `听力借用第 ${p.listenFrom} 套（真题 PDF 已注明本套不重复显示）` })
        } else problem(p.id, `PDF 说明本套听力与第 ${p.listenFrom} 套相同，但那一套没解析出听力`)
      } else {
        const ans = answerSets.get(p.id)
        p.answers = ans ? answerRecord(ans) : null
        if (!ans) problem(p.id, '答案总表里没有这一套')
      }

      if (p.cloze) {
        // 答案表里的“字母 + 原词”比 PDF 词库更可靠：字母对不上时按原词校正
        for (const n of Object.keys(p.answers?.cloze || {})) {
          const letter = p.answers.cloze[n]
          const word = p.answers.clozeWords?.[n]
          if (!word) continue
          const byLetter = p.cloze.bank.find((b) => b.letter === letter)
          if (byLetter && byLetter.word.toLowerCase() === word.toLowerCase()) continue
          const hit = p.cloze.bank.find((b) => b.word.toLowerCase() === word.toLowerCase())
          if (hit) {
            p.answers.cloze[n] = hit.letter
            problem(p.id, `选词第 ${n} 题答案字母按原词「${word}」从 ${letter} 校正为 ${hit.letter}`)
          } else problem(p.id, `选词第 ${n} 题答案词「${word}」不在词库里`)
        }
      }
      if (p.reading) {
        for (const ps of p.reading) for (const q of ps.questions) q.answer = p.answers?.reading?.[q.n] || ''
        const blank = p.reading.flatMap((ps) => ps.questions).filter((q) => !q.answer)
        if (blank.length) problem(p.id, `仔细阅读 ${blank.length} 题缺答案`)
      }
      if (p.matching) {
        for (const s of p.matching.statements) s.answer = p.answers?.matching?.[s.n] || ''
        // 答案指向不存在的段落 → 这道题永远做不对，移出练习
        const labels = new Set(p.matching.paragraphs.map((x) => x.label))
        const dropped = p.matching.statements.filter((s) => !labels.has(s.answer))
        if (dropped.length) {
          problem(p.id, `长篇阅读 ${dropped.map((s) => s.n).join('/')} 题答案指向不存在的段落，已移出`)
          p.matching.statements = p.matching.statements.filter((s) => labels.has(s.answer))
        }
      }
      p.translation = p.translation?.cn ? { cn: p.translation.cn } : null
      p.writing = p.writing?.prompt ? { prompt: p.writing.prompt } : null

      if (!p.answers) problem(p.id, '整套没有答案')
    }
  }

  /* 7. 落盘 */
  for (const p of papers) {
    fs.writeFileSync(path.join(papersDir, `${p.id}.json`), JSON.stringify(p))
  }

  const papersMeta = papers
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({
      id: p.id,
      title: p.title,
      year: p.year,
      month: p.month,
      set: p.set,
      hasListening: !!p.listening,
      hasAudio: !!p.listening?.audio,
      audioVerified: !!p.listening?.verified,
      // 第 3 套常注明“听力与第 1 套相同”，录音整段沿用，这里保留来源，前端好如实标注
      audioCopiedFrom: p.listening?.copiedFrom || '',
      hasTranscript: !!p.listening?.passages?.some((x) => x.text),
      hasCloze: !!p.cloze,
      hasMatching: !!p.matching?.statements?.length,
      hasReading: !!p.reading?.length,
      hasTranslation: !!p.translation,
      hasWriting: !!p.writing,
      listeningQuestions: p.listening?.passages?.reduce((a, x) => a + x.questions.length, 0) || 0,
      matchingStatements: p.matching?.statements?.length || 0,
      matchingParagraphs: p.matching?.paragraphs?.length || 0,
    }))

  const index = {
    generatedAt: report.generatedAt,
    source: SRC,
    vocab: {
      1500: { total: v1500.length, unitSize: 100, units: Math.ceil(v1500.length / 100), label: '核心 1500' },
      [fullName]: { total: vFull.length, unitSize: 100, units: Math.ceil(vFull.length / 100), label: `大纲 ${fullName}` },
    },
    // 录音文件数与“可听的套数”不是一回事：第 3 套常借用第 1 套的录音
    audio: {
      files: tracks.length,
      sets: papersMeta.filter((p) => p.hasAudio).length,
      borrowed: papersMeta.filter((p) => p.audioCopiedFrom).length,
      assumed: papersMeta.filter((p) => p.hasAudio && !p.audioVerified).length,
      transcribed: papersMeta.filter((p) => p.hasTranscript).length,
    },
    papers: papersMeta,
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1))
  fs.writeFileSync(path.join(OUT, 'media.json'), JSON.stringify(media, null, 1))

  report.stats = {
    source: SRC,
    vocab1500: v1500.length,
    [`vocab${fullName}`]: vFull.length,
    vocabWithExample: v1500.filter((w) => w.ex).length,
    papers: papers.length,
    answerSets: answerSets.size,
    transcripts: transcripts.size,
    tracks: tracks.length,
    audioVerified,
    audioAssumed,
    listeningOk: papers.filter((p) => p.listening?.passages?.length === 8).length,
    clozeOk: papers.filter((p) => p.cloze && Object.keys(p.answers?.cloze || {}).length === 10).length,
    matchingOk: papers.filter((p) => p.matching?.statements?.length === 10).length,
    readingOk: papers.filter((p) => p.reading?.length === 2 && p.reading.every((x) => x.questions.length === 5)).length,
    translationOk: papers.filter((p) => p.translation?.cn).length,
    writingOk: papers.filter((p) => p.writing?.prompt).length,
  }
  report.audioPairs = audioPairs
  fs.writeFileSync(path.join(OUT, 'build-report.json'), JSON.stringify(report, null, 1))

  console.log(`资料目录：${SRC}`)
  console.log(`输出目录：${OUT}`)
  for (const [k, v] of Object.entries(report.stats)) console.log(`  ${k}: ${v}`)
  if (report.notes.length) {
    console.log(`\n说明 ${report.notes.length} 条：`)
    for (const n of report.notes) console.log(`  - [${n.scope}] ${n.msg}`)
  }
  if (report.warnings.length) {
    console.log(`\n警告 ${report.warnings.length} 条：`)
    for (const w of report.warnings) console.log(`  - [${w.scope}] ${w.msg}`)
  }
  if (audioPairs.length) {
    console.log(`\n录音归属 ${audioPairs.length} 条（内容比对的可信，推定的请自己听一遍）：`)
    for (const a of audioPairs) {
      console.log(`  - ${a.track} → ${a.paper}（${a.method}${a.match ? ` 重合 ${a.match}` : ''}）`)
    }
  }
  if (report.problems.length) {
    console.log(`\n有 ${report.problems.length} 条问题（详见 data/build-report.json）：`)
    for (const p of report.problems.slice(0, 40)) console.log(`  - [${p.scope}] ${p.msg}`)
    if (report.problems.length > 40) console.log('  ...')
  } else console.log('\n没有发现问题。')
}

/**
 * 把听力题目、录音分段、原文合成一张“按篇组织”的结构：
 * 每一篇自带音频起止时间、原文与题目 —— 前端点某一篇就能跳到对应录音处。
 */
function buildListening(questions, track, transcript, pieces, answers) {
  const slots = PIECE_SLOTS.map((slot, i) => {
    const piece = pieces[i] || null
    const tr = transcript?.passages?.find((p) => p.title.toLowerCase() === slot.title.toLowerCase())
    const qs = questions.filter((q) => q.n >= slot.from && q.n <= slot.to).sort((a, b) => a.n - b.n)
    const stems = new Map((tr?.stems || []).map((x) => [x.n, x.stem]))
    return {
      key: slot.key,
      section: slot.section,
      sectionLabel: LISTEN_LABEL[slot.section],
      title: slot.title,
      from: slot.from,
      to: slot.to,
      start: piece ? piece.start : null,
      end: piece ? piece.end : null,
      text: (tr?.paras || []).join('\n\n'),
      questions: qs.map((q) => ({
        n: q.n,
        stem: stems.get(q.n) || '',
        options: q.options,
        answer: answers[q.n] || '',
      })),
    }
  })

  const missing = slots.flatMap((s) => s.questions.filter((q) => !q.answer).map((q) => q.n))
  if (missing.length) problem(track?.id || 'listening', `听力 ${missing.join('/')} 题缺答案`)

  return {
    track: track?.id || '',
    audio: track ? `media/${track.id}${track.ext}` : '',
    verified: !!transcript,
    passages: slots,
  }
}

main()
