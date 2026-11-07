/* 生词本：列表 / 搜索 / 复习 / 导出 / 导入 */
(function () {
  const CET4 = (window.CET4 = window.CET4 || {});
  const { esc } = CET4.util;
  let query = '';

  const N = (CET4.Notebook = {
    render() {
      const list = CET4.Store.state.notebook;
      const kw = query.trim().toLowerCase();
      const filtered = kw
        ? list.filter((x) => x.w.toLowerCase().includes(kw) || (x.def || '').toLowerCase().includes(kw))
        : list;

      const items = filtered
        .map(
          (x) => `
        <div class="nb-item">
          <div class="w">${esc(x.w)}</div>
          <div class="pill">${x.ph ? '/' + esc(x.ph) + '/' : ''} ${x.lib === 1500 ? '核心 1500' : x.lib === 4500 ? '大纲 4500' : ''}</div>
          <div class="d">${esc(x.def)}</div>
          <div class="foot">
            <button class="btn btn-ghost btn-sm" data-say="${esc(x.w)}" title="朗读">🔊</button>
            <button class="btn btn-ghost btn-sm" data-del="${esc(x.w)}">移除</button>
          </div>
        </div>`
        )
        .join('');

      CET4.UI.set(`
        <div class="wrap">
          <div class="section-title">
            <h2>生词本</h2>
            <span class="pill">${list.length} 个词</span>
            <span class="spacer"></span>
            <input class="text" id="nb-search" style="max-width:200px;font-size:14px;text-align:left;padding:7px 12px"
                   placeholder="搜索单词或释义" value="${esc(query)}" />
            <button class="btn btn-primary btn-sm" id="nb-review" ${list.length ? '' : 'disabled'}>开始复习</button>
            <button class="btn btn-sm" id="nb-export" ${list.length ? '' : 'disabled'}>导出</button>
            <button class="btn btn-sm" id="nb-import">导入</button>
            <input type="file" id="nb-file" accept="application/json,.json" hidden />
          </div>
          ${
            list.length
              ? filtered.length
                ? `<div class="nb-list">${items}</div>`
                : CET4.UI.empty('🔎', '没找到匹配的词')
              : CET4.UI.empty('📌', '生词本还是空的', '在背单词/记单词/默写时点 ☆ 就能把词收进来')
          }
        </div>`);
      CET4.UI.backTo(() => CET4.App.home());

      const search = document.getElementById('nb-search');
      search.oninput = () => {
        query = search.value;
        const pos = search.selectionStart;
        N.render();
        const s2 = document.getElementById('nb-search');
        if (s2) {
          s2.focus();
          s2.setSelectionRange(pos, pos);
        }
      };
      document.querySelectorAll('[data-say]').forEach((b) => {
        b.onclick = () => CET4.util.speak(b.dataset.say);
      });
      document.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = () => {
          CET4.Store.removeNotebook(b.dataset.del);
          N.render();
        };
      });
      const rv = document.getElementById('nb-review');
      if (rv)
        rv.onclick = () => {
          const words = CET4.util.shuffle(list).map((x) => ({ w: x.w, ph: x.ph, def: x.def, stars: 0, ex: '', exCn: '' }));
          CET4.Vocab.practiceWords(words, '生词本复习', () => N.render());
        };
      const ex = document.getElementById('nb-export');
      if (ex)
        ex.onclick = () => {
          const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `cet4-生词本-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        };
      const im = document.getElementById('nb-import');
      const file = document.getElementById('nb-file');
      im.onclick = () => file.click();
      file.onchange = async () => {
        const f = file.files?.[0];
        if (!f) return;
        try {
          const arr = JSON.parse(await f.text());
          if (!Array.isArray(arr)) throw new Error('文件里不是数组');
          const clean = arr
            .filter((x) => x && typeof x.w === 'string' && x.w.trim())
            .map((x) => ({
              w: x.w.trim(),
              def: String(x.def || ''),
              ph: String(x.ph || ''),
              lib: x.lib === 1500 || x.lib === 4500 ? x.lib : undefined,
            }));
          const n = CET4.Store.addNotebookBulk(clean);
          CET4.UI.toast(n ? `已导入 ${n} 个词` : '没有新词（都已在生词本里）');
          N.render();
        } catch (e) {
          CET4.UI.toast(`导入失败：${e.message}`);
        }
      };
    },
  });
})();
