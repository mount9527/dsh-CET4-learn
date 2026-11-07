/* 听力真题：本地录音 + 按篇跳转 + 录音原文 + 25 题作答与对答案。
 *
 * 数据来自 data/papers/<id>.json 的 listening 字段：
 *   每套 8 篇（3 篇新闻 / 2 段长对话 / 3 篇短文），每篇自带音频起止时间与题目，
 *   所以“第 5 题在哪一段、从第几秒开始”是确定的，不靠猜。
 * 只给答案，不给解析：交卷后标出对错与正确选项，原文可自行对照。
 */
(function () {
  const CET4 = (window.CET4 = window.CET4 || {});
  const { esc } = CET4.util;
  const LIMIT = 25 * 60 * 1000;

  const keyOf = (paperId) => `${paperId}:listening`;
  const recOf = (paperId) => CET4.Store.state.quiz[keyOf(paperId)];

  const fmt = (s) => {
    const t = Math.max(0, Math.floor(Number(s) || 0));
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };

  const L = (CET4.Listening = {
    /** 卷宗列表：按考期分组，只列有录音的套 */
    async renderMenu() {
      CET4.UI.loading();
      const idx = await CET4.Data.index();
      const papers = idx.papers.filter((p) => p.hasAudio);
      if (!papers.length) {
        CET4.UI.set(`<div class="wrap">${CET4.UI.empty('🎧', '还没有可用的听力录音')}</div>`);
        return;
      }
      const stat = idx.audio || {};
      const periods = new Map();
      for (const p of papers) {
        const k = `${p.year}年${p.month}月`;
        if (!periods.has(k)) periods.set(k, []);
        periods.get(k).push(p);
      }
      const done = papers.filter((p) => recOf(p.id)?.submitted).length;
      const cards = [...periods]
        .map(
          ([label, list]) => `
          <div class="panel panel-pad" style="margin-bottom:14px">
            <div class="section-title"><h2 style="font-size:15px">${esc(label)}</h2>
              <span class="pill">${list.length} 套</span></div>
            <div class="grid">
              ${list
                .map((p) => {
                  const r = recOf(p.id);
                  const score = r?.submitted ? `已交卷 ${r.score?.right ?? 0}/${r.score?.total ?? 25}` : r ? '做到一半' : '';
                  const borrowedFrom = p.audioCopiedFrom ? Number(String(p.audioCopiedFrom).split('-s')[1]) : 0;
                  return `<div class="card" data-paper="${p.id}">
                    <div class="card-icon">🎧</div>
                    <h3>第 ${p.set} 套</h3>
                    <p>25 题${p.hasTranscript ? ' · 含录音原文' : ' · 无原文，只听题'} · ${p.hasAudio ? '可在线听' : '无录音'}</p>
                    <div class="card-meta">
                      <span class="tag">Section A–C</span>
                      ${p.hasTranscript ? '<span class="tag">带原文</span>' : ''}
                      ${borrowedFrom ? `<span class="tag">沿用第 ${borrowedFrom} 套录音</span>` : ''}
                      ${!p.audioVerified ? '<span class="tag">录音按套号推定</span>' : ''}
                      ${score ? `<span class="tag ${r?.submitted ? 'ok' : 'warn'}">${score}</span>` : ''}
                    </div>
                  </div>`;
                })
                .join('')}
            </div>
          </div>`
        )
        .join('');

      CET4.UI.set(`
        <div class="wrap">
          <div class="section-title">
            <h2>听力真题</h2>
            <span class="pill">${papers.length} 套 · ${stat.files || '—'} 份录音 · 25 题 / 套</span>
            <span class="spacer"></span>
            <span class="pill">已交卷 ${done}</span>
          </div>
          <p class="muted" style="margin-top:0">
            录音在本地播放，可以按篇目跳听；题目只给答案，交卷后标出对错，录音原文可自行对照。
            ${
              stat.borrowed
                ? `其中 ${stat.borrowed} 套的听力与同考期第 1 套相同（真题 PDF 如此注明），录音沿用那一套。`
                : ''
            }
            ${stat.assumed ? `另有 ${stat.assumed} 套缺听力原文，录音归属按文件名推定，标了「按套号推定」，建议先听一遍确认。` : ''}
          </p>
          ${cards}
        </div>`);
      CET4.UI.backTo(() => CET4.App.home());
      document.querySelectorAll('.card[data-paper]').forEach((el) => {
        el.onclick = () => L.start(el.dataset.paper);
      });
    },

    async start(paperId) {
      CET4.UI.loading('加载录音…');
      const paper = await CET4.Data.paper(paperId);
      const ls = paper.listening;
      if (!ls?.passages?.length) {
        CET4.UI.toast('这一套没有听力数据');
        return;
      }
      const key = keyOf(paperId);
      const rec = (CET4.Store.state.quiz[key] = CET4.Store.state.quiz[key] || { answers: {}, elapsed: 0, submitted: false });
      rec.answers = rec.answers || {};

      const questions = ls.passages.flatMap((p) => p.questions);
      const total = questions.length;
      const byN = new Map(questions.map((q) => [String(q.n), q]));
      const persist = () => {
        rec.elapsed = clock ? clock.total : rec.elapsed || 0;
        rec.at = Date.now();
        CET4.Store.save();
      };

      let clock = null;
      const leave = () => {
        rec.elapsed = clock ? clock.total : rec.elapsed;
        if (clock) clock.stop();
        CET4.Store.save();
        L.renderMenu();
      };

      const headHtml = () => `
        <div class="quizbar">
          <button class="btn btn-ghost btn-sm" id="ls-exit">← 退出</button>
          <strong>听力</strong>
          <span class="pill">${esc(paper.title)}</span>
          <span class="spacer" style="flex:1"></span>
          <span class="timer" id="ls-timer">${CET4.util.fmtTime(rec.elapsed || 0)}</span>
          <span class="pill" id="ls-progress"></span>
          ${rec.submitted ? '<button class="btn btn-sm" id="ls-redo">再做一遍</button>' : '<button class="btn btn-primary btn-sm" id="ls-submit">交卷</button>'}
        </div>`;

      const audioSrc = ls.audio ? CET4.Data.mediaUrl(ls.audio) : '';
      const pieces = ls.passages.filter((p) => p.start != null);

      const paint = () => {
        document.querySelectorAll('.opt').forEach((el) => {
          const n = el.dataset.n;
          const k = el.dataset.k;
          const q = byN.get(String(n));
          el.className = 'opt';
          if (rec.submitted) {
            if (q && k === q.answer) el.classList.add('right');
            else if (k === rec.answers[n]) el.classList.add('wrong');
          } else if (k === rec.answers[n]) el.classList.add('pick');
        });
        const el = document.getElementById('ls-progress');
        if (el) el.textContent = `${questions.filter((q) => rec.answers[q.n]).length}/${total} 题`;
      };

      const passagesHtml = ls.passages
        .map((p) => {
          return `
          <div class="panel panel-pad" style="margin-bottom:16px" id="ps-${p.key}">
            <div class="section-title">
              <h2 style="font-size:15px">Section ${p.section} · ${esc(p.title)}</h2>
              <span class="pill">${p.from}–${p.to} 题</span>
              <span class="spacer"></span>
              ${p.text ? `<button class="btn btn-ghost btn-sm" data-script="${p.key}">原文</button>` : ''}
            </div>
            ${p.text ? `<div class="listen-script" id="sc-${p.key}" hidden>${esc(p.text).replace(/\n{2,}/g, '</p><p>').replace(/^/, '<p>')}</div>` : ''}
            ${p.questions
              .map(
                (q) => `
              <div class="q-item" data-n="${q.n}">
                <div class="q-stem"><b>${q.n}</b>${q.stem ? esc(q.stem) : '<span class="muted">题干在录音里，先听再选</span>'}</div>
                <div class="opts">${CET4.UI.optionsHtml(q, rec.answers[q.n], rec.submitted, q.answer)}</div>
                ${
                  rec.submitted
                    ? `<div class="answer-line">${rec.answers[q.n] === q.answer ? '<span class="tag ok">答对</span>' : `<span class="tag warn">${rec.answers[q.n] ? '你选 ' + esc(rec.answers[q.n]) : '未作答'}</span>`}
                        <span class="tag">答案 ${esc(q.answer || '—')}</span></div>`
                    : ''
                }
              </div>`
              )
              .join('')}
          </div>`;
        })
        .join('');

      CET4.UI.set(
        headHtml() +
          `<div class="wrap">
            ${
              audioSrc
                ? `<div class="audio-bar">
                     <audio id="ls-audio" controls preload="metadata" src="${esc(audioSrc)}"></audio>
                     <div class="audio-side">
                       <label class="rate">倍速
                         <select id="ls-rate">
                           <option value="0.75">0.75×</option>
                           <option value="1" selected>1×</option>
                           <option value="1.25">1.25×</option>
                           <option value="1.5">1.5×</option>
                         </select>
                       </label>
                       <span class="pill" id="ls-pos">00:00</span>
                     </div>
                   </div>
                   ${
                     pieces.length
                       ? `<div class="pieces">${pieces
                           .map((p) => {
                             const no = Number(p.key.slice(1));
                             const name = { A: '新闻', B: '对话', C: '短文' }[p.section] || '';
                             return `<button class="piece" data-jump="${p.key}" data-start="${p.start}" data-end="${p.end}" title="${esc(
                               `${p.title} · ${p.from}–${p.to} 题 · 从 ${fmt(p.start)} 开始，播完这一段自动停`
                             )}">${name}${no}</button>`;
                           })
                           .join('')}</div>
                         <p class="muted" style="margin:-8px 0 16px;font-size:12px">
                           点篇目跳到对应录音，播完这一段自动停；也可以直接拖进度条听全程。
                         </p>`
                       : `<p class="muted" style="margin:-4px 0 16px;font-size:12px">
                           这一套没有分段表，录音只能整段播放。
                         </p>`
                   }`
                : CET4.UI.note('这一套没有对应录音，只能作答与对答案。', 'warn')
            }
            ${!ls.verified ? CET4.UI.note('这一套没有录音原文，录音按套号推定归属；如果听下来不对，可在设置里核对资料目录。', 'info') : ''}
            ${
              ls.copiedFrom
                ? CET4.UI.note(
                    `本套听力与同考期第 ${Number(String(ls.copiedFrom).split('-s')[1]) || 1} 套相同（真题 PDF 如此注明），录音与原文沿用那一套。`,
                    'info'
                  )
                : ''
            }
            ${passagesHtml}
          </div>`
      );

      /* 计时 */
      clock = CET4.Timer.start({
        from: rec.elapsed || 0,
        limit: LIMIT,
        onTick: (ms) => {
          const el = document.getElementById('ls-timer');
          if (!el) return;
          el.textContent = CET4.util.fmtTime(ms);
          el.classList.toggle('over', ms > LIMIT);
        },
      });

      /* 退出 / 交卷 / 重做 */
      document.getElementById('ls-exit').onclick = async () => {
        const answered = Object.keys(rec.answers).length;
        if (!rec.submitted && answered) {
          const ok = await CET4.UI.confirm({
            title: '退出听力练习',
            body: '作答记录会保存，计时暂停；下次进来接着做。',
            ok: '退出并保存',
            cancel: '继续听',
          });
          if (!ok) return;
        }
        leave();
      };

      const submit = document.getElementById('ls-submit');
      if (submit)
        submit.onclick = async () => {
          const answered = Object.keys(rec.answers).length;
          if (answered < total) {
            const ok = await CET4.UI.confirm({
              title: '还有题没作答',
              body: `已作答 ${answered}/${total}，未作答的按错算。确定交卷吗？`,
              ok: '交卷',
              cancel: '再检查一下',
            });
            if (!ok) return;
          }
          let right = 0;
          for (const q of questions) if (rec.answers[q.n] === q.answer) right++;
          rec.submitted = true;
          rec.elapsed = clock.total;
          rec.score = { right, total };
          rec.at = Date.now();
          for (const q of questions) {
            if (rec.answers[q.n] === q.answer) continue;
            CET4.Store.addWrong({
              key: `${paperId}:listening:${q.n}`,
              paperId,
              type: 'listening',
              n: q.n,
              stem: (q.stem || '').slice(0, 80),
            });
          }
          clock.stop();
          const audio = document.getElementById('ls-audio');
          if (audio) audio.pause();
          CET4.Store.save();
          L.start(paperId);
        };

      const redo = document.getElementById('ls-redo');
      if (redo)
        redo.onclick = async () => {
          const ok = await CET4.UI.confirm({
            title: '再做一遍',
            body: '会清掉这次的作答与成绩（错题本里的记录保留）。',
            ok: '清空并重做',
            cancel: '取消',
          });
          if (!ok) return;
          CET4.Store.state.wrongBook = CET4.Store.state.wrongBook.filter((w) => !String(w.key).startsWith(`${paperId}:listening:`));
          delete CET4.Store.state.quiz[key];
          CET4.Store.save();
          if (clock) clock.stop();
          L.start(paperId);
        };

      /* 作答 */
      if (!rec.submitted)
        document.querySelectorAll('.opt').forEach((el) => {
          el.onclick = () => {
            rec.answers[el.dataset.n] = el.dataset.k;
            persist();
            paint();
          };
        });
      paint();

      /* 音频：按篇跳转、播完本段自动停 */
      const audio = document.getElementById('ls-audio');
      let stopAt = null;
      if (audio) {
        const rate = document.getElementById('ls-rate');
        rate.onchange = () => (audio.playbackRate = Number(rate.value));
        const pos = document.getElementById('ls-pos');
        audio.addEventListener('timeupdate', () => {
          if (pos) pos.textContent = fmt(audio.currentTime);
          document.querySelectorAll('.piece').forEach((b) => {
            const s = Number(b.dataset.start);
            const e = Number(b.dataset.end);
            b.classList.toggle('on', audio.currentTime >= s && audio.currentTime < e);
          });
          if (stopAt != null && audio.currentTime >= stopAt) {
            audio.pause();
            stopAt = null;
          }
        });
        audio.addEventListener('loadedmetadata', () => {
          if (pos) pos.textContent = fmt(audio.currentTime);
        });
        document.querySelectorAll('[data-jump]').forEach((b) => {
          b.onclick = () => {
            const start = Number(b.dataset.start);
            const end = Number(b.dataset.end);
            audio.currentTime = start;
            stopAt = end;
            audio.play().catch(() => {});
            const target = document.getElementById(`ps-${b.dataset.jump}`);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          };
        });
      } else {
        document.querySelectorAll('[data-jump]').forEach((b) => b.remove());
      }

      /* 原文展开 */
      document.querySelectorAll('[data-script]').forEach((b) => {
        b.onclick = () => {
          const box = document.getElementById(`sc-${b.dataset.script}`);
          if (!box) return;
          box.hidden = !box.hidden;
          b.textContent = box.hidden ? '原文' : '收起原文';
        };
      });

      CET4.UI.onLeave(() => {
        if (clock) clock.stop();
        rec.elapsed = clock ? clock.total : rec.elapsed;
        CET4.Store.save();
        const a = document.getElementById('ls-audio');
        if (a) {
          try {
            a.pause();
          } catch {
            /* 忽略 */
          }
        }
      });
    },
  });
})();
