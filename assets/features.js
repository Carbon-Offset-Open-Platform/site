(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* 1. Liability journey: scroll position drives the token */
  (function journey() {
    var track = $('lj-track'); if (!track) return;
    var steps = Array.prototype.slice.call(document.querySelectorAll('#lj-steps .lj-step'));
    var paths = [0, 1, 2, 3, 4].map(function (i) { return $('lj-p' + i); });
    var lens = paths.map(function (p) { return p.getTotalLength(); });
    var nodes = [0, 1, 2, 3, 4, 5].map(function (i) { return $('lj-n' + i); });
    var chips = Array.prototype.slice.call(document.querySelectorAll('.lj-chip'));
    var token = $('lj-token'), halo = $('lj-halo'), bars = $('lj-bars'), bar = $('lj-progress');
    paths.forEach(function (p, i) { p.style.strokeDasharray = lens[i]; p.style.strokeDashoffset = lens[i]; });

    function draw(i, t) { paths[i].style.strokeDashoffset = lens[i] * (1 - t); }
    function place(i, t) {
      var pt = paths[i].getPointAtLength(lens[i] * t);
      token.setAttribute('cx', pt.x); token.setAttribute('cy', pt.y);
      halo.setAttribute('cx', pt.x); halo.setAttribute('cy', pt.y);
    }

    function update() {
      var r = track.getBoundingClientRect();
      var total = track.offsetHeight - window.innerHeight;
      var p = clamp(-r.top / total, 0, 1);
      bar.style.width = (p * 100) + '%';
      var s = p * 6, step = Math.min(5, Math.floor(s)), t = clamp(s - step, 0, 1);
      var e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

      steps.forEach(function (el, i) {
        el.classList.toggle('is-on', i === step);
        el.classList.toggle('is-done', i < step);
      });
      bars.classList.toggle('is-live', step === 0);

      // trunk: server -> event -> tenant
      draw(0, step === 1 ? e : step > 1 ? 1 : 0);
      draw(1, step === 2 ? e : step > 2 ? 1 : 0);
      // branches: one at a time, each replaying from the tenant
      [2, 3, 4].forEach(function (b, k) { draw(b, step === 3 + k ? e : step > 3 + k ? 1 : 0); });

      if (step === 0) place(0, 0);
      else if (step === 1) place(0, e);
      else if (step === 2) place(1, e);
      else place(step - 1, e);

      // node i lights once the token arrives at it (node 0 is the start)
      nodes.forEach(function (n, i) {
        n.classList.toggle('is-lit', i === 0 || step > i || (step === i && e > .9));
      });
      chips.forEach(function (c) {
        var k = +c.getAttribute('data-chip');
        c.classList.toggle('is-on', k === 0 ? true : k === 1 ? step >= 1 : k === 2 ? step >= 2 : step >= 3);
      });
    }
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return; ticking = true;
      requestAnimationFrame(function () { ticking = false; update(); });
    }, { passive: true });
    window.addEventListener('resize', update);
    update();
  })();

  /* 2. Restatement time machine */
  (function timeMachine() {
    var range = $('tm-range'); if (!range) return;
    var num = $('tm-num'), status = $('tm-status'), c1 = $('tm-c1'), c2 = $('tm-c2'), note = $('tm-c1-note');
    var V1 = 412.6, V2 = 287.9, shown = V1, raf = null, state = null;
    function animateTo(target) {
      if (reduce) { shown = target; num.textContent = target.toFixed(1); return; }
      cancelAnimationFrame(raf);
      var from = shown, t0 = performance.now();
      (function tick(now) {
        var t = clamp((now - t0) / 600, 0, 1), e = 1 - Math.pow(1 - t, 3);
        shown = from + (target - from) * e; num.textContent = shown.toFixed(1);
        if (t < 1) raf = requestAnimationFrame(tick);
      })(t0);
    }
    function update() {
      var v2 = +range.value >= 50;
      if (v2 === state) return; state = v2;
      animateTo(v2 ? V2 : V1);
      status.textContent = v2 ? 'v2 · RESTATED' : 'v1 · AS PUBLISHED';
      status.classList.toggle('is-v2', v2);
      document.querySelectorAll('.tm-node[data-changes] [data-v1]').forEach(function (el) {
        el.textContent = el.getAttribute(v2 ? 'data-v2' : 'data-v1');
      });
      document.querySelectorAll('.tm-node[data-changes]').forEach(function (el) { el.classList.toggle('is-changed', v2); });
      c1.classList.toggle('is-superseded', v2);
      note.textContent = v2 ? 'Superseded by v2. Still on record.' : 'Published. Current figure.';
      c2.style.opacity = v2 ? '1' : '.35';
    }
    range.addEventListener('input', update);
    range.addEventListener('change', function () { range.value = +range.value >= 50 ? 100 : 0; update(); });
    update();
  })();

  /* 3. Maturity quiz */
  (function quiz() {
    var q = $('mq-q'); if (!q) return;
    var QS = [
      ['Can you report activity totals, like energy or fuel used, for the period?', 'Default emission factors are fine at this stage.'],
      ['Could you reproduce last period’s figure from versioned data with defined boundaries?', 'Think: could an auditor rebuild your number?'],
      ['Is ingestion automated, with method, provenance and lineage on every figure?', 'Not just in a spreadsheet note.'],
      ['Do you quantify uncertainty and reconcile against independent observations?', 'For example a second meter, a utility bill or satellite data.'],
      ['Do you forecast emissions and optimize them with suppliers and customers?', 'Across the value chain, not only inside your walls.']
    ];
    var NAMES = ['Not yet participating', 'Level 1 · Participating', 'Level 2 · Managed', 'Level 3 · Defined', 'Level 4 · Quantitatively controlled', 'Level 5 · Predictive and optimizing'];
    var NEXT = [
      'Start by gathering activity totals and applying default factors. That gets you to Level 1.',
      'Next: version your data and define boundaries so the report can be reproduced.',
      'Next: automate ingestion and attach lineage, method and uncertainty to every figure.',
      'Next: build uncertainty budgets and reconcile against independent evidence.',
      'Next: forecast and optimize burdens with your suppliers and customers.',
      'You are at the top of the ladder. Help shape the standard in the P7802 working group.'
    ];
    var dots = Array.prototype.slice.call(document.querySelectorAll('#mq-dots .mq-dot'));
    var rungs = Array.prototype.slice.call(document.querySelectorAll('#mq-ladder .mq-rung'));
    var hint = $('mq-hint'), actions = $('mq-actions'), done = $('mq-done'), result = $('mq-result');
    var i = 0, answers = [];

    function render() {
      dots.forEach(function (d, k) {
        d.className = 'mq-dot' + (answers[k] === true ? ' is-yes' : answers[k] === false ? ' is-no' : k === i && !finished() ? ' is-now' : '');
      });
      var level = answers.filter(function (a) { return a; }).length;
      rungs.forEach(function (r, k) {
        r.classList.toggle('is-reached', k < level);
        r.classList.toggle('is-here', finished() && k === level - 1);
      });
      if (finished()) {
        q.textContent = level === 0 ? 'You’re at the starting line.' : 'You’re at ' + NAMES[level].replace(' · ', ', ') + '.';
        hint.textContent = 'Based on ' + answers.length + ' answer' + (answers.length > 1 ? 's' : '') + '. This is a quick guide, not an assessment.';
        result.innerHTML = '';
        var h = document.createElement('h3'); h.textContent = NAMES[level];
        var p = document.createElement('p'); p.textContent = NEXT[level];
        result.appendChild(h); result.appendChild(p);
        actions.hidden = true; done.hidden = false;
      } else {
        q.textContent = QS[i][0]; hint.textContent = 'Question ' + (i + 1) + ' of 5 · ' + QS[i][1];
        actions.hidden = false; done.hidden = true;
      }
    }
    function finished() { return answers.length === 5 || answers[answers.length - 1] === false; }
    $('mq-yes').addEventListener('click', function () { answers.push(true); i++; render(); });
    $('mq-no').addEventListener('click', function () { answers.push(false); i++; render(); });
    $('mq-restart').addEventListener('click', function () {
      answers = []; i = 0;
      result.innerHTML = '<h3>Answer to climb the ladder</h3><p>Levels follow the P7802 core model. Higher maturity means less uncertainty, and less uncertainty means lower recognized emissions.</p>';
      render(); $('mq-yes').focus();
    });
    render();
  })();

  /* 4. North Star roadmap: buttons and arrow keys scroll the rail */
  (function roadmap() {
    var track = $('ns-track'); if (!track) return;
    function by(dir) {
      var card = track.querySelector('.ns-card');
      track.scrollBy({ left: dir * (card ? card.offsetWidth + 20 : 360), behavior: reduce ? 'auto' : 'smooth' });
    }
    $('ns-prev').addEventListener('click', function () { by(-1); });
    $('ns-next').addEventListener('click', function () { by(1); });
    track.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); by(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); by(-1); }
    });
  })();
})();

