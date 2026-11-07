/**
 * 端到端冒烟 + 功能断言（v2 UI）。
 *   node build/e2e.mjs [baseUrl]
 * 默认打 http://127.0.0.1:8788/cet4/app/index.html（先跑 npm run preview:plugin）
 *
 * 这一版对齐了「只给答案、不给解析；翻译作文只作答；听力按篇跳听」的改造：
 * 凡是旧版靠解析/范文/译文才能过的断言，全部换成对答案区与音频定位的检查。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/** puppeteer 不在本包依赖里：装过就用；否则在 DSH profile 的 node_modules 里找一个 */
const puppeteer = (() => {
  const tries = ['puppeteer-core', 'puppeteer']
  const profileDirs = []
  const roots = [
    process.env.PUPPETEER_DIR,
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles'),
  ].filter(Boolean)
  for (const r of roots) {
    try {
      for (const d of fs.readdirSync(r)) profileDirs.push(path.join(r, d, 'node_modules'))
    } catch {
      /* 目录不存在就算了 */
    }
  }
  for (const dir of profileDirs) tries.push(path.join(dir, 'puppeteer-core'))
  for (const spec of tries) {
    try {
      return require(spec)
    } catch {
      /* 换下一个 */
    }
  }
  console.error('没有找到 puppeteer-core / puppeteer，跳过 e2e：npm i -D puppeteer-core，或设置 PUPPETEER_DIR')
  process.exit(2)
})()

const BASE = process.argv[2] || 'http://127.0.0.1:8788/cet4/app/index.html'
/** 第二个实例：题库目录为空，用来验证「准备题库」引导页。不设就跳过那一条。 */
const EMPTY_BASE = process.env.CET4_EMPTY_BASE || ''
const OUT = path.join(ROOT, '.cache', 'shots')
fs.mkdirSync(OUT, { recursive: true })
/** 浏览器：CHROME_PATH 优先，其次各平台的常见位置 */
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean).find((p) => fs.existsSync(p))
if (!CHROME) {
  console.error('没找到 Chrome / Edge（可用 CHROME_PATH 指定），无法跑 e2e')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const consoleErrors = []
const httpErrors = []
const check = async (name, fn) => {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail })
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, detail: e.message })
    console.log(`  ✗ ${name} — ${e.message}`)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

const CDP_URL = process.env.E2E_CDP || ''
const browser = CDP_URL
  ? await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
  : await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900'],
      defaultViewport: { width: 1280, height: 900 },
    })
const page = await browser.newPage()
if (!CDP_URL) await page.setViewport({ width: 1280, height: 900 })
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push('[pageerror] ' + e.message))
page.on('response', (r) => {
  // 206 是音频 Range 的正常响应
  if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`)
})

const shot = async (name) => {
  await sleep(150)
  await page.screenshot({ path: path.join(OUT, `${name}.png`) })
}
const $text = (sel) => page.$eval(sel, (el) => el.innerText).catch(() => '')
const $exists = (sel) => page.$(sel).then(Boolean)
const clickBy = async (sel) => {
  const el = await page.$(sel)
  assert(el, `找不到元素 ${sel}`)
  await el.click()
  await sleep(260)
}
/** 若弹窗出现则点指定按钮 */
const modalAct = async (act = 'ok') => {
  const sel = `#modal:not([hidden]) [data-act="${act}"]`
  const el = await page.$(sel)
  if (!el) return false
  await el.click()
  await sleep(340)
  return true
}
const home = async () => {
  await page.evaluate(() => CET4.App.home())
  await page.waitForSelector('.card[data-go]', { timeout: 15000 })
  await sleep(120)
}

await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 })
// 每次从干净状态跑：同一个浏览器实例里 localStorage 会跨轮次保留
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle2' })
await page.waitForSelector('.card[data-go]', { timeout: 15000 })

/* ── 期望值一律从 index.json 读 ──
 * 这个脚本随包发布，别人用自己的题库跑时会得到不同的卷数/词数。断言不写死数字，
 * 才能让失败项真的指向 bug，而不是「你的数据和作者的不一样」。 */
const IDX = await page.evaluate(() =>
  fetch(new URL('../data/index.json', location.href), { cache: 'no-store' }).then((r) => r.json())
)
const V15 = IDX.vocab['1500']
/** 第二套词表是可选的：内置示例题库只有一套，跑 e2e 时也要能过 */
const FULL_KEY = Object.keys(IDX.vocab).find((k) => k !== '1500')
const FULL_SIZE = FULL_KEY ? Number(FULL_KEY) : null
const V45 = FULL_KEY ? IDX.vocab[FULL_KEY] : null
const IS_STARTER = IDX.kind === 'starter'
const AUDIO = IDX.audio || {}
const AUDIO_SETS = AUDIO.sets ?? IDX.papers.filter((p) => p.hasAudio).length
const AUDIO_FILES = AUDIO.files ?? AUDIO_SETS
const TRANSCRIBED = AUDIO.transcribed ?? IDX.papers.filter((p) => p.hasTranscript).length
/** 样例卷：优先「有录音 + 有原文 + 听力满题」，其次「有录音」，最后退回第一套 */
const SAMPLE =
  IDX.papers.find((p) => p.hasAudio && p.hasTranscript && p.listeningQuestions >= 8) ||
  IDX.papers.find((p) => p.hasAudio) ||
  IDX.papers[0]
