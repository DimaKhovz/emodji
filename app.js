(() => {
  const { Engine, Bodies, Body, Composite, Sleeping, Query } = Matter;

  // ---------- DOM ----------
  const canvas = document.getElementById('world');
  const ctx = canvas.getContext('2d');
  const field = document.getElementById('field');
  const bar = document.getElementById('bar');
  const statusEl = document.getElementById('status');
  const countEl = document.getElementById('count');
  const tip = document.getElementById('tip');
  const loading = document.getElementById('loading');
  const modal = document.getElementById('modal');
  const keyInput = document.getElementById('keyInput');
  const modelInput = document.getElementById('modelInput');

  const DEFAULT_MODEL = 'gemini-2.5-flash';
  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  const params = new URLSearchParams(location.search);
  const DEMO = params.get('demo') !== null; // ?demo — without API, for checking physics

  const MOBILE = params.get('mobile') !== null || matchMedia('(max-width: 700px)').matches ||
    (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700);
  document.body.classList.toggle('mobile', MOBILE);
  const vv = window.visualViewport;
  let offX = 0, offY = 0; // visual viewport offset (on-screen keyboard / pan)
  function viewport() {
    if (MOBILE && vv) {
      offX = vv.offsetLeft; offY = vv.offsetTop;
      const root = document.documentElement.style;
      root.setProperty('--vvt', offY + 'px'); root.setProperty('--vvh', vv.height + 'px');
      return { w: vv.width, h: vv.height };
    }
    return { w: window.innerWidth, h: window.innerHeight };
  }

  const norm = (s) => s.replace(/️/g, '');
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- geometry ----------
  let W = 0, H = 0, dpr = 1;
  let lineY = 0, lineX = 0, lineW = 0;
  let bigR = 20, spacing = 42, perRow = 10, maxMatched = 50;
  let mode = 'magnet'; // magnet | story | defend | guess
  const ordered = () => mode === 'story' || mode === 'guess'; // emojis read left to right

  // ---------- physics ----------
  const engine = Engine.create({ enableSleeping: true, positionIterations: 6, velocityIterations: 4 });
  engine.gravity.y = 1.5;
  const world = engine.world;
  const G = () => engine.gravity.y * engine.gravity.scale;

  const CAT_PILE = 0x0001, CAT_LINE = 0x0002, CAT_MAG = 0x0004, CAT_MOUSE = 0x8000;
  let floor, wallL, wallR, lineBody;
  let r0 = 14;

  const recs = [];            // all emoji records
  const byChar = new Map();   // normalized char -> record
  const active = new Set();   // currently magnetised records
  const probe = new Set();     // dropped near the bar, waiting for Gemini's verdict
  const forced = new Set();    // won the argument: stay magnetised for this query
  const banned = new Set();    // lost the argument: stay out for this query
  let currentChars = [];
  let spawnQueue = [];
  let atlas, atlasCtx, atlasFamily, ATLAS_CELL = 64, ATLAS_COLS = 40;
  const EXTRA_SLOTS = 80; // emojis summoned by search that were not in the heap
  let listLen = 0, extraUsed = 0;

  function measure() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = viewport(); W = vp.w; H = vp.h;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const r = field.getBoundingClientRect();
    lineX = r.left + r.width / 2 - offX; lineW = r.width; lineY = r.bottom - offY;
    bigR = MOBILE ? 16 : clamp(lineW / 40, 15, 24);
    spacing = bigR * 2.08;
    perRow = Math.max(4, Math.floor((lineW - 24) / spacing));
    maxMatched = MOBILE ? Math.min(perRow * 2, 20) : Math.min(perRow * 5, 90);
  }

  function slotPos(i) {
    const row = Math.floor(i / perRow), k = i % perRow;
    if (ordered()) return {
      x: lineX - (perRow - 1) / 2 * spacing + k * spacing,
      y: lineY + 10 + spacing * 0.5 + row * spacing * 0.94,
    };
    const off = k === 0 ? 0 : (k % 2 ? (k + 1) / 2 : -k / 2); // centre outward
    return {
      x: lineX + off * spacing + (perRow % 2 === 0 ? spacing / 2 : 0),
      y: lineY + 10 + spacing * 0.5 + row * spacing * 0.94,
    };
  }

  function zoneBottom(extra) {
    const rows = Math.max(3, Math.ceil((active.size + (extra || 0)) / perRow));
    return lineY + 18 + rows * spacing * 0.94 + 70;
  }

  function buildStatics() {
    const old = [floor, wallL, wallR, lineBody].filter(Boolean);
    if (old.length) Composite.remove(world, old);
    const opt = { isStatic: true, friction: 0.5, restitution: 0.3 };
    floor = Bodies.rectangle(W / 2, H + 60, W + 400, 120, { ...opt, collisionFilter: { category: CAT_PILE | CAT_LINE, mask: 0xFFFF } });
    wallL = Bodies.rectangle(-60, H / 2 - H, 120, H * 4, { ...opt, collisionFilter: { category: CAT_PILE | CAT_LINE, mask: 0xFFFF } });
    wallR = Bodies.rectangle(W + 60, H / 2 - H, 120, H * 4, { ...opt, collisionFilter: { category: CAT_PILE | CAT_LINE, mask: 0xFFFF } });
    lineBody = Bodies.rectangle(lineX, lineY - 30, lineW, 80, { // thick so fast emojis can't tunnel through
      ...opt, restitution: 0.5, collisionFilter: { category: CAT_LINE, mask: 0xFFFF },
    });
    Composite.add(world, [floor, wallL, wallR, lineBody]);
  }

  // ---------- atlas ----------
  async function buildAtlas(list) {
    const family = '"Noto Color Emoji", "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
    try { await document.fonts.load(`48px "Noto Color Emoji"`, list.map(e => e[0]).join('')); } catch {}
    try { await document.fonts.ready; } catch {}
    listLen = list.length;
    const rows = Math.ceil((list.length + EXTRA_SLOTS) / ATLAS_COLS);
    atlas = document.createElement('canvas');
    atlas.width = ATLAS_COLS * ATLAS_CELL; atlas.height = rows * ATLAS_CELL;
    const a = atlasCtx = atlas.getContext('2d');
    atlasFamily = family;
    a.font = `46px ${family}`;
    a.textAlign = 'center'; a.textBaseline = 'middle';
    list.forEach((e, i) => {
      const cx = (i % ATLAS_COLS) * ATLAS_CELL + ATLAS_CELL / 2;
      const cy = Math.floor(i / ATLAS_COLS) * ATLAS_CELL + ATLAS_CELL / 2 + 2;
      a.fillText(e[0], cx, cy);
    });
  }

  // ---------- records ----------
  function makeBody(x, y, r) {
    return Bodies.circle(x, y, r, {
      restitution: 0.5, friction: 0.25, frictionStatic: 0.4, frictionAir: 0.004, density: 0.002,
      sleepThreshold: 50, collisionFilter: { category: CAT_PILE, mask: CAT_PILE | CAT_MOUSE },
    }, 12);
  }

  function initRecords(list) {
    const area = W * (MOBILE ? Math.min(H, 420) : H) * 0.34;
    r0 = clamp(Math.sqrt(area / (list.length * 1.25)) / 2, MOBILE ? 7 : 8, MOBILE ? 10 : 17);
    list.forEach((e, i) => {
      const rec = { i, c: e[0], name: e[1], group: e[2], body: null, cur: r0, target: r0, state: 'pile', slot: -1, at: 0 };
      recs.push(rec);
      byChar.set(norm(e[0]), rec);
    });
    spawnQueue = recs.slice().sort(() => Math.random() - 0.5);
  }

  function spawnBatch(n, low) {
    const batch = spawnQueue.splice(0, n);
    for (const rec of batch) {
      rec.body = makeBody(rand(r0, W - r0), low ? H - rand(r0, 150) : rand(-300, -r0 * 2), r0);
      rec.body.rec = rec;
      Body.setAngle(rec.body, rand(0, 6.28));
      Body.setAngularVelocity(rec.body, rand(-0.1, 0.1));
      Composite.add(world, rec.body);
    }
  }

  // ---------- magnet logic ----------
  function setResults(chars) {
    const now = performance.now();
    while (spawnQueue.length) spawnBatch(500, true); // still raining: drop the rest straight into the heap

    currentChars = chars;
    const wanted = new Map();
    const add = (ch) => {
      const rec = byChar.get(norm(ch));
      if (rec && !banned.has(rec) && !wanted.has(rec) && wanted.size < maxMatched) wanted.set(rec, wanted.size);
    };
    forced.forEach(rec => add(rec.c));
    chars.forEach(add);
    for (const rec of wanted.keys()) probe.delete(rec);

    // release those that no longer match
    let outIdx = 0;
    for (const rec of Array.from(active)) {
      if (wanted.has(rec)) continue;
      active.delete(rec);
      rec.state = 'out'; rec.slot = -1; rec.moved = false; rec.target = r0; rec.at = now + outIdx++ * 12 + rand(0, 160);
      rec.released = false;
    }

    const n = wanted.size;
    if (ordered()) { // story / hints: slot = position in the sequence
      let k = 0;
      for (const [rec, idx] of wanted) {
        const p = slotPos(idx);
        rec.slot = idx; rec.moved = false; rec.tx = p.x; rec.ty = p.y;
        if (active.has(rec)) continue;
        rec.state = 'in'; rec.target = bigR; rec.at = now + k++ * 70; rec.engaged = false; rec.arrived = false;
        active.add(rec);
      }
      countEl.textContent = n ? `${n} шт.` : '';
      return;
    }
    const used = new Set();
    const movedRecs = [];
    for (const rec of active) { if (rec.moved) movedRecs.push(rec); else used.add(rec.slot); }
    const blocked = (i) => {
      const p = slotPos(i);
      return movedRecs.some(m => Math.hypot(m.tx - p.x, m.ty - p.y) < spacing * 0.85);
    };
    const lowestFree = () => { let s = 0; while (used.has(s) || blocked(s)) s++; return s; };
    // compact kept ones towards the first slots
    const kept = Array.from(active).filter(r => !r.moved && r.slot >= n).sort((a, b) => a.slot - b.slot);
    for (const rec of kept) {
      used.delete(rec.slot);
      const s2 = lowestFree();
      rec.slot = Math.min(rec.slot, s2); used.add(rec.slot);
      Object.assign(rec, { tx: slotPos(rec.slot).x, ty: slotPos(rec.slot).y });
    }

    // new arrivals
    let inIdx = 0;
    for (const [rec] of Array.from(wanted).sort((a, b) => a[1] - b[1])) {
      if (active.has(rec)) continue;
      rec.slot = lowestFree(); used.add(rec.slot);
      rec.moved = false; rec.tx = slotPos(rec.slot).x; rec.ty = slotPos(rec.slot).y;
      rec.state = 'in'; rec.target = bigR; rec.at = now + inIdx++ * 22; rec.engaged = false; rec.arrived = false;
      active.add(rec);
    }
    countEl.textContent = n ? `${n} шт.` : '';
  }

  function applyForces(now) {
    const g = G();
    const gx = engine.gravity.x * engine.gravity.scale; // phone tilt: only the heap feels it
    for (const rec of active) {
      const b = rec.body;
      if (now < rec.at) continue;
      if (!rec.engaged) {
        rec.engaged = true;
        b.collisionFilter.category = CAT_MAG;
        b.collisionFilter.mask = CAT_MAG | CAT_LINE | CAT_MOUSE; // flies through the heap, hits the magnet bar
        Sleeping.set(b, false);
        Body.setVelocity(b, { x: b.velocity.x + rand(-1, 1), y: b.velocity.y - 2 });
        Body.setAngularVelocity(b, rand(-0.15, 0.15));
      }
      Sleeping.set(b, false);
      const dx = rec.tx - b.position.x, dy = rec.ty - b.position.y;
      if (!rec.arrived && Math.hypot(dx, dy) < bigR * 0.8) { rec.arrived = true; fx.attach(); }
      let ax = dx * 0.022 - b.velocity.x * 0.32 - gx * 1000;
      let ay = dy * 0.022 - b.velocity.y * 0.30 - g * 1000; // cancel gravity
      const m = Math.hypot(ax, ay), cap = 9;
      if (m > cap) { ax *= cap / m; ay *= cap / m; }
      b.force.x += b.mass * ax * 0.001;
      b.force.y += b.mass * ay * 0.001;
      const sp = Math.hypot(b.velocity.x, b.velocity.y);
      if (sp > 18) Body.setVelocity(b, { x: b.velocity.x * 18 / sp, y: b.velocity.y * 18 / sp });
      // straighten up
      const ang = Math.atan2(Math.sin(b.angle), Math.cos(b.angle));
      Body.setAngularVelocity(b, b.angularVelocity * 0.93 - ang * 0.012);
    }
    for (const rec of recs) { // found-by-search emojis: fly clear of the heap, then land normally
      if (!rec.tossing) continue;
      const b = rec.body;
      if (b.velocity.y > -0.5 || now > rec.tossUntil) {
        rec.tossing = false;
        if (!active.has(rec)) { b.collisionFilter.category = CAT_PILE; b.collisionFilter.mask = CAT_PILE | CAT_MOUSE; }
      }
    }
    for (const rec of recs) { // shrink back once the glow is over
      if (rec.glowUntil && now > rec.glowUntil && !active.has(rec) && !probe.has(rec) && rec.target !== r0) { rec.target = r0; rec.glowUntil = 0; }
    }
    for (const rec of probe) {
      if (now - rec.probeAt > 15000) { dropRec(rec); continue; } // safety net: never hang forever
      const b = rec.body;
      Sleeping.set(b, false);
      const ax = (rec.hold.x - b.position.x) * 0.012 - b.velocity.x * 0.3 - gx * 1000;
      const ay = (rec.hold.y - b.position.y) * 0.012 - b.velocity.y * 0.3 - g * 1000;
      b.force.x += b.mass * ax * 0.001;
      b.force.y += b.mass * ay * 0.001;
    }
    for (const rec of recs) {
      if (rec.state !== 'out' || now < rec.at) continue;
      const b = rec.body;
      if (!rec.released) {
        rec.released = true;
        b.collisionFilter.category = CAT_PILE;
        b.collisionFilter.mask = CAT_PILE | CAT_MOUSE; // drops off the magnet, ignores the bar
        Sleeping.set(b, false);
        Body.setVelocity(b, { x: rand(-3.5, 3.5), y: rand(-1.5, 1) });
        fx.drop();
        Body.setAngularVelocity(b, rand(-0.25, 0.25));
      }
      if (b.isSleeping && Math.abs(rec.cur - rec.target) < 0.05) rec.state = 'pile';
    }
    // smooth radius change (grow when attached / shrink "falling back")
    for (const rec of recs) {
      if (!rec.body || Math.abs(rec.cur - rec.target) < 0.02) continue;
      if (rec.state === 'in' && now < rec.at) continue;
      if (rec.state === 'out' && now < rec.at) continue;
      const next = rec.cur + (rec.target - rec.cur) * 0.07;
      const k = next / rec.cur;
      Body.scale(rec.body, k, k);
      rec.cur = next;
    }
  }
  Matter.Events.on(engine, 'beforeUpdate', () => applyForces(performance.now()));

  // ---------- render ----------
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const act = [];
    for (const rec of recs) {
      const b = rec.body;
      if (!b) continue;
      if (active.has(rec) || probe.has(rec) || rec.state === 'out' || rec.glowUntil > performance.now()) { act.push(rec); continue; }
      drawSprite(rec, 0.92);
    }

    // magnet bar (reset the transform left over from the sprites)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const glow = Math.min(1, active.size / 12);
    const gr = ctx.createLinearGradient(lineX - lineW / 2, 0, lineX + lineW / 2, 0);
    gr.addColorStop(0, 'rgba(124,140,255,0.15)');
    gr.addColorStop(0.5, 'rgba(160,175,255,0.95)');
    gr.addColorStop(1, 'rgba(124,140,255,0.15)');
    ctx.save();
    ctx.shadowColor = `rgba(124,140,255,${0.25 + glow * 0.6})`;
    ctx.shadowBlur = 10 + glow * 26;
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.roundRect(lineX - lineW / 2, lineY, lineW, 6, [0, 0, 6, 6]);
    ctx.fill();
    ctx.restore();

    act.sort((a, b) => (active.has(a) || probe.has(a) ? 1 : 0) - (active.has(b) || probe.has(b) ? 1 : 0));
    for (const rec of act) {
      drawSprite(rec, 1);
      const left = rec.glowUntil - performance.now();
      if (left > 0) { // "look here": pulsing ring around a found emoji
        const b = rec.body, k = Math.min(1, left / 600), pulse = 1 + 0.12 * Math.sin(performance.now() / 110);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.beginPath(); ctx.arc(b.position.x, b.position.y, rec.cur * 1.55 * pulse, 0, 6.283);
        ctx.lineWidth = 2.5; ctx.strokeStyle = `rgba(255,236,150,${0.9 * k})`;
        ctx.shadowColor = 'rgba(255,220,120,0.9)'; ctx.shadowBlur = 14 * k; ctx.stroke(); ctx.shadowBlur = 0;
      }
    }
  }

  function drawSprite(rec, alpha) {
    const b = rec.body;
    const d = rec.cur * 2 * 1.32;
    const sx = (rec.i % ATLAS_COLS) * ATLAS_CELL, sy = Math.floor(rec.i / ATLAS_COLS) * ATLAS_CELL;
    const c = Math.cos(b.angle), s = Math.sin(b.angle);
    ctx.setTransform(c * dpr, s * dpr, -s * dpr, c * dpr, b.position.x * dpr, b.position.y * dpr);
    ctx.globalAlpha = alpha;
    ctx.drawImage(atlas, sx, sy, ATLAS_CELL, ATLAS_CELL, -d / 2, -d / 2, d, d);
    ctx.globalAlpha = 1;
  }

  // ---------- loop ----------
  let last = performance.now(), acc = 0;
  function frame(t) {
    const dt = Math.min(t - last, 100); last = t;
    acc += dt;
    if (spawnQueue.length) spawnBatch(26);
    let steps = 0;
    while (acc >= 1000 / 60 && steps < 3) { Engine.update(engine, 1000 / 60); acc -= 1000 / 60; steps++; }
    if (steps === 3) acc = 0;
    draw();
    requestAnimationFrame(frame);
  }


  // ---------- picking an emoji: Gemini explains / judges ----------
  const bubble = document.getElementById('bubble');
  const bEmoji = document.getElementById('bEmoji');
  const bVerdict = document.getElementById('bVerdict');
  const bText = document.getElementById('bText');
  const bArg = document.getElementById('bArg');
  let convo = null;

  function hideBubble() { bubble.classList.remove('open'); convo = null; }

  function placeBubble() {
    const rows = Math.ceil(Math.max(active.size, 1) / perRow);
    const top = lineY + 18 + rows * spacing * 0.94 + 14;
    if (MOBILE) {
      bubble.style.left = (offX + 10) + 'px';
      bubble.style.top = (offY + Math.min(top, Math.max(H - 175, lineY + 20))) + 'px';
    } else {
      bubble.style.left = clamp(lineX - 170, 10, Math.max(10, W - 350)) + 'px';
      bubble.style.top = Math.min(top, H * 0.5) + 'px';
    }
  }

  function showBubble(rec, state, reason) {
    bEmoji.textContent = rec.c;
    bVerdict.className = state;
    bVerdict.textContent = state === 'think' ? 'thinking…' : state === 'yes' ? 'fits' : 'does not fit';
    bText.textContent = reason || '';
    bArg.disabled = state === 'think';
    bArg.placeholder = state === 'no' ? 'Argue back… (Enter)' : 'Disagree? Say why… (Enter)';
    placeBubble();
    bubble.classList.add('open');
  }

  function holdRec(rec, x, y) {
    rec.hold = { x, y };
    rec.state = 'probe'; rec.target = bigR; rec.probeAt = performance.now();
    const b = rec.body;
    b.collisionFilter.category = CAT_MAG;
    b.collisionFilter.mask = CAT_MAG | CAT_LINE | CAT_MOUSE;
    probe.add(rec);
  }

  function dropRec(rec) {
    const kick = probe.delete(rec);
    if (active.has(rec)) return;
    rec.state = 'out'; rec.target = r0; rec.at = performance.now(); rec.released = !kick;
  }

  function applyVerdict(rec, v, wasActive) {
    if (v.fits) {
      banned.delete(rec); forced.add(rec);
      setResults(currentChars);
    } else if (wasActive) {
      forced.delete(rec); banned.add(rec);
      setResults(currentChars);
    } else {
      dropRec(rec);
    }
  }

  async function pick(rec, held) {
    const text = field.value.trim();
    if (!text) { dropRec(rec); showBubble(rec, 'no', 'Type something first, then I can judge.'); convo = null; return; }
    const wasActive = active.has(rec);
    const c = convo = { rec, text, reason: '', wasActive };
    showBubble(rec, 'think', '');
    try {
      const v = await judge(text, rec);
      // always settle the emoji, even if the user moved on meanwhile (else it hangs in the air)
      if (field.value.trim() === text) applyVerdict(rec, v, wasActive);
      else dropRec(rec);
      if (convo !== c) return;
      c.reason = v.reason;
      showBubble(rec, v.fits ? 'yes' : 'no', v.reason);
    } catch (e) {
      if (!wasActive) dropRec(rec);
      if (convo !== c) return;
      showBubble(rec, 'no', 'Error: ' + e.message);
    }
  }

  bArg.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && mode === 'defend') { game.defend(bArg.value.trim()); return; }
    if (e.key !== 'Enter' || !convo || !bArg.value.trim()) return;
    const c = convo, arg = bArg.value.trim();
    bArg.value = '';
    coach.check(arg, 'argument');
    const wasActive = active.has(c.rec);
    showBubble(c.rec, 'think', '');
    try {
      const v = await judge(c.text, c.rec, arg, c.reason);
      if (convo !== c) return;
      c.reason = v.reason;
      showBubble(c.rec, v.fits ? 'yes' : 'no', v.reason);
      applyVerdict(c.rec, v, wasActive);
    } catch (err) {
      if (convo === c) showBubble(c.rec, 'no', 'Error: ' + err.message);
    }
  });
  document.getElementById('bClose').addEventListener('click', hideBubble);

  function onDragEnd(rec, moved) {
    const b = rec.body;
    if (probe.has(rec)) return;
    if (mode === 'defend' || mode === 'guess') { // games: tap reopens the game panel, no judging
      if (active.has(rec) && moved < 10) game.reopen();
      return;
    }
    const inBox = Math.abs(b.position.x - lineX) < lineW / 2 + 30 && b.position.y < zoneBottom(1);
    if (active.has(rec)) {
      if (moved < 10) pick(rec, false);
      else if (inBox) { // dropped somewhere else under the bar: stays right there
        rec.moved = true; rec.slot = -1;
        rec.tx = clamp(b.position.x, lineX - lineW / 2 + bigR, lineX + lineW / 2 - bigR);
        rec.ty = Math.max(b.position.y, lineY + bigR + 10);
      }
      return; // pulled far away: spring brings it back to where it was
    }
    const inZone = inBox && b.position.y > lineY;
    if (inZone) { holdRec(rec, b.position.x, b.position.y); pick(rec, true); }
    else if (moved < 10) pick(rec, false); // plain tap/click: explain / judge
  }

  // ---------- pointer (mouse + finger) ----------
  // Own pointer handling instead of Matter's mouse: uses clientX/Y, so it stays
  // correct on phones when the keyboard shifts the visual viewport.
  function toWorld(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function hitTest(p, slop) {
    let best = null, bestD = Infinity;
    for (const rec of recs) {
      const b = rec.body;
      if (!b) continue;
      const d = Math.hypot(b.position.x - p.x, b.position.y - p.y) - rec.cur;
      if (d > slop) continue;
      // magnetised / held ones are drawn on top: prefer them
      const score = d - (active.has(rec) || probe.has(rec) ? 1000 : 0);
      if (score < bestD) { bestD = score; best = rec; }
    }
    return best;
  }

  function setupMouse() {
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      fx.unlock();
      if (e.button !== undefined && e.button > 0) return;
      const p = toWorld(e);
      const rec = hitTest(p, e.pointerType === 'mouse' ? 1 : 14);
      if (!rec) return;
      e.preventDefault(); // keep the keyboard / input focus
      fx.tap();
      const b = rec.body;
      Sleeping.set(b, false);
      const con = Matter.Constraint.create({
        pointA: p, bodyB: b,
        pointB: { x: p.x - b.position.x, y: p.y - b.position.y },
        stiffness: 0.25, damping: 0.1, length: 0,
      });
      con.angleB = b.angle;
      Composite.add(world, con);
      drag = { id: e.pointerId, rec, con, x: b.position.x, y: b.position.y };
      try { canvas.setPointerCapture(e.pointerId); } catch {}
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      e.preventDefault();
      drag.con.pointA = toWorld(e);
      Sleeping.set(drag.rec.body, false);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { rec, con, x, y } = drag;
      drag = null;
      Composite.remove(world, con);
      const b = rec.body;
      onDragEnd(rec, Math.hypot(b.position.x - x, b.position.y - y));
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    if (!MOBILE) window.addEventListener('mousemove', (e) => {
      const hit = Query.point(Array.from(active).map(r => r.body), { x: e.clientX, y: e.clientY })[0];
      if (hit && hit.rec) {
        tip.textContent = `${hit.rec.c}  ${hit.rec.name}`;
        tip.style.left = Math.min(e.clientX + 14, W - 220) + 'px';
        tip.style.top = e.clientY + 18 + 'px';
        tip.style.opacity = 1;
      } else tip.style.opacity = 0;
    });
  }

  // ---------- Gemini ----------
  const PROMPT = `You are the semantic engine of an emoji picker. The user is typing a text line (any language).
Return Unicode emojis that fit the WHOLE text, in two kinds:
1) OBVIOUS: strongly and directly relevant emojis.
2) CREATIVE: emojis whose look can be read, logically and wittily, as relevant even though that is not their usual meaning. Examples: the sweating smiley fits "running" or "gym" (it is sweating from effort); the crying-laughing smiley fits "motorbike" (speed blows the tears and spit sideways).
Order: the most obvious first, creative ones after them. Every item needs a defensible link; no random filler.
The text is cumulative: later words narrow or modify the earlier ones (e.g. "what to wear" then "in winter" drops summer items).
At most MAX items; each item is a single emoji character; if the text is empty or meaningless return an empty array.`;

  const PROMPT_M = `You are the semantic engine of a mobile emoji picker. The user is typing a text line (any language).
The user picks the obvious emojis by hand, so DO NOT return obvious ones. Return ONLY creative, lateral picks: emojis whose look can be read, logically and wittily, as relevant even though that is not their usual meaning. Examples: the sweating smiley fits "running" or "gym" (it is sweating from effort); the crying-laughing smiley fits "motorbike" (speed blows the tears sideways).
Every item needs a defensible link. If there are not enough clever picks, fill up with emojis that are loosely or indirectly related (still avoid the most obvious ones). The text is cumulative: later words narrow earlier ones.
Choose ONLY from this list: LIST
Return between MIN and MAX items, each a single emoji character copied from the list, best first. If the text is empty or meaningless return an empty array.`;

  const STORY = `Turn the user's text into a short emoji story: a sequence of emojis that tells it step by step, in chronological order, like a one-line comic strip.
Creative, witty readings of an emoji's look are welcome (e.g. the sweating smiley = running late). Each emoji at most once.
Return between MIN and MAX emojis, in story order. If the text is empty or meaningless return an empty array.`;

  const JUDGE = `You judge whether an emoji fits the user's text. It fits if EITHER the link is obvious OR a creative, witty but logical reading of the emoji's look connects it to the text (e.g. the sweating smiley fits "running": it sweats from effort; the crying-laughing smiley fits "motorbike": speed blows the tears sideways). Be generous: accept whenever a defensible link exists; reject only when no logical link can be made.
Reply as JSON {"fits": boolean, "reason": string}. The reason is in English, ONE short sentence, max 14 words, light wit welcome. If it fits, state the link; if not, state why it does not fit.`;

  let inflight = null;
  let lastText = '';
  const cache = new Map();

  async function geminiJSON(prompt, schema, signal) {
    const key = store.get('gemini_key');
    if (!key) throw new Error('Нужен API-ключ — нажми ⚙');
    const model = store.get('gemini_model') || DEFAULT_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const mk = (withThinking) => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.4,
        ...(withThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    });
    const post = (body) => fetch(url, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    let res = await post(mk(true));
    if (res.status === 400) res = await post(mk(false));
    if (!res.ok) {
      let msg = res.status + '';
      try { msg = (await res.json()).error?.message || msg; } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || 'null';
    return JSON.parse(raw);
  }

  async function callGemini(text, signal) {
    const listNote = MOBILE ? '\nChoose ONLY from this list: ' + recs.map(r => r.c).join(' ') : '';
    const prompt = mode === 'story'
      ? STORY.replace('MIN', '5').replace('MAX', String(Math.min(16, maxMatched))) + listNote
      : MOBILE
        ? PROMPT_M.replace('LIST', recs.map(r => r.c).join(' ')).replace('MIN', String(Math.min(perRow + 3, maxMatched)))
        : PROMPT;
    const arr = await geminiJSON(
      prompt.replace('MAX', String(maxMatched)) + '\n\nTEXT:\n' + text,
      { type: 'ARRAY', items: { type: 'STRING' } }, signal) || [];
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const out = [];
    for (const item of arr) for (const { segment } of seg.segment(String(item))) out.push(segment);
    return out;
  }

  async function judge(text, rec, argument, prevReason) {
    if (DEMO) {
      const ok = text.toLowerCase().split(/\s+/).some(w => w.length > 1 && rec.name.includes(w)) || !!argument;
      await new Promise(r => setTimeout(r, 500));
      return { fits: ok, reason: ok ? 'Demo mode: looks like a fit to me.' : 'Demo mode: I see no link here.' };
    }
    let p = `${JUDGE}\n\nUser text: "${text}"\nEmoji: ${rec.c} (${rec.name})`;
    if (argument) p += `\nYour previous verdict reason: "${prevReason}"\nThe user objects: "${argument}"\nIf the objection is logical, concede (fits=true) in one short sentence; if it is weak, keep your verdict and say briefly why.`;
    const r = await geminiJSON(p, {
      type: 'OBJECT', properties: { fits: { type: 'BOOLEAN' }, reason: { type: 'STRING' } }, required: ['fits', 'reason'],
    });
    return { fits: !!r.fits, reason: String(r.reason || '') };
  }

  function demoPick(text) {
    // offline stub: picks emojis by name keywords, just to test the physics
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    if (!words.length) return [];
    return recs.filter(r => words.some(w => r.name.includes(w))).slice(0, maxMatched).map(r => r.c);
  }

  function setStatus(msg, err) { statusEl.textContent = msg; statusEl.classList.toggle('err', !!err); }

  async function run(text) {
    text = text.trim();
    if (inflight) inflight.abort();
    if (text !== lastText) { forced.clear(); banned.clear(); lastText = text; }
    if (!text) { setResults([]); setStatus('Напиши что-нибудь, например: что надеть зимой'); return; }
    const key = mode + '|' + text;
    if (cache.has(key)) { setResults(cache.get(key)); setStatus('Готово'); return; }
    const ac = inflight = new AbortController();
    setStatus('Думаю…');
    try {
      const list = DEMO ? demoPick(text) : await callGemini(text, ac.signal);
      if (ac.signal.aborted) return;
      cache.set(key, list);
      setResults(list);
      if (list.length) hist.add(text, list);
      setStatus(list.length ? 'Готово' : 'Ничего не нашлось');
    } catch (e) {
      if (e.name === 'AbortError') return;
      setStatus('Ошибка: ' + e.message, true);
    }
  }

  let timer = 0;
  field.addEventListener('input', () => {
    if (mode === 'defend' || mode === 'guess') return;
    hideBubble();
    clearTimeout(timer);
    timer = setTimeout(() => run(field.value), 550);
  });
  field.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (mode === 'guess') { game.guess(field.value); return; }
    if (mode === 'defend') return;
    clearTimeout(timer); run(field.value);
    coach.check(field.value, 'phrase', (fixed) => { field.value = fixed; run(fixed); });
  });

  // ---------- preferences ----------
  const prefs = {
    sound: store.get('opt_sound') !== '0',
    vibe: store.get('opt_vibe') !== '0',
    tilt: false,
    shake: store.get('opt_shake') !== '0',
  };

  // ---------- sound + vibration ----------
  const fx = (() => {
    let audio = null;
    const last = {};
    const ok = (k, gap) => { const t = performance.now(); if (t - (last[k] || 0) < gap) return false; last[k] = t; return true; };
    function tone(f0, f1, dur, type, vol, delay = 0) {
      if (!prefs.sound || !audio || audio.state !== 'running') return;
      const t = audio.currentTime + delay;
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + dur + 0.02);
    }
    const buzz = (p) => { if (prefs.vibe && navigator.vibrate) try { navigator.vibrate(p); } catch {} };
    return {
      unlock() {
        try {
          if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
          if (audio.state === 'suspended') audio.resume();
        } catch {}
      },
      get audio() { return audio; },
      buzz,
      tap() { if (ok('vt', 120)) buzz(18); },
      attach() { if (ok('a', 45)) { tone(1500, 900, 0.05, 'triangle', 0.07); } if (ok('va', 110)) buzz(28); },
      drop() { if (ok('d', 60)) tone(420, 130, 0.16, 'sine', 0.08); if (ok('vd', 150)) buzz(16); },
      win() { [660, 880, 1320].forEach((f, i) => tone(f, f, 0.12, 'triangle', 0.08, i * 0.09)); buzz([40, 50, 40, 50, 90]); },
      wrong() { tone(220, 150, 0.18, 'square', 0.04); buzz([60, 60, 60]); },
    };
  })();
  window.addEventListener('keydown', () => fx.unlock(), { capture: true });

  // ---------- phone tilt: moves only the heap ----------
  const tilt = (() => {
    let on = false, gx = 0, woke = 0;
    function onOrient(e) {
      if (e.gamma == null) return;
      const target = clamp(Math.sin(e.gamma * Math.PI / 180) * 1.6, -1.1, 1.1);
      gx += (target - gx) * 0.25;
      engine.gravity.x = Math.abs(gx) < 0.06 ? 0 : gx;
      if (Math.abs(gx - woke) > 0.06) { // sleeping bodies ignore gravity: wake the heap
        woke = gx;
        for (const rec of recs) if (rec.body && !active.has(rec) && !probe.has(rec)) Sleeping.set(rec.body, false);
      }
    }
    function start() { if (!on) { on = true; window.addEventListener('deviceorientation', onOrient); } }
    function stop() { on = false; window.removeEventListener('deviceorientation', onOrient); engine.gravity.x = 0; gx = 0; }
    return {
      set(want) {
        prefs.tilt = want; store.set('opt_tilt', want ? '1' : '0');
        if (!want || !MOBILE) { stop(); return; }
        const D = window.DeviceOrientationEvent;
        if (D && typeof D.requestPermission === 'function') { // iOS: must be asked from a tap
          D.requestPermission().then(r => r === 'granted' ? start() : stop()).catch(stop);
        } else start();
      },
      _start: start, // for testing
      boot() {
        const saved = store.get('opt_tilt');
        const needsAsk = window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function';
        prefs.tilt = MOBILE && saved !== '0'; // on by default on phones
        if (!prefs.tilt) return;
        if (!needsAsk) { start(); return; }
        // iOS (and some Chrome builds) ask for motion access: do it on the first tap
        const ask = () => {
          window.removeEventListener('pointerdown', ask, true);
          DeviceOrientationEvent.requestPermission().then(r => r === 'granted' ? start() : (prefs.tilt = false)).catch(() => (prefs.tilt = false));
        };
        window.addEventListener('pointerdown', ask, true);
      },
    };
  })();

  // ---------- toast ----------
  const toastEl = document.getElementById('toast');
  let toastT = 0;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 1600);
  }

  // ---------- copy the row ----------
  function rowText() {
    const rowH = spacing * 0.94;
    return Array.from(active)
      .map(r => ({ r, row: Math.round((r.ty - lineY - 10 - spacing * 0.5) / rowH), x: r.tx }))
      .sort((a, b) => a.row - b.row || a.x - b.x)
      .map(o => o.r.c).join('');
  }
  async function copyRow() {
    const text = rowText();
    if (!text) { toast('Нечего копировать'); return; }
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {}
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
    }
    toast(ok ? `Скопировано: ${text}` : 'Не получилось скопировать');
    if (ok) { fx.attach(); fx.buzz([30, 40, 30]); }
  }
  document.getElementById('copyBtn').addEventListener('click', copyRow);

  // ---------- query history ----------
  const histPanel = document.getElementById('histPanel');
  const hist = {
    load() { try { return JSON.parse(store.get('emodji_history') || '[]'); } catch { return []; } },
    add(text, chars) {
      if (mode !== 'magnet' && mode !== 'story') return;
      const list = hist.load().filter(h => !(h.t === text && h.m === mode));
      list.unshift({ t: text, m: mode, c: chars.slice(0, 40) });
      store.set('emodji_history', JSON.stringify(list.slice(0, 25)));
    },
    render() {
      const list = hist.load();
      histPanel.innerHTML = '';
      if (!list.length) { histPanel.innerHTML = '<div class="hempty">Пока пусто — попробуй что-нибудь написать</div>'; return; }
      for (const h of list) {
        const b = document.createElement('button');
        b.className = 'hitem';
        const t = document.createElement('span'); t.className = 'ht';
        t.textContent = (h.m === 'story' ? '📖 ' : '') + h.t;
        const e = document.createElement('span'); e.className = 'he';
        e.textContent = h.c.slice(0, 10).join('');
        b.append(t, e);
        b.addEventListener('click', () => {
          histPanel.classList.remove('open');
          setMode(h.m);
          field.value = h.t; lastText = h.t;
          cache.set(h.m + '|' + h.t, h.c);
          setResults(h.c); setStatus('Из истории');
        });
        histPanel.appendChild(b);
      }
      const clr = document.createElement('button');
      clr.className = 'hclear'; clr.textContent = 'Очистить историю';
      clr.addEventListener('click', () => { store.set('emodji_history', '[]'); hist.render(); });
      histPanel.appendChild(clr);
    },
  };
  document.getElementById('histBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (histPanel.classList.toggle('open')) hist.render();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!histPanel.contains(e.target) && e.target.id !== 'histBtn') histPanel.classList.remove('open');
  });

  // ---------- game panel (reuses the bubble) ----------
  const bActions = document.getElementById('bActions');
  function showPanel({ emoji, pill, pillClass, text, input, actions }) {
    convo = null;
    bEmoji.textContent = emoji || '';
    bVerdict.className = pillClass || '';
    bVerdict.textContent = pill || '';
    bText.textContent = text || '';
    bArg.style.display = input ? '' : 'none';
    if (input) { bArg.placeholder = input; bArg.disabled = false; }
    bActions.innerHTML = '';
    for (const a of actions || []) {
      const b = document.createElement('button');
      b.textContent = a.label; if (a.primary) b.className = 'primary';
      b.addEventListener('click', a.fn);
      bActions.appendChild(b);
    }
    placeBubble();
    bubble.classList.add('open');
  }
  // plain magnet bubble: no game buttons, input visible
  const _showBubble = showBubble;
  showBubble = function (...a) { bActions.innerHTML = ''; bArg.style.display = ''; _showBubble(...a); };

  const stats = {
    get() { try { return JSON.parse(store.get('emodji_stats') || '{}'); } catch { return {}; } },
    put(s) { store.set('emodji_stats', JSON.stringify(s)); },
  };

  const TOPICS = ['winter', 'the beach', 'outer space', 'cooking dinner', 'school', 'a wedding', 'football', 'the office',
    'camping', 'a birthday party', 'rain', 'music', 'the cinema', 'an airport', 'the gym', 'a hospital', 'pizza',
    'Monday morning', 'love', 'money', 'shopping', 'robots', 'dinosaurs', 'Halloween', 'New Year', 'fishing', 'coffee',
    'sleep', 'an exam', 'video games', 'the ocean', 'a farm', 'superheroes', 'a job interview', 'a first date',
    'a road trip', 'cats', 'the internet', 'the jungle', 'a traffic jam', 'a haircut', 'the dentist', 'a picnic'];
  const CATEGORIES = ['food', 'animals', 'weather', 'sports', 'professions', 'household objects', 'transport', 'nature',
    'holidays', 'music', 'clothes', 'places in a city', 'space', 'the sea', 'technology', 'feelings', 'body', 'fairy tales'];
  const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
  const cleanWord = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  const game = {
    round: null,
    reopen() { if (game.round && game.round.panel) game.round.panel(); },

    // ---- Defend the emoji ----
    newDefend() {
      const pool = recs.filter(r => r.group !== 'Flags');
      const rec = pickOne(pool), topic = pickOne(TOPICS);
      field.value = 'Тема: ' + topic;
      setResults([rec.c]);
      const s = stats.get().defend || { rounds: 0, sum: 0, best: 0 };
      setStatus(s.rounds ? `Раундов: ${s.rounds} · средний балл ${(s.sum / s.rounds).toFixed(1)} · рекорд ${s.best}` : 'Защити смайлик: докажи, что он подходит к теме');
      const r = game.round = { kind: 'defend', rec, topic, done: false };
      r.panel = () => showPanel({
        emoji: rec.c, pill: 'defend it!', text: `Why does ${rec.c} fit “${topic}”? Be clever — logic and wit score points.`,
        input: 'Your defence… (Enter)', actions: [{ label: 'Другой смайлик ↻', fn: () => game.newDefend() }],
      });
      r.panel();
    },
    async defend(arg) {
      const r = game.round;
      if (!r || r.kind !== 'defend' || r.done || !arg) return;
      bArg.value = ''; bArg.disabled = true;
      coach.check(arg, 'defence');
      bVerdict.className = ''; bVerdict.textContent = 'judging…';
      try {
        let res;
        if (DEMO) { await new Promise(x => setTimeout(x, 500)); res = { score: Math.min(10, 3 + Math.floor(arg.length / 12)), comment: 'Demo mode: nice try!' }; }
        else res = await geminiJSON(`Game "Defend the emoji". Topic: "${r.topic}". Emoji: ${r.rec.c} (${r.rec.name}).
The player argues why this emoji fits the topic. Player's defence: "${arg}"
Score it 0-10 for logic, wit and creativity: a lazy or illogical defence scores low, a clever, witty reading of the emoji's look scores high.
Reply JSON {"score": integer, "comment": string}. The comment is in simple English, ONE short friendly sentence, max 16 words.`,
          { type: 'OBJECT', properties: { score: { type: 'INTEGER' }, comment: { type: 'STRING' } }, required: ['score', 'comment'] });
        if (game.round !== r) return;
        const score = clamp(Math.round(+res.score || 0), 0, 10);
        r.done = true;
        const all = stats.get(); const s = all.defend || { rounds: 0, sum: 0, best: 0 };
        s.rounds++; s.sum += score; s.best = Math.max(s.best, score); all.defend = s; stats.put(all);
        setStatus(`Раундов: ${s.rounds} · средний балл ${(s.sum / s.rounds).toFixed(1)} · рекорд ${s.best}`);
        if (score >= 6) fx.win(); else fx.wrong();
        r.panel = () => showPanel({
          emoji: r.rec.c, pill: `${score}/10`, pillClass: score >= 6 ? 'yes' : 'no', text: res.comment,
          actions: [{ label: 'Следующий раунд ▶', primary: true, fn: () => game.newDefend() }],
        });
        r.panel();
      } catch (e) {
        if (game.round !== r) return;
        bArg.disabled = false;
        bVerdict.className = 'no'; bVerdict.textContent = 'error'; bText.textContent = e.message;
      }
    },

    // ---- Guess the word ----
    async newGuess() {
      const r = game.round = { kind: 'guess', loading: true };
      field.value = ''; setResults([]);
      setStatus('Загадываю слово…');
      showPanel({ emoji: '❓', pill: 'thinking…', text: 'Picking a secret word…' });
      try {
        let res;
        if (DEMO) res = { word: 'heart', accept: ['heart', 'сердце'], hints: recs.filter(x => x.name.includes('heart')).slice(0, 8).map(x => x.c) };
        else {
          const recent = (() => { try { return JSON.parse(store.get('emodji_recent_words') || '[]'); } catch { return []; } })();
          const listNote = MOBILE ? '\nUse ONLY emojis from this list: ' + recs.map(x => x.c).join(' ') : '';
          res = await geminiJSON(`Game "Guess the word by emojis". Secretly pick ONE common, concrete English noun from the category "${pickOne(CATEGORIES)}". Avoid: ${recent.join(', ') || 'nothing'}.
Give 8 emoji hints ordered from the most creative / indirect (witty readings of an emoji's look are great) to the most obvious (the last ones almost give it away). Each hint is a single emoji, no repeats.${listNote}
Also give "accept": all acceptable answers in lowercase — the word, close synonyms and plural, in English AND in Russian.
Reply JSON {"word": string, "accept": [string], "hints": [string]}.`,
            { type: 'OBJECT', properties: { word: { type: 'STRING' }, accept: { type: 'ARRAY', items: { type: 'STRING' } }, hints: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['word', 'accept', 'hints'] });
          store.set('emodji_recent_words', JSON.stringify([res.word, ...recent].slice(0, 20)));
        }
        if (game.round !== r) return;
        const seen = new Set();
        r.hints = (res.hints || []).map(h => byChar.get(norm(String(h))))
          .filter(x => x && !seen.has(x) && seen.add(x)).map(x => x.c);
        if (r.hints.length < 3) throw new Error('не вышло подобрать подсказки, попробуй ещё');
        r.word = String(res.word || '');
        r.accept = [r.word, ...(res.accept || [])].map(cleanWord).filter(Boolean);
        r.shown = Math.min(3, r.hints.length); r.wrong = 0; r.loading = false; r.done = false;
        setResults(r.hints.slice(0, r.shown));
        setStatus('Угадай слово по смайликам и напиши его в строке');
        field.placeholder = 'Твой ответ… (Enter)';
        r.panel = () => game.guessPanel();
        r.panel();
      } catch (e) {
        if (game.round !== r) return;
        setStatus('Ошибка: ' + e.message, true);
        showPanel({ emoji: '❓', pill: 'error', pillClass: 'no', text: e.message, actions: [{ label: 'Ещё раз ↻', primary: true, fn: () => game.newGuess() }] });
      }
    },
    points() { const r = game.round; return Math.max(1, 10 - (r.shown - 3) * 2 - r.wrong); },
    guessPanel(extra) {
      const r = game.round;
      showPanel({
        emoji: '❓', pill: `hint ${r.shown}/${r.hints.length}`,
        text: (extra ? extra + ' ' : '') + `Guess the word! It's worth ${game.points()} points now.`,
        actions: [
          ...(r.shown < r.hints.length ? [{ label: '+ подсказка', fn: () => { r.shown++; setResults(r.hints.slice(0, r.shown)); game.guessPanel(); } }] : []),
          { label: 'Сдаюсь', fn: () => game.endGuess(false) },
        ],
      });
    },
    guess(text) {
      const r = game.round;
      if (!r || r.kind !== 'guess' || r.loading || r.done) return;
      const g = cleanWord(text);
      if (!g) return;
      const hit = r.accept.some(a => a === g || (a.length >= 5 && lev(a, g) <= 1));
      if (hit) { game.endGuess(true); return; }
      r.wrong++; fx.wrong();
      field.classList.remove('shake'); void field.offsetWidth; field.classList.add('shake');
      field.select();
      game.guessPanel(`“${text.trim()}” — nope.`);
    },
    endGuess(won) {
      const r = game.round;
      r.done = true;
      const pts = won ? game.points() : 0;
      const all = stats.get(); const s = all.guess || { rounds: 0, wins: 0, points: 0 };
      s.rounds++; if (won) s.wins++; s.points += pts; all.guess = s; stats.put(all);
      setResults(r.hints);
      if (won) fx.win();
      setStatus(`Угадано ${s.wins} из ${s.rounds} · очков ${s.points}`);
      r.panel = () => showPanel({
        emoji: won ? '🎉' : '🙈', pill: won ? `+${pts}` : 'the word', pillClass: won ? 'yes' : 'no',
        text: won ? `Yes! The word was “${r.word}”.` : `The word was “${r.word}”.`,
        actions: [{ label: 'Новое слово ▶', primary: true, fn: () => game.newGuess() }],
      });
      r.panel();
    },
  };

  // ---------- modes ----------
  const PLACEHOLDER = { magnet: 'Что хочешь найти?', story: 'Расскажи историю: мой понедельник…', defend: '', guess: 'Твой ответ… (Enter)' };
  const HINT = {
    magnet: 'Напиши что-нибудь, например: что надеть зимой',
    story: 'Напиши ситуацию — смайлики расскажут её по порядку',
  };
  function setMode(m) {
    if (inflight) inflight.abort();
    clearTimeout(timer);
    mode = m;
    document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    hideBubble(); histPanel.classList.remove('open');
    forced.clear(); banned.clear(); lastText = '';
    game.round = null;
    field.readOnly = m === 'defend';
    field.value = '';
    field.placeholder = PLACEHOLDER[m];
    setResults([]);
    setStatus(HINT[m] || '');
    if (m === 'defend') game.newDefend();
    if (m === 'guess') game.newGuess();
    if (!MOBILE || m === 'magnet' || m === 'story' || m === 'guess') field.focus();
  }
  document.querySelectorAll('#modes button').forEach(b => b.addEventListener('click', () => { fx.unlock(); setMode(b.dataset.mode); }));
  tilt.boot();


  // ---------- search: toss a named emoji out of the heap ----------
  const searchBar = document.getElementById('searchBar');
  const searchInput = document.getElementById('searchInput');
  const allEntries = new Map(window.EMOJI_DATA.map(e => [norm(e[0]), e]));

  function ensureRec(ch) {
    let rec = byChar.get(norm(ch));
    if (rec) return rec;
    const e = allEntries.get(norm(ch));
    if (!e || extraUsed >= EXTRA_SLOTS || !atlasCtx) return null;
    const i = listLen + extraUsed++;
    atlasCtx.font = `46px ${atlasFamily}`; atlasCtx.textAlign = 'center'; atlasCtx.textBaseline = 'middle';
    atlasCtx.fillText(e[0], (i % ATLAS_COLS) * ATLAS_CELL + ATLAS_CELL / 2, Math.floor(i / ATLAS_COLS) * ATLAS_CELL + ATLAS_CELL / 2 + 2);
    rec = { i, c: e[0], name: e[1], group: e[2], body: null, cur: r0, target: r0, state: 'pile', slot: -1, at: 0 };
    rec.body = makeBody(rand(r0 * 2, W - r0 * 2), H - r0 - rand(0, 20), r0);
    rec.body.rec = rec;
    rec.body.collisionFilter.category = CAT_MAG; rec.body.collisionFilter.mask = CAT_MAG | CAT_MOUSE; // appears inside the heap without a shove
    Composite.add(world, rec.body);
    recs.push(rec); byChar.set(norm(e[0]), rec);
    return rec;
  }

  function toss(rec, delay) {
    const now = performance.now() + delay;
    rec.glowUntil = now + 3200; rec.target = r0 * 1.6;
    if (active.has(rec) || probe.has(rec)) return; // already on the bar: the glow is enough
    setTimeout(() => {
      const b = rec.body;
      if (!b || active.has(rec)) return;
      const v = clamp(Math.sqrt(2 * 0.417 * Math.max(120, (H - lineY) * 0.55)), 10, 19); // apex roughly mid-screen
      Sleeping.set(b, false);
      b.collisionFilter.category = CAT_MAG; b.collisionFilter.mask = CAT_MAG | CAT_MOUSE;
      rec.tossing = true; rec.tossUntil = performance.now() + 2500; rec.state = 'pile';
      Body.setVelocity(b, { x: rand(-1.2, 1.2), y: -v });
      Body.setAngularVelocity(b, rand(-0.3, 0.3));
      fx.drop();
    }, delay);
  }

  function localSearch(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const scored = [];
    for (const e of window.EMOJI_DATA) {
      const n = e[1].toLowerCase();
      if (!words.every(w => n.includes(w))) continue;
      scored.push([n === words.join(' ') ? 0 : n.startsWith(words[0]) ? 1 : 2, n.length, e[0]]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, 5).map(x => x[2]);
  }

  let searchSeq = 0;
  async function runSearch(q) {
    q = q.trim();
    if (!q) return;
    const seq = ++searchSeq;
    let chars = [];
    if (!DEMO && store.get('gemini_key')) {
      try {
        const arr = await geminiJSON(`The user looks for ONE specific emoji in a big pile and describes it with a word or short phrase (any language): "${q}".
Return up to 4 real Unicode emojis that best match what they mean, the most exact match first. Single emoji characters only.`,
          { type: 'ARRAY', items: { type: 'STRING' } });
        const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        for (const item of arr || []) for (const { segment } of seg.segment(String(item))) chars.push(segment);
      } catch (err) { /* fall back to the local name search */ }
    }
    if (seq !== searchSeq) return;
    if (!chars.some(c => allEntries.has(norm(c)))) chars = localSearch(q);
    const found = [];
    for (const ch of chars) { const rec = ensureRec(ch); if (rec && !found.includes(rec)) found.push(rec); if (found.length >= 4) break; }
    if (!found.length) { toast('Не нашёл такой смайлик'); return; }
    found.forEach((rec, i) => toss(rec, i * 160));
    toast('Смотри, где он подлетел: ' + found.map(r => r.c).join(' '));
  }

  let searchTimer = 0;
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(searchInput.value), 650); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer); runSearch(searchInput.value);
      coach.check(searchInput.value, 'search', (fixed) => { searchInput.value = fixed; runSearch(fixed); });
    }
    if (e.key === 'Escape') closeSearch();
  });
  function openSearch() { fx.unlock(); searchBar.classList.add('open'); searchInput.value = ''; searchInput.focus(); }
  function closeSearch() { searchBar.classList.remove('open'); searchInput.blur(); }
  document.getElementById('searchBtn').addEventListener('click', openSearch);
  document.getElementById('searchClose').addEventListener('click', closeSearch);


  // ---------- English coach: correction + read aloud ----------
  const tts = (() => {
    const synthOk = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    let voice = null;
    function pickVoice() {
      if (!synthOk) return;
      const vs = speechSynthesis.getVoices();
      voice = vs.find(v => /^en-US/i.test(v.lang) && /(natural|google|samantha|aria|jenny)/i.test(v.name))
        || vs.find(v => /^en-US/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
    }
    if (synthOk) { pickVoice(); speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', pickVoice); }

    const cache = new Map(); // text -> AudioBuffer
    let src = null, seq = 0;
    const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

    function browserSay(text) {
      if (!synthOk) { toast('Озвучка не поддерживается в этом браузере'); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US'; u.rate = 0.9;
      if (voice) u.voice = voice;
      speechSynthesis.speak(u);
    }

    async function geminiBuffer(text) {
      if (cache.has(text)) return cache.get(text);
      const key = store.get('gemini_key');
      if (!key) throw new Error('no key');
      const model = store.get('gemini_tts_model') || TTS_MODEL;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Say clearly, in a warm friendly American voice, a little slowly: ' + text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          },
        }),
      });
      if (!res.ok) throw new Error('tts ' + res.status);
      const data = await res.json();
      const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!part) throw new Error('no audio');
      const bin = atob(part.inlineData.data);
      const n = bin.length >> 1, f32 = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
        if (v >= 32768) v -= 65536;
        f32[i] = v / 32768;
      }
      const rate = +(/rate=(\d+)/.exec(part.inlineData.mimeType || '') || [0, 24000])[1];
      fx.unlock();
      const ctxA = fx.audio;
      if (!ctxA) throw new Error('no audio context');
      const buf = ctxA.createBuffer(1, n, rate);
      buf.copyToChannel(f32, 0);
      cache.set(text, buf);
      return buf;
    }

    return {
      ok: true,
      async say(text) {
        text = (text || '').trim();
        if (!text) return;
        const my = ++seq;
        if (src) { try { src.stop(); } catch {} src = null; }
        if (synthOk) speechSynthesis.cancel();
        fx.unlock();
        if (DEMO) { browserSay(text); return; }
        toast('🔊 …');
        try {
          const buf = await geminiBuffer(text);
          if (my !== seq) return;
          const ctxA = fx.audio;
          if (ctxA.state === 'suspended') await ctxA.resume();
          src = ctxA.createBufferSource();
          src.buffer = buf; src.connect(ctxA.destination); src.start();
        } catch (e) {
          if (my === seq) browserSay(text); // fall back to the phone's own voice
        }
      },
    };
  })();

  const coachEl = document.getElementById('coach');
  const coachTitle = document.getElementById('coachTitle');
  const coachBody = document.getElementById('coachBody');
  const coachActions = document.getElementById('coachActions');
  let coachSeq = 0, coachTimer = 0;

  function placeCoach() {
    coachEl.style.left = clamp(MOBILE ? offX + 10 : (W - coachEl.offsetWidth) / 2, 10, Math.max(10, W - coachEl.offsetWidth - 10)) + 'px';
    coachEl.style.top = (offY + H - coachEl.offsetHeight - 12) + 'px';
  }
  function hideCoach() { coachSeq++; clearTimeout(coachTimer); coachEl.classList.remove('open'); }
  document.getElementById('coachClose').addEventListener('click', hideCoach);

  function showCoach({ title, cls, html, actions, autoHide }) {
    coachEl.className = 'open ' + (cls || '');
    coachTitle.textContent = title;
    coachBody.innerHTML = html;
    coachActions.innerHTML = '';
    for (const a of actions || []) {
      const b = document.createElement('button');
      b.textContent = a.label; if (a.primary) b.className = 'primary';
      b.addEventListener('click', a.fn);
      coachActions.appendChild(b);
    }
    placeCoach();
    clearTimeout(coachTimer);
    if (autoHide) coachTimer = setTimeout(() => coachEl.classList.remove('open'), autoHide);
  }
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const looksEnglish = (t) => {
    const letters = t.match(/\p{L}/gu) || [];
    if (letters.length < 3) return false;
    const latin = letters.filter(c => /[A-Za-z]/.test(c)).length;
    return latin / letters.length > 0.8;
  };

  const coach = {
    // text: what the user wrote; apply(corrected): optional, puts the fixed phrase back where it was typed
    async check(text, kind, apply) {
      text = (text || '').trim();
      if (!looksEnglish(text)) return;
      const seq = ++coachSeq;
      try {
        let r;
        if (DEMO) {
          await new Promise(x => setTimeout(x, 400));
          const fixed = text.replace(/\bi\b/g, 'I').replace(/\bme go\b/i, 'I go');
          r = fixed === text ? { ok: true, corrected: '', note: '' } : { ok: false, corrected: fixed, note: 'Demo: "I" is always a capital letter.' };
        } else {
          r = await geminiJSON(`You are a friendly English teacher. A Russian-speaking learner typed this ${kind === 'search' ? 'search query' : kind === 'defence' ? 'argument' : 'phrase'} in an emoji app: "${text}"
Check grammar, spelling, word choice and naturalness. Ignore a missing capital letter at the start and missing final punctuation (it is a search box). Do not flag proper nouns or a single correctly spelled word.
If it is correct and natural, reply ok=true. Otherwise ok=false, "corrected" = the natural corrected version keeping the meaning (as short as the original), "note" = ONE short sentence in simple English naming the main mistake (max 16 words).
If the text is not English, reply ok=true.
Reply JSON {"ok": boolean, "corrected": string, "note": string}.`,
            { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' }, corrected: { type: 'STRING' }, note: { type: 'STRING' } }, required: ['ok', 'corrected', 'note'] });
        }
        if (seq !== coachSeq) return;
        const speak = { label: '🔊 Listen', fn: () => tts.say(r.ok ? text : r.corrected) };
        if (r.ok || !r.corrected || r.corrected.trim() === text) {
          showCoach({ title: '✓ Nice English!', cls: 'good', html: `<div class="cfix">${esc(text)}</div>`, actions: tts.ok ? [speak] : [], autoHide: 4500 });
          return;
        }
        const actions = [speak];
        if (apply) actions.push({ label: '✔ Use it', primary: true, fn: () => { apply(r.corrected); hideCoach(); } });
        showCoach({
          title: '✏️ Better English', cls: 'fix',
          html: `<div class="cold">${esc(text)}</div><div class="cfix">${esc(r.corrected)}</div><div class="cnote">${esc(r.note)}</div>`,
          actions: tts.ok ? actions : actions.slice(1),
        });
      } catch (e) { /* the coach must never get in the way */ }
    },
  };
  document.getElementById('bSpeak').addEventListener('click', () => tts.say(bText.textContent));


  // ---------- shake the phone: the magnetised emojis fall (shake again to get them back) ----------
  const shake = (() => {
    let hits = [], cool = 0, undo = null, started = false;
    function trigger() {
      if (mode !== 'magnet' && mode !== 'story') return; // never mid-game
      if (probe.size || convo) return;
      const now = performance.now();
      if (undo && now - undo.t < 9000 && active.size === 0) { // shake again: bring them back
        for (const ch of undo.forced) { const r = byChar.get(norm(ch)); if (r) forced.add(r); }
        setResults(undo.chars);
        undo = null; toast('Смайлики вернулись'); fx.buzz([30, 40, 30]);
        return;
      }
      if (!active.size) return;
      undo = { t: now, chars: currentChars.slice(), forced: [...forced].map(r => r.c) };
      forced.clear(); banned.clear();
      setResults([]);
      toast('Все упали! Тряхни ещё раз — вернутся');
      fx.buzz([60, 40, 60, 40, 120]);
    }
    function onMotion(e) {
      if (!prefs.shake) return;
      const a = e.acceleration;
      let mag;
      if (a && a.x != null) mag = Math.hypot(a.x, a.y, a.z);
      else {
        const g = e.accelerationIncludingGravity;
        if (!g || g.x == null) return;
        mag = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.8);
      }
      if (mag < 15) return;
      const now = performance.now();
      hits.push(now); hits = hits.filter(t => now - t < 900);
      if (hits.length >= 4 && now > cool) { cool = now + 2000; hits = []; trigger(); }
    }
    function start() { if (started) return; started = true; window.addEventListener('devicemotion', onMotion); }
    return {
      trigger, onMotion,
      boot() {
        if (!MOBILE) return;
        const DM = window.DeviceMotionEvent;
        if (DM && typeof DM.requestPermission === 'function') { // iOS: ask on the first tap
          const ask = () => {
            window.removeEventListener('pointerdown', ask, true);
            DM.requestPermission().then(r => { if (r === 'granted') start(); }).catch(() => {});
          };
          window.addEventListener('pointerdown', ask, true);
        } else start();
      },
    };
  })();
  shake.boot();

  // ---------- settings ----------
  const optSound = document.getElementById('optSound');
  const optVibe = document.getElementById('optVibe');
  const optTilt = document.getElementById('optTilt');
  const optShake = document.getElementById('optShake');
  const ttsModelInput = document.getElementById('ttsModelInput');
  const vibeNote = document.getElementById('vibeNote');
  const openModal = () => {
    keyInput.value = store.get('gemini_key');
    modelInput.value = store.get('gemini_model');
    optSound.checked = prefs.sound; optVibe.checked = prefs.vibe; optTilt.checked = prefs.tilt; optShake.checked = prefs.shake;
    ttsModelInput.value = store.get('gemini_tts_model');
    vibeNote.textContent = navigator.vibrate ? '' : 'Этот браузер не поддерживает вибрацию (на iPhone её нет вообще).';
    modal.classList.add('open'); keyInput.focus();
  };
  const closeModal = () => { modal.classList.remove('open'); field.focus(); };
  document.getElementById('gear').addEventListener('click', openModal);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('saveBtn').addEventListener('click', () => {
    store.set('gemini_key', keyInput.value.trim());
    store.set('gemini_model', modelInput.value.trim());
    prefs.sound = optSound.checked; prefs.vibe = optVibe.checked;
    store.set('opt_sound', prefs.sound ? '1' : '0'); store.set('opt_vibe', prefs.vibe ? '1' : '0');
    tilt.set(optTilt.checked); // inside the click: iOS asks for motion permission here
    prefs.shake = optShake.checked; store.set('opt_shake', prefs.shake ? '1' : '0');
    store.set('gemini_tts_model', ttsModelInput.value.trim());
    if (prefs.vibe) fx.buzz([50, 70, 50]); // test pulse so you can feel it works
    cache.clear(); closeModal();
    if (field.value.trim()) run(field.value);
  });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('saveBtn').click(); if (e.key === 'Escape') closeModal(); });

  // ---------- resize ----------
  let rt = 0;
  function onResize() {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const prevH = H;
      measure(); buildStatics();
      if (MOBILE && H !== prevH) {
        // keyboard opened/closed: move the whole heap with the floor instead of squashing it
        const dy = H - prevH;
        for (const rec of recs) {
          if (!rec.body || active.has(rec) || probe.has(rec)) continue;
          Body.setPosition(rec.body, { x: rec.body.position.x, y: rec.body.position.y + dy });
        }
      }
      for (const rec of active) {
        if (rec.moved) { rec.tx = clamp(rec.tx, lineX - lineW / 2 + bigR, lineX + lineW / 2 - bigR); rec.ty = Math.max(rec.ty, lineY + bigR + 10); }
        else { const p = slotPos(rec.slot); rec.tx = p.x; rec.ty = p.y; }
      }
      for (const rec of recs) {
        const b = rec.body;
        if (!b) continue;
        const x = clamp(b.position.x, rec.cur + 2, W - rec.cur - 2);
        let y = b.position.y;
        if (y > H - rec.cur - 2) y = H - rec.cur - 2 - rand(0, 30); // floor moved up (keyboard)
        if (x !== b.position.x || y !== b.position.y) Body.setPosition(b, { x, y });
        if (MOBILE) Sleeping.set(b, false);
      }
    }, MOBILE ? 60 : 150);
  }
  window.addEventListener('resize', onResize);
  if (MOBILE && vv) { vv.addEventListener('resize', onResize); vv.addEventListener('scroll', onResize); }

  // ---------- boot ----------
  (async () => {
    measure();
    const list = MOBILE
      ? window.EMOJI_DATA.filter((e, i) => e[3] && i % 10 < 7) // main emojis only
      : window.EMOJI_DATA;
    await buildAtlas(list);
    buildStatics();
    initRecords(list);
    setupMouse();
    loading.classList.add('hide');
    if (!store.get('gemini_key') && !DEMO) openModal();
    window.__emodji = { recs, active, setResults, engine, tilt, runSearch, shake };
    requestAnimationFrame(frame);
  })();
})();
