/* 准备题库：题库没生成 / 读不出来时打开这一页
 * ---------------------------------------------------------------------------
 * 替掉原来那句「读取 index.json 失败（HTTP 404）」——那句话对使用者没有意义。
 *
 * 页面只做三件事：
 *   1. 说清资料目录该长什么样（目录名前两位 01–05，后面的名字随意）；
 *   2. 让用户选一次自己的资料目录，在前端做结构自检。浏览器拿不到绝对路径，
 *      但 webkitRelativePath 足够判断「缺哪个目录、每个目录里有多少份文件」；
 *   3. 按用户粘贴的路径拼出构建命令，可一键复制。
 *
 * 自检规则与 build/build.mjs 的 findDir() / walk() 用同一套前缀约定，改目录命名时两边一起改。
 * inspect() 是纯函数（不碰 DOM），方便直接喂假数据做回归。
 */
(function () {
  const CET4 = (window.CET4 = window.CET4 || {});
  const { esc } = CET4.util;

  /** 资料目录约定：key 用于分组，prefix 与 build.mjs 的前缀匹配一致 */
  const DIRS = [
    {
      key: 'paper',
      prefix: '01',
      label: '01 真题试卷',
      hint: '每套一份 PDF；没有 PDF 抽取器时，可在旁边放同名 .txt',
    },
    {
      key: 'answer',
      prefix: '02',
      label: '02 答案',
      hint: '答案总表 CSV，表头含「题号」「答案」，不含解析',
    },
    {
      key: 'script',
      prefix: '03',
      label: '03 听力原文',
      hint: '可选（YYYY年M月第N套_听力原文.txt），缺了只能靠听',
    },
    {
      key: 'vocab',
      prefix: '04',
      label: '04 词汇',
      hint: '核心 1500 与大纲 4500 两个 CSV',
    },
    {
      key: 'audio',
      prefix: '05',
      label: '05 听力音频',
      hint: '可选（.aac / .m4a / .mp3），缺了只能看原文',
    },
  ];

  const ext = (name) => {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i).toLowerCase() : '';
  };
  const noExt = (p) => p.replace(/\.[^./]+$/, '');

  /**
   * 结构自检。
   * @param {Array<string|{path:string,text?:string}>} entries 相对路径（或带首行文本）
   * @returns {{root:string,groups:object,checks:Array,verdict:'ok'|'warn'|'bad'|'empty',counts:object}}
   */
  function inspect(entries) {
    const list = (entries || [])
      .map((e) => (typeof e === 'string' ? { path: e } : e || {}))
      .map((e) => ({ ...e, path: String(e.path || '').replace(/\\/g, '/') }))
      .filter((e) => e.path);

    if (!list.length) {
      return { root: '', groups: {}, checks: [], verdict: 'empty', counts: {} };
    }

    /* 浏览器给的路径一定带着用户选中的那一层目录名；选到子目录时就只剩 01xxx/… */
    const tops = new Set(list.map((e) => e.path.split('/')[0]));
    const root = tops.size === 1 && list.every((e) => e.path.includes('/')) ? [...tops][0] : '';

    const groups = Object.fromEntries(DIRS.map((d) => [d.key, []]));
    for (const e of list) {
      const segs = e.path.split('/').filter(Boolean);
      // 从最外层往里找两级，兼容「选了资料根」和「直接选了 01 这种子目录」
      for (let i = 0; i < Math.min(segs.length - 1, 2); i++) {
        const d = DIRS.find((x) => segs[i].startsWith(x.prefix));
        if (!d) continue;
        const name = segs[segs.length - 1];
        groups[d.key].push({ ...e, name, ext: ext(name), rel: segs.slice(i + 1).join('/') });
        break;
      }
    }

    /* 01：一份卷 = 一个 PDF，或者一个没有同名 PDF 的 .txt（build 会把后者当卷） */
    const pdfs = groups.paper.filter((e) => e.ext === '.pdf');
    const txts = groups.paper.filter((e) => e.ext === '.txt');
    const pdfKeys = new Set(pdfs.map((e) => noExt(e.rel)));
    const txtOnly = txts.filter((e) => !pdfKeys.has(noExt(e.rel)));
    const sets = new Set([...pdfs, ...txtOnly].map((e) => noExt(e.rel))).size;

    /* 02：答案总表 CSV（分场次 *_答案.txt 也认，但不作为主表） */
    const ansCsv = groups.answer.filter((e) => e.ext === '.csv');
    const ansTxt = groups.answer.filter((e) => e.ext === '.txt');
    const head = ansCsv.map((e) => e.text).find(Boolean) || '';
    const headerOk = head ? /题号/.test(head) && /答案/.test(head) : null;

    /* 04：两份词表按文件名里的 1500 / 4500 认 */
    const vocCsv = groups.vocab.filter((e) => e.ext === '.csv');
    const core = vocCsv.filter((e) => /1500/.test(e.name));
    const full = vocCsv.filter((e) => /(4500|3600)/.test(e.name));

    const scripts = groups.script.filter((e) => e.ext === '.txt');
    const audios = groups.audio.filter((e) => /^\.(aac|m4a|mp3|wav|ogg)$/.test(e.ext));

    const checks = [
      {
        key: 'paper',
        level: sets ? 'ok' : 'bad',
        text: sets
          ? `${sets} 套卷 · PDF ${pdfs.length} 份${txtOnly.length ? ` · 纯文本 ${txtOnly.length} 份` : ''}`
          : '没找到试卷：需要 PDF，或 PDF 旁边放一份同名 .txt',
      },
      {
        key: 'answer',
        level: ansCsv.length ? (headerOk === false ? 'bad' : 'ok') : 'bad',
        text: ansCsv.length
          ? headerOk === false
            ? '答案 CSV 表头不像「场次,套数,题号,题型,答案」'
            : `${ansCsv.length} 份答案 CSV${headerOk ? ' · 表头正常' : ''}${ansTxt.length ? ` · 另有 ${ansTxt.length} 份分场次答案` : ''}`
          : '没找到答案总表 CSV',
      },
      {
        key: 'script',
        level: scripts.length ? 'ok' : 'warn',
        text: scripts.length ? `${scripts.length} 份听力原文` : '没有听力原文：听力题只能靠听，交卷后只给答案',
      },
      {
        key: 'vocab',
        level: core.length && full.length ? 'ok' : 'bad',
        text:
          core.length && full.length
            ? `核心词表 ${core.length} 份 · 大纲词表 ${full.length} 份`
            : !vocCsv.length
              ? '04 词汇里没有 CSV'
              : `缺${core.length ? '' : ' 1500 核心'}${!core.length && !full.length ? ' 与' : ''}${full.length ? '' : ' 4500 大纲'}词表`,
      },
      {
        key: 'audio',
        level: audios.length ? 'ok' : 'warn',
        text: audios.length ? `${audios.length} 份录音` : '没有录音：听力页只能看原文、不能播',
      },
    ];

    const verdict = checks.some((c) => c.level === 'bad')
      ? 'bad'
      : checks.some((c) => c.level === 'warn')
        ? 'warn'
        : 'ok';

    return {
      root,
      groups,
      checks,
      verdict,
      counts: {
        sets,
        pdf: pdfs.length,
        txtOnly: txtOnly.length,
        answers: ansCsv.length,
        core: core.length,
        full: full.length,
        scripts: scripts.length,
        audio: audios.length,
      },
    };
  }

  const ICON = { ok: '✓', warn: '!', bad: '✕' };

  function reportHtml(r) {
    if (!r || r.verdict === 'empty') return '';
    const rows = r.checks
      .map(
        (c) => `<div class="check-item ${c.level}">
          <span class="check-mark">${ICON[c.level] || '·'}</span>
          <span class="check-name">${esc((DIRS.find((d) => d.key === c.key) || {}).label || c.key)}</span>
          <span class="check-text">${esc(c.text)}</span>
        </div>`
      )
      .join('');
    const verdict = {
      ok: ['资料齐了', 'go', '下面第 3 步复制命令，跑完回来点「重新加载」'],
      warn: ['能生成，但缺可选资料', 'warn', '缺的部分在面板里会标「无原文」或「无录音」，不影响其他模块'],
      bad: ['还差必需资料', 'bad', '按上面标红的两项补齐后重新选一次目录'],
    }[r.verdict];
    return `
      <div class="check-list">${rows}</div>
      <div class="check-verdict ${verdict[1]}">
        <b>${esc(verdict[0])}</b><span>${esc(verdict[2])}</span>
      </div>`;
  }

  function render(err) {
    const fileMode = location.protocol === 'file:';
    const msg = err && (err.message || String(err));

    /* 双击 index.html：跟题库没关系，直接说清怎么打开 */
    if (fileMode) {
      CET4.UI.set(`
        <div class="wrap setup">
          <div class="panel panel-pad">
            <h2 style="margin-top:0">要从左侧栏打开</h2>
            <p class="muted" style="line-height:1.9">
              你现在是直接双击 <code>index.html</code> 打开的，浏览器会以 <code>file://</code> 拦截读取题库的请求。
              请在 DeepSeek Harness 左侧栏点「CET-4 训练台」进入。
            </p>
          </div>
        </div>`);
      CET4.UI.hideBack();
      return;
    }

    const missing = !err || err.status === 404;
    const voluntary = !err; // 从首页/设置点进来：当前有示例可看，只是要换成自己的
    const title = voluntary ? '换成我自己的真题' : missing ? '先把题库准备好' : '题库读不出来';
    const lead = voluntary
      ? '内置示例只有 426 个词和一套原创模拟卷。把自备的真题资料构建一次，示例会自动让位，数据只留在本机。'
      : missing
        ? '这个插件只带代码，题目不在包里。用你自己的资料生成一次，大约两分钟，之后就一直能用了。'
        : '题库文件在，但读的时候出错了。多半是构建中途被打断，重新生成一次即可。';

    CET4.UI.set(`
      <div class="wrap setup">
        <div class="setup-head">
          <h1>${esc(title)}</h1>
          <p>${esc(lead)}</p>
        </div>

        <section class="panel panel-pad setup-step">
          <div class="step-no">1</div>
          <div class="step-body">
            <h2>把资料摆成这个样子</h2>
            <pre class="tree">CET-4/
  01 真题试卷/2023年6月/第1套/xxx.pdf
  02 答案/答案总表.csv
  03 听力原文/2023年6月第1套_听力原文.txt
  04 词汇/核心1500.csv、大纲4500.csv
  05 听力音频/2023年6月第1套听力音频.aac</pre>
            <p class="muted small">
              最外层叫什么都可以，进去就是 01–05 五个目录，前两位必须是数字，后面的名字随意。
              01 要 PDF；02 要一份答案总表 CSV；04 要核心 1500 与大纲 4500 两个 CSV；03、05 可以没有。
              没有 PDF 抽取器也能做：在 PDF 旁边放一份同名 <code>.txt</code>。
            </p>
          </div>
        </section>

        <section class="panel panel-pad setup-step">
          <div class="step-no">2</div>
          <div class="step-body">
            <h2>选一下你的资料目录，我先检查一遍</h2>
            <p class="muted small">只在本地读文件名，不上传任何内容。</p>
            <div class="row">
              <label class="btn btn-primary btn-sm" for="setup-dir">选择资料目录…</label>
              <input id="setup-dir" type="file" webkitdirectory multiple hidden>
              <span class="muted small" id="setup-dir-msg">还没选</span>
            </div>
            <div id="setup-report"></div>
          </div>
        </section>

        <section class="panel panel-pad setup-step is-locked" id="setup-step3">
          <div class="step-no">3</div>
          <div class="step-body">
            <h2>跑这条命令</h2>
            <p class="setup-lock" id="setup-lock">先在第 2 步选一次资料目录 —— 自检通过后这一步才会解锁。</p>
            <p class="muted small">在插件目录里执行（就是你放 dsh-cet4 的那个文件夹，通常结尾是 <code>node_modules/dsh-cet4</code>）。把下面的路径换成你第 2 步选的目录。</p>
            <div class="row" style="margin-bottom:8px">
              <input id="setup-src" class="text setup-src" type="text" spellcheck="false" placeholder="资料目录的完整路径，例如 D:/CET-4" autocomplete="off" disabled>
              <button class="btn btn-sm" id="setup-copy" disabled>复制命令</button>
            </div>
            <p class="muted small" id="setup-src-hint">浏览器只会给出文件夹名，请把上面的路径补成完整路径（例如 <code>D:/CET-4</code>）。</p>
            <pre class="code" id="setup-cmd"></pre>
            <p class="muted small">题库默认写到 <code>~/.dsh/dsh-cet4/data</code>；想放别处就设环境变量 <code>CET4_DATA</code>。</p>
          </div>
        </section>

        <div class="setup-foot">
          <button class="btn btn-primary" id="setup-retry" disabled title="自检通过后可用">已生成，重新加载</button>
          ${
            msg
              ? `<details class="setup-why"><summary>看技术细节</summary><pre class="code">${esc(msg)}</pre></details>`
              : ''
          }
        </div>
      </div>`);

    if (voluntary) CET4.UI.backTo(() => CET4.App.home());
    else CET4.UI.hideBack();
    const srcEl = document.getElementById('setup-src');
    const cmdEl = document.getElementById('setup-cmd');
    const buildCmd = (src) => `cd <插件目录>\nnpm run build:data -- --src "${src || 'D:/CET-4'}"`;
    const refresh = () => {
      cmdEl.textContent = buildCmd((srcEl.value || '').trim().replace(/[\\/]+$/, ''));
    };
    srcEl.oninput = refresh;
    refresh();

    /* 第 3 步只在自检通过（ok / warn）后解锁，避免“还没选目录就能复制命令”的错位 */
    const step3 = document.getElementById('setup-step3');
    const lockEl = document.getElementById('setup-lock');
    const hintEl = document.getElementById('setup-src-hint');
    const copyEl = document.getElementById('setup-copy');
    const retryEl = document.getElementById('setup-retry');
    const applyCheck = (r) => {
      const pass = !!r && (r.verdict === 'ok' || r.verdict === 'warn');
      if (step3) step3.classList.toggle('is-locked', !pass);
      if (srcEl) srcEl.disabled = !pass;
      if (copyEl) copyEl.disabled = !pass;
      if (retryEl) {
        retryEl.disabled = !pass;
        retryEl.title = pass ? '' : '自检通过后可用';
      }
      if (lockEl) {
        lockEl.hidden = pass;
        if (!pass) {
          lockEl.textContent =
            r && r.verdict === 'bad'
              ? '自检没通过：把第 2 步标红的资料补齐，再重新选一次目录。'
              : '先在第 2 步选一次资料目录 —— 自检通过后这一步才会解锁。';
        }
      }
      if (hintEl) hintEl.hidden = !pass;
      if (pass && srcEl && !srcEl.value.trim()) srcEl.focus();
      return pass;
    };
    applyCheck(null);
    CET4.Setup._applyCheck = applyCheck;

    document.getElementById('setup-copy').onclick = async () => {
      const text = cmdEl.textContent;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        /* 非安全上下文里 clipboard 会被拒，退回选中让用户自己复制 */
        const r = document.createRange();
        r.selectNodeContents(cmdEl);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
      CET4.UI.toast('命令已复制');
    };

    document.getElementById('setup-retry').onclick = () => location.reload();

    /* 选目录 → 结构自检 */
    const dirEl = document.getElementById('setup-dir');
    const msgEl = document.getElementById('setup-dir-msg');
    const boxEl = document.getElementById('setup-report');
    dirEl.onchange = async () => {
      const files = [...dirEl.files];
      if (!files.length) return;
      msgEl.textContent = '检查中…';
      const entries = files.map((f) => ({ path: f.webkitRelativePath || f.name }));

      /* 只读答案 CSV 的前 512 字节，用来确认表头 —— 文件内容不出本机 */
      const pick = files.findIndex((f) => /(^|\/)0?2[^/]*\/[^/]*\.csv$/i.test(f.webkitRelativePath || ''));
      if (pick > -1) {
        try {
          entries[pick].text = await files[pick].slice(0, 512).text();
        } catch {
          /* 读不出来就当没读到，表头那一项不判 */
        }
      }

      const r = inspect(entries);
      msgEl.textContent = `${r.root || '已选目录'} · ${files.length} 个文件`;
      boxEl.innerHTML = reportHtml(r);
      const pass = applyCheck(r);
      /* 浏览器不给绝对路径，只把目录名填进命令里当占位，让用户改成完整路径 */
      if (pass && r.root && !srcEl.value.trim()) {
        srcEl.value = r.root;
        refresh();
      }
    };
  }

  CET4.Setup = { inspect, render, dirs: DIRS, _report: reportHtml };
})();