/** 听力整段借用别套的卷（PDF 里注明“与第 X 套相同”） */
const BORROWED = IDX.papers.find((p) => p.audioCopiedFrom && p.audioCopiedFrom !== p.id)
const SAMPLE_PAPER = await page.evaluate((id) => CET4.Data.paper(id), SAMPLE.id)
const LS_PASSAGES = SAMPLE_PAPER.listening.passages.length

/* ── 1. 首页 ── */
await check(`首页：${V45 ? 9 : 8} 个模块入口`, async () => {
  const n = await page.$$eval('.card[data-go]', (els) => els.length)
  const want = V45 ? 9 : 8
  assert(n === want, `实际 ${n}（应 ${want}）`)
  return `${n} 个`
})

await check(`首页：词数分母是 ${(V45 || V15).total}（不是两表相加）`, async () => {
  const t = await $text('.hero-stats')
  assert(t.includes(String((V45 || V15).total)), `没看到 ${(V45 || V15).total}：${t.replace(/\n/g, ' | ')}`)
  if (V45) assert(!t.includes(String(V15.total + V45.total)), '还在把两套词表相加')
  return t.replace(/\n/g, ' | ').slice(0, 90)
})

await check('首页：带免责说明（只带代码 / 示例内容，不带真题）', async () => {
  const t = await $text('.wrap')
  assert(/不附带任何真题内容|不含任何真题/.test(t), '首页没有免责说明')
  assert(/版权|权利/.test(t), '没提版权归属')
  return IS_STARTER ? '示例模式说明' : '作者题库说明'
})

await shot('home-light')
await check('首页：听力卡片区分「套」与「录音份数」', async () => {
  const t = await page.$eval('.card[data-go="listening"] .card-meta', (el) => el.innerText)
  assert(new RegExp(`${AUDIO_SETS} 套可听`).test(t), `没写可听套数（应 ${AUDIO_SETS}）：${t.replace(/\n/g, ' ')}`)
  if (AUDIO_FILES) assert(new RegExp(`${AUDIO_FILES} 份录音`).test(t), `没写录音份数（应 ${AUDIO_FILES}）：${t.replace(/\n/g, ' ')}`)
  else assert(/语音合成/.test(t), `没有录音时应标明语音合成：${t.replace(/\n/g, ' ')}`)
  return t.replace(/\n/g, ' · ')
})

/* ── 2. 词汇 ── */
await check(`词表：核心 ${V15.units} 单元${V45 ? ` / 大纲 ${V45.units} 单元` : ''}（每 100 词）`, async () => {
  await clickBy('.card[data-go="v1500"]')
  await page.waitForSelector('.unit')
  const u15 = await page.$$eval('.unit', (els) => els.length)
  assert(u15 === V15.units, `1500 单元数 ${u15}（index.json 说 ${V15.units}）`)
  if (!V45) return `${u15} 单元（单套词表）`
  await home()
  await clickBy('.card[data-go="vfull"]')
  await page.waitForSelector('.unit')
  const u45 = await page.$$eval('.unit', (els) => els.length)
  assert(u45 === V45.units, `4500 单元数 ${u45}（index.json 说 ${V45.units}）`)
  const label = await $text('.section-title h2')
  assert(/4500|大纲/.test(label), `没标明是哪个词表：${label.slice(0, 40)}`)
  return `${u15} / ${u45} 单元 · ${label.trim()}`
})

await check('背单词：空格揭释义、→ 翻词、位置保存', async () => {
  await home()
  await clickBy('.card[data-go="v1500"]')
  await page.waitForSelector('.unit')
  await clickBy('.unit[data-unit="1"]')
  await page.waitForSelector('.word-big')
  const w1 = await $text('.word-big')
  await page.keyboard.press('Space')
  await sleep(200)
  const revealed = await page.$eval('#word-reveal', (el) => !el.hidden)
  assert(revealed, '空格没揭释义')
  await page.keyboard.press('ArrowRight')
  await sleep(250)
  const w2 = await $text('.word-big')
  assert(w1 !== w2, '→ 没翻词')
  return `${w1.trim()} → ${w2.trim()}`
})

await check('默写：错答进错词本', async () => {
  await clickBy('#mode-seg button[data-mode="write"]')
  await page.waitForSelector('#dict-input')
  await page.type('#dict-input', 'zzzz')
  await page.keyboard.press('Enter')
  await sleep(250)
  const verdict = await $text('#dict-verdict')
  assert(/正确答案/.test(verdict), `判定文案异常：${verdict}`)
  const wrong = await page.evaluate(() => Object.keys(CET4.Store.state.vocab.wrong).length)
  assert(wrong >= 1, '错词本没记上')
  return `${verdict.trim()} · 错词 ${wrong}`
})

