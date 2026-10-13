/* Animated hand-drawn icons (Web Animations API only, no libraries).
   IconAnim.create(name)            -> <span class="ico"> with the layers of that icon
   IconAnim.attach(button, ico)     -> pointerdown plays the animation, press scale 0.94
   IconAnim.play(ico, event?)       -> play (restarts if it is already running)
   Coordinates below are in the 160x160 space of the artwork. */
(function () {
  'use strict';

  var G = {
    magnet:   { tipA: [123.4, 46.1], tipB: [120.5, 108.1] },
    book:     { spine: 75.5 },
    question: { split: 116, dot: [45, 116, 85, 158] },
    scissors: { screw: [79.1, 83.2] },
    magnifier:{ lens: [61.0, 57.6], joint: [94.2, 90.8] },
    clipboard:{ check: 'M58 99 L75 117 L109 72' },
    clock:    { pivot: [79.5, 82.5], minute: [2, 32], hour: [268, 23.5] },
    gear:     { center: [78, 78.5], hub: 34 }
  };
  var NAMES = ['magnet', 'book', 'shield', 'question', 'scissors', 'magnifier', 'clipboard', 'clock', 'gear'];
  var pct = function (v) { return (v / 160 * 100) + '%'; };
  var SVGNS = 'http://www.w3.org/2000/svg';

  function reduced() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  // ------------------------------------------------------------------ dom helpers
  function el(tag, cls, style, parent) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (style) for (var k in style) d.style[k] = style[k];
    if (parent) parent.appendChild(d);
    return d;
  }
  function lay(parent, imgClass, style) { return el('i', 'lay ' + (imgClass || ''), style, parent); }
  function svg(parent) {
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 160 160');
    s.setAttribute('class', 'lsvg');
    parent.appendChild(s);
    return s;
  }
  function path(parent, attrs) {
    var p = document.createElementNS(SVGNS, 'path');
    for (var k in attrs) p.setAttribute(k, attrs[k]);
    parent.appendChild(p); return p;
  }
  function svgEl(parent, tag, attrs) {
    var p = document.createElementNS(SVGNS, tag);
    for (var k in attrs) p.setAttribute(k, attrs[k]);
    parent.appendChild(p); return p;
  }

  // ------------------------------------------------------------------ animation bookkeeping
  function A(st, target, frames, dur, opts) {
    var o = { duration: dur, easing: 'linear', fill: 'none' };
    if (opts) for (var k in opts) o[k] = opts[k];
    var a = target.animate(frames, o);
    st.anims.push(a);
    return a;
  }
  function cancelAll(st) {
    for (var i = 0; i < st.anims.length; i++) { try { st.anims[i].cancel(); } catch (e) {} }
    st.anims.length = 0;
  }
  // keyframes: [[offset, {props}, easing?], ...]
  function K(list) {
    return list.map(function (it) {
      var f = { offset: it[0] };
      for (var k in it[1]) f[k] = it[1][k];
      if (it[2]) f.easing = it[2];
      return f;
    });
  }
  var EASE_OUT = 'cubic-bezier(.2,.8,.3,1)';
  var EASE_IN = 'cubic-bezier(.6,0,.9,.5)';
  var SPRING = 'cubic-bezier(.3,1.6,.5,1)';

  // sheen: a bright band sweeping across the icon silhouette (mask = the icon itself)
  function sheen(parent, imgClass) {
    return el('i', 'sheen ' + (imgClass || ''), null, parent);
  }
  function sheenPass(st, sh, from, to, delay, dur, strong) {
    sh.style.opacity = '0';
    return A(st, sh, K([
      [0, { backgroundPosition: from + '% 0', opacity: 0 }],
      [0.12, { opacity: strong ? 1 : 0.85 }],
      [0.88, { opacity: strong ? 1 : 0.85 }],
      [1, { backgroundPosition: to + '% 0', opacity: 0 }]
    ]), dur, { delay: delay, easing: 'ease-in-out' });
  }

  // ------------------------------------------------------------------ builders (create layers) + players
  var B = {};

  // ---------- MAGNET: jerks towards the touch point, damped wobble, tips flash
  B.magnet = {
    build: function (host, st) {
      st.base = lay(host, '');
      st.gA = el('i', 'glow', { left: pct(G.magnet.tipA[0]), top: pct(G.magnet.tipA[1]) }, host);
      st.gB = el('i', 'glow', { left: pct(G.magnet.tipB[0]), top: pct(G.magnet.tipB[1]) }, host);
    },
    play: function (st, pt) {
      var d = Math.hypot(pt.dx, pt.dy) || 1, ux = pt.dx / d, uy = pt.dy / d, amp = 15;
      var tr = function (k, rk) { return 'translate(' + (ux * amp * k).toFixed(2) + '%,' + (uy * amp * k).toFixed(2) + '%) rotate(' + (ux * 7 * rk).toFixed(2) + 'deg)'; };
      A(st, st.base, K([
        [0, { transform: tr(0, 0), filter: 'brightness(1)' }, 'cubic-bezier(.1,.9,.2,1)'],
        [0.10, { transform: tr(1, 1), filter: 'brightness(1.28)' }, 'ease-in-out'],
        [0.27, { transform: tr(-0.55, -0.6), filter: 'brightness(1.1)' }, 'ease-in-out'],
        [0.43, { transform: tr(0.30, 0.35), filter: 'brightness(1.05)' }, 'ease-in-out'],
        [0.59, { transform: tr(-0.16, -0.18), filter: 'brightness(1)' }, 'ease-in-out'],
        [0.76, { transform: tr(0.07, 0.07) }, 'ease-in-out'],
        [1, { transform: tr(0, 0) }]
      ]), 760);
      [st.gA, st.gB].forEach(function (g, i) {
        A(st, g, K([
          [0, { opacity: 0, transform: 'translate(-50%,-50%) scale(.5)' }],
          [0.11, { opacity: 1, transform: 'translate(-50%,-50%) scale(1.5)' }, 'ease-out'],
          [0.35, { opacity: 0.35, transform: 'translate(-50%,-50%) scale(1.1)' }],
          [0.5, { opacity: 0.75, transform: 'translate(-50%,-50%) scale(1.3)' }],
          [1, { opacity: 0, transform: 'translate(-50%,-50%) scale(.8)' }]
        ]), 760, { delay: i * 25 });
      });
    }
  };

  // ---------- BOOK: cover dips, pages lift and flip, a wave runs over the text
  B.book = {
    build: function (host, st) {
      host.style.perspective = '300px';
      var sp = G.book.spine;
      st.grp = el('div', 'grp', { transformStyle: 'preserve-3d' }, host);
      st.left = lay(st.grp, '', { clipPath: 'inset(0 ' + (100 - sp / 160 * 100) + '% 0 0)', transformOrigin: pct(sp) + ' 62%' });
      st.right = lay(st.grp, '', { clipPath: 'inset(0 0 0 ' + (sp / 160 * 100) + '%)', transformOrigin: pct(sp) + ' 62%' });
      st.sh = sheen(host, '');
    },
    play: function (st) {
      A(st, st.grp, K([
        [0, { transform: 'translateY(0) scaleY(1)' }, EASE_OUT],
        [0.14, { transform: 'translateY(5%) scaleY(.92)' }, 'ease-in-out'],
        [0.40, { transform: 'translateY(0) scaleY(1.03)' }, 'ease-in-out'],
        [0.62, { transform: 'translateY(0) scaleY(.99)' }],
        [1, { transform: 'translateY(0) scaleY(1)' }]
      ]), 950);
      A(st, st.left, K([
        [0, { transform: 'translateY(0) rotate(0) rotateY(0)' }, EASE_OUT],
        [0.22, { transform: 'translateY(-8%) rotate(-5deg) rotateY(14deg)' }, 'ease-in-out'],
        [0.6, { transform: 'translateY(-6%) rotate(-3deg) rotateY(8deg)' }, 'ease-in-out'],
        [0.85, { transform: 'translateY(1%) rotate(.5deg) rotateY(-2deg)' }, 'ease-out'],
        [1, { transform: 'translateY(0) rotate(0) rotateY(0)' }]
      ]), 950);
      A(st, st.right, K([
        [0, { transform: 'translateY(0) rotate(0) rotateY(0)' }, EASE_OUT],
        [0.22, { transform: 'translateY(-8%) rotate(5deg) rotateY(-6deg)' }, 'ease-in-out'],
        [0.46, { transform: 'translateY(-8%) rotate(4deg) rotateY(-78deg)' }, 'ease-in-out'],
        [0.74, { transform: 'translateY(-2%) rotate(1deg) rotateY(9deg)' }, 'ease-out'],
        [0.88, { transform: 'translateY(0) rotate(0) rotateY(-3deg)' }, 'ease-out'],
        [1, { transform: 'translateY(0) rotate(0) rotateY(0)' }]
      ]), 950);
      sheenPass(st, st.sh, 100, 0, 220, 560, false);
    }
  };

  // ---------- SHIELD: diagonal glint, ripple from the hit point, takes the blow and springs back
  B.shield = {
    build: function (host, st) {
      host.style.perspective = '260px';
      st.grp = el('div', 'grp', { transformStyle: 'preserve-3d' }, host);
      st.base = lay(st.grp, '');
      st.sh = sheen(st.grp, '');
      st.rip = el('div', 'ripple', null, st.grp);
      st.ring = el('i', 'ring', null, st.rip);
    },
    play: function (st, pt) {
      var tx = -pt.dy * 14, ty = pt.dx * 14;      // tilt away from the hit
      var shove = function (k) { return 'translate(' + (-pt.dx * 5 * k) + '%,' + (-pt.dy * 5 * k) + '%) scale(' + (1 - 0.15 * k) + ') rotateX(' + (tx * k) + 'deg) rotateY(' + (ty * k) + 'deg)'; };
      A(st, st.grp, K([
        [0, { transform: shove(0) }, 'cubic-bezier(.1,.9,.2,1)'],
        [0.13, { transform: shove(1) }, 'ease-out'],
        [0.38, { transform: 'translate(0,0) scale(1.05) rotateX(' + (-tx * 0.3) + 'deg) rotateY(' + (-ty * 0.3) + 'deg)' }, 'ease-in-out'],
        [0.58, { transform: 'translate(0,0) scale(.985) rotateX(' + (tx * 0.1) + 'deg)' }, 'ease-in-out'],
        [1, { transform: shove(0) }]
      ]), 780);
      sheenPass(st, st.sh, 100, 0, 40, 520, true);
      st.ring.style.left = ((pt.x * 100)) + '%'; st.ring.style.top = ((pt.y * 100)) + '%';
      A(st, st.ring, K([
        [0, { transform: 'translate(-50%,-50%) scale(.1)', opacity: 0.95 }, EASE_OUT],
        [1, { transform: 'translate(-50%,-50%) scale(5)', opacity: 0 }]
      ]), 640);
    }
  };

  // ---------- QUESTION: the mark bounces up, the dot separates and lands later with a squash
  B.question = {
    build: function (host, st) {
      var sp = G.question.split, db = G.question.dot;
      st.body = lay(host, 'L-question-body', { transformOrigin: '50% ' + pct(sp) });
      st.dot = lay(host, 'L-question-dot', { transformOrigin: pct((db[0] + db[2]) / 2) + ' ' + pct(db[3]) });
    },
    play: function (st) {
      A(st, st.body, K([
        [0, { transform: 'translateY(0) scale(1,1)' }, 'cubic-bezier(.15,.9,.3,1)'],
        [0.26, { transform: 'translateY(-24%) scale(.96,1.05)' }, 'ease-in'],
        [0.46, { transform: 'translateY(2%) scale(1.04,.95)' }, 'ease-out'],
        [0.62, { transform: 'translateY(-3%) scale(.99,1.01)' }, 'ease-in-out'],
        [0.8, { transform: 'translateY(.5%) scale(1,1)' }, 'ease-out'],
        [1, { transform: 'translateY(0) scale(1,1)' }]
      ]), 800);
      A(st, st.dot, K([
        [0, { transform: 'translateY(0) scale(1,1)' }, 'cubic-bezier(.15,.9,.3,1)'],
        [0.28, { transform: 'translateY(-20%) scale(.94,1.1)' }, 'ease-in'],
        [0.5, { transform: 'translateY(0) scale(1.22,.74)' }, 'ease-out'],
        [0.68, { transform: 'translateY(-4%) scale(.96,1.05)' }, 'ease-in-out'],
        [0.85, { transform: 'translateY(0) scale(1.04,.96)' }, 'ease-out'],
        [1, { transform: 'translateY(0) scale(1,1)' }]
      ]), 800, { delay: 100 });
    }
  };

  // ---------- SCISSORS: blades snap shut once, open a bit wider, return. Pivot = screw.
  B.scissors = {
    build: function (host, st) {
      var o = pct(G.scissors.screw[0]) + ' ' + pct(G.scissors.screw[1]);
      lay(host, 'L-scissors-decor');
      st.b = lay(host, 'L-scissors-b', { transformOrigin: o });
      st.a = lay(host, 'L-scissors-a', { transformOrigin: o });
    },
    play: function (st) {
      var f = function (s) {
        return K([
          [0, { transform: 'rotate(0deg) scale(1)' }, EASE_IN],
          [0.2, { transform: 'rotate(' + (31 * s) + 'deg) scale(.95)' }, 'ease-out'],
          [0.44, { transform: 'rotate(' + (-9 * s) + 'deg) scale(1.02)' }, 'ease-in-out'],
          [0.7, { transform: 'rotate(' + (2.5 * s) + 'deg) scale(1)' }, 'ease-out'],
          [1, { transform: 'rotate(0deg) scale(1)' }]
        ]);
      };
      A(st, st.a, f(1), 560); A(st, st.b, f(-1), 560);
    }
  };

  // ---------- MAGNIFIER: one rigid piece (lens + handle move together), sweeps a short arc, glint runs over the glass
  B.magnifier = {
    build: function (host, st) {
      var j = G.magnifier.joint;
      lay(host, 'L-magnifier-decor');
      st.grp = el('div', 'grp', { transformOrigin: pct(j[0]) + ' ' + pct(j[1]) }, host);
      lay(st.grp, 'L-magnifier-handle');
      lay(st.grp, 'L-magnifier-lens');
      st.sh = sheen(st.grp, 'L-magnifier-lens');
    },
    play: function (st) {
      A(st, st.grp, K([
        [0, { transform: 'translate(0,0) rotate(0deg)' }, EASE_OUT],
        [0.24, { transform: 'translate(-8%,-6%) rotate(-11deg)' }, 'ease-in-out'],
        [0.5, { transform: 'translate(3%,-10%) rotate(3deg)' }, 'ease-in-out'],
        [0.74, { transform: 'translate(9%,-1%) rotate(10deg)' }, 'ease-in-out'],
        [0.9, { transform: 'translate(-1%,0) rotate(-1.5deg)' }, 'ease-in-out'],
        [1, { transform: 'translate(0,0) rotate(0deg)' }]
      ]), 820);
      sheenPass(st, st.sh, 100, 0, 120, 480, true);
    }
  };

  // ---------- CLIPBOARD: shakes as if tapped, the check draws itself, the clip hops
  B.clipboard = {
    build: function (host, st) {
      lay(host, 'L-clipboard-decor');
      st.grp = el('div', 'grp', { transformOrigin: '50% 90%' }, host);
      lay(st.grp, 'L-clipboard-body');
      var s = svg(st.grp);
      st.ck1 = path(s, { d: G.clipboard.check, pathLength: '1', fill: 'none', stroke: '#1d1b2e', 'stroke-width': '13', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': '1', 'stroke-dashoffset': '1', opacity: '0' });
      st.ck2 = path(s, { d: G.clipboard.check, pathLength: '1', fill: 'none', stroke: '#35c46f', 'stroke-width': '7.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': '1', 'stroke-dashoffset': '1', opacity: '0' });
      st.clip = lay(st.grp, 'L-clipboard-clip', { transformOrigin: '50% 20%' });
    },
    play: function (st) {
      A(st, st.grp, K([
        [0, { transform: 'rotate(0deg)' }, 'ease-out'],
        [0.06, { transform: 'rotate(-5deg)' }, 'ease-in-out'],
        [0.12, { transform: 'rotate(4deg)' }, 'ease-in-out'],
        [0.18, { transform: 'rotate(-3deg)' }, 'ease-in-out'],
        [0.25, { transform: 'rotate(1.5deg)' }, 'ease-in-out'],
        [0.32, { transform: 'rotate(0deg)' }],
        [1, { transform: 'rotate(0deg)' }]
      ]), 1150);
      A(st, st.clip, K([
        [0, { transform: 'translateY(0)' }, EASE_OUT],
        [0.1, { transform: 'translateY(-8%)' }, 'ease-in'],
        [0.2, { transform: 'translateY(1%)' }, 'ease-out'],
        [0.27, { transform: 'translateY(-1.5%)' }, 'ease-in-out'],
        [0.34, { transform: 'translateY(0)' }],
        [1, { transform: 'translateY(0)' }]
      ]), 1150);
      [st.ck1, st.ck2].forEach(function (p) {
        A(st, p, K([
          [0, { strokeDashoffset: 1, opacity: 1 }],
          [0.18, { strokeDashoffset: 1, opacity: 1 }],
          [0.52, { strokeDashoffset: 0, opacity: 1 }, 'ease-out'],
          [0.82, { strokeDashoffset: 0, opacity: 1 }],
          [1, { strokeDashoffset: 0, opacity: 0 }]
        ]), 1150, { easing: 'ease-in-out' });
      });
    }
  };

  // ---------- CLOCK: hands whirl (minute 360, hour +30) and settle with a spring; case squeezes at the start
  var clockHourAdvance = 0;
  B.clock = {
    build: function (host, st) {
      var piv = G.clock.pivot;
      st.grp = el('div', 'grp', { transformOrigin: pct(piv[0]) + ' ' + pct(piv[1]) }, host);
      lay(st.grp, 'L-clock-face');
      var s = svg(st.grp);
      var mk = function (spec, w, inner) {
        var a = spec[0] * Math.PI / 180, x2 = piv[0] + Math.sin(a) * spec[1], y2 = piv[1] - Math.cos(a) * spec[1];
        var g = svgEl(s, 'g', { class: 'hand' });
        g.style.transformBox = 'view-box'; g.style.transformOrigin = piv[0] + 'px ' + piv[1] + 'px';
        svgEl(g, 'line', { x1: piv[0], y1: piv[1], x2: x2, y2: y2, stroke: '#1d1414', 'stroke-width': w + 3.2, 'stroke-linecap': 'round' });
        svgEl(g, 'line', { x1: piv[0], y1: piv[1], x2: x2, y2: y2, stroke: inner, 'stroke-width': w, 'stroke-linecap': 'round' });
        return g;
      };
      st.hour = mk(G.clock.hour, 4.6, '#d56a2c');
      st.minute = mk(G.clock.minute, 4.6, '#d56a2c');
      svgEl(s, 'circle', { cx: piv[0], cy: piv[1], r: 6.4, fill: '#e8482a', stroke: '#1d1414', 'stroke-width': 2.4 });
      st.hourBase = 0;
    },
    play: function (st) {
      A(st, st.grp, K([
        [0, { transform: 'scale(1)' }, 'ease-out'],
        [0.07, { transform: 'scale(.93)' }, 'ease-out'],
        [0.26, { transform: 'scale(1.03)' }, 'ease-in-out'],
        [0.4, { transform: 'scale(1)' }],
        [1, { transform: 'scale(1)' }]
      ]), 1000);
      var spin = function (total, wob) {
        return K([
          [0, { transform: 'rotate(0deg)' }, 'cubic-bezier(.45,0,.25,1)'],
          [0.56, { transform: 'rotate(' + total + 'deg)' }, 'ease-out'],
          [0.69, { transform: 'rotate(' + (total + wob) + 'deg)' }, 'ease-in-out'],
          [0.81, { transform: 'rotate(' + (total - wob * 0.6) + 'deg)' }, 'ease-in-out'],
          [0.91, { transform: 'rotate(' + (total + wob * 0.25) + 'deg)' }, 'ease-in-out'],
          [1, { transform: 'rotate(' + total + 'deg)' }]
        ]);
      };
      A(st, st.minute, spin(360, 9), 1000);
      // the hour hand really moves on by 30 degrees and stays there (time has gone)
      var h0 = st.hourBase, h1 = h0 + 30;
      var a = A(st, st.hour, spin(30, 3).map(function (f) {
        f.transform = f.transform.replace(/rotate\(([-\d.]+)deg\)/, function (m, v) { return 'rotate(' + (h0 + parseFloat(v)) + 'deg)'; });
        return f;
      }), 1000, { fill: 'forwards' });
      st.hourBase = h1;
      st.hour.style.transform = 'rotate(' + h1 + 'deg)';
      a.onfinish = function () { try { a.cancel(); } catch (e) {} };
    },
    reset: function (st) { st.hourBase = 0; st.hour.style.transform = ''; }
  };

  // ---------- GEAR: turns with a little overshoot, settles, then turns back to exactly where it started; the teeth lag behind the hub
  B.gear = {
    build: function (host, st) {
      var c = G.gear.center, r = G.gear.hub;
      var cx = pct(c[0]), cy = pct(c[1]);
      st.base = lay(host, '');
      st.hub = lay(host, '', { clipPath: 'circle(' + (r / 160 * 100) + '% at ' + cx + ' ' + cy + ')', transformOrigin: cx + ' ' + cy });
      var m = 'radial-gradient(circle at ' + cx + ' ' + cy + ', transparent ' + (r / 160 * 100 - 0.3) + '%, #000 ' + (r / 160 * 100 + 0.2) + '%)';
      st.teeth = lay(host, '', { transformOrigin: cx + ' ' + cy, webkitMaskImage: m, maskImage: m });
      st.hub.style.opacity = '0'; st.teeth.style.opacity = '0';
    },
    play: function (st) {
      var rot = function (peak) {
        return K([
          [0, { transform: 'rotate(0deg)', opacity: 1 }, 'cubic-bezier(.55,0,.75,.6)'],
          [0.34, { transform: 'rotate(' + peak + 'deg)', opacity: 1 }, 'cubic-bezier(.3,0,.4,1)'],
          [0.5, { transform: 'rotate(' + (peak - 8) + 'deg)', opacity: 1 }, 'linear'],
          [0.6, { transform: 'rotate(' + (peak - 8) + 'deg)', opacity: 1 }, 'cubic-bezier(.45,0,.3,1)'],
          [1, { transform: 'rotate(0deg)', opacity: 1 }]
        ]);
      };
      // all three animations end at the same instant (T) and the teeth are shown from the very first frame (fill: backwards),
      // so the static drawing is swapped for the turning layers and back again without a single missing frame
      var T = 1126;
      A(st, st.hub, rot(53), T);
      A(st, st.teeth, rot(55), T - 26, { delay: 26, fill: 'backwards' });
      A(st, st.base, [{ opacity: 0 }, { opacity: 0 }], T);
    }
  };

  // ------------------------------------------------------------------ public api
  function hitPoint(host, ev) {
    var r = host.getBoundingClientRect();
    var x = 0.5, y = 0.5;
    if (ev && typeof ev.clientX === 'number' && r.width) {
      x = (ev.clientX - r.left) / r.width; y = (ev.clientY - r.top) / r.height;
    } else if (ev && typeof ev.x === 'number') { x = ev.x; y = ev.y; }
    x = Math.max(-0.3, Math.min(1.3, x)); y = Math.max(-0.3, Math.min(1.3, y));
    var dx = x - 0.5, dy = y - 0.5;
    if (Math.abs(dx) + Math.abs(dy) < 0.05) { dx = 0.35; dy = -0.2; }   // plain click on the centre: use a default direction
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), dx: dx, dy: dy };
  }

  function create(name) {
    var host = el('i', 'ico ic-' + name); // an <i>, not a <span>: the phone layout hides the button labels (spans)
    host.setAttribute('data-ico', name);
    var st = { name: name, anims: [] };
    host._st = st;
    B[name].build(host, st);
    if (name !== 'shield' && name !== 'magnet' && name !== 'book' && name !== 'gear' && !host.querySelector('.lay')) { /* all builders add layers */ }
    return host;
  }

  function flash(host) { // prefers-reduced-motion: no movement, only a brief change of opacity
    var st = host._st;
    A(st, host, [{ opacity: 1 }, { opacity: 0.5 }, { opacity: 1 }], 200, { easing: 'ease-out' });
  }

  function play(host, ev) {
    var st = host._st;
    cancelAll(st);                       // restart: the previous run is cancelled first
    if (reduced()) { flash(host); return; }
    var pt = hitPoint(host, ev);
    B[st.name].play(st, pt);
  }

  function attach(button, host) {
    var pressAnim = null, down = false;
    function release() {
      if (!down) return;
      down = false;
      if (reduced()) return;
      var from = pressAnim ? 0.94 : 1;
      if (pressAnim) { try { pressAnim.cancel(); } catch (e) {} pressAnim = null; }
      button.animate([{ transform: 'scale(' + from + ')' }, { transform: 'scale(1)' }], { duration: 140, easing: SPRING, fill: 'none' });
    }
    button.addEventListener('pointerdown', function (ev) {
      if (ev.button !== undefined && ev.button > 0) return;
      down = true;
      if (!reduced()) {
        if (pressAnim) { try { pressAnim.cancel(); } catch (e) {} }
        pressAnim = button.animate([{ transform: 'scale(1)' }, { transform: 'scale(.94)' }], { duration: 70, easing: 'ease-out', fill: 'forwards' });
      }
      play(host, ev);
      // the finger may leave the button: the icon animation keeps playing, only the press scale is released
      window.addEventListener('pointerup', release, { once: true });
      window.addEventListener('pointercancel', release, { once: true });
    });
    button.style.touchAction = 'manipulation';
  }

  window.IconAnim = {
    NAMES: NAMES, create: create, play: play, attach: attach, reduced: reduced,
    anims: function (host) { return host._st.anims; },
    // used by the preview: freeze every animation of an icon at a given time (ms)
    seek: function (host, t) { host._st.anims.forEach(function (a) { try { a.pause(); a.currentTime = t; } catch (e) {} }); },
    reset: function (host) { var st = host._st; cancelAll(st); if (B[st.name].reset) B[st.name].reset(st); }
  };
})();
