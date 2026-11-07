/* 单词练习：背单词 / 记单词 / 默写（三种模式共用一个位置，切换不重置）
 *
 * “学过”是按单词记的（1500 ⊂ 4500），所以两套词表的进度天然一致。
 */
(function () {
  const CET4 = (window.CET4 = window.CET4 || {});
  const { esc } = CET4.util;

  const MODES = [
    { key: 'recall', label: '背单词', desc: '看词 → 想意思 → 点开核对' },
    { key: 'read', label: '记单词', desc: '词、释义、例句一起看' },
    { key: 'write', label: '默写', desc: '看释义拼单词，错的自动进错词本' },
  ];

  /** 默写提示：已给的首字母高亮，剩下的位置用下划线占位 */
  function maskHtml(word) {
    const n = CET4.util.hintOf(word).length;
    return [...word]
      .map((ch, i) => (i < n ? `<b>${esc(ch)}</b>` : '<span class="u">_</span>'))
      .join('');
  }

  /** 例句里把目标词挖空（整词匹配，避免 one 把 money 也打码） */
  function blankExample(ex, word) {
    if (!ex) return '';
    const safe = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return String(ex).replace(new RegExp(`\\b${safe}\\b`, 'ig'), '______');
  }

  const Vocab = (CET4.Vocab = {
    /* 单元选择 */
    async renderUnits(size) {
      CET4.UI.loading();
      const idx = await CET4.Data.index();
      const list = await CET4.Data.vocab(size);
      CET4.Store.migrateDone(size, list);
      const units = CET4.Data.unitCount(list.length, 100);
      const lib = CET4.Store.lib(size);
      const learnedAll = list.filter((w) => CET4.Store.isLearned(w.w)).length;
      const wrongAll = CET4.Store.wrongWords().filter((w) => (w.lib || 4500) === size).length;

      const cards = [];
      for (let u = 1; u <= units; u++) {
        const words = CET4.Data.unit(list, u, 100);
        const p = CET4.Store.progressOf(list, u);
        const first = words[0]?.id ?? 0;
        const last = words[words.length - 1]?.id ?? 0;
        const here = Number(lib.unit) === u;
        cards.push(`
          <div class="unit ${p.pct >= 100 ? 'done' : ''} ${here ? 'here' : ''}" data-unit="${u}">
            <div class="unit-top">
              <span class="unit-no">第 ${u} 单元</span>
              <span class="pill">${p.done}/${p.total}</span>
            </div>
            <div class="unit-range">编号 ${first} – ${last}</div>
            <div class="bar"><i style="width:${p.pct}%"></i></div>
          </div>`);
      }

      CET4.UI.set(`
        <div class="wrap">
          <div class="section-title">
            <h2>${size === 1500 ? '四级核心词汇（约 1500）' : '四级大纲词汇（约 4500）'}</h2>
            <span class="pill">${list.length} 词 · ${units} 个单元 · 每单元 100 词</span>
            <span class="spacer"></span>
            <button class="btn btn-ghost btn-sm" id="vocab-wrong">错词本 ${wrongAll ? `(${wrongAll})` : ''}</button>
            <button class="btn btn-ghost btn-sm" id="vocab-reset">重置练习位置</button>
          </div>
          <div class="summary-line">
            <span>已学 <b>${learnedAll}</b> / ${list.length}</span>
            <span class="muted">· 两套词表共用同一份「已学」记录，学过的词不会重复计数</span>
          </div>
          <div class="unit-grid">${cards.join('')}</div>
        </div>`);

      CET4.UI.backTo(() => CET4.App.home());
      document.querySelectorAll('.unit').forEach((el) => {
        el.onclick = () => Vocab.practice(size, Number(el.dataset.unit));
      });
      document.getElementById('vocab-wrong').onclick = () => CET4.Wrong.words(size);
      document.getElementById('vocab-reset').onclick = async () => {
        const ok = await CET4.UI.confirm({
          title: '重置练习位置',
          body: '只把“练到哪个词”归零，「已学」记录不受影响。',
          ok: '重置',
        });
        if (!ok) return;
        const st = CET4.Store.lib(size);
        st.pos = {};
        CET4.Store.save();
        Vocab.renderUnits(size);
      };
    },

    /* 练习 */
    async practice(size, unitNo, opts = {}) {
      const list = await CET4.Data.vocab(size);
      CET4.Store.migrateDone(size, list);
      const words = CET4.Data.unit(list, unitNo, 100);
      if (!words.length) {
        CET4.UI.toast('这个单元没有词');
        return;
      }
      const lib = CET4.Store.lib(size);
      lib.unit = unitNo;
      if (opts.mode) lib.mode = opts.mode;
      let pos = Math.min(Math.max(0, lib.pos[unitNo] || 0), words.length - 1);

      const savepos = () => {
        lib.pos[unitNo] = pos;
        CET4.Store.save();
      };

      const render = () => {
        const word = words[pos];
        const mode = lib.mode || 'recall';
        const p = CET4.Store.progressOf(list, unitNo);
        const starred = CET4.Store.notebookHas(word.w);
        const unlearnedAhead = words.findIndex((w, i) => i > pos && !CET4.Store.isLearned(w.w));

        const seg = MODES.map(
          (m) => `<button data-mode="${m.key}" class="${mode === m.key ? 'on' : ''}" title="${m.desc}">${m.label}</button>`
        ).join('');

        let body = '';
        if (mode === 'recall') {
          body = `
            <div class="word-big" id="word-toggle" title="点一下显示释义">${esc(word.w)}</div>
            ${word.ph ? `<div class="word-ph">/${esc(word.ph)}/</div>` : ''}
            <div class="stars" title="考频星级：★ 越多越常考">${'★'.repeat(word.stars || 0) || '<span class="muted">—</span>'}</div>
            <div class="reveal" id="word-reveal" hidden>
              <div class="def">${esc(word.def)}</div>
              ${word.ex ? `<div class="ex">${esc(word.ex)}${word.exCn ? `<span class="ex-cn">${esc(word.exCn)}</span>` : ''}</div>` : '<div class="ex-missing">这个词表没收录例句</div>'}
            </div>
            <div class="hint-click" id="word-hint">点单词或按 <kbd>空格</kbd> 显示释义</div>`;
        } else if (mode === 'read') {
          body = `
            <div class="word-big" id="word-toggle" title="点一下朗读">${esc(word.w)}</div>
            ${word.ph ? `<div class="word-ph">/${esc(word.ph)}/</div>` : ''}
            <div class="stars" title="考频星级：★ 越多越常考">${'★'.repeat(word.stars || 0) || '<span class="muted">—</span>'}</div>
            <div class="reveal">
              <div class="def">${esc(word.def)}</div>
              ${word.ex ? `<div class="ex">${esc(word.ex)}${word.exCn ? `<span class="ex-cn">${esc(word.exCn)}</span>` : ''}</div>` : '<div class="ex-missing">这个词表没收录例句</div>'}
            </div>`;
        } else {
          body = `
            <div class="dictation">
              <div class="def-big">${esc(word.def)}</div>
              ${word.ex ? `<div class="blank-line">${esc(blankExample(word.ex, word.w))}</div>` : '<div class="ex-missing">这个词表没收录例句</div>'}
              <div class="mask-hint">${maskHtml(word.w)}</div>
              <input class="text" id="dict-input" autocomplete="off" autocapitalize="off" spellcheck="false"
                     placeholder="输入后按 Enter" />
              <div class="verdict" id="dict-verdict"></div>
            </div>`;
        }

        CET4.UI.set(`
          <div class="practice">
            <div class="practice-head">
              <button class="btn btn-ghost btn-sm" id="p-back">← 单元</button>
              <div class="seg" id="mode-seg">${seg}</div>
              <span class="spacer" style="flex:1"></span>
              ${unlearnedAhead > 0 ? `<button class="btn btn-ghost btn-sm" id="p-jump" title="跳到本单元下一个没学过的词">跳到未学</button>` : ''}
              <span class="pill">第 ${pos + 1} / ${words.length} 词</span>
            </div>
            <div class="word-card">
              ${body}
              <div class="word-actions">
                <button class="btn btn-ghost" id="act-prev" ${pos === 0 ? 'disabled' : ''}>← 上一个</button>
                <button class="btn" id="act-speak" title="朗读单词">🔊 朗读</button>
                <button class="btn ${starred ? 'starred' : ''}" id="act-star">${starred ? '★ 已收藏' : '☆ 加入生词本'}</button>
                <button class="btn btn-primary btn-lg" id="act-next">下一个 →</button>
              </div>
            </div>
            <div class="progress-line">
              <span>单元已学</span>
              <div class="bar"><i style="width:${p.pct}%"></i></div>
              <span>${p.done}/${p.total}</span>
            </div>
          </div>`);

        CET4.UI.backTo(() => Vocab.renderUnits(size));
        document.getElementById('p-back').onclick = () => Vocab.renderUnits(size);
        const jump = document.getElementById('p-jump');
        if (jump)
          jump.onclick = () => {
            pos += unlearnedAhead;
            savepos();
            render();
          };

        document.querySelectorAll('#mode-seg button').forEach((b) => {
          b.onclick = () => {
            lib.mode = b.dataset.mode;
            CET4.Store.save();
            render();
          };
        });

        const toggle = document.getElementById('word-toggle');
        if (mode === 'recall') {
          toggle.onclick = () => {
            const r = document.getElementById('word-reveal');
            const hint = document.getElementById('word-hint');
            if (r) r.hidden = false;
            if (hint) hint.hidden = true;
          };
        } else if (mode === 'read') {
          toggle.onclick = () => CET4.util.speak(word.w);
        }

        document.getElementById('act-speak').onclick = () => CET4.util.speak(word.w);
        document.getElementById('act-prev').onclick = () => {
          if (pos > 0) {
            pos--;
            savepos();
            render();
          }
        };
        document.getElementById('act-next').onclick = () => next();
        document.getElementById('act-star').onclick = () => {
          if (CET4.Store.notebookHas(word.w)) {
            CET4.Store.removeNotebook(word.w);
            CET4.UI.toast('已从生词本移除');
          } else {
            CET4.Store.addNotebook({ w: word.w, def: word.def, ph: word.ph, lib: size, id: word.id });
            CET4.UI.toast('已加入生词本');
          }
          render();
        };

        /* 默写 */
        const input = document.getElementById('dict-input');
        if (input) {
          input.focus();
          input.onkeydown = (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const v = input.value.trim().toLowerCase();
            if (!v) return;
            const verdict = document.getElementById('dict-verdict');
            const ok = v === word.w.toLowerCase();
            if (ok) {
              CET4.Store.clearWrongWord(word.w);
              verdict.className = 'verdict ok';
              verdict.textContent = `✓ 正确：${word.w}`;
              setTimeout(() => next(), 480);
            } else {
              CET4.Store.markWrongWord({ w: word.w, def: word.def, ph: word.ph, lib: size });
              verdict.className = 'verdict bad';
              verdict.textContent = `✗ 正确答案：${word.w}（已收进错词本）`;
              input.style.borderColor = 'var(--bad)';
              setTimeout(() => {
                input.style.borderColor = '';
                input.select();
              }, 900);
            }
          };
        }
        CET4.UI.bindKeys(onKey);
      };

      const next = () => {
        CET4.Store.markWord(words[pos].w);
        if (pos < words.length - 1) {
          pos++;
          savepos();
        } else {
          pos = words.length - 1;
          savepos();
          CET4.UI.toast('这个单元已过完一遍 🎉');
        }
        render();
      };

      /** 键盘处理器要在每次 render 之后绑定：UI.set() 会清掉上一个视图的绑定 */
      const onKey = (e) => {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.code === 'Space' || e.key === 'ArrowRight') {
          e.preventDefault();
          if (lib.mode === 'recall') {
            const r = document.getElementById('word-reveal');
            if (r && r.hidden) {
              r.hidden = false;
              const hint = document.getElementById('word-hint');
              if (hint) hint.hidden = true;
              return;
            }
          }
          next();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (pos > 0) {
            pos--;
            savepos();
            render();
          }
        }
      };

      render();
    },

    /** 自定义词表练习（生词本 / 错词本 / 今日复习） */
    practiceWords(words, title = '复习', backFn, startMode = 'recall') {
      if (!words.length) {
        CET4.UI.toast('没有可复习的词');
        return;
      }
      let pos = 0;
      let mode = startMode;
      const render = () => {
        const word = words[pos];
        const seg = MODES.map(
          (m) => `<button data-mode="${m.key}" class="${mode === m.key ? 'on' : ''}" title="${m.desc}">${m.label}</button>`
        ).join('');
        let body = '';
        if (mode === 'write') {
          body = `
            <div class="dictation">
              <div class="def-big">${esc(word.def)}</div>
              ${word.ex ? `<div class="blank-line">${esc(blankExample(word.ex, word.w))}</div>` : '<div class="ex-missing">这个词表没收录例句</div>'}
              <div class="mask-hint">${maskHtml(word.w)}</div>
              <input class="text" id="dict-input" autocomplete="off" spellcheck="false" placeholder="输入后按 Enter" />
              <div class="verdict" id="dict-verdict"></div>
            </div>`;
        } else {
          body = `
            <div class="word-big" id="word-toggle">${esc(word.w)}</div>
            ${word.ph ? `<div class="word-ph">/${esc(word.ph)}/</div>` : ''}
            <div class="reveal" ${mode === 'recall' ? 'hidden id="word-reveal"' : ''}>
              <div class="def">${esc(word.def)}</div>
              ${word.ex ? `<div class="ex">${esc(word.ex)}${word.exCn ? `<span class="ex-cn">${esc(word.exCn)}</span>` : ''}</div>` : '<div class="ex-missing">这个词表没收录例句</div>'}
            </div>
            ${mode === 'recall' ? '<div class="hint-click" id="word-hint">点单词或按 <kbd>空格</kbd> 显示释义</div>' : ''}`;
        }
        CET4.UI.set(`
          <div class="practice">
            <div class="practice-head">
              <button class="btn btn-ghost btn-sm" id="p-back">← 返回</button>
              <div class="seg" id="mode-seg">${seg}</div>
              <span style="flex:1"></span>
              <span class="pill">${esc(title)} · ${pos + 1}/${words.length}</span>
            </div>
            <div class="word-card">
              ${body}
              <div class="word-actions">
                <button class="btn btn-ghost" id="act-prev" ${pos === 0 ? 'disabled' : ''}>← 上一个</button>
                <button class="btn" id="act-speak" title="朗读单词">🔊 朗读</button>
                <button class="btn btn-primary btn-lg" id="act-next">下一个 →</button>
              </div>
            </div>
          </div>`);
        const back = backFn || (() => CET4.Notebook.render());
        CET4.UI.backTo(back);
        document.querySelectorAll('#mode-seg button').forEach((b) => {
          b.onclick = () => {
            mode = b.dataset.mode;
            render();
          };
        });
        document.getElementById('p-back').onclick = back;
        document.getElementById('act-speak').onclick = () => CET4.util.speak(word.w);
        document.getElementById('act-prev').onclick = () => {
          if (pos > 0) {
            pos--;
            render();
          }
        };
        document.getElementById('act-next').onclick = () => {
          CET4.Store.touchWord(word.w);
          if (pos < words.length - 1) pos++;
          else CET4.UI.toast('复习完成 🎉');
          render();
        };
        const tg = document.getElementById('word-toggle');
        if (tg)
          tg.onclick = () => {
            if (mode === 'recall') {
              const r = document.getElementById('word-reveal');
              if (r) r.hidden = false;
              const h = document.getElementById('word-hint');
              if (h) h.hidden = true;
            } else CET4.util.speak(word.w);
          };
        const input = document.getElementById('dict-input');
        if (input) {
          input.focus();
          input.onkeydown = (e) => {
            if (e.key !== 'Enter') return;
            const v = input.value.trim().toLowerCase();
            if (!v) return;
            const verdict = document.getElementById('dict-verdict');
            if (v === word.w.toLowerCase()) {
              verdict.className = 'verdict ok';
              verdict.textContent = `✓ 正确：${word.w}`;
              setTimeout(() => {
                if (pos < words.length - 1) pos++;
                render();
              }, 480);
            } else {
              verdict.className = 'verdict bad';
              verdict.textContent = `✗ 正确答案：${word.w}`;
            }
          };
        }
        CET4.UI.bindKeys((e) => {
          const tag = e.target && e.target.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA') return;
          if (e.code === 'Space' || e.key === 'ArrowRight') {
            e.preventDefault();
            const r = document.getElementById('word-reveal');
            if (mode === 'recall' && r && r.hidden) {
              r.hidden = false;
              const h = document.getElementById('word-hint');
              if (h) h.hidden = true;
              return;
            }
            if (pos < words.length - 1) pos++;
            render();
          }
        });
      };
      render();
    },
  });
})();