await check('大纲词里没有例句的词会明确标注，而不是留一块空白', async () => {
  if (!FULL_SIZE) return '只有一套词表，跳过'
  const at = await page.evaluate((size) => {
    return CET4.Data.vocab(size).then((list) => {
      const i = list.findIndex((w) => !w.ex)
      if (i < 0) return null
      const unit = Math.floor(i / 100) + 1
      const lib = CET4.Store.lib(size)
      lib.unit = unit
      lib.mode = 'recall'
      lib.pos[unit] = i % 100
      CET4.Store.save()
      return { i, unit }
    })
  }, FULL_SIZE)
  if (!at) return '这个词表每条都有例句，跳过'
  await page.evaluate(([size, u]) => CET4.Vocab.practice(size, u), [FULL_SIZE, at.unit])
  await page.waitForSelector('.word-card')
  await clickBy('#word-toggle')
  await sleep(220)
  const marks = await page.$$eval('.ex-missing', (els) => els.map((e) => e.textContent.trim()))
  assert(marks.length === 1, `没标注缺例句：${marks.join('|') || '无'}`)
  assert(/没收录例句/.test(marks[0]), `标注文案不对：${marks[0]}`)
  return `第 ${at.i + 1} 条缺例句，已标注`
})

await check('切模式不重置位置', async () => {
  const before = await page.$eval('.practice-head .pill:last-child', (el) => el.innerText)
  await clickBy('#mode-seg button[data-mode="recall"]')
  const after = await page.$eval('.practice-head .pill:last-child', (el) => el.innerText)
  assert(before === after, `${before} != ${after}`)
  return after
})

await check('回归：离开词汇页后按空格不会把页面拽回单词卡', async () => {
  await home()
  await clickBy('.card[data-go="quiz"]')
  await page.waitForSelector('.card[data-type]')
  await page.keyboard.press('Space')
  await sleep(300)
  assert(!(await $exists('.word-card')), '空格仍然串到了词汇页')
  return '视图保持不变'
})

/* ── 3. 听力 ── */
await check(`听力菜单：${AUDIO_SETS} 套可听 / ${AUDIO_FILES} 份录音`, async () => {
  await home()
  await clickBy('.card[data-go="listening"]')
  await page.waitForSelector('.card[data-paper]')
  await shot('listening-menu')
  const n = await page.$$eval('.card[data-paper]', (els) => els.length)
  assert(n === AUDIO_SETS, `可听套数 ${n}（index.json 说 ${AUDIO_SETS}）`)
  const groups = await page.$$eval('.section-title h2', (els) => els.length)
  assert(groups >= 1, `考期分组 ${groups}`)
  const tags = await page.$$eval('.card[data-paper] .tag', (els) => els.map((e) => e.textContent))
  const guessed = tags.filter((t) => /按套号推定/.test(t)).length
  const borrowed = tags.filter((t) => /沿用第 1 套录音/.test(t)).length
  if (AUDIO.assumed != null) assert(guessed === AUDIO.assumed, `推定标记 ${guessed} 个（index.json 说 ${AUDIO.assumed}）`)
  if (AUDIO.borrowed != null) assert(borrowed === AUDIO.borrowed, `沿用标记 ${borrowed} 个（index.json 说 ${AUDIO.borrowed}）`)
  const head = await $text('.section-title')
  if (AUDIO_FILES) assert(new RegExp(`${AUDIO_FILES} 份录音`).test(head), `菜单没标出录音文件数：${head.replace(/\n/g, ' ')}`)
  else {
    const body = await $text('.wrap')
    assert(/语音|合成|原创/.test(body), '没有录音时菜单应说明是合成朗读')
    assert(!/份录音/.test(head), `没有录音却写了「份录音」：${head.replace(/\n/g, ' ')}`)
  }
  return `${n} 套 / ${groups} 个考期 / ${borrowed} 套沿用 / ${guessed} 份待核对`
})

