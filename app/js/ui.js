/* 轻量 DOM 助手：toast / 弹窗 / 片段渲染 / 视图级键盘绑定 */
(function () {
  const CET4 = (window.CET4 = window.CET4 || {});
  const view = () => document.getElementById('view');

  /** 当前视图的键盘处理器；换视图时统一解绑，避免上一页的空格键把页面拽回去 */
  let keyHandler = null;
  function bindKeys(fn) {
    document.removeEventListener('keydown', keyHandler, true);
    keyHandler = fn;
    document.addEventListener('keydown', keyHandler, true);
  }
  function clearKeys() {
    if (!keyHandler) return;
    document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }

  const UI = (CET4.UI = {
    h(html) {
      const t = document.createElement('template');
      t.innerHTML = html.trim();
      return t.content.firstElementChild;
    },
    set(html) {
      if (CET4.UI._cleanup) {
        try {
          CET4.UI._cleanup();
        } catch (e) {
          /* 清理失败不影响渲染 */
        }
        CET4.UI._cleanup = null;
      }
      clearKeys();
      const v = view();
      v.innerHTML = html;
      v.scrollTop = 0;
      return v;
    },
    /** 下一个视图渲染前做点收尾（停表、解绑事件） */
    onLeave(fn) {
      CET4.UI._cleanup = fn;
    },
    bindKeys,
    clearKeys,
    loading(text = '加载中…') {
      this.set(`<div class="loading"><div class="spin"></div>${CET4.util.esc(text)}</div>`);
    },
    toast(msg, ms = 1800) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.hidden = false;
      requestAnimationFrame(() => el.classList.add('show'));
      clearTimeout(this._t);
      this._t = setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => (el.hidden = true), 220);
      }, ms);
    },
    /** options: { title, body(html), ok, cancel, danger } → Promise<boolean> */
    confirm({ title, body = '', ok = '确定', cancel = '取消', danger = false }) {
      const box = document.getElementById('modal-box');
      const modal = document.getElementById('modal');
      box.innerHTML = `
        <h3>${CET4.util.esc(title)}</h3>
        ${body ? `<p>${body}</p>` : ''}
        <div class="modal-actions">
          <button class="btn" data-act="cancel">${CET4.util.esc(cancel)}</button>
          <button class="btn btn-primary ${danger ? 'btn-danger' : ''}" data-act="ok">${CET4.util.esc(ok)}</button>
        </div>`;
      modal.hidden = false;
      return new Promise((resolve) => {
        const done = (v) => {
          modal.hidden = true;
          modal.onclick = null;
          setTimeout(() => {
            if (modal.hidden) box.innerHTML = '';
          }, 240);
          resolve(v);
        };
        box.querySelector('[data-act="cancel"]').onclick = () => done(false);
        box.querySelector('[data-act="ok"]').onclick = () => done(true);
        modal.onclick = (e) => {
          if (e.target === modal) done(false);
        };
      });
    },
    /** options: { title, body(html), wide } → Promise<void>；body 内可放按钮，需自行绑定 */
    open({ title, body = '', wide = false }) {
      const box = document.getElementById('modal-box');
      const modal = document.getElementById('modal');
      box.style.maxWidth = wide ? '780px' : '470px';
      box.innerHTML = `
        <h3>${CET4.util.esc(title)}</h3>
        <div class="modal-body">${body}</div>
        <div class="modal-actions"><button class="btn" data-act="close">关闭</button></div>`;
      modal.hidden = false;
      return new Promise((resolve) => {
        const done = () => {
          modal.hidden = true;
          modal.onclick = null;
          setTimeout(() => {
            if (modal.hidden) box.innerHTML = '';
          }, 240);
          resolve();
        };
        box.querySelector('[data-act="close"]').onclick = done;
        modal.onclick = (e) => {
          if (e.target === modal) done();
        };
      });
    },
    empty(icon, title, desc = '') {
      return `<div class="empty"><div class="big">${icon}</div><div>${CET4.util.esc(title)}</div>${
        desc ? `<div class="muted" style="margin-top:8px">${CET4.util.esc(desc)}</div>` : ''
      }</div>`;
    },
    /** 通用「返回」按钮绑定 */
    backTo(fn) {
      const btn = document.getElementById('btn-back');
      btn.hidden = false;
      btn.onclick = fn;
    },
    hideBack() {
      document.getElementById('btn-back').hidden = true;
    },
    note(text, kind = 'info') {
      return `<div class="note ${kind}">${CET4.util.esc(text)}</div>`;
    },
    /** 一段题干 + 选项的统一渲染（阅读 / 听力共用） */
    optionsHtml(q, mine, submitted, right) {
      return ['A', 'B', 'C', 'D']
        .map((k) => {
          let cls = 'opt';
          if (submitted) {
            if (k === right) cls += ' right';
            else if (k === mine) cls += ' wrong';
          } else if (k === mine) cls += ' pick';
          return `<div class="${cls}" data-n="${q.n}" data-k="${k}"><span class="k">${k}</span><span>${CET4.util.esc(
            q.options?.[k] || ''
          )}</span></div>`;
        })
        .join('');
    },
  });

  /* 页面卸载时清掉全局键盘监听 */
  window.addEventListener('pagehide', () => clearKeys());
})();
