/* 片段翻译：部分翻译（随机抽 1–2 句） / 全篇翻译。
 *
 * 只提供作答：题库里没有参考译文，这里也不生成，避免把不可靠的译文当标准答案。
 * 译文与用时都存在本地，退出后可以接着写。
 */
(function () {
  const CET4 = (window.CET4 = window.CET4 || {});
  const { esc } = CET4.util;

  const LIMIT = { part: 5 * 60 * 1000, full: 30 * 60 * 1000 };

  const T = (CET4.Translate = {
    async renderMenu() {
      CET4.UI.loading();
      const papers = await CET4.Data.papersMeta();
      const pool = papers.filter((p) => p.hasTranslation);
      const drafts = Object.keys(CET4.Store.state.translate).filter((k) => /^t:/.test(k)).length;

      CET4.UI.set(`
        <div class="wrap">
          <div class="section-title">
            <h2>片段翻译</h2>
            <span class="pill">题库 ${pool.length} 套 · 中译英</span>
            <span class="spacer"></span>
            ${drafts ? `<span class="pill">已有 ${drafts} 篇草稿</span>` : ''}
          </div>
          <div class="grid">
            <div class="card" data-mode="partial">
              <div class="card-icon">✂️</div>
              <h3>部分翻译</h3>
              <p>从真题翻译里随机抽 1–2 句来译，练句子处理最有效。</p>
              <div class="card-meta"><span class="tag">建议 5 分钟</span><span class="tag">自动保存</span></div>
            </div>
            <div class="card" data-mode="full">
              <div class="card-icon">📄</div>
              <h3>全翻译</h3>
              <p>抽一整段真题翻译（约 150–200 字），练整篇的表达与连贯。</p>
              <div class="card-meta"><span class="tag">建议 30 分钟</span><span class="tag">带计时</span></div>
            </div>
          </div>
          <p class="muted" style="margin-top:18px">
            题库只收录题目，不含参考译文；写完后可以对照真题原文自查，或交给老师/同学互评。计时只做参考，不会强制交卷。
          </p>
        </div>`);
      CET4.UI.backTo(() => CET4.App.home());
      document.querySelectorAll('.card[data-mode]').forEach((el) => {
        el.onclick = () => T.start(el.dataset.mode === 'full');
      });
    },

    async start(full) {
      CET4.UI.loading('抽题中…');
      const papers = await CET4.Data.papersMeta();
      const pool = papers.filter((p) => p.hasTranslation);
      if (!pool.length) {
        CET4.UI.set(`<div class="wrap">${CET4.UI.empty('✂️', '题库里还没有翻译题')}</div>`);
        return;
      }
      const last = CET4.Store.state.translate.__last;
      const fresh = pool.filter((p) => p.id !== last);
      const meta = CET4.util.pick(fresh.length ? fresh : pool);
      CET4.Store.state.translate.__last = meta.id;
      CET4.Store.save();
      const paper = await CET4.Data.paper(meta.id);

      const cnAll = paper.translation?.cn || '';
      const sentences = CET4.util.sentences(cnAll);
      let cnText = cnAll;
      let segLabel = '全篇';
      let segIndex = -1;

      if (!full && sentences.length > 1) {
        const count = sentences.length >= 6 && Math.random() < 0.5 ? 2 : 1;
        const startIdx = Math.floor(Math.random() * Math.max(1, sentences.length - count + 1));
        segIndex = startIdx;
        cnText = sentences.slice(startIdx, startIdx + count).join('');
        segLabel = `第 ${startIdx + 1}${count > 1 ? `–${startIdx + count}` : ''} 句`;
      }

      const key = `t:${paper.id}:${full ? 'full' : segIndex}`;
      const draft = CET4.Store.state.translate[key] || { text: '' };
      CET4.Store.state.translate[key] = draft;
      const limit = full ? LIMIT.full : LIMIT.part;

      CET4.UI.set(`
        <div class="wrap">
          <div class="section-title">
            <h2>${full ? '全篇翻译' : '部分翻译'}</h2>
            <span class="pill">${esc(paper.title)} · ${esc(segLabel)}</span>
            <span class="spacer"></span>
            <span class="timer" id="tr-timer" title="建议 ${Math.round(limit / 60000)} 分钟">00:00</span>
            <button class="btn btn-ghost btn-sm" id="re-draw">换一篇</button>
          </div>
          <div class="split">
            <div class="panel panel-pad">
              <div class="section-title"><h2 style="font-size:15px">中文原文</h2></div>
              <div class="cn-text">${esc(cnText)}</div>
            </div>
            <div class="panel panel-pad">
              <div class="section-title"><h2 style="font-size:15px">你的译文</h2><span class="spacer"></span>
                <span class="pill" id="word-count">0 词</span>
              </div>
              <textarea class="text" id="tr-input" placeholder="在这里写英文译文…">${esc(draft.text || '')}</textarea>
              <div class="row" style="margin-top:12px">
                <button class="btn btn-ghost btn-sm" id="btn-clear">清空</button>
                <span class="muted" style="font-size:12.5px">内容会自动保存到本机</span>
              </div>
            </div>
          </div>
        </div>`);
      CET4.UI.backTo(() => T.renderMenu());

      const input = document.getElementById('tr-input');
      const countEl = document.getElementById('word-count');
      const updateCount = () => {
        const n = (input.value.trim().match(/[A-Za-z'’]+/g) || []).length;
        countEl.textContent = `${n} 词`;
      };
      updateCount();
      input.oninput = () => {
        updateCount();
        draft.text = input.value;
        CET4.Store.save();
      };

      /* 计时：切走就停，回来继续 */
      const timer = CET4.Timer.start({
        from: draft.elapsed || 0,
        limit,
        onTick: (ms) => {
          const el = document.getElementById('tr-timer');
          if (!el) return;
          el.textContent = CET4.util.fmtTime(ms);
          el.classList.toggle('over', ms > limit);
          draft.elapsed = ms;
        },
      });
      CET4.UI.onLeave(() => {
        timer.stop();
        draft.elapsed = timer.total;
        CET4.Store.save();
      });

      document.getElementById('btn-clear').onclick = async () => {
        const ok = await CET4.UI.confirm({ title: '清空译文', body: '只清空这一篇的草稿内容。', ok: '清空' });
        if (!ok) return;
        input.value = '';
        draft.text = '';
        updateCount();
        CET4.Store.save();
      };
      document.getElementById('re-draw').onclick = () => T.start(full);
    },
  });
})();