await check(`听力：${SAMPLE.listeningQuestions || '?'} 题、8 篇、能播放`, async () => {
  await page.evaluate((id) => CET4.Listening.start(id), SAMPLE.id)
  await page.waitForSelector('.opt')
  const items = await page.$$eval('.q-item', (els) => els.length)
  const opts = await page.$$eval('.opt', (els) => els.length)
  const pieces = await page.$$eval('.piece', (els) => els.length)
  assert(items === SAMPLE.listeningQuestions, `题目 ${items}（index.json 说 ${SAMPLE.listeningQuestions}）`)
  assert(opts === items * 4, `选项 ${opts}（应 ${items * 4}）`)
  assert(pieces === LS_PASSAGES, `篇目按钮 ${pieces}（卷宗说 ${LS_PASSAGES} 篇）`)

  /* 示例卷没有音频文件：走语音合成，不该出现 <audio>，也不该有原文按钮（交卷前） */
  if (IS_STARTER) {
    assert(await $exists('.tts-bar'), '示例卷没有语音合成播放条')
    const speaks = await page.$$eval('[data-speak]', (els) => els.length)
    assert(speaks === LS_PASSAGES, `朗读按钮 ${speaks}（应 ${LS_PASSAGES}）`)
    assert(!(await $exists('#ls-audio')), '示例卷不该有 <audio>（包里没有音频文件）')
    assert(!(await $exists('[data-script]')), '示例卷交卷前不该给原文按钮')
    await shot('listening-synth')
    return `${items} 题 / ${pieces} 篇 / 语音合成`
  }

  // 跳转入口只留一排篇目按钮：段落标题里不再重复一个「听本篇」
  const jumps = await page.$$eval('[data-jump]', (els) => els.length)
  assert(jumps === LS_PASSAGES, `跳转按钮 ${jumps} 个（应只有 ${LS_PASSAGES} 个篇目 chip）`)
  assert(!(await $exists('.panel [data-jump]')), '段落标题里还留着重复的跳转按钮')
  await shot('listening-quiz')
  assert(await $exists('#ls-audio'), '没有音频播放器')
  const info = await page.$eval('#ls-audio', (a) =>
    new Promise((resolve) => {
      const done = () =>
        resolve({ src: a.currentSrc || a.src, duration: a.duration, ready: a.readyState, canplay: a.canPlayType('audio/aac') })
      if (a.readyState >= 1) return done()
      a.addEventListener('loadedmetadata', done, { once: true })
      setTimeout(done, 8000)
    })
  )
  assert(/\/cet4\/media\//.test(info.src), `音频地址不对：${info.src}`)
  assert(info.ready >= 1 && info.duration > 300, `音频没读出来：ready=${info.ready} duration=${info.duration}`)
  return `${items} 题 / ${pieces} 篇 / ${Math.round(info.duration)}s / canPlayType=${info.canplay}`
})

await check('听力：按篇跳转把播放头移到本段起点', async () => {
  if (IS_STARTER) return '示例卷用语音合成，没有时间轴，跳过'
  const target = await page.$eval('[data-jump="B1"]', (el) => ({
    start: Number(el.dataset.start),
    end: Number(el.dataset.end),
  }))
  assert(target.start > 0, `起点异常 ${target.start}`)
  await clickBy('[data-jump="B1"]')
  await sleep(900)
  const now = await page.$eval('#ls-audio', (a) => a.currentTime)
  assert(now >= target.start - 0.5, `播放头 ${now.toFixed(1)}s 没到 ${target.start.toFixed(1)}s`)
  assert(now < target.start + 40, `播放头跑太远：${now.toFixed(1)}s`)
  const onPiece = await page.$$eval('.piece.on', (els) => els.map((e) => e.dataset.jump))
  assert(onPiece.includes('B1'), `高亮没落在 B1：${onPiece.join(',')}`)
  await page.evaluate(() => {
    const a = document.getElementById('ls-audio')
    if (a) a.pause()
  })
  return `${target.start.toFixed(1)}s → 现 ${now.toFixed(1)}s · 高亮 B1`
})

await check('听力：借用第 1 套的卷宗有明确说明', async () => {
  if (!BORROWED) return '本题库没有借用听力的卷，跳过'
  await page.evaluate((id) => CET4.Listening.start(id), BORROWED.id)
  await page.waitForSelector('.opt')
  const note = await $text('.wrap')
  assert(/与同考期第 1 套相同/.test(note), '没说明本套听力沿用第 1 套')
  assert(/沿用那一套/.test(note), '说明文案不完整')
  return `${BORROWED.id} 已标注沿用来源`
})

await check('听力：原文可展开，且带原文的套才有按钮', async () => {
  if (IS_STARTER) return '示例卷原文交卷后才给（由下一条验证）'
  if (!SAMPLE.hasTranscript) return '样例卷没有原文，跳过'
  await page.evaluate((id) => CET4.Listening.start(id), SAMPLE.id)
  await page.waitForSelector('[data-script="A1"]')
  const btn = await page.$('[data-script="A1"]')
  assert(btn, 'A1 没有原文按钮')
  await btn.click()
  await sleep(220)
  const open = await page.$eval('#sc-A1', (el) => !el.hidden && el.innerText.length > 100)
  assert(open, '原文没展开或内容过短')
  await btn.click()
  await sleep(200)
  const closed = await page.$eval('#sc-A1', (el) => el.hidden)
  assert(closed, '再点一次没收起')
  return '展开 / 收起正常'
})

await check('听力：交卷后只给答案，不给解析', async () => {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.opt')) if (el.dataset.k === 'B') el.click()
  })
  await sleep(220)
  await clickBy('#ls-submit')
  if (await $exists('#modal:not([hidden])')) await modalAct('ok')
  await page.waitForSelector('.answer-line', { timeout: 8000 })
  const lines = await page.$$eval('.answer-line', (els) => els.length)
  assert(lines === SAMPLE.listeningQuestions, `答案行 ${lines}（应 ${SAMPLE.listeningQuestions}）`)
  await shot('listening-review')
  const first = await $text('.answer-line')
  assert(/答案\s*[A-D]/.test(first), `答案行内容异常：${first.replace(/\n/g, ' ')}`)
  assert(!(await $exists('.explain')), '出现了 .explain（解析）元素')
  assert(!(await $exists('#ls-submit')), '交卷后还留着“交卷”')
  assert(await $exists('#ls-redo'), '交卷后没有“再做一遍”')
  if (IS_STARTER) {
    const scriptBtn = await page.$('[data-script="A1"]')
    assert(scriptBtn, '示例卷交卷后应该能看原文')
    await scriptBtn.click()
    await sleep(220)
    const open = await page.$eval('#sc-A1', (el) => !el.hidden && el.innerText.length > 100)
    assert(open, '示例卷原文没展开')
  }
  const wrong = await page.evaluate(() =>
    CET4.Store.state.wrongBook.filter((w) => w.type === 'listening').length
  )
  assert(wrong > 0, '错题本没记听力错题')
  return `${lines} 行答案 · 错题 ${wrong}`
})