// Learn: click-to-load YouTube (privacy-enhanced, no cookies until played)
(function () {
  document.querySelectorAll('.lm-video[data-yt]').forEach(function (box) {
    var btn = box.querySelector('.lm-play');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var f = document.createElement('iframe');
      f.src = 'https://www.youtube-nocookie.com/embed/' + box.dataset.yt + '?autoplay=1&rel=0';
      f.title = 'SCOOP video';
      f.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      f.allowFullscreen = true;
      f.referrerPolicy = 'strict-origin-when-cross-origin';
      btn.replaceWith(f);
      f.focus();
    });
  });
})();

// Feature reuse map (from the draft project portfolio, Oct 2026). 1 = used, 0.5 = under discussion.
(function () {
  var grid = document.getElementById('fm-grid');
  if (!grid) return;
  var F = [
    ['Secure portal and dashboard', 'Signed-in workspace for each project', [0, 1, 1, 1]],
    ['Data entry template', 'Sampling rate, calculation assumptions, policy features, ownership', [1, 1, 1, 1]],
    ['Reference data retrieval', 'Profiles of carbon projects and typical emission sources', [0, 1, 0, 0]],
    ['Connector to live data feeds', 'CPU tenant cycles, GIS, LIDAR, manual collection', [1, 1, 1, 1]],
    ['Asset and liability simulation', 'Weather, energy, physical structure and other drivers', [1, 1, 0, 0]],
    ['One-time data upload', 'CSV and similar files', [0, 1, 1, 1]],
    ['Translator', 'Reconciles data built on different policies or standards', [0, 1, 1, 1]],
    ['Mapper', 'Equivalence between claims, products and events', [0, 1, 1, 0.5]],
    ['Calculation dashboard', 'Every input and output, with implications', [1, 1, 1, 1]],
    ['Export to existing systems', 'ERP, bill of materials, balance sheet', [0, 1, 0, 0]],
    ['Data lineage and event record', 'Trace, record and aggregate every event', [0, 1, 1, 1]],
    ['Agent-based auction', 'Settlement under a defined market policy', [0, 1, 0, 0]],
    ['What-if analysis', 'Financial, carbon, ROI and NPV under new assumptions', [0, 1, 1, 0.5]]
  ];
  var names = ['Data center monitor', 'Carbon exchange', 'Agroforestry portal', 'Community impact'];
  grid.innerHTML = F.map(function (f, i) {
    var used = f[2].filter(function (v) { return v === 1; }).length;
    var dots = f[2].map(function (v, j) {
      return '<span class="fm-dot' + (v === 1 ? ' on' : v ? ' maybe' : '') + '" title="' + names[j] + (v === 1 ? ': used' : v ? ': under discussion' : ': not used') + '"></span>';
    }).join('');
    return '<li class="fm-item" data-i="' + i + '"><strong>' + f[0] + '</strong><small>' + f[1] + '</small><div class="fm-dots">' + dots + '<span class="fm-count">' + used + ' of 4</span></div></li>';
  }).join('');
  var items = grid.querySelectorAll('.fm-item');
  document.querySelectorAll('.fm-tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.fm-tabs button').forEach(function (x) { x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
      var p = b.dataset.p;
      items.forEach(function (el) {
        var v = p === 'all' ? 1 : F[+el.dataset.i][2][+p - 1];
        el.classList.toggle('dim', p !== 'all' && !v);
        el.classList.toggle('hit', p !== 'all' && !!v);
      });
    });
  });
})();
