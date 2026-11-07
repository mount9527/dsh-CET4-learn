/* 入口：首页（模块选择）+ 设置 + 主题 */
(function () {
  const CET4 = (window.CET4 = window.CET4 || {});
  const { esc } = CET4.util;

  const V1500 = 1500;
  const VFULL = 4500;

  CET4.Theme = {
    apply(mode) {
      const m = mode || CET4.Store.state.meta.theme || 'auto';
      const dark = m === 'dark' || (m === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      const btn = document.getElementById('btn-theme');
      if (btn) {
        btn.textContent = dark ? '☀️' : '🌙';
        btn.title = dark ? '切到浅色' : '切到深色';
      }
    },
    toggle() {
      const cur = document.documentElement.dataset.theme === 'dark';
      CET4.Store.state.meta.theme = cur ? 'light' : 'dark';
      CET4.Store.save();
      this.apply();
    },
  };

  const App = (CET4.App = {
    idx: null,

    async home() {
      const st = CET4.Store.state;
      let idx = App.idx;
      if (!idx) {
        try {
          idx = App.idx = await CET4.Data.index();
        } catch (e) {
          App.dataError(e);
          return;
        }
      }

      /* 词表加载一次：换算老版本的进度、给「今日复习」建索引
         —— 示例题库只有一套词表，所以第二套要按 index.json 的声明来决定加不加载 */
      const vocabMeta = idx.vocab || {};
      const hasFull = !!vocabMeta[VFULL];
      const coreLabel = vocabMeta[V1500]?.label || '核心词';
      const fullLabel = vocabMeta[VFULL]?.label || '大纲词';
      const isStarter = idx.kind === 'starter';
      let v1500 = [];
      let vFull = [];
      try {
        v1500 = await CET4.Data.vocab(V1500);
        CET4.Store.migrateDone(V1500, v1500);
        if (hasFull) {
          vFull = await CET4.Data.vocab(VFULL);
          CET4.Store.migrateDone(VFULL, vFull);
        }
      } catch (e) {
        App.dataError(e);
        return;
      }
      const wordTotal = vFull.length || v1500.length;

      const learned = CET4.Store.learnedCount();
      const nb = st.notebook.length;
      const wrongWords = CET4.Store.wrongWords().length;
      const wrongQuiz = st.wrongBook.length;
      const quizDone = Object.values(st.quiz).filter((r) => r && r.submitted).length;
      const listenDone = Object.entries(st.quiz).filter(([k, r]) => k.endsWith(':listening') && r?.submitted).length;
      const units1500 = CET4.Data.unitCount(v1500.length);
      const unitsFull = CET4.Data.unitCount(vFull.length);
      const finished = (list, units) => {
        let n = 0;
        for (let u = 1; u <= units; u++) if (CET4.Store.progressOf(list, u).pct >= 100) n++;
        return n;
      };
      const est = CET4.Quiz.estimate();
      const days = CET4.util.daysUntil(st.meta.examDate);
      const due = CET4.Store.reviewDue(1);
      App._wordMap = new Map((vFull.length ? vFull : v1500).map((w) => [w.w.toLowerCase(), w]));

      const audioPapers = idx.papers.filter((p) => p.hasAudio).length;
      const audioFiles = idx.audio?.files || 0;
      const synthPapers = idx.audio?.synth || idx.papers.filter((p) => p.synth).length;

      CET4.UI.set(`
        <div class="wrap">
          <div class="hero">
            ${
              isStarter
                ? `<div class="starter-tip">
                     <span class="starter-badge">示例</span>
                     <span>现在用的是插件自带的示例内容：426 个自编核心词 + 1 套原创模拟卷（听力由系统语音朗读），<b>不是真题</b>。</span>
                     <button class="btn btn-ghost btn-sm" id="go-setup">换成我的真题 →</button>
                   </div>`
                : ''
            }
            <h1>今天练哪一块？</h1>
            <p>词汇、听力、阅读、翻译、写作都在这一块面板里 · 进度与作答记录只保存在本机</p>
            <div class="hero-stats">
              <div class="st"><b>${learned}</b>已学单词 / ${wordTotal}</div>
              <div class="st"><b>${quizDone}</b>份已交卷</div>
              <div class="st"><b>${nb}</b>生词本</div>
              <div class="st"><b>${due.length}</b>今日待复习</div>
              <div class="st"><b>${wrongWords + wrongQuiz}</b>待巩固（错词 ${wrongWords} · 错题 ${wrongQuiz}）</div>
              ${
                est.objectiveFull
                  ? `<div class="st"><b>${est.objective}</b>客观题估分 / ${est.objectiveFull}</div>`
                  : ''
              }
              ${
                days != null
                  ? `<div class="st"><b>${days >= 0 ? days : '—'}</b>${days >= 0 ? '天后考试' : '考试日期已过'}</div>`
                  : `<div class="st muted">还没设考试日期，点右上角 ⚙ 设一个</div>`
              }
            </div>
          </div>

          <div class="grid">
            <div class="card" data-go="v1500">
              <div class="card-icon">🔤</div>
              <h3>${esc(coreLabel)}</h3>
              <p>四级高频词，背单词 / 记单词 / 默写三种模式，中途切换不重置位置。</p>
              <div class="card-meta">
                <span class="tag">${v1500.length} 词 · ${units1500} 单元</span>
                <span class="tag ${finished(v1500, units1500) ? 'ok' : ''}">已过完 ${finished(v1500, units1500)} 单元</span>
              </div>
            </div>
            ${
              hasFull
                ? `<div class="card" data-go="vfull">
              <div class="card-icon">📚</div>
              <h3>${esc(fullLabel)}</h3>
              <p>完整大纲词表，同样的三种模式，每 100 词一个单元。</p>
              <div class="card-meta">
                <span class="tag">${vFull.length} 词 · ${unitsFull} 单元</span>
                <span class="tag ${finished(vFull, unitsFull) ? 'ok' : ''}">已过完 ${finished(vFull, unitsFull)} 单元</span>
              </div>
            </div>`
                : ''
            }
            <div class="card" data-go="listening">
              <div class="card-icon">🎧</div>
              <h3>${isStarter ? '听力练习' : '听力真题'}</h3>
              <p>${
                isStarter
                  ? '原创模拟卷，系统语音朗读，可按篇分听，25 题作答，交卷对答案。'
                  : '本地录音可按篇目跳听，25 题作答，交卷对答案，原文随时对照。'
              }</p>
              <div class="card-meta">
                <span class="tag">${audioPapers} 套可听${audioFiles ? ` · ${audioFiles} 份录音` : ''}</span>
                ${synthPapers ? `<span class="tag">${synthPapers} 套语音合成</span>` : ''}
                <span class="tag ${listenDone ? 'ok' : ''}">已交卷 ${listenDone}</span>
              </div>
            </div>
            <div class="card" data-go="quiz">
              <div class="card-icon">🎯</div>
              <h3>随机题测试</h3>
              <p>选词填空 / 长篇阅读 / 仔细阅读，随机抽卷，作答计时并自动保存。</p>
              <div class="card-meta">
                <span class="tag">3 种题型</span>
                <span class="tag ${quizDone ? 'ok' : ''}">${quizDone} 份已交卷</span>
              </div>
            </div>
            <div class="card" data-go="translate">
              <div class="card-icon">✂️</div>
              <h3>片段翻译</h3>
              <p>部分翻译练句子，全篇翻译练整段，译文自动保存、带计时。</p>
              <div class="card-meta">
                <span class="tag">${idx.papers.filter((p) => p.hasTranslation).length} 套</span>
                <span class="tag">只作答</span>
              </div>
            </div>
            <div class="card" data-go="writing">
              <div class="card-icon">📝</div>
              <h3>作文书写</h3>
              <p>随机抽写作题，30 分钟倒计时，实时统计词数与句数。</p>
              <div class="card-meta">
                <span class="tag">${idx.papers.filter((p) => p.hasWriting).length} 套</span>
                <span class="tag">120–180 词</span>
              </div>
            </div>
            <div class="card" data-go="notebook">
              <div class="card-icon">📌</div>
              <h3>生词本</h3>
              <p>练习时点 ☆ 收词，随时复习、搜索、导入导出。</p>
              <div class="card-meta"><span class="tag ${nb ? 'ok' : ''}">${nb} 个词</span></div>
            </div>
            <div class="card" data-go="wrong">
              <div class="card-icon">📕</div>
              <h3>错词 / 错题本</h3>
              <p>默写错词、交卷错题自动归档，可以单独重练或回到原卷重做。</p>
              <div class="card-meta">
                <span class="tag ${wrongWords ? 'warn' : ''}">错词 ${wrongWords}</span>
                <span class="tag ${wrongQuiz ? 'warn' : ''}">错题 ${wrongQuiz}</span>
              </div>
            </div>
            <div class="card" data-go="review">
              <div class="card-icon">🔁</div>
              <h3>今日复习</h3>
              <p>学过但隔天没再碰过的词，用默写过一遍，刷新记忆时间。</p>
              <div class="card-meta">
                <span class="tag ${due.length ? 'warn' : 'ok'}">${due.length ? `${due.length} 个待复习` : '今天没有到期的词'}</span>
              </div>
            </div>
          </div>

          <p class="muted" style="margin-top:22px;font-size:12.5px;line-height:1.8">
            ${
              isStarter
                ? '当前显示的是插件内置的示例内容：原创模拟卷与自编词表，不含任何真题、真题录音或真题答案；听力由操作系统语音合成实时朗读，包内没有音频文件。点「换成我的真题」可导入自备资料，版权仍归原权利人。'
                : '非官方学习工具：题目、录音与词汇资料均由使用者自行准备并保存在本机，本插件不附带任何真题内容；资料版权归原权利人，请仅用于个人学习。点右上角 ⚙ 可查看资料来源与免责说明。'
            }
          </p>
        </div>`);

      const setupBtn = document.getElementById('go-setup');
      if (setupBtn) setupBtn.onclick = () => CET4.Setup.render();

      CET4.UI.hideBack();
      document.querySelectorAll('.card[data-go]').forEach((el) => {
        el.onclick = () => {
          const go = el.dataset.go;
          if (go === 'v1500') CET4.Vocab.renderUnits(V1500);
          else if (go === 'vfull') CET4.Vocab.renderUnits(VFULL);
          else if (go === 'listening') CET4.Listening.renderMenu();
          else if (go === 'quiz') CET4.Quiz.renderMenu();
          else if (go === 'translate') CET4.Translate.renderMenu();
          else if (go === 'writing') CET4.Writing.start();
          else if (go === 'notebook') CET4.Notebook.render();
          else if (go === 'wrong') App.wrongHome();
          else if (go === 'review') App.review();
        };
      });
    },

    /** 今日复习：学过但超过一天没碰的词，默认进默写模式 */
    async review() {
      const due = CET4.Store.reviewDue(1);
      if (!due.length) {
        CET4.UI.toast('今天没有到期的词 🎉');
        return;
      }
      let map = App._wordMap;
      if (!map) {
        const idx = App.idx || (await CET4.Data.index());
        const list = idx.vocab?.[VFULL] ? await CET4.Data.vocab(VFULL) : await CET4.Data.vocab(V1500);
        map = new Map(list.map((w) => [w.w.toLowerCase(), w]));
        App._wordMap = map;
      }
      const words = due
        .map((w) => map.get(w))
        .filter(Boolean)
        .map((w) => ({ w: w.w, def: w.def, ph: w.ph, stars: w.stars, ex: w.ex, exCn: w.exCn }));
      if (!words.length) {
        CET4.UI.toast('这些词不在当前词表里');
        return;
      }
      CET4.Vocab.practiceWords(words.slice(0, 60), '今日复习', () => App.home(), 'write');
    },

    async wrongHome() {
      const st = CET4.Store.state;
      const words = CET4.Store.wrongWords().length;
      const quiz = st.wrongBook.length;
      CET4.UI.set(`
        <div class="wrap">
          <div class="section-title"><h2>待巩固</h2>
            <span class="pill">错词 ${words} · 错题 ${quiz}</span></div>
          <div class="grid">
            <div class="card" data-open="words">
              <div class="card-icon">✍️</div>
              <h3>错词本</h3>
              <p>默写打错的词，按词库过滤，可单独拉出来默写重练。</p>
              <div class="card-meta"><span class="tag ${words ? 'warn' : ''}">${words} 个</span></div>
            </div>
            <div class="card" data-open="quiz">
              <div class="card-icon">📕</div>
              <h3>错题本</h3>
              <p>交卷答错的题，按题型归档，可回原卷重做，答对自动销账。</p>
              <div class="card-meta"><span class="tag ${quiz ? 'warn' : ''}">${quiz} 道</span></div>
            </div>
          </div>
        </div>`);
      CET4.UI.backTo(() => App.home());
      document.querySelectorAll('[data-open]').forEach((el) => {
        el.onclick = () => (el.dataset.open === 'words' ? CET4.Wrong.words() : CET4.Wrong.render());
      });
    },

    dataError(e) {
      /* 交给引导页：那里会区分「还没生成题库」和「题库读坏了」，并给出可照着做的三步 */
      if (CET4.Setup) {
        CET4.Setup.render(e);
        return;
      }
      CET4.UI.set(`
        <div class="wrap">
          <div class="panel panel-pad">
            <h2 style="margin-top:0">题库没加载出来</h2>
            <p class="muted">${esc(e.message || e)}</p>
            <button class="btn btn-primary" id="retry">重试</button>
          </div>
        </div>`);
      document.getElementById('retry').onclick = () => location.reload();
    },

    settings() {
      const st = CET4.Store.state;
      const src = App.idx?.source || '';
      const srcName = src ? src.split(/[\\/]/).filter(Boolean).pop() || src : '（未读取到题库）';
      const generated = App.idx?.generatedAt ? new Date(App.idx.generatedAt).toLocaleString() : '—';
      CET4.UI.open({
        title: '设置',
        wide: true,
        body: `
          <div class="settings-grid">
            <div>
              <h4>学习节奏</h4>
              <label class="field"><span>考试日期（首页显示倒计时）</span>
                <input class="text" id="set-exam" type="date" style="font-size:14px;text-align:left" value="${esc(st.meta.examDate || '')}" /></label>
              <label class="field"><span>主题</span>
                <select class="text" id="set-theme" style="font-size:14px;text-align:left">
                  <option value="auto" ${st.meta.theme === 'auto' ? 'selected' : ''}>跟随系统</option>
                  <option value="light" ${st.meta.theme === 'light' ? 'selected' : ''}>浅色</option>
                  <option value="dark" ${st.meta.theme === 'dark' ? 'selected' : ''}>深色</option>
                </select></label>
              <div class="muted" style="font-size:12.5px;line-height:1.7">
                学习记录存在浏览器 localStorage（键 <code>cet4.state.v4</code>），不上传任何服务器。
                清空后不可恢复。
              </div>
            </div>
            <div>
              <h4>题库来源</h4>
              ${
                App.idx?.kind === 'starter'
                  ? `<div class="src-line">
                       <span>当前：<b>内置示例题库</b></span>
                       <span class="starter-badge">示例</span>
                     </div>
                     <p class="muted" style="font-size:12.5px;line-height:1.8;margin-top:8px">
                       示例内容随插件分发：426 个自编核心词 + 1 套原创模拟卷。听力由系统语音合成朗读，
                       包里没有任何音频文件，也不含任何真题内容。
                     </p>
                     <p class="muted" style="font-size:12.5px;line-height:1.8;margin-top:6px">
                       想换成自己的真题，按引导页把 01–05 资料准备好并构建到用户目录即可，示例会自动让位。
                     </p>
                     <button class="btn btn-primary btn-sm" id="set-setup" style="margin-top:10px">准备我自己的真题</button>`
                  : `<div class="src-line">
                       <span>资料目录：<b>${esc(srcName)}</b></span>
                       <button class="btn btn-ghost btn-sm" id="set-reveal">显示完整路径</button>
                     </div>
                     <div class="src-full" id="set-full" hidden><code>${esc(src)}</code></div>
                     <div class="muted" style="font-size:12.5px;line-height:1.8;margin-top:8px">
                       生成时间：${esc(generated)}
                     </div>
                     <p class="muted" style="font-size:12.5px;line-height:1.8;margin-top:10px">
                       本插件只带代码，不带任何真题、录音与词汇数据；题库由使用者在自己的资料目录上运行
                       <code>npm run build:data</code> 生成。资料版权归原权利人，请仅用于个人学习。
                     </p>`
              }
            </div>
          </div>
          <div class="row" style="margin-top:6px">
            <button class="btn btn-primary btn-sm" id="set-save">保存</button>
            <span class="muted" id="set-msg" style="font-size:12.5px"></span>
          </div>
          <div class="danger-zone">
            <div>
              <b>清空所有学习数据</b>
              <p class="muted">删除学习进度、生词本、错词错题、作答记录与草稿，不可恢复。</p>
            </div>
            <button class="btn btn-danger btn-sm" id="set-reset">全部清空</button>
          </div>`,
      });
      setTimeout(() => {
        const save = document.getElementById('set-save');
        if (!save) return;
        const reveal = document.getElementById('set-reveal');
        if (reveal)
          reveal.onclick = () => {
            const box = document.getElementById('set-full');
            if (!box) return;
            box.hidden = !box.hidden;
            reveal.textContent = box.hidden ? '显示完整路径' : '收起';
          };
        const setupBtn = document.getElementById('set-setup');
        if (setupBtn)
          setupBtn.onclick = () => {
            document.getElementById('modal').hidden = true;
            CET4.Setup.render();
          };
        save.onclick = () => {
          st.meta.examDate = document.getElementById('set-exam').value;
          st.meta.theme = document.getElementById('set-theme').value;
          CET4.Store.save();
          CET4.Theme.apply(st.meta.theme);
          CET4.UI.toast('已保存');
          document.getElementById('modal').hidden = true;
          App.home();
        };
        document.getElementById('set-reset').onclick = async () => {
          const ok = await CET4.UI.confirm({
            title: '清空所有数据',
            body: '将删除学习进度、生词本、错词错题、作答记录与草稿（不可恢复）。',
            ok: '全部清空',
            danger: true,
          });
          if (!ok) return;
          CET4.Store.reset();
          location.reload();
        };
      }, 30);
    },
  });

  /* 启动 */
  document.addEventListener('DOMContentLoaded', () => {
    CET4.Store.load();
    CET4.Theme.apply();
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
        if (CET4.Store.state.meta.theme === 'auto') CET4.Theme.apply('auto');
      });
    }
    document.getElementById('btn-settings').onclick = () => App.settings();
    const themeBtn = document.getElementById('btn-theme');
    if (themeBtn) themeBtn.onclick = () => CET4.Theme.toggle();
    App.home();
  });
})();