await check('听力：切走再进来进度还在，交卷标记可见', async () => {
  await page.evaluate(() => CET4.Listening.renderMenu())
  await page.waitForSelector('.card[data-paper]')
  const done = await page.$$eval('.card[data-paper] .tag.ok', (els) =>
    els.filter((e) => /已交卷/.test(e.textContent)).length
  )
  assert(done >= 1, '菜单里没有已交卷标记')
  return `已交卷 ${done} 套`
})

/* ── 4. 随机题 ── */
await check('随机题菜单：3 种题型（听力已独立成模块）', async () => {
  await home()
  await clickBy('.card[data-go="quiz"]')
  await page.waitForSelector('.card[data-type]')
  const types = await page.$$eval('.card[data-type]', (els) => els.map((e) => e.dataset.type))
  assert(types.length === 3, `题型卡片 ${types.length}：${types.join(',')}`)
  assert(types.sort().join(',') === 'cloze,matching,reading', `题型不对：${types.join(',')}`)
  return types.join(' / ')
})

await check('选词填空：交卷后答案区给出字母+原词，无解析', async () => {
  await page.evaluate(() => CET4.Quiz.start('cloze'))
  await page.waitForSelector('.chip')
  const blanks = await page.$$eval('.blank', (els) => els.length)
  assert(blanks > 0, `空数 ${blanks}`)
  // 真实作答路径：点第一个空位，之后程序自动跳到下一个空，连选三个词
  const filled = await page.evaluate(() => {
    document.querySelector('.blank[data-n="26"]')?.click()
    const chips = [...document.querySelectorAll('.chip')]
    chips.slice(0, 3).forEach((c) => c.click())
    const key = Object.keys(CET4.Store.state.quiz).find((k) => k.endsWith(':cloze'))
    return Object.keys(CET4.Store.state.quiz[key]?.answers || {}).length
  })
  assert(filled === 3, `记录了 ${filled} 个作答（应 3）`)
  await sleep(200)
  await clickBy('#quiz-submit')
  if (await $exists('#modal:not([hidden])')) await modalAct('ok')
  await page.waitForSelector('.answer-row', { timeout: 8000 })
  await shot('cloze-review')
  const rows = await page.$$eval('.answer-row', (els) => els.length)
  assert(rows === blanks, `答案行 ${rows} ≠ 空数 ${blanks}`)
  const t = await $text('#cloze-review')
  assert(/\d+/.test(t) && /[A-O]\.\s*\w/.test(t), `答案区没给出「字母. 单词」：${t.slice(0, 60)}`)
  const unanswered = await page.$$eval('.answer-row .tag.warn', (els) =>
    els.filter((e) => /未作答/.test(e.textContent)).length
  )
  assert(unanswered === blanks - 3, `未作答标记 ${unanswered} 个（应 ${blanks - 3}）`)
  assert(!(await $exists('.explain')), '出现了 .explain')
  return `${blanks} 空 / ${rows} 行答案 / ${unanswered} 未作答`
})

await check('长篇阅读：陈述答案指向具体段落、无解析', async () => {
  await page.evaluate(() => CET4.Quiz.start('matching'))
  await page.waitForSelector('.stmt-row')
  const paras = await page.$$eval('.para', (els) => els.map((e) => e.dataset.label).join(''))
  const stmts = await page.$$eval('.stmt-row', (els) => els.length)
  assert(stmts > 0, `陈述数 ${stmts}`)
  assert(paras.length >= stmts, `段落数 ${paras.length} 少于陈述数 ${stmts}`)
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.letter')) if (el.dataset.l === 'A') el.click()
  })
  await sleep(200)
  await clickBy('#quiz-submit')
  if (await $exists('#modal:not([hidden])')) await modalAct('ok')
  await page.waitForSelector('#match-review .answer-row, .answer-row', { timeout: 8000 })
  await shot('matching-review')
  const t = await $text('.wrap')
  assert(/段落\s*[A-Z]/.test(t), `没给出段落号：${t.slice(0, 80)}`)
  const rows = await page.$$eval('.answer-row', (els) => els.length)
  assert(rows === stmts, `答案行 ${rows} ≠ 陈述数 ${stmts}`)
  assert(!(await $exists('.explain')), '出现了 .explain')
  return `${paras.length} 段 / ${stmts} 题`
})

