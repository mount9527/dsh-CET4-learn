/* 数据加载 + 本地存储 + 小工具。所有模块都挂到 window.CET4 上。
 *
 * 存储版本 v4：
 *  - 词表换成「核心 1500 / 大纲 4500」，两套词表的“已学”仍按单词共享，
 *    所以 1500 里学过的词在 4500 里也算学过（1500 是 4500 的子集）。
 *  - 去掉 AI 讲解/批改：题目只给答案，翻译与作文只保留作答。
 *  - 作答记录按「卷宗:题型」保存，听力与三类阅读题共用同一套结构。
 */
(function () {
  const CET4 = (window.CET4 = window.CET4 || {});

  /* ───────── 数据 ───────── */
  const DATA_BASE = new URL('../data/', document.baseURI).href;
  const cache = new Map();

  async function getJSON(name) {
    if (cache.has(name)) return cache.get(name);
    const res = await fetch(DATA_BASE + name, { cache: 'no-cache' });
    if (!res.ok) {
      /* 带上 status：404 = 还没生成题库，引导页据此换措辞 */
      const err = new Error(`读取 ${name} 失败（HTTP ${res.status}）`);
      err.status = res.status;
      err.resource = name;
      throw err;
    }
    try {
      const json = await res.json();
      cache.set(name, json);
      return json;
    } catch (e) {
      const err = new Error(`${name} 不是合法的 JSON：${e.message}`);
      err.status = 0;
      err.resource = name;
      throw err;
    }
  }

  CET4.Data = {
    index: () => getJSON('index.json'),
    vocab: (size) => getJSON(`vocab-${size}.json`),
    paper: (id) => getJSON(`papers/${id}.json`),
    /** 音频在 data/ 的上一级（宿主按 Range 推流，不拷进包里） */
    mediaUrl: (rel) => new URL(`../${rel}`, DATA_BASE).href,
    async papersMeta() {
      const idx = await this.index();
      return idx.papers;
    },
    /** 词表按每 100 词切单元 */
    unit(list, no, size = 100) {
      const start = (no - 1) * size;
      return list.slice(start, start + size);
    },
    unitCount(total, size = 100) {
      return Math.ceil(total / size);
    },
  };

  /* ───────── 存储 ───────── */
  const KEY = 'cet4.state.v4';
  const LEGACY_KEYS = ['cet4.state.v3', 'cet4.state.v2'];

  const blankVocabLib = () => ({ unit: 1, mode: 'recall', pos: {} });

  const blank = () => ({
    v: 4,
    vocab: { learned: {}, wrong: {}, 1500: blankVocabLib(), 4500: blankVocabLib() },
    notebook: [], // { w, def, ph, lib, id, at }
    quiz: {}, // { 'paperId:type': { answers, elapsed, submitted, score, at } }
    wrongBook: [], // { key, paperId, type, n, at, times }
    translate: {},
    writing: {},
    settings: {},
    meta: { theme: 'auto', examDate: '' },
    stats: { quizDone: 0, listeningDone: 0, wordsSeen: 0 },
  });

  const Store = (CET4.Store = {
    state: blank(),
    key: KEY,

    load() {
      let raw = null;
      try {
        raw = localStorage.getItem(KEY);
        if (!raw) {
          for (const k of LEGACY_KEYS) {
            const old = localStorage.getItem(k);
            if (old) {
              this.state = migrate(JSON.parse(old));
              this.save();
              // 迁移成功就把老键删掉，免得两套数据并存互相误导
              try {
                localStorage.removeItem(k);
              } catch {
                /* 忽略 */
              }
              break;
            }
          }
          return this.state;
        }
        const parsed = JSON.parse(raw);
        this.state = Object.assign(blank(), parsed);
        this.state.vocab = Object.assign(blank().vocab, parsed.vocab || {});
        this.state.vocab.learned = parsed.vocab?.learned || {};
        this.state.vocab.wrong = parsed.vocab?.wrong || {};
        this.state.settings = Object.assign(blank().settings, parsed.settings || {});
        this.state.meta = Object.assign(blank().meta, parsed.meta || {});
        this.state.stats = Object.assign(blank().stats, parsed.stats || {});
      } catch (e) {
        console.warn('[cet4] 读取本地进度失败，已重置', e);
        this.state = blank();
      }
      return this.state;
    },

    save() {
      try {
        localStorage.setItem(KEY, JSON.stringify(this.state));
      } catch (e) {
        console.warn('[cet4] 保存失败', e);
      }
    },

    reset() {
      this.state = blank();
      this.save();
    },

    /** 某个词库的切换位置 / 模式（“学过”状态是全局共享的） */
    lib(size) {
      const s = this.state;
      if (!s.vocab[size]) s.vocab[size] = blankVocabLib();
      const v = s.vocab[size];
      v.pos = v.pos || {};
      return v;
    },

    /* ── 学过的词（两套词表共用一份） ── */
    isLearned(word) {
      return !!this.state.vocab.learned[String(word).toLowerCase()];
    },
    markWord(word) {
      const w = String(word || '').toLowerCase();
      if (!w || this.state.vocab.learned[w]) return false;
      this.state.vocab.learned[w] = Date.now();
      this.save();
      return true;
    },
    /** 复习时刷新时间戳：隔天没碰过的词才算“待复习” */
    touchWord(word) {
      const w = String(word || '').toLowerCase();
      if (!w || !this.state.vocab.learned[w]) return;
      this.state.vocab.learned[w] = Date.now();
      this.save();
    },
    /** 待复习：学过但超过 N 天没再碰过的词（轻量间隔复习，不是完整 SRS） */
    reviewDue(days = 1) {
      const cut = Date.now() - days * 86400000;
      return Object.entries(this.state.vocab.learned)
        .filter(([, ts]) => ts < cut)
        .sort((a, b) => a[1] - b[1])
        .map(([w]) => w);
    },
    unmarkWord(word) {
      delete this.state.vocab.learned[String(word).toLowerCase()];
      this.save();
    },
    learnedCount() {
      return Object.keys(this.state.vocab.learned).length;
    },
    /** 老版本把“翻过的词”记在 lib.done[unit] = [id]；词表加载后换算成单词集合 */
    migrateDone(size, list) {
      const v = this.lib(size);
      if (!v.done) return 0;
      let n = 0;
      for (const ids of Object.values(v.done)) {
        for (const id of ids) {
          const hit = list[id - 1];
          if (hit && !this.state.vocab.learned[hit.w.toLowerCase()]) {
            this.state.vocab.learned[hit.w.toLowerCase()] = Date.now();
            n++;
          }
        }
      }
      delete v.done;
      if (n) this.save();
      return n;
    },
    progressOf(list, unitNo, size = 100) {
      const words = CET4.Data.unit(list, unitNo, size);
      const done = words.filter((w) => this.isLearned(w.w)).length;
      return { done, total: words.length, pct: CET4.util.pct(done, words.length) };
    },

    /* ── 默写错词 ── */
    markWrongWord(entry) {
      const k = String(entry.w).toLowerCase();
      const rec = this.state.vocab.wrong[k];
      this.state.vocab.wrong[k] = {
        w: entry.w,
        def: entry.def,
        ph: entry.ph,
        lib: entry.lib,
        times: (rec?.times || 0) + 1,
        at: Date.now(),
      };
      this.save();
    },
    clearWrongWord(word) {
      delete this.state.vocab.wrong[String(word).toLowerCase()];
      this.save();
    },
    wrongWords() {
      return Object.values(this.state.vocab.wrong).sort((a, b) => b.at - a.at);
    },

    /* ── 生词本 ── */
    notebookHas(w) {
      return this.state.notebook.some((x) => x.w.toLowerCase() === String(w).toLowerCase());
    },
    addNotebook(entry) {
      if (this.notebookHas(entry.w)) return false;
      this.state.notebook.unshift({ ...entry, at: Date.now() });
      this.save();
      return true;
    },
    removeNotebook(w) {
      this.state.notebook = this.state.notebook.filter((x) => x.w !== w);
      this.save();
    },
    addNotebookBulk(list) {
      let n = 0;
      for (const e of list) if (e && e.w && this.addNotebook(e)) n++;
      return n;
    },

    /* ── 错题本 ── */
    addWrong({ key, paperId, type, n, stem }) {
      const hit = this.state.wrongBook.find((x) => x.key === key);
      if (hit) {
        hit.times += 1;
        hit.at = Date.now();
      } else {
        this.state.wrongBook.unshift({ key, paperId, type, n, stem: stem || '', times: 1, at: Date.now() });
      }
      this.save();
    },
    removeWrong(key) {
      this.state.wrongBook = this.state.wrongBook.filter((x) => x.key !== key);
      this.save();
    },
    clearWrongBook() {
      this.state.wrongBook = [];
      this.save();
    },
  });

  /** v2/v3 → v4：保留学习进度与记录，词表编号换成 1500 / 4500 */
  function migrate(old) {
    const s = blank();
    if (!old || typeof old !== 'object') return s;
    s.notebook = Array.isArray(old.notebook) ? old.notebook : [];
    s.quiz = old.quiz || {};
    s.translate = old.translate || {};
    s.writing = old.writing || {};
    s.stats = Object.assign(s.stats, old.stats || {});
    if (old.vocab) {
      s.vocab.learned = old.vocab.learned || {};
      s.vocab.wrong = old.vocab.wrong || {};
      for (const size of [1500, 4500]) {
        // 旧版 3600 词表的位置搬到 4500（编号不同，故只搬单元号与模式，不搬词内位置）
        const v = old.vocab[size] || (size === 4500 ? old.vocab[3600] : null);
        if (!v) continue;
        s.vocab[size] = {
          unit: v.unit || 1,
          mode: v.mode || 'recall',
          pos: old.vocab[size] ? v.pos || {} : {},
        };
        if (v.done && old.vocab[size]) s.vocab[size].done = v.done; // 交给 migrateDone 换算
      }
    }
    if (old.meta) s.meta = Object.assign(s.meta, old.meta);
    return s;
  }

  /* ───────── 工具 ───────── */
  CET4.util = {
    esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    pick(arr) {
      return arr[Math.floor(Math.random() * arr.length)];
    },
    fmtTime(ms) {
      const total = Math.max(0, Math.floor((ms || 0) / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const r = total % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
    },
    /** 距考试还有多少天（按本地日期算） */
    daysUntil(dateStr) {
      if (!dateStr) return null;
      const t = new Date(`${dateStr}T00:00:00`).getTime();
      if (Number.isNaN(t)) return null;
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      return Math.round((t - today) / 86400000);
    },
    /** 默写提示：>5 露前 3 个字母，4-5 露前 2 个，<=3 露 1 个 */
    hintOf(word) {
      const w = String(word || '');
      const n = w.length > 5 ? 3 : w.length > 3 ? 2 : 1;
      return w.slice(0, n).toLowerCase();
    },
    maskOf(word) {
      const w = String(word || '');
      return w
        .split('')
        .map((ch, i) => (i < this.hintOf(w).length ? ch : '_'))
        .join(' ');
    },
    speak(text) {
      try {
        const synth = window.speechSynthesis;
        if (!synth) return;
        synth.cancel();
        const u = new SpeechSynthesisUtterance(String(text));
        u.lang = 'en-US';
        u.rate = 0.92;
        const voices = synth.getVoices();
        const en = voices.find((v) => /en[-_]US/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang));
        if (en) u.voice = en;
        synth.speak(u);
      } catch (e) {
        /* 静音环境忽略 */
      }
    },
    /** 英文内容词（去停用词），用于答案定位 */
    keywords(text) {
      const stop = new Set(
        'the a an of to in on for with and or is are be been was were that this these those you your we our it its as at by from not but they their he she his her i my me can will would should could more most such than then there here what which who whom how when where why all any both each few many some no nor only own same so too very just about into over after before according author passage writer'.split(
          ' '
        )
      );
      return [
        ...new Set(
          String(text || '')
            .toLowerCase()
            .match(/[a-z][a-z'-]{2,}/g) || []
        ),
      ].filter((w) => !stop.has(w) && w.length >= 4);
    },
    /** 把长文切成句子（中英都认） */
    sentences(text) {
      return String(text || '')
        .replace(/\s+/g, ' ')
        .split(/(?<=[.!?。！？；])\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
    },
    pct(a, b) {
      return b ? Math.round((a / b) * 100) : 0;
    },
  };

  /* ───────── 计时器（页面切走就停，回来接着走） ───────── */
  CET4.Timer = {
    /** opts: { from=0, limit=0, onTick } → { total, stop() } */
    start({ from = 0, limit = 0, onTick } = {}) {
      let total = Number(from) || 0;
      let last = Date.now();
      let id = 0;
      const tick = () => {
        const now = Date.now();
        total += now - last;
        last = now;
        if (onTick) onTick(total, limit ? Math.max(0, limit - total) : 0);
      };
      id = setInterval(tick, 500);
      if (onTick) onTick(total, limit ? Math.max(0, limit - total) : 0);
      return {
        get total() {
          return total;
        },
        stop() {
          if (id) clearInterval(id);
          id = 0;
        },
      };
    },
  };

  /* ───────── 710 估分（按官方分值比例粗算，仅供定位） ───────── */
  CET4.score = {
    /** 听力 / 阅读各占 35%（248.5 分）；写作、翻译各 15%，离线无法估，故只报客观题 */
    FULL: 248.5,
    /** rows: [{ kind:'listening'|'reading', right, total }] */
    estimate(rows) {
      const bucket = { listening: [0, 0], reading: [0, 0] };
      for (const r of rows || []) {
        const k = r.kind === 'listening' ? 'listening' : 'reading';
        bucket[k][0] += r.right || 0;
        bucket[k][1] += r.total || 0;
      }
      const sec = {};
      for (const k of ['listening', 'reading']) {
        const [right, total] = bucket[k];
        sec[k] = total ? { right, total, acc: right / total, score: Math.round((right / total) * this.FULL) } : null;
      }
      const objective = (sec.listening?.score || 0) + (sec.reading?.score || 0);
      const objectiveFull = (sec.listening ? this.FULL : 0) + (sec.reading ? this.FULL : 0);
      return { sec, objective: Math.round(objective), objectiveFull: Math.round(objectiveFull) };
    },
  };

})();
