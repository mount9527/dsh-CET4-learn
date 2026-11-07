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
      const synthSets = papers.filter((p) => p.synth).length;
      const periods = new Map();
      for (const p of papers) {
        const k = p.period || `${p.year}年${p.month}月`;
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
                    <h3>${esc(p.title || `第 ${p.set} 套`)}</h3>
                    <p>${p.listeningQuestions || 25} 题 · ${
                      p.synth ? '系统语音朗读' : p.hasTranscript ? '含录音原文' : '无原文，只听题'
                    } · ${p.synth ? '无真人录音' : p.hasAudio ? '可在线听' : '无录音'}</p>
                    <div class="card-meta">
                      <span class="tag">Section A–C</span>
                      ${p.synth ? '<span class="tag">原创</span>' : ''}
                      ${p.hasTranscript && !p.synth ? '<span class="tag">带原文</span>' : ''}
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
            <h2>${idx.kind === 'starter' ? '听力练习' : '听力真题'}</h2>
            <span class="pill">${papers.length} 套 · ${stat.files ? `${stat.files} 份录音 · ` : ''}25 题 / 套</span>
            <span class="spacer"></span>
            <span class="pill">已交卷 ${done}</span>
          </div>
          <p class="muted" style="margin-top:0">
            ${
              synthSets && synthSets === papers.length
                ? '这里全是原创示例卷：没有真人录音，点篇目用系统语音朗读该篇，读完自动停。题目只给答案，交卷后标出对错，原文在交卷后才出现。'
                : `录音在本地播放，可以按篇目跳听；题目只给答案，交卷后标出对错，录音原文可自行对照。${
                    synthSets ? `其中有 ${synthSets} 套是原创示例卷，没有真人录音，用系统语音合成朗读（音色取决于你的电脑）。` : ''
                  }`
            }
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
      /* 示例卷没有音频文件：用系统语音合成朗读原文（包里不带录音，也就没有录音版权问题） */
      const synthMode = !audioSrc && !!ls.synth;
      const canSynth = synthMode && typeof window.speechSynthesis !== 'undefined';
      const pieces = synthMode ? ls.passages : ls.passages.filter((p) => p.start != null);

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
          /* 示例卷的原文就是朗读内容：交卷前藏起来，否则等于先看答案 */
          const scriptOpen = !!p.text && (!synthMode || rec.submitted);
          return `
          <div class="panel panel-pad" style="margin-bottom:16px" id="ps-${p.key}">
            <div class="section-title">
              <h2 style="font-size:15px">Section ${p.section} · ${esc(p.title)}</h2>
              <span class="pill">${p.from}–${p.to} 题</span>
              <span class="spacer"></span>
              ${scriptOpen ? `<button class="btn btn-ghost btn-sm" data-script="${p.key}">原文</button>` : ''}
            </div>
            ${scriptOpen ? `<div class="listen-script" id="sc-${p.key}" hidden>${esc(p.text).replace(/\n{2,}/g, '</p><p>').replace(/^/, '<p>')}</div>` : ''}
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

      const chips = pieces
        .map((p) => {
          const no = Number(String(p.key).slice(1));
          const name = { A: '新闻', B: '对话', C: '短文' }[p.section] || '';
          const tip = synthMode
            ? `${p.title} · ${p.from}–${p.to} 题 · 朗读这一篇`
            : `${p.title} · ${p.from}–${p.to} 题 · 从 ${fmt(p.start)} 开始，播完这一段自动停`;
          return synthMode
            ? `<button class="piece" data-speak="${p.key}" title="${esc(tip)}">${name}${no}</button>`
            : `<button class="piece" data-jump="${p.key}" data-start="${p.start}" data-end="${p.end}" title="${esc(tip)}">${name}${no}</button>`;
        })
        .join('');

      const audioBlock = audioSrc
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
               ? `<div class="pieces">${chips}</div>
                  <p class="muted" style="margin:-8px 0 16px;font-size:12px">
                    点篇目跳到对应录音，播完这一段自动停；也可以直接拖进度条听全程。
                  </p>`
               : `<p class="muted" style="margin:-4px 0 16px;font-size:12px">
                    这一套没有分段表，录音只能整段播放。
                  </p>`
           }`
        : canSynth
          ? `<div class="tts-bar">
               <button class="btn btn-primary btn-sm" id="tts-all">▶ 从第 1 篇开始</button>
               <button class="btn btn-sm" id="tts-pause" disabled>暂停</button>
               <label class="rate">倍速
                 <select id="tts-rate">
                   <option value="0.8">0.8×</option>
                   <option value="1" selected>1×</option>
                   <option value="1.2">1.2×</option>
                 </select>
               </label>
               <span class="pill" id="tts-state">未播放</span>
             </div>
             <p class="tts-warn" id="tts-warn" hidden>系统里没有可用的英语语音，示例听力无法朗读。可以导入带录音的题库，或在装有英语语音的系统/浏览器里打开。</p>
             <div class="pieces">${chips}</div>
             <p class="muted" style="margin:-8px 0 16px;font-size:12px">
               这一套是原创示例卷，没有真人录音：点篇目用系统语音朗读该篇，读完自动停；也可以从第 1 篇连着听。
               原文在交卷后才出现。
             </p>`
          : CET4.UI.note(
              synthMode
                ? '这个环境没有语音合成，听不了示例卷的听力。可以导入带真人录音的题库，或交卷后看原文。'
                : '这一套没有对应录音，只能作答与对答案。',
              'warn'
            );

      CET4.UI.set(
        headHtml() +
          `<div class="wrap">
            ${audioBlock}
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
          try {
            window.speechSynthesis?.cancel();
          } catch {
            /* 忽略 */
          }
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
        if (canSynth) setupTts();
      }

      /* 语音合成朗读（示例卷）：按句朗读，一篇读完就停；不打包任何音频文件 */
      function setupTts() {
        const synth = window.speechSynthesis;
        const stateEl = document.getElementById('tts-state');
        const pauseBtn = document.getElementById('tts-pause');
        const rateSel = document.getElementById('tts-rate');
        let token = 0;

        /* 没有英语语音时不要装作在播：禁用按钮并说明原因，voiceschanged 后自动恢复 */
        const voicesOk = () => {
          try {
            return (synth.getVoices() || []).some((v) => /^en/i.test(v.lang));
          } catch {
            return false;
          }
        };
        const warnEl = document.getElementById('tts-warn');
        const refreshVoices = () => {
          const ok = voicesOk();
          if (warnEl) warnEl.hidden = ok;
          const all = document.getElementById('tts-all');
          const rate = document.getElementById('tts-rate');
          if (all) all.disabled = !ok;
          if (rate) rate.disabled = !ok;
          document.querySelectorAll('[data-speak]').forEach((b) => {
            b.disabled = !ok;
          });
          if (stateEl && !synth.speaking) stateEl.textContent = ok ? '未播放' : '无可用语音';
        };

        const pickVoice = () => {
          const voices = synth.getVoices() || [];
          return voices.find((v) => /en[-_]US/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang)) || null;
        };

        const say = (text) =>
          new Promise((resolve, reject) => {
            const u = new SpeechSynthesisUtterance(text);
            u.lang = 'en-US';
            u.rate = Number(rateSel?.value || 1);
            const v = pickVoice();
            if (v) u.voice = v;
            u.onend = resolve;
            u.onerror = reject;
            synth.speak(u);
          });

        const halt = () => {
          token++;
          try {
            synth.cancel();
          } catch {
            /* 忽略 */
          }
          if (pauseBtn) {
            pauseBtn.disabled = true;
            pauseBtn.textContent = '暂停';
          }
        };

        const play = async (fromKey) => {
          if (!voicesOk()) {
            refreshVoices();
            return;
          }
          const startIdx = fromKey ? ls.passages.findIndex((p) => p.key === fromKey) : 0;
          if (startIdx < 0) return;
          halt();
          const my = ++token;
          if (pauseBtn) pauseBtn.disabled = false;

          for (let i = startIdx; i < ls.passages.length; i++) {
            const p = ls.passages[i];
            if (stateEl) stateEl.textContent = `朗读 ${p.title}`;
            const target = document.getElementById(`ps-${p.key}`);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            for (const s of CET4.util.sentences(p.text || '')) {
              if (my !== token) return;
              try {
                await say(s);
              } catch {
                if (my === token && stateEl) stateEl.textContent = '朗读被中断';
                if (pauseBtn) pauseBtn.disabled = true;
                return;
              }
            }
            /* 点单篇：读完这篇就停；从第 1 篇开始：一路读下去 */
            if (fromKey) break;
          }
          if (my === token && stateEl) stateEl.textContent = '读完了';
          if (pauseBtn) pauseBtn.disabled = true;
        };

        document.querySelectorAll('[data-speak]').forEach((b) => {
          b.onclick = () => {
            document.querySelectorAll('.piece').forEach((x) => x.classList.remove('on'));
            b.classList.add('on');
            play(b.dataset.speak);
          };
        });

        const all = document.getElementById('tts-all');
        if (all) all.onclick = () => play(null);

        if (pauseBtn)
          pauseBtn.onclick = () => {
            try {
              if (synth.paused) {
                synth.resume();
                pauseBtn.textContent = '暂停';
              } else {
                synth.pause();
                pauseBtn.textContent = '继续';
              }
            } catch {
              /* 忽略 */
            }
          };

        /* 有些环境要先触发一次 getVoices 才有声音列表；voice 列表异步到达时再刷一次 */
        try {
          synth.getVoices();
        } catch {
          /* 忽略 */
        }
        refreshVoices();
        try {
          synth.addEventListener?.('voiceschanged', refreshVoices);
        } catch {
          /* 忽略 */
        }
        synth.onvoiceschanged = refreshVoices;
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
        try {
          window.speechSynthesis?.cancel();
        } catch {
          /* 忽略 */
        }
      });
    },
  });
})();