await check('仔细阅读：交卷后标对错并给正确选项，按钮变“再做一遍”', async () => {
  await page.evaluate(() => CET4.Quiz.start('reading'))
  await page.waitForSelector('.q-item')
  const items = await page.$$eval('.q-item', (els) => els.length)
  assert(items > 0, `仔细阅读题数 ${items}`)
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.opt')) if (el.dataset.k === 'A') el.click()
  })
  await sleep(200)
  await clickBy('#quiz-submit')
  if (await $exists('#modal:not([hidden])')) await modalAct('ok')
  await page.waitForSelector('#quiz-review', { timeout: 8000 })
  await shot('reading-review')
  const score = await $text('#score-big')
  assert(/\d+\s*\/\s*\d+/.test(score.replace(/\n/g, ' ')), `成绩卡异常：${score}`)
  const ans = await page.$$eval('.answer-line', (els) => els.length)
  assert(ans === items, `答案行 ${ans} ≠ 题数 ${items}`)
  const t = await $text('.wrap')
  assert(/答案\s*[A-D]\./.test(t), '答案行没带选项原文')
  assert(!(await $exists('.explain')), '出现了 .explain')
  assert(await $exists('#quiz-redo'), '交卷后没有“再做一遍”')
  assert(!(await $exists('#quiz-submit')), '交卷后还留着“交卷”')
  return score.replace(/\n/g, ' ')
})

await check('交卷后成绩卡不会被吸顶答题条盖住', async () => {
  await sleep(900)
  const r = await page.evaluate(() => {
    const bar = document.querySelector('.quizbar').getBoundingClientRect()
    const card = document.querySelector('#quiz-review').getBoundingClientRect()
    return { bar: Math.round(bar.bottom), card: Math.round(card.top) }
  })
  assert(r.card >= r.bar - 2, `成绩卡 top=${r.card} 被答题条 bottom=${r.bar} 盖住`)
  return `答题条 ${r.bar} < 成绩卡 ${r.card}`
})

await check('错题本：三类题型的错题都归档了', async () => {
  const n = await page.evaluate(() => {
    const b = CET4.Store.state.wrongBook
    return { total: b.length, types: [...new Set(b.map((w) => w.type))].sort() }
  })
  assert(n.total > 0, '错题本为空')
  assert(n.types.includes('listening'), `缺听力错题：${n.types.join(',')}`)
  return `${n.total} 道 · ${n.types.join(' / ')}`
})

/* ── 5. 翻译 ── */
await check('翻译：两种模式都能进，只有作答区（无参考译文）', async () => {
  await home()
  await clickBy('.card[data-go="translate"]')
  await page.waitForSelector('.card[data-mode]')
  const modes = await page.$$eval('.card[data-mode]', (els) => els.map((e) => e.dataset.mode))
  assert(modes.includes('partial') && modes.includes('full'), `模式：${modes.join(',')}`)
  await clickBy('.card[data-mode="partial"]')
  await page.waitForSelector('#tr-input')
  assert(await $exists('#tr-timer'), '没有计时器')
  const hasRef = await page.evaluate(
    () => !!(document.querySelector('.ref-box') || document.querySelector('#btn-ref') || /参考译文/.test(document.body.innerText))
  )
  assert(!hasRef, '翻译页仍有参考译文入口')
  await page.type('#tr-input', 'The Chinese government has been promoting compulsory education.')
  await sleep(220)
  const cnt = await $text('#word-count')
  assert(/\d+\s*词/.test(cnt), `词数统计异常：${cnt}`)
  await shot('e2e-translate')
  return `${modes.join(' / ')} · ${cnt}`
})

await check('翻译：换一篇不丢草稿逻辑（切到全篇仍可作答）', async () => {
  await page.evaluate(() => CET4.Translate.renderMenu())
  await page.waitForSelector('.card[data-mode]')
  await clickBy('.card[data-mode="full"]')
  await page.waitForSelector('#tr-input')
  const cn = await $text('.cn-text')
  assert(cn.length > 60, `中文原文过短：${cn.length}`)
  return `中文 ${cn.length} 字`
})

/* ── 6. 作文 ── */
await check('作文：30 分钟倒计时、词数句数、没有范文', async () => {
  await home()
  await clickBy('.card[data-go="writing"]')
  await page.waitForSelector('#w-input')
  const timer = await $text('#w-timer')
  assert(/^\d{2}:\d{2}$/.test(timer.trim()), `倒计时格式异常：${timer}`)
  assert(timer.trim().startsWith('29') || timer.trim().startsWith('30'), `倒计时起点异常：${timer}`)
  await page.type('#w-input', 'With the development of society, people pay more attention to this issue. It matters.')
  await sleep(220)
  const cnt = await $text('#w-count')
  assert(/\d+\s*词/.test(cnt) && /\d+\s*句/.test(cnt), `统计异常：${cnt}`)
  await shot('writing')
  const hasSample = await page.evaluate(
    () => !!(document.querySelector('#w-ref-slot') || document.querySelector('.model-essay') || /范文|参考作文/.test(document.body.innerText))
  )
  assert(!hasSample, '作文页仍有范文')
  return `${timer.trim()} · ${cnt}`
})

