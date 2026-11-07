/* 随机题练习：选词填空 / 长篇阅读 / 仔细阅读
 * 含计时、实时保存、交卷判分、错题本。只给答案，不给解析（听力单独在 listening.js）。 */
(function () {
  const CET4 = (window.CET4 = window.CET4 || {});
  const { esc } = CET4.util;

  const MIN = 60 * 1000;
  const TYPES = {
    cloze: {
      label: '选词填空',
      short: '选词',
      desc: '15 选 10，考词性与搭配。',
      icon: '🧩',
      limit: 8 * MIN,
      has: (p) => !!p.hasCloze,
      total: (p) => p.cloze ? 10 : 0,
      unit: '空',
      section: 'reading',
    },
    matching: {
      label: '长篇阅读',
      short: '长篇',
      desc: '10 条信息匹配段落，考定位与速读。',
      icon: '🔍',
      limit: 15 * MIN,
      has: (p) => !!p.hasMatching,
      total: (p) => p.matching?.statements?.length || 0,
      unit: '题',
      section: 'reading',
    },
    reading: {
      label: '仔细阅读',
      short: '仔细',
      desc: '两篇短文各 5 题，考细节与推断。',
      icon: '📖',
      limit: 16 * MIN,
      has: (p) => !!p.hasReading,
      total: (p) => (p.reading || []).reduce((a, s) => a + s.questions.length, 0),
      unit: '题',
      section: 'reading',
    },
  };

  const keyOf = (paperId, type) => `${paperId}:${type}`;
  const recOf = (paperId, type) => CET4.Store.state.quiz[keyOf(paperId, type)];

  /** 所有已交卷记录 → 710 估分（听力 / 阅读两条线） */
  function estimate() {
    const rows = [];
    const quiz = CET4.Store.state.quiz || {};
    for (const [k, r] of Object.entries(quiz)) {
      if (!r || !r.submitted || !r.score) continue;
      const type = k.split(':')[1];
      if (!TYPES[type]) continue;
      rows.push({ kind: TYPES[type].section, right: r.score.right, total: r.score.total });
    }
    return { rows, ...CET4.score.estimate(rows) };
  }

  const Quiz = (CET4.Quiz = {
    TYPES,
    estimate,

    /* 题型菜单 */
    async renderMenu() {
      CET4.UI.loading();
      const papers = await CET4.Data.papersMeta();
      const st = CET4.Store.state.quiz;
      const est = estimate();

      const cards = Object.entries(TYPES)
        .map(([key, t]) => {
          const avail = papers.filter(t.has).length;
          const done = papers.filter((p) => t.has(p) && st[keyOf(p.id, key)]?.submitted).length;
          const inProgress = papers.filter((p) => t.has(p) && st[keyOf(p.id, key)] && !st[keyOf(p.id, key)].submitted);
          return `
            <div class="card" data-type="${key}">
              <div class="card-icon">${t.icon}</div>
              <h3>${t.label}</h3>
              <p>${t.desc}</p>
              <div class="card-meta">
                <span class="tag">题库 ${avail} 套</span>
                <span class="tag ${done ? 'ok' : ''}">已交卷 ${done}</span>
                ${inProgress.length ? `<span class="tag warn">未交卷 ${inProgress.length}</span>` : ''}
              </div>
            </div>`;
        })
        .join('');

      /* 未交卷的记录必须能点回去，否则“有 N 份未交卷”就是个死胡同 */
      const suspended = [];
      for (const [k, r] of Object.entries(st)) {
        if (!r || r.submitted) continue;
        const [paperId, type] = k.split(':');
        if (!TYPES[type]) continue;
        const meta = papers.find((p) => p.id === paperId);
        if (!meta) continue;
        const answered = Object.keys(r.answers || {}).length;
        if (!answered) continue;
        suspended.push({ paperId, type, meta, r, answered });
      }
      suspended.sort((a, b) => (b.r.at || 0) - (a.r.at || 0));

      const estHtml = est.sec.listening || est.sec.reading
        ? `<div class="panel panel-pad stat-panel">
             <div class="section-title"><h2 style="font-size:15px">客观题估分</h2>
               <span class="pill">按四级 710 分制折算，仅作定位参考</span></div>
             <div class="score-row">
               ${
                 est.sec.listening
                   ? `<div class="score-cell"><div class="k">听力</div><div class="v">${est.sec.listening.score}<small>/249</small></div>
                      <div class="muted">${est.sec.listening.right}/${est.sec.listening.total} 题</div></div>`
                   : ''
               }
               ${
                 est.sec.reading
                   ? `<div class="score-cell"><div class="k">阅读</div><div class="v">${est.sec.reading.score}<small>/249</small></div>
                      <div class="muted">${est.sec.reading.right}/${est.sec.reading.total} 题</div></div>`
                   : ''
               }
               <div class="score-cell"><div class="k">客观题合计</div><div class="v">${est.objective}<small>/${est.objectiveFull}</small></div>
                 <div class="muted">写作 + 翻译另占 30%</div></div>
             </div>
           </div>`
        : '';

      CET4.UI.set(`
        <div class="wrap">
          <div class="section-title">
            <h2>随机题测试</h2>
            <span class="pill">从 ${papers.length} 套真题里出题 · 作答自动保存</span>
          </div>
          <div class="grid">${cards}</div>
          ${
            suspended.length
              ? `<div class="panel panel-pad" style="margin-top:16px">
                   <div class="section-title"><h2 style="font-size:15px">未交卷的记录</h2><span class="pill">点一下接着做</span></div>
                   <div class="resume-list">
                     ${suspended
                       .slice(0, 8)
                       .map(
                         (s) => `<button class="resume-item" data-paper="${s.paperId}" data-type="${s.type}">
                           <span class="tag">${TYPES[s.type].short}</span>
                           <b>${esc(s.meta.title)}</b>
                           <span class="muted">已答 ${s.answered} 题 · 用时 ${CET4.util.fmtTime(s.r.elapsed || 0)}</span>
                           <span class="spacer"></span><span class="go">继续 →</span>
                         </button>`
                       )
                       .join('')}
                   </div>
                 </div>`
              : ''
          }
          ${estHtml}
          <p class="muted" style="margin-top:18px">
            每类题型点进去优先接着做未交卷的那套；没有就抽没做过的，最后才随机重复。交卷后的错题自动进错题本。
          </p>
        </div>`);
      CET4.UI.backTo(() => CET4.App.home());
      document.querySelectorAll('.card[data-type]').forEach((el) => {
        el.onclick = () => Quiz.start(el.dataset.type);
      });
      document.querySelectorAll('.resume-item').forEach((el) => {
        el.onclick = () => Quiz.start(el.dataset.type, el.dataset.paper);
      });
    },

    /* 抽题 + 建立/恢复会话 */
    async start(type, forcedPaper) {
      const t = TYPES[type];
      CET4.UI.loading('正在抽题…');
      const papers = await CET4.Data.papersMeta();
      const pool = papers.filter(t.has);
      if (!pool.length) {
        CET4.UI.toast('题库里没有这类题');
        return;
      }

      let pick = forcedPaper ? pool.find((p) => p.id === forcedPaper) : null;
      if (!pick) {
        // 1) 有没有做到一半的
        const suspended = pool.filter((p) => {
          const r = recOf(p.id, type);
          return r && !r.submitted && Object.keys(r.answers || {}).length;
        });
        if (suspended.length) {
          suspended.sort((a, b) => (recOf(b.id, type).at || 0) - (recOf(a.id, type).at || 0));
          pick = suspended[0];
        }
      }
      if (!pick) {
        // 2) 没做过的优先，其次避开上一篇
        const fresh = pool.filter((p) => !recOf(p.id, type));
        const last = CET4.Store.state.quiz.__last;
        const base = fresh.length ? fresh : pool;
        const noLast = base.filter((p) => p.id !== last);
        pick = CET4.util.pick(noLast.length ? noLast : base);
      }
      CET4.Store.state.quiz.__last = pick.id;
      CET4.Store.save();

      const existing = recOf(pick.id, type);
      if (existing && !existing.submitted && Object.keys(existing.answers || {}).length) {
        const cont = await CET4.UI.confirm({
          title: '接着上次做？',
          body: `题源：<b>${esc(pick.title)}</b><br>已作答 ${Object.keys(existing.answers).length} 题，用时 ${CET4.util.fmtTime(
            existing.elapsed || 0
          )}。`,
          ok: '继续上次',
          cancel: '重新开始',
        });
        if (!cont) {
          existing.answers = {};
          existing.elapsed = 0;
          existing.submitted = false;
          CET4.Store.save();
        }
      } else if (existing && existing.submitted) {
        const again = await CET4.UI.confirm({
          title: '这篇已经交过卷',
          body: `题源：<b>${esc(pick.title)}</b><br>上次得分 ${existing.score?.right ?? '-'}/${existing.score?.total ?? '-'}。`,
          ok: '再做一遍',
          cancel: '查看上次结果',
        });
        if (again) {
          delete CET4.Store.state.quiz[keyOf(pick.id, type)];
          CET4.Store.save();
        }
      }

      Quiz.open(pick.id, type);
    },

    async open(paperId, type) {
      CET4.UI.loading('加载试题…');
      const t = TYPES[type];
      const paper = await CET4.Data.paper(paperId);
      const key = keyOf(paperId, type);
      const rec = (CET4.Store.state.quiz[key] = CET4.Store.state.quiz[key] || {
        answers: {},
        elapsed: 0,
        submitted: false,
      });
      if (!rec.answers) rec.answers = {};
      if (!rec.at) rec.at = Date.now();
      const persist = () => {
        rec.elapsed = clock.total;
        rec.at = Date.now();
        CET4.Store.save();
      };

      const items = () => {
        if (type === 'reading') return paper.reading.flatMap((s) => s.questions);
        if (type === 'matching') return paper.matching.statements;
        return Object.keys(paper.answers.cloze).map((n) => ({ n }));
      };
      const total = items().length;

      /* ── 计时 ── */
      let clock = null;
      const startClock = () => {
        clock = CET4.Timer.start({
          from: rec.elapsed || 0,
          limit: t.limit,
          onTick: (ms, left) => {
            const el = document.getElementById('quiz-timer');
            if (!el) return;
            el.textContent = CET4.util.fmtTime(ms);
            el.classList.toggle('over', ms > t.limit);
            el.title = ms > t.limit ? `已超过建议用时 ${Math.round(t.limit / 60000)} 分钟` : `建议用时 ${Math.round(t.limit / 60000)} 分钟`;
            if (ms > t.limit) rec.elapsed = ms;
          },
        });
        CET4.UI.onLeave(() => {
          if (clock) clock.stop();
        });
      };

      const leave = (toMenu = true) => {
        rec.elapsed = clock ? clock.total : rec.elapsed;
        CET4.Store.save();
        if (clock) clock.stop();
        if (toMenu) Quiz.renderMenu();
      };

      const headHtml = () => {
        const submitted = !!rec.submitted;
        return `
        <div class="quizbar">
          <button class="btn btn-ghost btn-sm" id="quiz-exit">← 退出</button>
          <strong>${t.label}</strong>
          <span class="pill">${esc(paper.title)}</span>
          <span class="spacer" style="flex:1"></span>
          <span class="timer" id="quiz-timer">${CET4.util.fmtTime(rec.elapsed || 0)}</span>
          <span class="pill" id="quiz-progress"></span>
          ${
            submitted
              ? `<button class="btn btn-sm" id="quiz-redo">再做一遍</button>`
              : `<button class="btn btn-primary btn-sm" id="quiz-submit">交卷</button>`
          }
        </div>`;
      };

      const paintProgress = (answered) => {
        const el = document.getElementById('quiz-progress');
        if (el) el.textContent = `${answered}/${total} ${t.unit}`;
      };

      /* ── 选词填空 ── */
      function renderCloze() {
        const c = paper.cloze;
        const bank = c.bank;
        let activeBlank = null;
        const blanks = () => [...document.querySelectorAll('.blank')];
        const usedLetters = () => new Set(Object.values(rec.answers));

        const passageHtml = c.passage.replace(/\{\{(\d+)\}\}/g, (_, n) => `<span class="blank blank--empty" data-n="${n}">${n}</span>`);
        const bankHtml = bank
          .map((b) => `<span class="chip ${usedLetters().has(b.letter) ? 'used' : ''}" data-letter="${b.letter}">${b.letter}. ${esc(b.word)}</span>`)
          .join('');

        CET4.UI.set(
          headHtml() +
            `<div class="wrap">
              <div class="panel panel-pad">
                <div class="passage">${passageHtml}</div>
                <div class="bank" id="cloze-bank">${bankHtml}</div>
                <div class="row muted">点一个空，再点下方词库里的词填入；点已填的空可以清空。</div>
              </div>
            </div>`
        );
        bindHead();

        const paint = () => {
          blanks().forEach((el) => {
            const n = el.dataset.n;
            const letter = rec.answers[n];
            const w = letter ? bank.find((b) => b.letter === letter)?.word : null;
            if (rec.submitted) {
              const right = paper.answers.cloze[n];
              el.className = 'blank ' + (letter === right ? 'right' : 'wrong');
              el.textContent = `${n} ${w || letter || '—'}`;
            } else {
              el.className = 'blank' + (letter ? '' : ' blank--empty') + (String(n) === String(activeBlank) ? ' sel' : '');
              el.textContent = letter ? `${n} ${w || letter}` : n;
            }
          });
          document.querySelectorAll('#cloze-bank .chip').forEach((chip) => {
            const letter = chip.dataset.letter;
            chip.classList.toggle('used', usedLetters().has(letter) && !rec.submitted);
          });
          paintProgress(blanks().filter((el) => rec.answers[el.dataset.n]).length);
        };
        blanks().forEach((el) => {
          el.onclick = () => {
            if (rec.submitted) return;
            const n = el.dataset.n;
            if (activeBlank === n) {
              delete rec.answers[n];
              activeBlank = null;
              persist();
              paint();
              return;
            }
            activeBlank = n;
            paint();
          };
        });
        document.querySelectorAll('#cloze-bank .chip').forEach((chip) => {
          chip.onclick = () => {
            if (rec.submitted) return;
            if (!activeBlank) {
              CET4.UI.toast('先点一个空，再选词');
              return;
            }
            const letter = chip.dataset.letter;
            for (const [k, v] of Object.entries(rec.answers)) if (v === letter) delete rec.answers[k];
            rec.answers[activeBlank] = letter;
            const cur = Number(activeBlank);
            activeBlank = null;
            const nextEmpty = Object.keys(paper.answers.cloze)
              .map(Number)
              .filter((n) => !rec.answers[n])
              .sort((a, b) => a - b)
              .find((n) => n > cur);
            if (nextEmpty) activeBlank = String(nextEmpty);
            persist();
            paint();
          };
        });
        paint();
      }

      /* ── 长篇阅读 ── */
      function renderMatching() {
        const m = paper.matching;
        const labels = m.paragraphs.map((p) => p.label);
        const notes = [];
        if (m.note) notes.push(CET4.UI.note(m.note, 'warn'));
        if (m.noteShort) notes.push(CET4.UI.note(m.noteShort, 'info'));

        CET4.UI.set(
          headHtml() +
            `<div class="wrap">
              ${notes.join('')}
              <div class="split">
                <div class="panel panel-pad">
                  <div class="section-title"><h2 style="font-size:15px">${esc(m.title || 'Passage')}</h2></div>
                  ${m.paragraphs.map((p) => `<p class="para" data-label="${p.label}"><span class="plabel">${p.label}</span>${esc(p.text)}</p>`).join('')}
                </div>
                <div class="panel panel-pad">
                  <div class="section-title"><h2 style="font-size:15px">信息匹配</h2><span class="pill">选出信息所在段落</span></div>
                  ${m.statements
                    .map(
                      (s) => `
                    <div class="stmt-row" data-n="${s.n}">
                      <div class="stmt-text"><b>${s.n}</b>${esc(s.text)}</div>
                      <div class="letter-pick">
                        ${labels
                          .map((L) => `<button class="letter ${rec.answers[s.n] === L ? 'pick' : ''}" data-n="${s.n}" data-l="${L}">${L}</button>`)
                          .join('')}
                      </div>
                    </div>`
                    )
                    .join('')}
                </div>
              </div>
            </div>`
        );
        bindHead();

        const paint = () => {
          document.querySelectorAll('.letter').forEach((b) => {
            const n = b.dataset.n;
            const L = b.dataset.l;
            const mine = rec.answers[n];
            const right = paper.answers.matching[n];
            b.className = 'letter';
            if (rec.submitted) {
              if (L === right) b.classList.add('right');
              else if (L === mine) b.classList.add('wrong');
            } else if (L === mine) b.classList.add('pick');
          });
          document.querySelectorAll('.para').forEach((p) => {
            p.classList.toggle(
              'mark',
              rec.submitted && Object.entries(paper.answers.matching).some(([n, L]) => L === p.dataset.label && rec.answers[n] === L)
            );
          });
          paintProgress(Object.keys(rec.answers).length);
        };

        document.querySelectorAll('.letter').forEach((b) => {
          b.onclick = () => {
            if (rec.submitted) return;
            rec.answers[b.dataset.n] = b.dataset.l;
            persist();
            paint();
          };
        });
        paint();
      }

      /* ── 仔细阅读 ── */
      function renderReading() {
        const body = paper.reading
          .map(
            (p) => `
          <div class="panel panel-pad" style="margin-bottom:18px">
            <div class="section-title"><h2 style="font-size:15px">${esc(p.title)}</h2>
              <span class="pill">第 ${p.range?.[0] ?? ''}–${p.range?.[1] ?? ''} 题</span></div>
            <div class="passage">${(p.text || p.paragraphs.join('\n\n')).split(/\n+/).filter(Boolean).map((x) => `<p>${esc(x)}</p>`).join('')}</div>
          </div>
          <div class="panel panel-pad" style="margin-bottom:18px">
            ${p.questions
              .map(
                (q) => `
              <div class="q-item" data-n="${q.n}">
                <div class="q-stem"><b>${q.n}</b>${esc(q.stem)}</div>
                <div class="opts">${CET4.UI.optionsHtml(q, rec.answers[q.n], rec.submitted, q.answer)}</div>
                <div class="slot-explain" data-slot="${q.n}"></div>
              </div>`
              )
              .join('')}
          </div>`
          )
          .join('');

        CET4.UI.set(headHtml() + `<div class="wrap">${body}</div>`);
        bindHead();
        document.querySelectorAll('.opt').forEach((el) => {
          el.onclick = () => {
            if (rec.submitted) return;
            rec.answers[el.dataset.n] = el.dataset.k;
            persist();
            paint();
          };
        });
        paint();
      }

      function paint() {
        if (type === 'reading') {
          document.querySelectorAll('.opt').forEach((el) => {
            const n = el.dataset.n;
            const k = el.dataset.k;
            const all = paper.reading.flatMap((s) => s.questions);
            const q = all.find((x) => String(x.n) === String(n));
            el.className = 'opt';
            if (rec.submitted) {
              if (k === q.answer) el.classList.add('right');
              else if (k === rec.answers[n]) el.classList.add('wrong');
            } else if (k === rec.answers[n]) el.classList.add('pick');
          });
          paintProgress(Object.keys(rec.answers).length);
        }
        if (rec.submitted) renderReview();
      }

      /* ── 交卷后：只标对错与正确答案（不给解析） ── */
      function renderReview() {
        if (type === 'cloze') renderClozeReview();
        else if (type === 'matching') renderMatchReview();
        else renderReadingReview();
      }

      function renderClozeReview() {
        const c = paper.cloze;
        const slot = document.getElementById('cloze-review');
        const box = slot || document.querySelector('#view .wrap');
        if (!box) return;
        const rows = Object.keys(paper.answers.cloze)
          .map((n) => {
            const right = paper.answers.cloze[n];
            const w = c.bank.find((b) => b.letter === right);
            const mine = rec.answers[n];
            return `<div class="answer-row" data-n="${n}">
              <span class="an">${n}</span>
              <span class="av">${esc(right)}. ${esc(w?.word || '')}</span>
              ${mine === right ? '<span class="tag ok">答对</span>' : `<span class="tag warn">${mine ? '你选 ' + esc(mine) : '未作答'}</span>`}
            </div>`;
          })
          .join('');
        const rightCount = Object.keys(paper.answers.cloze).filter((n) => rec.answers[n] === paper.answers.cloze[n]).length;
        const html = `<div class="panel panel-pad" style="margin-top:16px">
            <div class="section-title"><h2 style="font-size:15px">答案</h2>
              <span class="pill">${rightCount} / ${Object.keys(paper.answers.cloze).length} 题正确</span></div>
            <div class="answer-grid">${rows}</div>
          </div>`;
        // 交卷重绘时预留了 #cloze-review 容器；正常渲染路径下就补在末尾
        if (slot) slot.innerHTML = html;
        else box.insertAdjacentHTML('beforeend', html);
      }

      function renderMatchReview() {
        const m = paper.matching;
        const box = document.querySelector('#view .wrap');
        if (!box) return;
        const rows = m.statements
          .map((s) => {
            const right = paper.answers.matching[s.n];
            const mine = rec.answers[s.n];
            return `<div class="answer-row" data-n="${s.n}">
              <span class="an">${s.n}</span>
              <span class="av">段落 ${esc(right || '—')}</span>
              ${mine === right ? '<span class="tag ok">答对</span>' : `<span class="tag warn">${mine ? '你选 ' + esc(mine) : '未作答'}</span>`}
            </div>`;
          })
          .join('');
        const right = m.statements.filter((s) => rec.answers[s.n] === paper.answers.matching[s.n]).length;
        box.insertAdjacentHTML(
          'beforeend',
          `<div class="panel panel-pad" style="margin-top:16px">
            <div class="section-title"><h2 style="font-size:15px">答案</h2>
              <span class="pill">${right} / ${m.statements.length} 题正确</span></div>
            <div class="answer-grid">${rows}</div>
          </div>`
        );
      }

      function renderReadingReview() {
        for (const p of paper.reading) {
          for (const q of p.questions) {
            const slot = document.querySelector(`.slot-explain[data-slot="${q.n}"]`);
            if (!slot) continue;
            const right = q.answer;
            const mine = rec.answers[q.n];
            const ok = mine === right;
            slot.innerHTML = `<div class="answer-line">
              ${ok ? '<span class="tag ok">答对</span>' : `<span class="tag warn">${mine ? '你选 ' + esc(mine) : '未作答'}</span>`}
              <span class="tag">答案 ${esc(right || '—')}. ${esc((q.options?.[right] || '').slice(0, 48))}</span>
            </div>`;
          }
        }
      }


      /* ── 顶栏绑定 ── */
      function bindHead() {
        document.getElementById('quiz-exit').onclick = async () => {
          if (!rec.submitted && Object.keys(rec.answers).length) {
            const ok = await CET4.UI.confirm({
              title: '退出练习',
              body: '作答记录会保存，计时暂停；下次进来会优先接着做。',
              ok: '退出并保存',
              cancel: '继续作答',
            });
            if (!ok) return;
          }
          leave(true);
        };
        const submit = document.getElementById('quiz-submit');
        if (submit) submit.onclick = () => doSubmit();
        const redo = document.getElementById('quiz-redo');
        if (redo)
          redo.onclick = async () => {
            const ok = await CET4.UI.confirm({
              title: '再做一遍',
              body: '会清掉这次的成绩与作答记录（错题本里的记录保留）。',
              ok: '清空并重做',
              cancel: '取消',
            });
            if (!ok) return;
            clearWrongEntries();
            delete CET4.Store.state.quiz[key];
            CET4.Store.save();
            clock.stop();
            Quiz.open(paperId, type);
          };
      }

      async function doSubmit() {
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
        rec.submitted = true;
        rec.elapsed = clock.total;
        rec.score = grade();
        rec.at = Date.now();
        CET4.Store.state.stats.quizDone = (CET4.Store.state.stats.quizDone || 0) + 1;
        recordWrong();
        CET4.Store.save();
        clock.stop();
        renderAll();
        const card = document.getElementById('quiz-review');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      function grade() {
        if (type === 'cloze') {
          let right = 0;
          const map = paper.answers.cloze;
          for (const [n, a] of Object.entries(map)) if (rec.answers[n] === a) right++;
          return { right, total: Object.keys(map).length };
        }
        const list = type === 'matching' ? paper.matching.statements : paper.reading.flatMap((s) => s.questions);
        let right = 0;
        for (const q of list) if (rec.answers[q.n] === q.answer) right++;
        return { right, total: list.length };
      }

      /** 错题本：错的记进去，对的顺手销账（重做对了就自动移出） */
      function wrongKeys() {
        if (type === 'cloze') return Object.keys(paper.answers.cloze).map((n) => ({ n, answer: paper.answers.cloze[n], stem: `第 ${n} 空` }));
        if (type === 'matching') return paper.matching.statements.map((s) => ({ n: s.n, answer: s.answer, stem: s.text }));
        return paper.reading.flatMap((s) => s.questions).map((q) => ({ n: q.n, answer: q.answer, stem: q.stem }));
      }
      function recordWrong() {
        for (const it of wrongKeys()) {
          const key = `${paperId}:${type}:${it.n}`;
          if (rec.answers[it.n] === it.answer) CET4.Store.removeWrong(key);
          else CET4.Store.addWrong({ key, paperId, type, n: it.n, stem: it.stem });
        }
      }
      function clearWrongEntries() {
        for (const it of wrongKeys()) CET4.Store.removeWrong(`${paperId}:${type}:${it.n}`);
      }

      function renderAll() {
        if (type === 'cloze') {
          // 选词填空交卷后重绘一版只读原文，解析另起一块
          const c = paper.cloze;
          const passageHtml = c.passage.replace(/\{\{(\d+)\}\}/g, (_, n) => {
            const letter = paper.answers.cloze[n];
            const mine = rec.answers[n];
            const w = c.bank.find((b) => b.letter === (mine || letter))?.word;
            const ok = mine === letter;
            const cls = rec.submitted ? 'blank ' + (ok ? 'right' : 'wrong') : 'blank';
            return `<span class="${cls}" data-n="${n}">${n} ${w || '—'}</span>`;
          });
          CET4.UI.set(
            headHtml() +
              `<div class="wrap">
                <div id="quiz-review">${scoreCard()}</div>
                <div class="panel panel-pad"><div class="passage">${passageHtml}</div></div>
                <div id="cloze-review"></div>
              </div>`
          );
          bindHead();
          setTimeout(() => renderClozeReview(), 0);
          return;
        }
        if (type === 'matching') {
          renderMatching();
          document.querySelector('#view .wrap').insertAdjacentHTML('afterbegin', scoreCard());
          renderMatchReview();
        } else {
          renderReading();
          document.querySelector('#view .wrap').insertAdjacentHTML('afterbegin', scoreCard());
          renderReadingReview();
        }
        const back = document.getElementById('btn-back-menu');
        if (back) back.onclick = () => leave(true);
      }

      function scoreCard() {
        if (!rec.score) return '';
        const pct = CET4.util.pct(rec.score.right, rec.score.total);
        const est = estimate();
        return `<div class="panel panel-pad" id="quiz-review" style="margin-bottom:16px">
          <div class="row">
            <div class="score-big" id="score-big">${rec.score.right}<small>/${rec.score.total}</small></div>
            <span class="tag ${pct >= 60 ? 'ok' : 'warn'}">正确率 ${pct}%</span>
            <span class="pill">用时 ${CET4.util.fmtTime(rec.elapsed || 0)}</span>
            <span class="spacer" style="flex:1"></span>
            <span class="pill">客观题估分 ${est.objective}/${est.objectiveFull}</span>
            <button class="btn btn-sm" id="btn-back-menu">换一篇</button>
          </div>
        </div>`;
      }

      startClock();
      if (rec.submitted) renderAll();
      else if (type === 'cloze') renderCloze();
      else if (type === 'matching') renderMatching();
      else renderReading();
    },

  });
})();
