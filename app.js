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
  let atlas, ATLAS_CELL = 64, ATLAS_COLS = 40;

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
    const rows = Math.ceil(list.length / ATLAS_COLS);
    atlas = document.createElement('canvas');
    atlas.width = ATLAS_COLS * ATLAS_CELL; atlas.height = rows * ATLAS_CELL;
    const a = atlas.getContext('2d');
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
      rec.state = 'in'; rec.target = bigR; rec.at = now + inIdx++ * 22; rec.engaged = false;
      active.add(rec);
    }
    countEl.textContent = n ? `${n} шт.` : '';
  }

  function applyForces(now) {
    const g = G();
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
      let ax = dx * 0.022 - b.velocity.x * 0.32;
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
    for (const rec of probe) {
      if (now - rec.probeAt > 15000) { dropRec(rec); continue; } // safety net: never hang forever
      const b = rec.body;
      Sleeping.set(b, false);
      const ax = (rec.hold.x - b.position.x) * 0.012 - b.velocity.x * 0.3;
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
      if (active.has(rec) || probe.has(rec) || rec.state === 'out') { act.push(rec); continue; }
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
    for (const rec of act) drawSprite(rec, 1);
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
    if (e.key !== 'Enter' || !convo || !bArg.value.trim()) return;
    const c = convo, arg = bArg.value.trim();
    bArg.value = '';
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
      if (e.button !== undefined && e.button > 0) return;
      const p = toWorld(e);
      const rec = hitTest(p, e.pointerType === 'mouse' ? 1 : 14);
      if (!rec) return;
      e.preventDefault(); // keep the keyboard / input focus
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
    const prompt = MOBILE
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
    if (cache.has(text)) { setResults(cache.get(text)); setStatus('Готово'); return; }
    const ac = inflight = new AbortController();
    setStatus('Думаю…');
    try {
      const list = DEMO ? demoPick(text) : await callGemini(text, ac.signal);
      if (ac.signal.aborted) return;
      cache.set(text, list);
      setResults(list);
      setStatus(list.length ? 'Готово' : 'Ничего не нашлось');
    } catch (e) {
      if (e.name === 'AbortError') return;
      setStatus('Ошибка: ' + e.message, true);
    }
  }

  let timer = 0;
  field.addEventListener('input', () => {
    hideBubble();
    clearTimeout(timer);
    timer = setTimeout(() => run(field.value), 550);
  });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(timer); run(field.value); }
  });

  // ---------- settings ----------
  const openModal = () => {
    keyInput.value = store.get('gemini_key');
    modelInput.value = store.get('gemini_model');
    modal.classList.add('open'); keyInput.focus();
  };
  const closeModal = () => { modal.classList.remove('open'); field.focus(); };
  document.getElementById('gear').addEventListener('click', openModal);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('saveBtn').addEventListener('click', () => {
    store.set('gemini_key', keyInput.value.trim());
    store.set('gemini_model', modelInput.value.trim());
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
    window.__emodji = { recs, active, setResults, engine };
    requestAnimationFrame(frame);
  })();
})();