/* ── 7. 主题 / 设置 ── */
await check('深色模式切换生效且能切回', async () => {
  await home()
  const before = await page.evaluate(() => document.documentElement.dataset.theme)
  await clickBy('#btn-theme')
  const after = await page.evaluate(() => document.documentElement.dataset.theme)
  assert(after !== before, `主题没变（${before} → ${after}）`)
  await clickBy('#btn-theme')
  const back = await page.evaluate(() => document.documentElement.dataset.theme)
  assert(back === before, `再点一次没切回来（${back}）`)
  return `${before} → ${after} → ${back}`
})

await check('设置：只有学习节奏与题库来源，没有 AI 配置', async () => {
  await clickBy('#btn-settings')
  await page.waitForSelector('#set-exam')
  assert(!(await $exists('#set-base')), '还留着 API 地址输入框')
  assert(!(await $exists('#set-model')), '还留着模型输入框')
  const t = await $text('#modal-box')
  assert(/cet4\.state\.v4/.test(t), '没显示存储键')
  assert(/不带任何真题|不含任何真题/.test(t), '没有免责说明')
  if (IS_STARTER) {
    assert(await $exists('.starter-badge'), '示例模式没标「示例」徽标')
    assert(await $exists('#set-setup'), '示例模式没给「准备自己的真题」入口')
  } else {
    // 绝对路径默认折叠，避免一打开就把本机路径摊在最显眼处
    assert(await $exists('#set-full[hidden]'), '资料目录的完整路径没有被折叠')
    const shortSrc = await $text('.src-line')
    assert(!/[\\/]/.test(shortSrc), `折叠状态仍露出路径分隔符：${shortSrc}`)
    await clickBy('#set-reveal')
    await sleep(160)
    const fullSrc = await $text('#set-full')
    assert(/[\\/]/.test(fullSrc) && fullSrc.length > shortSrc.length, `展开后没显示完整路径：${fullSrc}`)
    await clickBy('#set-reveal')
    await sleep(120)
  }
  assert(await $exists('.danger-zone #set-reset'), '清空入口不在危险操作区里')
  await page.$eval('#set-exam', (el) => {
    el.value = '2027-06-12'
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await clickBy('#set-save')
  await sleep(420)
  const hero = await $text('.hero-stats')
  assert(/天后考试|考试日期/.test(hero), `首页没有倒计时：${hero.replace(/\n/g, ' | ')}`)
  return hero.replace(/\n/g, ' | ').slice(-30)
})

/* ── 8. 数据面 ── */
await check('数据面：词表 / 卷宗 / 音轨索引与 index.json 自洽', async () => {
  const info = await page.evaluate(async (sampleId) => {
    const idx = await CET4.Data.index()
    const v15 = await CET4.Data.vocab(1500)
    const key = Object.keys(idx.vocab).find((k) => k !== '1500')
    const full = key ? await CET4.Data.vocab(Number(key)) : null
    const p = await CET4.Data.paper(sampleId)
    const withAudio = idx.papers.filter((x) => x.hasAudio).length
    return {
      papers: idx.papers.length,
      v15: v15.length,
      v45: full ? full.length : 0,
      audio: withAudio,
      files: idx.audio?.files || 0,
      assumed: idx.audio?.assumed ?? -1,
      borrowed: idx.audio?.borrowed ?? -1,
      transcripts: idx.papers.filter((x) => x.hasTranscript).length,
      sample: p.id,
      ls: p.listening.passages.length,
      noExplain: !('explain' in (p.listening.passages[0].questions[0] || {})),
      trHasModel: !!(p.translation && (p.translation.model || p.translation.ref)),
      wrHasModel: !!(p.writing && (p.writing.model || p.writing.sample)),
    }
  }, SAMPLE.id)
  assert(info.papers === IDX.papers.length, `卷数 ${info.papers} ≠ index.json ${IDX.papers.length}`)
  assert(info.v15 === V15.total, `核心词 ${info.v15} ≠ index.json ${V15.total}`)
  if (V45) assert(info.v45 === V45.total, `大纲词 ${info.v45} ≠ index.json ${V45.total}`)
  assert(info.audio === AUDIO_SETS, `可听套数 ${info.audio} ≠ ${AUDIO_SETS}`)
  assert(info.files === AUDIO_FILES, `录音文件 ${info.files} ≠ ${AUDIO_FILES}`)
  assert(info.transcripts === TRANSCRIBED, `有原文的套数 ${info.transcripts} ≠ ${TRANSCRIBED}`)
  if (AUDIO.assumed != null && AUDIO.borrowed != null) {
    assert(info.assumed === AUDIO.assumed && info.borrowed === AUDIO.borrowed, `推定 ${info.assumed} / 沿用 ${info.borrowed}`)
  }
  assert(info.ls === LS_PASSAGES, `听力篇数 ${info.ls} ≠ ${LS_PASSAGES}`)
  assert(info.noExplain, '听力题里混进了 explain 字段')
  assert(!info.trHasModel, '翻译数据里还留着参考译文')
  assert(!info.wrHasModel, '作文数据里还留着范文')
  return `${info.papers} 卷 · ${info.v15}/${info.v45} 词 · ${info.audio} 套可听 / ${info.files} 份录音 · ${info.transcripts} 套原文`
})

/* ── 9. 引导页 ── */
await check('引导页自检：认得资料目录结构，也指得出缺什么', async () => {
  const r = await page.evaluate(() => {
    if (!CET4.Setup) return null
    const full = CET4.Setup.inspect([
      'CET-4/01 真题试卷/2023年6月/第1套/a.pdf',
      'CET-4/01 真题试卷/2023年6月/第2套/b.txt',
      'CET-4/02 答案/总表.csv',
      'CET-4/03 听力原文/2023年6月第1套_听力原文.txt',
      'CET-4/04 词汇/core1500.csv',
      'CET-4/04 词汇/full4500.csv',
      'CET-4/05 听力音频/2023年6月第1套.aac',
    ])
    const noVocab = CET4.Setup.inspect(['X/01 卷/a.pdf', 'X/02 答案/a.csv'])
    const badHeader = CET4.Setup.inspect([
      { path: 'X/01 卷/a.pdf' },
      { path: 'X/02 答案/a.csv', text: '场次,套数,题号,作答' },
      { path: 'X/04 词/c1500.csv' },
      { path: 'X/04 词/c4500.csv' },
    ])
    const audioOnly = CET4.Setup.inspect(['X/05 音频/a.aac'])
    return {
      full: { verdict: full.verdict, sets: full.counts.sets, root: full.root },
      noVocab: noVocab.verdict,
      noVocabMissing: noVocab.checks.filter((c) => c.level === 'bad').map((c) => c.key),
      badHeader: badHeader.verdict,
      audioOnly: audioOnly.verdict,
      empty: CET4.Setup.inspect([]).verdict,
    }
  })
  assert(r, 'setup.js 没加载（app/js/setup.js 或 index.html 的引用有问题）')
  assert(r.full.verdict === 'ok', `结构完整的目录被判为 ${r.full.verdict}`)
  assert(r.full.sets === 2, `套数 ${r.full.sets}（PDF 与纯 .txt 各算一套）`)
  assert(r.full.root === 'CET-4', `根目录名 ${r.full.root}`)
  assert(r.noVocab === 'bad' && r.noVocabMissing.includes('vocab'), `缺词表没判成 bad：${r.noVocab}`)
  assert(r.badHeader === 'bad', `答案表头不对没判成 bad：${r.badHeader}`)
  assert(r.audioOnly === 'bad', `只有音频应判 bad：${r.audioOnly}`)
  assert(r.empty === 'empty', `空列表应判 empty：${r.empty}`)
  return `${r.full.sets} 套识别正确 · 缺词表/错表头/只有音频均判红`
})

await check('引导页：题库没生成时给三步，而不是一句 HTTP 404', async () => {
  if (!EMPTY_BASE) return '未设置 CET4_EMPTY_BASE，跳过'
  const p2 = await browser.newPage()
  try {
    await p2.setViewport({ width: 1100, height: 900 })
    await p2.goto(EMPTY_BASE, { waitUntil: 'networkidle2', timeout: 30000 })
    await p2.waitForSelector('.setup-step', { timeout: 15000 })
    const steps = await p2.$$eval('.setup-step', (els) => els.length)
    assert(steps === 3, `步骤块 ${steps}`)
    const t = await p2.$eval('#view', (el) => el.innerText)
    const head = t.split('技术细节')[0]
    assert(/把资料摆成这个样子/.test(head), '没有目录结构示意')
    assert(/选一下你的资料目录/.test(head), '没有目录自检')
    assert(/npm run build:data/.test(head), '没有构建命令')
    assert(!/HTTP 404/.test(head), '首屏还在显示那句 404')
    assert(await p2.$('.setup-why'), '没有折叠技术细节的入口')
    await p2.screenshot({ path: path.join(OUT, 'setup-empty.png'), fullPage: true })
    return `${steps} 步 · 结构示意 / 自检 / 命令都在`
  } finally {
    await p2.close()
  }
})

/* ── 10. 收尾 ── */
await check('全程没有 console 报错与 4xx/5xx', async () => {
  assert(consoleErrors.length === 0, `console: ${consoleErrors.slice(0, 3).join(' | ')}`)
  assert(httpErrors.length === 0, `http: ${httpErrors.slice(0, 3).join(' | ')}`)
  return '0 报错'
})

await page.evaluate(() => {
  CET4.Store.state.meta.theme = 'dark'
  CET4.Theme.apply('dark')
})
await home()
await shot('home-dark')
await page.evaluate(() => {
  CET4.Store.state.meta.theme = 'light'
  CET4.Theme.apply('light')
})
await home()
await shot('e2e-final')
if (CDP_URL) {
  await page.close()
  await browser.disconnect()
} else {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) process.exitCode = 1
