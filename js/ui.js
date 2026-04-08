/**
 * ui.js — CircuitLab UI
 * Wire-to-wire connectivity, physics-based particles, transient graph.
 */
const UI = (() => {
  'use strict';

  const _A = x => Array.isArray(x) ? x : [];
  const _S = x => (x instanceof Set) ? x : new Set();

  let canvas, ctx, wrapper;
  let _tool = 'select', _pending = null;
  let components = [], selectedIds = new Set();
  let _drag = null, _box = null, _wireStart = null;
  let _mx = 0, _my = 0, _frame = 0, _dark = true;
  let _showNodes = false, _showGraph = false, _graphTarget = null;
  const _parts = new Map();
  let zoom = 1, panX = 0, panY = 0;
  let _panning = false, _panSt = {};
  let _spaceDown = false;
  const MAX_H = 60;
  let _hist = [], _hIdx = -1, _clip = [], _nid = 1;
  const newId = () => 'c' + (_nid++);

  // ── Connectivity constants (must match engine.js) ────────────────
  const GRID = 32, TERM_OFFSET = 32, SNAP_RADIUS = 20;
  const NODE_COLORS = ['#ff3860','#00e5ff','#39ff14','#ffd700','#a78bfa','#f472b6','#38bdf8','#fb923c','#4ade80','#e879f9'];

  function _sv(v) { const n = parseFloat(v); return isFinite(n) ? Math.round(n / GRID) * GRID : 0; }
  function _nullEp() { return { attachedTo: null, terminal: null, kind: null }; }

  function compTerminals(comp) {
    if (!comp || comp.type === 'wire') return null;
    if (comp.type === 'ground') return { a: { x: _sv(comp.x), y: _sv(comp.y) }, b: null };
    const rad = (parseFloat(comp.rotation) || 0) * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return {
      a: { x: _sv(comp.x - TERM_OFFSET * cos), y: _sv(comp.y - TERM_OFFSET * sin) },
      b: { x: _sv(comp.x + TERM_OFFSET * cos), y: _sv(comp.y + TERM_OFFSET * sin) }
    };
  }

  function _closestOnSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    if (l2 < 1) return { x: ax, y: ay, d: Math.hypot(px - ax, py - ay), t: 0 };
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    const cx = ax + t * dx, cy = ay + t * dy;
    return { x: _sv(cx), y: _sv(cy), d: Math.hypot(px - cx, py - cy), t };
  }

  function _findCompSnap(px, py, excl) {
    let best = null, bestD = SNAP_RADIUS;
    _A(components).forEach(c => {
      if (!c || c.type === 'wire' || (excl && c.id === excl)) return;
      const t = compTerminals(c); if (!t) return;
      [['a', t.a], ['b', t.b]].forEach(([k, pt]) => {
        if (!pt) return;
        const d = Math.hypot(px - pt.x, py - pt.y);
        if (d < bestD) { bestD = d; best = { x: pt.x, y: pt.y, kind: 'component', attachedTo: c.id, terminal: k }; }
      });
    });
    return best;
  }

  function _findWireSnap(px, py, excl) {
    let best = null, bestD = SNAP_RADIUS;
    _A(components).forEach(w => {
      if (!w || w.type !== 'wire' || (excl && w.id === excl) || !isFinite(w.x2)) return;
      [[w.x, w.y, 'a'], [w.x2, w.y2, 'b']].forEach(([ex, ey, side]) => {
        const d = Math.hypot(px - ex, py - ey);
        if (d < bestD) { bestD = d; best = { x: ex, y: ey, kind: 'wire', attachedTo: w.id, terminal: side }; }
      });
    });
    _A(components).forEach(w => {
      if (!w || w.type !== 'wire' || (excl && w.id === excl) || !isFinite(w.x2)) return;
      const s = _closestOnSeg(px, py, w.x, w.y, w.x2, w.y2);
      if (s.t > 0.01 && s.t < 0.99 && s.d < bestD) { bestD = s.d; best = { x: s.x, y: s.y, kind: 'wire', attachedTo: w.id, terminal: null }; }
    });
    return best;
  }

  function _findSnap(px, py, excl) {
    const c = _findCompSnap(px, py, excl), w = _findWireSnap(px, py, excl);
    if (!c && !w) return null; if (!w) return c; if (!c) return w;
    return Math.hypot(px - c.x, py - c.y) <= Math.hypot(px - w.x, py - w.y) + 4 ? c : w;
  }

  function _resolveEp(px, py, excl) {
    const s = _findSnap(px, py, excl);
    if (s) return { x: s.x, y: s.y, ep: { attachedTo: s.attachedTo, terminal: s.terminal, kind: s.kind } };
    return { x: _sv(px), y: _sv(py), ep: _nullEp() };
  }

  function _revalidate() {
    _A(components).forEach(w => {
      if (w.type !== 'wire') return;
      ['a', 'b'].forEach(side => {
        const ep = w['ep_' + side];
        if (!ep || !ep.attachedTo || ep.kind !== 'component') return;
        const c = _byId(ep.attachedTo); if (!c) { w['ep_' + side] = _nullEp(); return; }
        const t = compTerminals(c); if (!t) return;
        const pt = t[ep.terminal]; if (!pt) { w['ep_' + side] = _nullEp(); return; }
        if (side === 'a') { w.x = pt.x; w.y = pt.y; } else { w.x2 = pt.x; w.y2 = pt.y; }
      });
    });
  }

  function _propagate(compId) {
    const c = _byId(compId); if (!c || c.type === 'wire') return;
    const t = compTerminals(c); if (!t) return;
    _A(components).forEach(w => {
      if (w.type !== 'wire') return;
      if (w.ep_a && w.ep_a.attachedTo === compId && w.ep_a.kind === 'component') { const pt = t[w.ep_a.terminal]; if (pt) { w.x = pt.x; w.y = pt.y; } }
      if (w.ep_b && w.ep_b.attachedTo === compId && w.ep_b.kind === 'component') { const pt = t[w.ep_b.terminal]; if (pt) { w.x2 = pt.x; w.y2 = pt.y; } }
    });
  }

  function _autoSnap(compId) {
    const c = _byId(compId); if (!c || c.type === 'wire') return;
    const t = compTerminals(c); if (!t) return;
    _A(components).forEach(w => {
      if (w.type !== 'wire') return;
      if (!w.ep_a || !w.ep_a.attachedTo) { [['a', t.a], ['b', t.b]].forEach(([k, pt]) => { if (!pt) return; if (Math.hypot(w.x - pt.x, w.y - pt.y) <= SNAP_RADIUS) { w.x = pt.x; w.y = pt.y; w.ep_a = { attachedTo: compId, terminal: k, kind: 'component' }; } }); }
      if (!w.ep_b || !w.ep_b.attachedTo) { [['a', t.a], ['b', t.b]].forEach(([k, pt]) => { if (!pt) return; if (Math.hypot(w.x2 - pt.x, w.y2 - pt.y) <= SNAP_RADIUS) { w.x2 = pt.x; w.y2 = pt.y; w.ep_b = { attachedTo: compId, terminal: k, kind: 'component' }; } }); }
    });
  }

  function _detach(id) {
    _A(components).forEach(w => {
      if (w.type !== 'wire') return;
      if (w.ep_a && w.ep_a.attachedTo === id) w.ep_a = _nullEp();
      if (w.ep_b && w.ep_b.attachedTo === id) w.ep_b = _nullEp();
    });
  }

  function _junctions() {
    const cnt = Object.create(null);
    _A(components).forEach(w => { if (w.type !== 'wire' || !isFinite(w.x2)) return; const ka = `${_sv(w.x)},${_sv(w.y)}`, kb = `${_sv(w.x2)},${_sv(w.y2)}`; cnt[ka] = (cnt[ka] || 0) + 1; cnt[kb] = (cnt[kb] || 0) + 1; });
    const j = new Set(); Object.keys(cnt).forEach(k => { if (cnt[k] >= 3) j.add(k); }); return j;
  }

  function _visualNodeMap() {
    const p = Object.create(null), GND = '__GND__';
    function find(k) { if (!p[k]) p[k] = k; if (p[k] !== k) p[k] = find(p[k]); return p[k]; }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) p[rb] = ra; }
    p[GND] = GND;
    _A(components).forEach(c => {
      if (c.type === 'wire') { if (!isFinite(c.x2)) return; const ka = `${_sv(c.x)},${_sv(c.y)}`, kb = `${_sv(c.x2)},${_sv(c.y2)}`; find(ka); find(kb); union(ka, kb); }
      else if (c.type === 'ground') { const ka = `${_sv(c.x)},${_sv(c.y)}`; find(ka); union(ka, GND); }
      else { const t = compTerminals(c); if (!t) return; find(`${t.a.x},${t.a.y}`); if (t.b) find(`${t.b.x},${t.b.y}`); }
    });
    const gr = find(GND), idx = Object.create(null); let ni = 1; idx[gr] = 0;
    const res = new Map(); new Set(Object.keys(p)).forEach(k => { const r = find(k); if (idx[r] === undefined) idx[r] = ni++; res.set(k, idx[r]); }); return res;
  }

  // ── Palettes ─────────────────────────────────────────────────────
  const PAL = {
    dark: { wire:'#00e5ff',wireHot:'#39ff14',wireDim:'#2a3a55',battery:'#ffd700',vsource:'#4ade80',isource:'#a3e635',ground:'#94a3b8',resistor:'#ff6b35',capacitor:'#a78bfa',inductor:'#38bdf8',pot:'#fb923c',led:'#ff3860',diode:'#f472b6',zener:'#e879f9',transistor:'#fb923c',pnp:'#f97316',mosfet:'#fbbf24',sw_on:'#39ff14',sw_off:'#ff3860',voltmeter:'#67e8f9',ammeter:'#6ee7b7',lamp:'#fde68a',selFill:'rgba(0,229,255,0.09)',selBorder:'#00e5ff',text:'#e8ecf4',textDim:'#8892b0',grid:'rgba(42,48,80,0.7)',particle:'#39ff14',termSnap:'#39ff14' },
    light:{ wire:'#0066cc',wireHot:'#2d8a00',wireDim:'#8899cc',battery:'#b88a00',vsource:'#16a34a',isource:'#65a30d',ground:'#64748b',resistor:'#e85d04',capacitor:'#7c3aed',inductor:'#0284c7',pot:'#ea580c',led:'#cc0033',diode:'#db2777',zener:'#a21caf',transistor:'#ea580c',pnp:'#c2410c',mosfet:'#d97706',sw_on:'#2d8a00',sw_off:'#cc0033',voltmeter:'#0891b2',ammeter:'#059669',lamp:'#d97706',selFill:'rgba(0,102,204,0.09)',selBorder:'#0066cc',text:'#1a1f30',textDim:'#4a5578',grid:'rgba(150,160,190,0.5)',particle:'#2d8a00',termSnap:'#2d8a00' }
  };
  const LEDS = { red:{off:'#5a1a1a',on:'#ff3860',glow:'#ff3860'},green:{off:'#1a4a1a',on:'#39ff14',glow:'#39ff14'},blue:{off:'#1a1a5a',on:'#00e5ff',glow:'#00e5ff'},yellow:{off:'#4a4a00',on:'#ffd700',glow:'#ffd700'},white:{off:'#3a3a3a',on:'#ffffff',glow:'#ccddff'},orange:{off:'#5a2a00',on:'#ff8c00',glow:'#ff8c00'} };

  // ── Init ─────────────────────────────────────────────────────────
  function init() {
    canvas = document.getElementById('circuit-canvas');
    ctx = canvas.getContext('2d');
    wrapper = document.getElementById('canvas-wrapper');
    _resize(); window.addEventListener('resize', _resize);
    document.querySelectorAll('.comp-item').forEach(el => {
      el.setAttribute('draggable', 'true');
      el.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', el.dataset.type));
      el.addEventListener('click', () => _setTool('component', el.dataset.type));
    });
    canvas.addEventListener('dragover', e => e.preventDefault());
    canvas.addEventListener('drop', _onDrop);
    canvas.addEventListener('mousedown', _onMD);
    canvas.addEventListener('mousemove', _onMM);
    canvas.addEventListener('mouseup', _onMU);
    canvas.addEventListener('dblclick', _onDbl);
    canvas.addEventListener('contextmenu', _onCtx);
    canvas.addEventListener('wheel', _onWheel, { passive: false });
    canvas.addEventListener('touchstart', _onTS, { passive: false });
    canvas.addEventListener('touchmove', _onTM, { passive: false });
    canvas.addEventListener('touchend', _onTU);
    canvas.addEventListener('mouseleave', () => _hideTip());
    window.addEventListener('keydown', _onKD);
    window.addEventListener('keyup', _onKU);
    document.querySelectorAll('[data-tool]').forEach(btn => btn.addEventListener('click', () => _setTool(btn.dataset.tool)));
    _pushH(); requestAnimationFrame(_loop); _updateToolUI();
  }

  function _resize() { if (!wrapper) return; const r = wrapper.getBoundingClientRect(); canvas.width = r.width; canvas.height = r.height; }

  function _setTool(tool, type) {
    _tool = tool; _pending = type || null; _wireStart = null; _updateToolUI();
    const msgs = { select: 'Seleziona e sposta. ESC per annullare.', wire: 'WIRE: click A → B. Snap su terminali e fili. ESC.', component: _pending ? `PLACE ${_pending}: click. ESC.` : 'Scegli componente.' };
    _st(msgs[tool] || '');
    if (canvas) canvas.style.cursor = { select: 'default', wire: 'crosshair', component: 'cell' }[tool] || 'default';
  }

  function _updateToolUI() {
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === _tool));
    document.querySelectorAll('.comp-item').forEach(el => el.classList.toggle('placing', _tool === 'component' && el.dataset.type === _pending));
    const badge = document.getElementById('tool-badge');
    if (badge) { badge.textContent = { select: 'SELECT', wire: 'WIRE', component: _pending ? `PLACE: ${_pending}`.toUpperCase() : 'PLACE' }[_tool] || _tool.toUpperCase(); badge.className = `tool-badge tb-${_tool === 'component' ? 'place' : _tool}`; }
  }

  const _s2w = (sx, sy) => ({ x: (sx - panX) / zoom, y: (sy - panY) / zoom });
  const _snap = (x, y, g = 32) => ({ x: Math.round(x / g) * g, y: Math.round(y / g) * g });
  const _sp = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const _wp = e => { const s = _sp(e); return _s2w(s.x, s.y); };
  const _ws = e => { const w = _wp(e); return _snap(w.x, w.y); };

  // ── Render loop ───────────────────────────────────────────────────
  let _jCache = new Set(), _jFrame = -1;
  function _getJ() { if (_jFrame !== _frame) { _jCache = _junctions(); _jFrame = _frame; } return _jCache; }

  function _loop() { _frame++; _updateParts(); _draw(); requestAnimationFrame(_loop); }

  function _draw() {
    const P = _dark ? PAL.dark : PAL.light;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save(); ctx.translate(panX, panY); ctx.scale(zoom, zoom);
    _drawGrid(P);
    _A(components).filter(c => c && c.type === 'wire').forEach(c => _dC(c, P));
    _A(components).filter(c => c && c.type !== 'wire').forEach(c => _dC(c, P));
    if (_showNodes) _drawNodeOv(P);
    if (_tool === 'wire' && _wireStart) {
      ctx.strokeStyle = P.wire; ctx.lineWidth = 2 / zoom; ctx.setLineDash([6 / zoom, 3 / zoom]);
      ctx.beginPath(); ctx.moveTo(_wireStart.x, _wireStart.y); ctx.lineTo(_mx, _my); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = P.wire; ctx.beginPath(); ctx.arc(_wireStart.x, _wireStart.y, 5 / zoom, 0, Math.PI * 2); ctx.fill();
      const hs = _findSnap(_mx, _my, null);
      if (hs) { ctx.strokeStyle = P.termSnap; ctx.lineWidth = 2 / zoom; ctx.beginPath(); ctx.arc(hs.x, hs.y, 8 / zoom, 0, Math.PI * 2); ctx.stroke(); }
    }
    if (_tool === 'component' && _pending) { const gs = _snap(_mx, _my); ctx.globalAlpha = 0.42; _drawGhost(_pending, gs.x, gs.y, P); ctx.globalAlpha = 1; }
    if (_box) { const rx = Math.min(_box.x0, _box.x1), ry = Math.min(_box.y0, _box.y1), rw = Math.abs(_box.x1 - _box.x0), rh = Math.abs(_box.y1 - _box.y0); ctx.fillStyle = P.selFill; ctx.fillRect(rx, ry, rw, rh); ctx.strokeStyle = P.selBorder; ctx.lineWidth = 1 / zoom; ctx.setLineDash([4 / zoom, 3 / zoom]); ctx.strokeRect(rx, ry, rw, rh); ctx.setLineDash([]); }
    ctx.restore();
    const zEl = document.getElementById('status-zoom');
    if (zEl) zEl.textContent = `Zoom: ${Math.round(zoom * 100)}%  |  ${components.length} comp.${_showNodes ? ' [N]' : ''}${_showGraph ? ' [G]' : ''}`;
    _drawBode(); if (_showGraph) _drawGraph();
  }

  function _drawGrid(P) {
    const step = 32, r = Math.max(0.35, 1.2 / zoom), x0 = -panX / zoom, y0 = -panY / zoom, x1 = x0 + canvas.width / zoom, y1 = y0 + canvas.height / zoom;
    ctx.fillStyle = P.grid;
    for (let x = Math.floor(x0 / step) * step; x < x1; x += step) for (let y = Math.floor(y0 / step) * step; y < y1; y += step) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
  }

  function _drawNodeOv(P) {
    const nm = _visualNodeMap(), j = _getJ(), drawn = new Set();
    function dp(x, y, isJ) {
      const key = `${x},${y}`, ni = nm.get(key) ?? -1, col = ni < 0 ? '#555' : NODE_COLORS[ni % NODE_COLORS.length], r = (isJ ? 6 : 4) / zoom;
      ctx.fillStyle = col; ctx.strokeStyle = _dark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1 / zoom;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (ni >= 0) { ctx.fillStyle = _dark ? '#fff' : '#000'; ctx.font = `${8 / zoom}px Share Tech Mono,monospace`; ctx.textAlign = 'center'; ctx.fillText(ni === 0 ? 'G' : String(ni), x, y - (r + 2 / zoom)); }
    }
    _A(components).forEach(c => { if (c.type === 'wire') return; const t = compTerminals(c); if (!t) return; [t.a, t.b].forEach(pt => { if (!pt) return; const k = `${pt.x},${pt.y}`; if (!drawn.has(k)) { drawn.add(k); dp(pt.x, pt.y, false); } }); });
    _A(components).forEach(w => { if (w.type !== 'wire' || !isFinite(w.x2)) return; [[_sv(w.x), _sv(w.y)], [_sv(w.x2), _sv(w.y2)]].forEach(([x, y]) => { const k = `${x},${y}`, isJ = j.has(k); if (!drawn.has(k) || isJ) { drawn.add(k); dp(x, y, isJ); } }); });
  }

  // ── Dispatcher ───────────────────────────────────────────────────
  function _dC(comp, P) {
    if (!comp || !comp.type) return;
    const { x, y, type, id, rotation = 0 } = comp;
    const isSel = _S(selectedIds).has(id), res = Engine.getResult(id);
    const on = res ? (res.status === 'on' || res.status === 'charged') : false;
    const burned = res ? res.status === 'burned' : false;
    ctx.save(); ctx.translate(x, y); if (rotation) ctx.rotate(rotation * Math.PI / 180);
    if (isSel && type !== 'wire') { ctx.fillStyle = P.selFill; ctx.strokeStyle = P.selBorder; ctx.lineWidth = 1.5 / zoom; ctx.setLineDash([4 / zoom, 3 / zoom]); ctx.fillRect(-46, -34, 92, 68); ctx.strokeRect(-46, -34, 92, 68); ctx.setLineDash([]); }
    switch (type) {
      case 'battery': _rBat(comp, P, on); break; case 'vsource': _rVSrc(comp, P, on); break;
      case 'isource': _rISrc(comp, P, on); break; case 'ground': _rGnd(comp, P); break;
      case 'resistor': _rRes(comp, P, on); break; case 'capacitor': _rCap(comp, P, on); break;
      case 'inductor': _rInd(comp, P, on); break; case 'potentiometer': _rPot(comp, P, on); break;
      case 'led': _rLED(comp, P, on, burned); break; case 'diode': _rDiode(comp, P, on); break;
      case 'zener': _rZener(comp, P, on); break; case 'transistor': _rNPN(comp, P, on); break;
      case 'pnp': _rPNP(comp, P, on); break; case 'mosfet_n': _rMOS(comp, P, on); break;
      case 'switch': _rSw(comp, P); break; case 'wire': _rWire(comp, P, on, isSel); break;
      case 'voltmeter': _rVM(comp, P, res); break; case 'ammeter': _rAM(comp, P, res); break;
      case 'lamp': _rLamp(comp, P, on, res); break;
    }
    if (Engine.isRunning() && res && type !== 'wire' && type !== 'ground') _rLbl(res, P);
    ctx.restore();
  }

  function _drawGhost(type, x, y, P) { ctx.save(); ctx.translate(x, y); _dC({ x, y, type, voltage: 9, resistance: 1000, ledColor: 'red', closed: true, capacitance: 100, inductance: 10, reversed: false, vz: 5.1, baseVoltage: 0.8, baseResistor: 10000, vgs: 3, vth: 2, wattage: 1, current: 10, wiper: 50, waveform: 'dc', frequency: 50 }, P); ctx.restore(); }

  // ── Component renderers ───────────────────────────────────────────
  function L(x1,y1,x2,y2){ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();}
  function D0(x,y,r){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
  function T(t,x,y,sz,col){ctx.fillStyle=col;ctx.font=`${sz}px Share Tech Mono,monospace`;ctx.textAlign='center';ctx.fillText(t,x,y);}

  function _rBat(c,P,on){const v=c.voltage||9,col=on?P.battery:(_dark?'#554400':'#ccaa44');ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-9,0);L(9,0,30,0);ctx.lineWidth=3;L(-9,-11,-9,11);ctx.lineWidth=5;L(9,-18,9,18);if(on){ctx.shadowColor=P.battery;ctx.shadowBlur=14;ctx.strokeStyle=P.battery;ctx.lineWidth=1.5;L(-30,0,30,0);ctx.shadowBlur=0;}T(`${v}V`,0,-28,11,col);ctx.font='10px Share Tech Mono,monospace';ctx.textAlign='center';ctx.fillStyle=_dark?'#ffd70055':'#b88a0055';ctx.fillText('+',16,11);ctx.fillText('−',-16,11);}
  function _rVSrc(c,P,on){const v=c.voltage||5,ac=c.waveform==='ac',col=on?P.vsource:(_dark?'#1a4a2a':'#86efac');ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-18,0);L(18,0,30,0);ctx.beginPath();ctx.arc(0,0,18,0,Math.PI*2);ctx.stroke();if(on){ctx.shadowColor=P.vsource;ctx.shadowBlur=10;ctx.stroke();ctx.shadowBlur=0;}ctx.lineWidth=1.5;if(ac){ctx.beginPath();ctx.moveTo(-10,0);for(let i=-10;i<=10;i+=0.5)ctx.lineTo(i,-7*Math.sin((i/10)*Math.PI));ctx.stroke();}else{L(-6,0,6,0);L(0,-6,0,6);}T(`${v}V`,0,-28,11,col);if(ac)T(`${c.frequency||50}Hz`,0,32,9,P.textDim);}
  function _rISrc(c,P,on){const col=on?P.isource:(_dark?'#1a3a10':'#bbf7d0');ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-18,0);L(18,0,30,0);ctx.beginPath();ctx.arc(0,0,18,0,Math.PI*2);ctx.stroke();ctx.lineWidth=2;L(0,-10,0,10);ctx.fillStyle=col;ctx.beginPath();ctx.moveTo(0,-10);ctx.lineTo(-5,-4);ctx.lineTo(5,-4);ctx.closePath();ctx.fill();T(`${c.current||10}mA`,0,-28,11,col);}
  function _rGnd(c,P){ctx.strokeStyle=P.ground;ctx.lineWidth=2.5;L(0,-8,0,10);ctx.lineWidth=3;L(-14,10,14,10);ctx.lineWidth=2.5;L(-9,17,9,17);ctx.lineWidth=2;L(-4,24,4,24);T('GND',0,-17,10,P.ground);}
  function _rRes(c,P,on){const r=c.resistance||1000,lbl=r>=1e6?`${r/1e6}MΩ`:r>=1000?`${r/1000}kΩ`:`${r}Ω`,col=on?P.resistor:(_dark?'#664422':'#cc8866');ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-18,0);L(18,0,30,0);ctx.strokeRect(-18,-10,36,20);ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(-14,0);for(let i=0;i<5;i++){ctx.lineTo(-14+i*6+3,i%2===0?-7:7);ctx.lineTo(-14+i*6+6,0);}ctx.stroke();if(on){ctx.shadowColor=P.resistor;ctx.shadowBlur=9;ctx.stroke();ctx.shadowBlur=0;}T(lbl,0,-19,11,on?P.resistor:P.textDim);}
  function _rCap(c,P,on){const col=on?P.capacitor:(_dark?'#443366':'#9977cc');ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-7,0);L(7,0,30,0);ctx.lineWidth=5;L(-7,-16,-7,16);L(7,-16,7,16);if(on){ctx.shadowColor=P.capacitor;ctx.shadowBlur=15;L(-7,-16,-7,16);L(7,-16,7,16);ctx.shadowBlur=0;}T(`${c.capacitance||100}μF`,0,-26,11,on?P.capacitor:P.textDim);}
  function _rInd(c,P,on){const col=on?P.inductor:(_dark?'#0c4a6e':'#7dd3fc');ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-20,0);L(20,0,30,0);for(let i=0;i<4;i++){ctx.beginPath();ctx.arc(-14+i*10,0,6,Math.PI,0);ctx.stroke();}T(`${c.inductance||10}mH`,0,-20,11,on?P.inductor:P.textDim);}
  function _rPot(c,P,on){const tot=c.resistance||10000,w=Math.max(0,Math.min(100,c.wiper||50)),col=on?P.pot:(_dark?'#7a3a00':'#fed7aa');ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-18,0);L(18,0,30,0);ctx.strokeRect(-18,-10,36,20);const wx=-18+(w/100)*36;ctx.lineWidth=1.5;L(wx,-10,wx,-22);ctx.fillStyle=col;ctx.beginPath();ctx.moveTo(wx,-22);ctx.lineTo(wx-4,-17);ctx.lineTo(wx+4,-17);ctx.closePath();ctx.fill();T(tot>=1000?`${tot/1000}kΩ`:`${tot}Ω`,0,-30,10,P.textDim);T(`${w}%`,0,22,9,on?P.pot:P.textDim);}
  function _rLED(c,P,on,burned){const lc=LEDS[c.ledColor||'red']||LEDS.red,col=burned?'#444':(on?lc.on:lc.off);ctx.strokeStyle=_dark?'#555':'#aaa';ctx.lineWidth=2;L(-30,0,-14,0);L(14,0,30,0);ctx.fillStyle=col;ctx.strokeStyle=(on&&!burned)?lc.on:(_dark?'#666':'#aaa');ctx.beginPath();ctx.moveTo(-14,-13);ctx.lineTo(-14,13);ctx.lineTo(14,0);ctx.closePath();ctx.fill();ctx.stroke();L(14,-13,14,13);if(on&&!burned){const p=0.6+0.4*Math.sin(_frame*0.09);ctx.shadowColor=lc.glow;ctx.shadowBlur=28*p;ctx.fillStyle=lc.on+'bb';ctx.beginPath();ctx.arc(0,0,9,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;ctx.strokeStyle=lc.glow;ctx.lineWidth=1;ctx.globalAlpha=0.38*p;for(let a=0;a<8;a++){const ag=a/8*Math.PI*2;ctx.beginPath();ctx.moveTo(Math.cos(ag)*11,Math.sin(ag)*11);ctx.lineTo(Math.cos(ag)*24,Math.sin(ag)*24);ctx.stroke();}ctx.globalAlpha=1;}if(burned){ctx.fillStyle='#ff3860';ctx.font='13px sans-serif';ctx.textAlign='center';ctx.fillText('✕',0,-21);}T(`LED ${c.ledColor||'red'}`,0,28,10,P.textDim);}
  function _rDiode(c,P,on){const rev=c.reversed===true||c.reversed==='true',col=on&&!rev?P.diode:(_dark?'#7a1a4a':'#f9a8d4');ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-14,0);L(14,0,30,0);ctx.fillStyle=on&&!rev?col:'transparent';if(!rev){ctx.beginPath();ctx.moveTo(-14,-12);ctx.lineTo(-14,12);ctx.lineTo(14,0);ctx.closePath();ctx.fill();ctx.stroke();L(14,-12,14,12);}else{ctx.beginPath();ctx.moveTo(14,-12);ctx.lineTo(14,12);ctx.lineTo(-14,0);ctx.closePath();ctx.stroke();L(-14,-12,-14,12);ctx.strokeStyle='#ff3860';ctx.lineWidth=1.5;L(-4,-4,4,4);L(4,-4,-4,4);}T(rev?'D↩':'D',0,-22,11,on&&!rev?P.diode:P.textDim);}
  function _rZener(c,P,on){const vz=c.vz||5.1,col=on?P.zener:(_dark?'#6b1a7a':'#e879f9');ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-14,0);L(14,0,30,0);ctx.fillStyle=on?col:'transparent';ctx.beginPath();ctx.moveTo(-14,-12);ctx.lineTo(-14,12);ctx.lineTo(14,0);ctx.closePath();ctx.fill();ctx.stroke();L(14,-12,8,-8);L(14,12,20,8);T(`Z ${vz}V`,0,-24,10,on?P.zener:P.textDim);}
  function _rNPN(c,P,on){const col=on?P.transistor:(_dark?'#7a3a00':'#fed7aa');ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-10,0);L(-10,-20,-10,20);ctx.beginPath();ctx.moveTo(-10,-8);ctx.lineTo(20,-24);ctx.stroke();ctx.beginPath();ctx.moveTo(-10,8);ctx.lineTo(20,24);ctx.stroke();ctx.fillStyle=col;ctx.beginPath();ctx.moveTo(20,24);ctx.lineTo(13,17);ctx.lineTo(20,14);ctx.closePath();ctx.fill();T('NPN',0,10,9,on?P.transistor:P.textDim);}
  function _rPNP(c,P,on){const col=on?P.pnp:(_dark?'#7a2a00':'#fdba74');ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-10,0);L(-10,-20,-10,20);ctx.beginPath();ctx.moveTo(-10,-8);ctx.lineTo(20,-24);ctx.stroke();ctx.beginPath();ctx.moveTo(-10,8);ctx.lineTo(20,24);ctx.stroke();ctx.fillStyle=col;ctx.beginPath();ctx.moveTo(-10,-8);ctx.lineTo(-3,-15);ctx.lineTo(-3,-8);ctx.closePath();ctx.fill();T('PNP',0,10,9,on?P.pnp:P.textDim);}
  function _rMOS(c,P,on){const col=on?P.mosfet:(_dark?'#7a5500':'#fde68a');ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-14,0);L(-14,-18,-14,18);ctx.strokeStyle=_dark?'rgba(255,255,255,0.15)':'rgba(0,0,0,0.15)';L(-14,-18,-8,-18);L(-14,18,-8,18);ctx.strokeStyle=col;L(-8,-18,-8,18);L(-8,-12,20,-12);L(-8,12,20,12);T('NMOS',0,28,9,on?P.mosfet:P.textDim);}
  function _rSw(c,P){const on=c.closed!==false&&c.closed!=='false',col=on?P.sw_on:P.sw_off;ctx.lineWidth=2.5;ctx.strokeStyle=col;L(-30,0,-14,0);L(14,0,30,0);ctx.fillStyle=col;D0(-14,0,3.5);D0(14,0,3.5);ctx.beginPath();ctx.moveTo(-14,0);ctx.lineTo(on?14:10,on?0:-16);ctx.stroke();T(on?'ON':'OFF',0,-23,10,col);}
  function _rVM(c,P,res){const col=P.voltmeter;ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-18,0);L(18,0,30,0);ctx.beginPath();ctx.arc(0,0,18,0,Math.PI*2);ctx.stroke();T('V',0,5,14,col);if(res&&res.voltage!=null)T(`${res.voltage.toFixed(2)}V`,0,28,9,P.textDim);}
  function _rAM(c,P,res){const col=P.ammeter;ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-18,0);L(18,0,30,0);ctx.beginPath();ctx.arc(0,0,18,0,Math.PI*2);ctx.stroke();T('A',0,5,14,col);if(res&&res.current!=null)T(`${res.current.toFixed(2)}mA`,0,28,9,P.textDim);}
  function _rLamp(c,P,on,res){const col=on?P.lamp:(_dark?'#5a4a00':'#fef9c3'),br=on&&res?Math.min(1,res.brightness||0.5):0;ctx.strokeStyle=col;ctx.lineWidth=2.5;L(-30,0,-18,0);L(18,0,30,0);ctx.beginPath();ctx.arc(0,0,18,0,Math.PI*2);ctx.stroke();ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(-8,0);for(let i=0;i<4;i++){ctx.lineTo(-8+i*5+2.5,i%2===0?-6:6);ctx.lineTo(-8+i*5+5,0);}ctx.stroke();if(on&&br>0){ctx.shadowColor=P.lamp;ctx.shadowBlur=20*br;ctx.fillStyle=`rgba(253,230,138,${br*0.6})`;ctx.beginPath();ctx.arc(0,0,16,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;}T(`${c.wattage||1}W`,0,-28,10,on?P.lamp:P.textDim);}
  function _rLbl(res,P){if(!res)return;const{voltage,current,status}=res;if(status==='off')return;const lines=[];if(voltage&&Math.abs(voltage)>0)lines.push(`${Math.abs(voltage).toFixed(1)}V`);if(current&&current>0)lines.push(`${current.toFixed(1)}mA`);if(!lines.length)return;const bg=_dark?'rgba(13,15,20,0.85)':'rgba(240,242,247,0.88)',h=lines.length*13+7,w=64,ty=38;ctx.fillStyle=bg;ctx.beginPath();if(ctx.roundRect)ctx.roundRect(-w/2,ty-2,w,h,3);else ctx.rect(-w/2,ty-2,w,h);ctx.fill();ctx.fillStyle=_dark?'#00e5ff':'#0066cc';ctx.font='10px Share Tech Mono,monospace';ctx.textAlign='center';lines.forEach((l,i)=>ctx.fillText(l,0,ty+10+i*13));}

  // ── Wire renderer with junction dots ──────────────────────────────
  function _rWire(c, P, on, sel) {
    if (c.x2 === undefined || c.y2 === undefined) return;
    const hot = on && Engine.isRunning();
    const thick = Math.max(1, parseFloat(c.thickness) || 2);
    const wCol = c.color || null;
    const wOp = c.opacity != null ? Math.max(0.05, Math.min(1, parseFloat(c.opacity))) : 1;
    const eCol = c.electronColor || P.particle;
    const aSp = Math.max(0.1, parseFloat(c.animationSpeed) || 1);
    const j = _getJ();
    ctx.save(); ctx.translate(-c.x, -c.y); ctx.globalAlpha = wOp;
    if (hot) { ctx.strokeStyle = wCol || P.wireHot; ctx.lineWidth = thick + 1; ctx.shadowColor = wCol || P.wireHot; ctx.shadowBlur = 10; ctx.setLineDash([10, 6]); ctx.lineDashOffset = -(_frame * 0.55 * aSp); }
    else if (sel) { ctx.strokeStyle = P.selBorder; ctx.lineWidth = thick + 1; }
    else { ctx.strokeStyle = wCol || P.wireDim; ctx.lineWidth = thick; }
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x2, c.y2); ctx.stroke();
    ctx.shadowBlur = 0; ctx.setLineDash([]); ctx.lineDashOffset = 0;
    [[c.x, c.y, c.ep_a], [c.x2, c.y2, c.ep_b]].forEach(([px, py, ep]) => {
      const conn = ep && ep.attachedTo;
      ctx.fillStyle = conn ? (hot ? (wCol || P.wireHot) : P.termSnap) : (hot ? (wCol || P.wireHot) : P.wireDim);
      ctx.beginPath(); ctx.arc(px, py, conn ? 4 / zoom : 2.5 / zoom, 0, Math.PI * 2); ctx.fill();
    });
    [[_sv(c.x), _sv(c.y)], [_sv(c.x2), _sv(c.y2)]].forEach(([px, py]) => {
      if (j.has(`${px},${py}`)) { ctx.fillStyle = hot ? (wCol || P.wireHot) : (wCol || P.wire || '#00e5ff'); ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 6; ctx.beginPath(); ctx.arc(px, py, 5 / zoom, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; }
    });
    if (hot) _drawParts(c, eCol, aSp);
    ctx.globalAlpha = 1; ctx.restore();
  }

  // ── Physics-based particles ───────────────────────────────────────
  // Direction: sign of current (positive = A→B, negative = B→A)
  function _updateParts() {
    if (!Engine.isRunning()) { _parts.clear(); return; }
    _A(components).filter(c => c && c.type === 'wire').forEach(c => {
      if (!isFinite(c.x2)) { _parts.delete(c.id); return; }
      const res = Engine.getResult(c.id);
      if (!res || res.status !== 'on') { _parts.delete(c.id); return; }
      const Ima = Math.abs(res.current || 0);
      if (Ima < 0.001) { _parts.delete(c.id); return; }
      const aSp = Math.max(0.1, parseFloat(c.animationSpeed) || 1);
      const spd = Math.min(0.002 + Ima * 0.0004, 0.05) * aSp;
      const n = Math.max(2, Math.min(12, Math.ceil(Ima / 5) + 1));
      const dir = (res.current || 0) >= 0 ? 1 : -1;
      if (!_parts.has(c.id)) { const ps = []; for (let i = 0; i < n; i++) ps.push({ t: i / n, wobble: Math.random() * Math.PI * 2 }); _parts.set(c.id, ps); }
      const ps = _parts.get(c.id);
      while (ps.length < n) ps.push({ t: Math.random(), wobble: Math.random() * Math.PI * 2 });
      if (ps.length > n) ps.splice(n);
      ps.forEach(p => { p.t += spd * dir; if (p.t > 1) p.t -= 1; if (p.t < 0) p.t += 1; p.wobble += 0.05; });
    });
  }

  function _drawParts(wire, color, aSp) {
    const ps = _parts.get(wire.id); if (!ps || !ps.length) return;
    const dx = wire.x2 - wire.x, dy = wire.y2 - wire.y, len = Math.hypot(dx, dy); if (len < 5) return;
    const nx = -dy / len, ny = dx / len;
    const res = Engine.getResult(wire.id);
    const Ima = res ? Math.abs(res.current || 0) : 0;
    const r = Math.max(1.8, Math.min(5, 1.8 + Ima * 0.06));
    const dir = res && (res.current || 0) >= 0 ? 1 : -1;
    ps.forEach(p => {
      const bx = wire.x + dx * p.t, by = wire.y + dy * p.t;
      const wobAmp = Math.min(2, Ima * 0.02);
      const wx = bx + nx * Math.sin(p.wobble) * wobAmp, wy = by + ny * Math.sin(p.wobble) * wobAmp;
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = r * 3;
      ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.arc(wx, wy, r * 0.35, 0, Math.PI * 2); ctx.fill();
      const tx = wx - dx / len * r * 3 * dir, ty = wy - dy / len * r * 3 * dir;
      ctx.strokeStyle = color; ctx.lineWidth = r * 0.5; ctx.globalAlpha = 0.25;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(wx, wy); ctx.stroke(); ctx.globalAlpha = 1;
    });
    ctx.shadowBlur = 0;
  }

  // ── Transient graph panel ─────────────────────────────────────────
  function _drawGraph() {
    const hist = Engine.getTransientHistory();
    if (!hist || !hist.time || !hist.time.length) return;
    const time = hist.time, history = hist.history;
    const W = Math.min(380, canvas.width - 20), H = 200;
    const gx = canvas.width - W - 10, gy = 10;
    ctx.save();
    ctx.fillStyle = _dark ? 'rgba(13,15,20,0.94)' : 'rgba(240,242,247,0.95)';
    ctx.strokeStyle = _dark ? '#2a3050' : '#c5cce0'; ctx.lineWidth = 1;
    if (ctx.roundRect) ctx.roundRect(gx, gy, W, H, 8); else ctx.rect(gx, gy, W, H);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = _dark ? '#e8ecf4' : '#1a1f30'; ctx.font = 'bold 11px Share Tech Mono,monospace'; ctx.textAlign = 'left';
    ctx.fillText(`Graph: ${_graphTarget || '—'}  [G]=close  [click component]=select`, gx + 8, gy + 18);
    if (!_graphTarget) { ctx.fillStyle = _dark ? '#4a5568' : '#99a0b8'; ctx.font = '10px Share Tech Mono,monospace'; ctx.textAlign = 'center'; ctx.fillText('Click a component to plot V(t) and I(t)', gx + W / 2, gy + H / 2); ctx.restore(); return; }
    const vData = [], iData = [];
    time.forEach((t, i) => { const r = history[i] && history[i][_graphTarget]; vData.push(r ? r.voltage : 0); iData.push(r ? r.current : 0); });
    const pad = { t: 30, r: 10, b: 28, l: 44 }, cw = W - pad.l - pad.r, ch = (H - pad.t - pad.b) / 2 - 4;
    const t0 = time[0] || 0, t1 = time[time.length - 1] || 1;
    function tx(t) { return gx + pad.l + cw * (t - t0) / (t1 - t0 || 1); }
    function drawWave(data, y0, yScale, col, lbl) {
      ctx.strokeStyle = _dark ? 'rgba(42,48,80,0.5)' : 'rgba(180,190,210,0.5)'; ctx.lineWidth = 0.5;
      for (let g = 0; g <= 4; g++) { const yg = y0 - ch * g / 4; ctx.beginPath(); ctx.moveTo(gx + pad.l, yg); ctx.lineTo(gx + pad.l + cw, yg); ctx.stroke(); }
      ctx.strokeStyle = _dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(gx + pad.l, y0); ctx.lineTo(gx + pad.l + cw, y0); ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath();
      data.forEach((v, i) => { const x = tx(time[i]), y = y0 - v * yScale; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }); ctx.stroke();
      ctx.fillStyle = col; ctx.font = '9px Share Tech Mono,monospace'; ctx.textAlign = 'left';
      ctx.fillText(lbl, gx + pad.l + 2, y0 - ch + 10);
    }
    const vMax = Math.max(...vData.map(Math.abs), 0.1), vy0 = gy + pad.t + ch;
    drawWave(vData, vy0, vData.some(v => v !== 0) ? (ch / vMax) * 0.9 : 1, _dark ? '#00e5ff' : '#0066cc', 'V [V]');
    const iMax = Math.max(...iData.map(Math.abs), 0.1), iy0 = gy + pad.t + ch * 2 + 10;
    drawWave(iData, iy0, iData.some(v => v !== 0) ? (ch / iMax) * 0.9 : 1, _dark ? '#39ff14' : '#2d8a00', 'I [mA]');
    ctx.fillStyle = _dark ? '#4a5568' : '#99a0b8'; ctx.font = '8px Share Tech Mono,monospace'; ctx.textAlign = 'center';
    [0, 0.25, 0.5, 0.75, 1].forEach(f => ctx.fillText((t0 + (t1 - t0) * f).toFixed(1) + 'ms', tx(t0 + (t1 - t0) * f), gy + H - 6));
    ctx.restore();
  }

  // ── Bode plot ─────────────────────────────────────────────────────
  function _drawBode() {
    const bc = document.getElementById('bode-canvas'); if (!bc) return;
    const an = Engine.getAnalysis(), bx = bc.getContext('2d'), W = bc.width, H = bc.height;
    bx.clearRect(0, 0, W, H); bx.fillStyle = _dark ? '#0d0f14' : '#f0f2f7'; bx.fillRect(0, 0, W, H);
    if (!an || !an.bode || !an.bode.length) { bx.fillStyle = _dark ? '#4a5568' : '#99a0b8'; bx.font = '10px Share Tech Mono,monospace'; bx.textAlign = 'center'; bx.fillText('Add C or L for Bode plot', W / 2, H / 2); return; }
    const pad = { t: 8, r: 6, b: 20, l: 30 }, cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
    bx.strokeStyle = _dark ? 'rgba(42,48,80,0.8)' : 'rgba(180,190,210,0.6)'; bx.lineWidth = 0.5;
    [-40, -30, -20, -10, 0].forEach(db => { const y = pad.t + ch * (1 - (db + 40) / 40); bx.beginPath(); bx.moveTo(pad.l, y); bx.lineTo(pad.l + cw, y); bx.stroke(); bx.fillStyle = _dark ? '#4a5568' : '#99a0b8'; bx.font = '8px Share Tech Mono,monospace'; bx.textAlign = 'right'; bx.fillText(`${db}`, pad.l - 3, y + 3); });
    if (an.fc) { const xFc = pad.l + cw * (Math.log10(an.fc) - Math.log10(0.1)) / (Math.log10(1e5) - Math.log10(0.1)); bx.strokeStyle = _dark ? 'rgba(255,107,53,0.6)' : 'rgba(230,90,40,0.6)'; bx.setLineDash([3, 3]); bx.beginPath(); bx.moveTo(xFc, pad.t); bx.lineTo(xFc, pad.t + ch); bx.stroke(); bx.setLineDash([]); bx.fillStyle = _dark ? '#ff6b35' : '#e85d04'; bx.font = '8px Share Tech Mono,monospace'; bx.textAlign = 'center'; bx.fillText(`fc=${an.fc < 1000 ? an.fc.toFixed(1) + 'Hz' : (an.fc / 1000).toFixed(1) + 'kHz'}`, xFc, pad.t + ch + 15); }
    const pts = an.bode, logMin = Math.log10(pts[0].f), logMax = Math.log10(pts[pts.length - 1].f);
    bx.strokeStyle = _dark ? '#00e5ff' : '#0066cc'; bx.lineWidth = 1.5; bx.beginPath(); pts.forEach((p, i) => { const x = pad.l + cw * (Math.log10(p.f) - logMin) / (logMax - logMin), y = pad.t + ch * (1 - (p.mag + 42) / 45); i === 0 ? bx.moveTo(x, y) : bx.lineTo(x, y); }); bx.stroke();
    bx.strokeStyle = _dark ? 'rgba(57,255,20,0.6)' : 'rgba(45,138,0,0.6)'; bx.lineWidth = 1; bx.setLineDash([3, 3]); bx.beginPath(); pts.forEach((p, i) => { const x = pad.l + cw * (Math.log10(p.f) - logMin) / (logMax - logMin), y = pad.t + ch * (1 - (p.phase + 90) / 90); i === 0 ? bx.moveTo(x, y) : bx.lineTo(x, y); }); bx.stroke(); bx.setLineDash([]);
    bx.fillStyle = _dark ? '#4a5568' : '#99a0b8'; bx.font = '8px Share Tech Mono,monospace'; bx.textAlign = 'left'; bx.fillText('|H| dB', 2, pad.t + 5);
  }

  // ── Mouse / touch ─────────────────────────────────────────────────
  function _onMD(e) {
    const sp = _sp(e), wp = _wp(e), ws = _ws(e);
    if (e.button === 1 || (e.button === 0 && _spaceDown)) { _panning = true; _panSt = { x: sp.x, y: sp.y, px: panX, py: panY }; canvas.style.cursor = 'grabbing'; e.preventDefault(); return; }
    if (e.button !== 0) return;
    if (_showGraph && _tool === 'select') { const hit = _hitTest(wp.x, wp.y); if (hit && hit.type !== 'wire') { _graphTarget = hit.id; _st(`Graph: ${hit.id}`); return; } }
    if (_tool === 'wire') {
      if (!_wireStart) { const r = _resolveEp(wp.x, wp.y, null); _wireStart = { x: r.x, y: r.y, ep: r.ep }; _st('Wire: click B. ESC=cancel.'); }
      else { const r = _resolveEp(wp.x, wp.y, null); if (r.x !== _wireStart.x || r.y !== _wireStart.y) { addComponent('wire', _wireStart.x, _wireStart.y, { x2: r.x, y2: r.y, ep_a: _wireStart.ep, ep_b: r.ep }); _pushH(); } _wireStart = null; }
      return;
    }
    if (_tool === 'component' && _pending) { const comp = addComponent(_pending, ws.x, ws.y); selectedIds.clear(); selectedIds.add(comp.id); _autoSnap(comp.id); updatePropsPanel(comp); _pushH(); return; }
    const hit = _hitTest(wp.x, wp.y);
    if (hit) {
      if (e.ctrlKey || e.metaKey) { selectedIds.has(hit.id) ? selectedIds.delete(hit.id) : selectedIds.add(hit.id); }
      else { if (!selectedIds.has(hit.id)) { selectedIds.clear(); selectedIds.add(hit.id); } }
      const sel = _A([..._S(selectedIds)]);
      _drag = { startX: ws.x, startY: ws.y, origins: sel.map(id => { const c = _byId(id); return c ? { id, x: c.x, y: c.y, x2: c.x2, y2: c.y2 } : null; }).filter(Boolean) };
      updatePropsPanel(hit);
    } else { if (!e.ctrlKey) selectedIds.clear(); _box = { x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y }; updatePropsPanel(null); }
  }

  function _onMM(e) {
    const sp = _sp(e), wp = _wp(e), ws = _ws(e);
    if (_panning) { panX = _panSt.px + (sp.x - _panSt.x); panY = _panSt.py + (sp.y - _panSt.y); return; }
    _mx = wp.x; _my = wp.y;
    if (_drag && _drag.origins) {
      const dx = ws.x - _snap(_drag.startX, _drag.startY).x, dy = ws.y - _snap(_drag.startX, _drag.startY).y;
      const moved = new Set();
      _A(_drag.origins).forEach(o => { const c = _byId(o.id); if (!c) return; c.x = o.x + dx; c.y = o.y + dy; if (o.x2 !== undefined) { c.x2 = o.x2 + dx; c.y2 = o.y2 + dy; } if (c.type !== 'wire') moved.add(c.id); });
      moved.forEach(id => _propagate(id));
      Engine.setComponents(components); return;
    }
    if (_box) { _box.x1 = wp.x; _box.y1 = wp.y; const rx0 = Math.min(_box.x0, _box.x1), ry0 = Math.min(_box.y0, _box.y1), rx1 = Math.max(_box.x0, _box.x1), ry1 = Math.max(_box.y0, _box.y1); selectedIds.clear(); _A(components).forEach(c => { if (c && c.x >= rx0 && c.x <= rx1 && c.y >= ry0 && c.y <= ry1) selectedIds.add(c.id); }); return; }
    if (_tool === 'select') { const hit = _hitTest(wp.x, wp.y); _showTip(hit, sp.x, sp.y); canvas.style.cursor = hit ? 'pointer' : (_spaceDown ? 'grab' : 'default'); }
  }

  function _onMU() {
    if (_panning) { _panning = false; canvas.style.cursor = _tool === 'wire' ? 'crosshair' : _tool === 'component' ? 'cell' : 'default'; return; }
    if (_drag) {
      const moved = _A(_drag.origins).filter(o => { const c = _byId(o.id); return c && c.type !== 'wire'; }).map(o => o.id);
      moved.forEach(id => _autoSnap(id)); _revalidate(); Engine.setComponents(components); _pushH(); _drag = null;
    }
    _box = null;
  }

  function _onDbl(e) { const wp = _wp(e), hit = _hitTest(wp.x, wp.y); if (!hit) return; if (hit.type === 'switch') { hit.closed = !(hit.closed !== false && hit.closed !== 'false'); _pushH(); _st(`Switch ${hit.closed ? 'ON' : 'OFF'}`); updatePropsPanel(hit); } }
  function _onCtx(e) { e.preventDefault(); const wp = _wp(e), hit = _hitTest(wp.x, wp.y); if (hit) { removeComponent(hit.id); _pushH(); } if (_tool === 'wire') _wireStart = null; }
  function _onWheel(e) { e.preventDefault(); const sp = _sp(e), d = e.deltaY < 0 ? 1.12 : 1 / 1.12, nz = Math.max(0.12, Math.min(6, zoom * d)); panX = sp.x - (sp.x - panX) * (nz / zoom); panY = sp.y - (sp.y - panY) * (nz / zoom); zoom = nz; }

  let _pd = null;
  function _onTS(e) { e.preventDefault(); if (e.touches.length === 2) { _pd = _p2(e); return; } const t = e.touches[0]; _onMD({ button: 0, clientX: t.clientX, clientY: t.clientY, ctrlKey: false, metaKey: false, preventDefault: () => {} }); }
  function _onTM(e) { e.preventDefault(); if (e.touches.length === 2) { const d = _p2(e), r = d / _pd, rc = canvas.getBoundingClientRect(), cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rc.left, cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rc.top, nz = Math.max(0.12, Math.min(6, zoom * r)); panX = cx - (cx - panX) * (nz / zoom); panY = cy - (cy - panY) * (nz / zoom); zoom = nz; _pd = d; return; } const t = e.touches[0]; _onMM({ clientX: t.clientX, clientY: t.clientY }); }
  function _onTU() { _onMU(); }
  function _p2(e) { return Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }
  function _onDrop(e) { e.preventDefault(); const type = e.dataTransfer.getData('text/plain'); if (!type) return; const r = canvas.getBoundingClientRect(), ws = _snap(...Object.values(_s2w(e.clientX - r.left, e.clientY - r.top))); if (type === 'wire') { _setTool('wire'); return; } const c = addComponent(type, ws.x, ws.y); selectedIds.clear(); selectedIds.add(c.id); _autoSnap(c.id); updatePropsPanel(c); _pushH(); }

  // ── Keyboard ──────────────────────────────────────────────────────
  function _onKD(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape') { _setTool('select'); return; }
    if (!e.ctrlKey && !e.metaKey) {
      if (e.key === 's' || e.key === 'S') { _setTool('select'); return; }
      if (e.key === 'w' || e.key === 'W') { _setTool('wire'); return; }
      if (e.key === 'n' || e.key === 'N') { _showNodes = !_showNodes; _st(_showNodes ? 'Node debug: ON [N]' : 'Node debug: OFF'); return; }
      if (e.key === 'g' || e.key === 'G') { _showGraph = !_showGraph; if (!_showGraph) _graphTarget = null; _st(_showGraph ? 'Graph: ON — click component [G]' : 'Graph: OFF'); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') { _copy(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') { _paste(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); _A(components).forEach(c => { if (c && c.id) selectedIds.add(c.id); }); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { _A([..._S(selectedIds)]).forEach(id => removeComponent(id)); selectedIds.clear(); updatePropsPanel(null); _pushH(); return; }
    if (e.key === 'r' || e.key === 'R') { _A([..._S(selectedIds)]).forEach(id => { const c = _byId(id); if (c && c.type !== 'wire') { c.rotation = ((c.rotation || 0) + 90) % 360; _propagate(id); } }); if (selectedIds.size) { _revalidate(); Engine.setComponents(components); _pushH(); } return; }
    if (e.key === ' ') { _spaceDown = true; canvas.style.cursor = 'grab'; e.preventDefault(); return; }
    const mv = { ArrowLeft: [-32, 0], ArrowRight: [32, 0], ArrowUp: [0, -32], ArrowDown: [0, 32] }[e.key];
    if (mv) { e.preventDefault(); const moved = []; _A([..._S(selectedIds)]).forEach(id => { const c = _byId(id); if (!c) return; c.x += mv[0]; c.y += mv[1]; if (c.x2 !== undefined) { c.x2 += mv[0]; c.y2 += mv[1]; } if (c.type !== 'wire') moved.push(id); }); moved.forEach(id => _propagate(id)); if (selectedIds.size) { _revalidate(); Engine.setComponents(components); _pushH(); } }
  }
  function _onKU(e) { if (e.key === ' ') { _spaceDown = false; canvas.style.cursor = _tool === 'wire' ? 'crosshair' : _tool === 'component' ? 'cell' : 'default'; } }

  // ── Component management ──────────────────────────────────────────
  function addComponent(type, x, y, extra = {}) {
    const defs = Engine.getDefaults ? Engine.getDefaults(type) : {};
    const c = { id: newId(), type, x, y, rotation: 0, ...defs, ...extra };
    if (type === 'wire') { if (!c.ep_a) c.ep_a = _nullEp(); else if (!c.ep_a.kind) c.ep_a.kind = c.ep_a.attachedTo ? 'component' : null; if (!c.ep_b) c.ep_b = _nullEp(); else if (!c.ep_b.kind) c.ep_b.kind = c.ep_b.attachedTo ? 'component' : null; }
    components.push(c); Engine.setComponents(components); return c;
  }

  function removeComponent(id) { _detach(id); const i = components.findIndex(c => c && c.id === id); if (i !== -1) components.splice(i, 1); selectedIds.delete(id); _parts.delete(id); Engine.setComponents(components); }
  function clearAll() { components.length = 0; selectedIds.clear(); _parts.clear(); Engine.setComponents(components); Engine.stop(); updatePropsPanel(null); updateMonitor(null); _pushH(); }
  function _byId(id) { return _A(components).find(c => c && c.id === id) || null; }

  function _hitTest(x, y) {
    const comps = _A(components);
    for (let i = comps.length - 1; i >= 0; i--) {
      const c = comps[i]; if (!c) continue;
      if (c.type === 'wire') { if (_hitW(c, x, y)) return c; }
      else if (c.type === 'ground') { if (Math.abs(x - c.x) < 16 && y > c.y - 14 && y < c.y + 36) return c; }
      else { const a = -(c.rotation || 0) * Math.PI / 180, dx = x - c.x, dy = y - c.y, lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a); if (Math.abs(lx) < 46 && Math.abs(ly) < 36) return c; }
    }
    return null;
  }
  function _hitW(w, x, y) { if (w.x2 === undefined) return false; const dx = w.x2 - w.x, dy = w.y2 - w.y, l2 = dx * dx + dy * dy; if (!l2) return false; const t = Math.max(0, Math.min(1, ((x - w.x) * dx + (y - w.y) * dy) / l2)); return Math.hypot(x - (w.x + t * dx), y - (w.y + t * dy)) < 9; }

  // ── History ───────────────────────────────────────────────────────
  function _pushH() { _hist = _hist.slice(0, _hIdx + 1); _hist.push(JSON.parse(JSON.stringify(_A(components)))); if (_hist.length > MAX_H) _hist.shift(); _hIdx = _hist.length - 1; Engine.setComponents(components); }
  function undo() { if (_hIdx <= 0) { if (window.showToast) showToast('Nothing to undo.', ''); return; } _hIdx--; _restH(); _st('Undone.'); }
  function redo() { if (_hIdx >= _hist.length - 1) { if (window.showToast) showToast('Nothing to redo.', ''); return; } _hIdx++; _restH(); _st('Redone.'); }
  function _restH() {
    const s = _A(_hist[_hIdx]); components.length = 0;
    s.forEach(c => { if (c && c.id) { if (c.type === 'wire') { if (!c.ep_a) c.ep_a = _nullEp(); if (!c.ep_b) c.ep_b = _nullEp(); } components.push(c); const n = parseInt((c.id || '').replace('c', '') || '0'); if (n >= _nid) _nid = n + 1; } });
    selectedIds.clear(); _parts.clear(); Engine.setComponents(components); updatePropsPanel(null); Engine.stop(); updateMonitor(null);
  }
  function _copy() { if (!selectedIds.size) return; _clip = _A([..._S(selectedIds)]).map(id => { const c = _byId(id); return c ? JSON.parse(JSON.stringify(c)) : null; }).filter(Boolean); _st(`${_clip.length} copied.`); if (window.showToast) showToast(`${_clip.length} copied.`, 'success'); }
  function _paste() { if (!_clip.length) return; selectedIds.clear(); _A(_clip).forEach(orig => { const c = { ...JSON.parse(JSON.stringify(orig)), id: newId(), x: orig.x + 48, y: orig.y + 48 }; if (c.x2 !== undefined) { c.x2 += 48; c.y2 += 48; } if (c.type === 'wire') { c.ep_a = _nullEp(); c.ep_b = _nullEp(); } components.push(c); selectedIds.add(c.id); }); Engine.setComponents(components); _pushH(); }

  // ── Properties panel ──────────────────────────────────────────────
  function updatePropsPanel(comp) {
    const panel = document.getElementById('props-panel'); if (!panel) return;
    if (!comp) { panel.innerHTML = selectedIds.size > 1 ? `<p class="p-empty">${selectedIds.size} selected — R:rotate Del:delete Ctrl+C:copy</p>` : '<p class="p-empty">Select or click component list to place</p>'; return; }
    const nm = { battery: 'Battery', vsource: 'V Source', isource: 'I Source', ground: 'Ground', resistor: 'Resistor', capacitor: 'Capacitor', inductor: 'Inductor', potentiometer: 'Potentiometer', led: 'LED', diode: 'Diode', zener: 'Zener', transistor: 'NPN BJT', pnp: 'PNP BJT', mosfet_n: 'NMOS FET', switch: 'Switch', wire: 'Wire', voltmeter: 'Voltmeter', ammeter: 'Ammeter', lamp: 'Lamp' };
    let h = `<div class="prop-type">${nm[comp.type] || comp.type}</div>`;
    switch (comp.type) {
      case 'battery': h += fi('Voltage (V)', 'voltage', comp.voltage ?? 9, 'number', comp.id); break;
      case 'vsource': h += fi('Voltage (V)', 'voltage', comp.voltage ?? 5, 'number', comp.id) + fs('Waveform', 'waveform', comp.waveform || 'dc', ['dc', 'ac'], comp.id, ['DC', 'AC']) + fi('Freq (Hz)', 'frequency', comp.frequency ?? 50, 'number', comp.id); break;
      case 'isource': h += fi('Current (mA)', 'current', comp.current ?? 10, 'number', comp.id); break;
      case 'resistor': h += fi('Resistance (Ω)', 'resistance', comp.resistance ?? 1000, 'number', comp.id); break;
      case 'potentiometer': h += fi('R total (Ω)', 'resistance', comp.resistance ?? 10000, 'number', comp.id) + fi('Wiper (%)', 'wiper', comp.wiper ?? 50, 'number', comp.id); break;
      case 'capacitor': h += fi('Capacitance (μF)', 'capacitance', comp.capacitance ?? 100, 'number', comp.id); break;
      case 'inductor': h += fi('Inductance (mH)', 'inductance', comp.inductance ?? 10, 'number', comp.id); break;
      case 'led': h += fs('Color', 'ledColor', comp.ledColor || 'red', ['red', 'green', 'blue', 'yellow', 'white', 'orange'], comp.id); break;
      case 'diode': h += fs('Polarity', 'reversed', String(comp.reversed || false), ['false', 'true'], comp.id, ['Forward', 'Reverse']); break;
      case 'zener': h += fi('Vz (V)', 'vz', comp.vz ?? 5.1, 'number', comp.id) + fs('Polarity', 'reversed', String(comp.reversed || false), ['false', 'true'], comp.id, ['Forward', 'Reverse']); break;
      case 'transistor': case 'pnp': h += fi('V_Base (V)', 'baseVoltage', comp.baseVoltage ?? 0.8, 'number', comp.id) + fi('R_Base (Ω)', 'baseResistor', comp.baseResistor ?? 10000, 'number', comp.id); break;
      case 'mosfet_n': h += fi('Vgs (V)', 'vgs', comp.vgs ?? 3, 'number', comp.id) + fi('Vth (V)', 'vth', comp.vth ?? 2, 'number', comp.id); break;
      case 'switch': h += fs('State', 'closed', String(comp.closed !== false), ['true', 'false'], comp.id, ['Closed (ON)', 'Open (OFF)']); break;
      case 'lamp': h += fi('Power (W)', 'wattage', comp.wattage ?? 1, 'number', comp.id); break;
      case 'wire': h += fi('Thickness', 'thickness', comp.thickness ?? 2, 'number', comp.id) + fi('Electron Speed', 'animationSpeed', comp.animationSpeed ?? 1, 'number', comp.id) + fi('Opacity', 'opacity', comp.opacity ?? 1, 'number', comp.id) + fi('Color (#hex)', 'color', comp.color || '', 'text', comp.id); break;
    }
    if (comp.type !== 'wire' && comp.type !== 'ground') h += fi('Rotation (°)', 'rotation', comp.rotation ?? 0, 'number', comp.id);
    panel.innerHTML = h;
    panel.querySelectorAll('input,select').forEach(el => el.addEventListener('change', _onPC));
  }

  function fi(l, p, v, t, id) { return `<div class="prop-row"><label>${l}</label><input type="${t}" value="${v}" data-prop="${p}" data-id="${id}" style="width:100%"/></div>`; }
  function fs(l, p, v, vals, id, lbls = null) { const o = vals.map((vv, i) => `<option value="${vv}" ${String(vv) === String(v) ? 'selected' : ''}>${lbls ? lbls[i] : vv}</option>`).join(''); return `<div class="prop-row"><label>${l}</label><select data-prop="${p}" data-id="${id}">${o}</select></div>`; }
  function _onPC(e) { const { prop, id } = e.target.dataset; const c = _byId(id); if (!c) return; let v = e.target.value; if (e.target.type === 'number') v = parseFloat(v); if (v === 'true') v = true; if (v === 'false') v = false; c[prop] = v; if (prop === 'rotation') _propagate(id); Engine.setComponents(components); _pushH(); }

  // ── Monitor panels ────────────────────────────────────────────────
  function updateMonitor(s) {
    const g = id => document.getElementById(id);
    const [mSt, mV, mI, mP, mR] = ['mon-status', 'mon-voltage', 'mon-current', 'mon-power', 'mon-resistance'].map(g);
    if (!s) { if (mSt) { mSt.textContent = 'IDLE'; mSt.className = 'mon-val idle'; } [mV, mI, mP, mR].forEach((el, i) => { if (el) el.textContent = ['— V', '— mA', '— mW', '— Ω'][i]; }); const cr = g('comp-readings'); if (cr) cr.innerHTML = '<p class="p-empty">Run simulation</p>'; const np = g('nodes-panel'); if (np) np.innerHTML = '<p class="p-empty">—</p>'; return; }
    const MAP = { running: ['RUNNING', 'run'], open_circuit: ['OPEN', 'err'], short_circuit: ['SHORT!', 'err'], warn: ['WARN', 'warn'] };
    const [lbl, cls] = MAP[s.status] || [s.status, ''];
    if (mSt) { mSt.textContent = lbl; mSt.className = `mon-val ${cls}`; }
    if (mV) mV.textContent = s.voltage != null ? `${s.voltage} V` : '— V';
    if (mI) mI.textContent = s.current != null ? `${s.current} mA` : '— mA';
    if (mP) mP.textContent = s.power   != null ? `${s.power} mW`   : '— mW';
    if (mR) mR.textContent = s.resistance != null ? `${s.resistance} Ω` : '— Ω';
    _updateReadings();
  }

  function _updateReadings() {
    const panel = document.getElementById('comp-readings'); if (!panel) return;
    const res = Engine.getAllResults();
    if (!res || !Object.keys(res).length) { panel.innerHTML = '<p class="p-empty">Run simulation</p>'; return; }
    const ico = { battery: '🔋', vsource: '⚡', isource: '⊙', ground: '⏚', resistor: '⬛', capacitor: '┤├', inductor: '∿', potentiometer: '⊿', led: '💡', diode: '▷|', zener: '▷⌇', transistor: '⊳', pnp: '⊲', mosfet_n: '⊓', switch: '🔘', wire: '〰', voltmeter: 'Ⓥ', ammeter: 'Ⓐ', lamp: '☉' };
    let html = '';
    _A(components).forEach(c => { if (!c) return; const r = res[c.id]; if (!r) return; const sm = r.status === 'burned' ? '🔥' : r.status === 'charged' ? '⚡' : r.status === 'on' ? '●' : '○'; html += `<div class="read-item"><div class="read-name">${ico[c.type] || '◦'} ${c.type} ${sm}</div><div class="read-vals">${r.voltage > 0 ? r.voltage.toFixed(2) + 'V' : ''}${r.current > 0 ? ' · ' + r.current.toFixed(2) + 'mA' : ''}${r.power > 0 ? ' · ' + r.power.toFixed(2) + 'mW' : ''}${r.status === 'burned' ? ' BURNED' : ''}${c.type === 'lamp' && r.brightness != null ? ` ${(r.brightness * 100).toFixed(0)}%` : ''}</div></div>`; });
    panel.innerHTML = html || '<p class="p-empty">No data</p>';
  }

  function updateDebugPanel(errors) {
    const errs = _A(errors), panel = document.getElementById('debug-list'), empty = document.getElementById('debug-ok'), badge = document.getElementById('debug-badge');
    if (badge) { badge.textContent = errs.length; badge.style.display = errs.length ? '' : 'none'; }
    if (!panel) return;
    if (!errs.length) { if (empty) empty.style.display = ''; panel.innerHTML = ''; return; }
    if (empty) empty.style.display = 'none';
    const ic = { short_circuit: '⚡', open_circuit: '🔴', inv: '↩', ground: '⏚', warn: '⚠', singular: '⚡' };
    panel.innerHTML = errs.map(e => `<div class="dbg-item dbg-${e.type}"><span class="dbg-ico">${ic[e.type] || '⚠'}</span><span class="dbg-msg">${e.message}</span></div>`).join('');
  }

  function updateNodesPanel(nodes) {
    const panel = document.getElementById('nodes-panel'); if (!panel) return;
    if (!nodes || !nodes.length) { panel.innerHTML = '<p class="p-empty">—</p>'; return; }
    panel.innerHTML = _A(nodes).map(n => `<div class="node-item"><span class="node-lbl">${n.label}</span><span class="node-val">${n.voltage.toFixed(3)}V</span></div>`).join('');
  }

  function updateAnalysisPanel(an) {
    if (!an) return;
    const g = id => document.getElementById(id);
    const fEl = g('an-freq'), tEl = g('an-tau'), gainEl = g('an-gain');
    if (fEl) fEl.textContent = an.fc != null ? (an.fc < 1000 ? `${an.fc.toFixed(1)} Hz` : `${(an.fc / 1000).toFixed(2)} kHz`) : '— Hz';
    if (tEl) tEl.textContent = an.tau != null ? `${an.tau.toFixed(2)} ms` : '— ms';
    if (gainEl) gainEl.textContent = an.gain_db != null ? `${an.gain_db.toFixed(1)} dB` : '— dB';
  }

  // ── Tooltip ───────────────────────────────────────────────────────
  const TIPS = { battery: ['Battery', 'DC source'], vsource: ['V Source', 'AC or DC generator'], isource: ['I Source', 'Constant current'], ground: ['Ground', '0V reference'], resistor: ['Resistor', 'V = R × I'], potentiometer: ['Potentiometer', 'Variable R (wiper %)'], capacitor: ['Capacitor', 'DC: open. Transient: C·dV/dt'], inductor: ['Inductor', 'DC: short. Transient: L·dI/dt'], led: ['LED', '1.8V drop, max 30mA'], diode: ['Diode', '0.7V drop'], zener: ['Zener', 'Vz clamp'], transistor: ['NPN BJT', 'β=100'], pnp: ['PNP BJT', 'β=100'], mosfet_n: ['NMOS', 'on when Vgs>Vth'], switch: ['Switch', 'Double-click to toggle'], wire: ['Wire', '● = connected  ○ = free  [N]=nodes  [G]=graph'], voltmeter: ['Voltmeter', 'Reads voltage'], ammeter: ['Ammeter', 'Reads current'], lamp: ['Lamp', 'Brightness ∝ power'] };
  function _showTip(comp, sx, sy) {
    const tt = document.getElementById('tooltip'); if (!tt) return;
    if (!comp || _drag) { _hideTip(); return; }
    const [title, desc] = TIPS[comp.type] || ['?', ''];
    const res = Engine.getResult(comp.id); let ex = '';
    if (res && Engine.isRunning() && res.status !== 'off') ex = `<div class="tt-line"><span class="tt-val">${Math.abs(res.voltage || 0).toFixed(2)}V</span> <span class="tt-val">${(res.current || 0).toFixed(2)}mA</span></div>`;
    tt.innerHTML = `<div class="tt-title">${title}</div><div class="tt-line">${desc}</div>${ex}`;
    const r = canvas.getBoundingClientRect();
    tt.style.left = `${Math.min(sx - r.left + 14, canvas.width - 220)}px`;
    tt.style.top = `${Math.max(0, sy - r.top - 14)}px`;
    tt.style.display = 'block';
  }
  function _hideTip() { const tt = document.getElementById('tooltip'); if (tt) tt.style.display = 'none'; }
  function _st(msg) { const el = document.getElementById('status-msg'); if (el) el.textContent = msg; }

  // ── Public API ────────────────────────────────────────────────────
  function getComponents() { return components; }
  function setStatus(m) { _st(m); }
  function pushHistory() { _pushH(); }
  function enableWireMode() { _setTool('wire'); }
  function resetView() { zoom = 1; panX = 0; panY = 0; _st('View reset.'); }

  function loadComponents(comps) {
    if (!Array.isArray(comps)) return;
    components.length = 0;
    comps.forEach(c => { if (c && c.id) { const comp = { rotation: 0, ...c }; if (comp.type === 'wire') { if (!comp.ep_a) comp.ep_a = _nullEp(); if (!comp.ep_b) comp.ep_b = _nullEp(); } components.push(comp); const n = parseInt((c.id || '').replace('c', '') || '0'); if (n >= _nid) _nid = n + 1; } });
    selectedIds.clear(); _parts.clear(); Engine.setComponents(components); updatePropsPanel(null); _pushH();
  }

  function setTheme(dark) { _dark = dark; document.body.classList.toggle('light', !dark); const btn = document.getElementById('btn-theme'); if (btn) btn.textContent = dark ? '☀' : '🌙'; }
  function showGraphPanel(show) { _showGraph = show; if (!show) _graphTarget = null; }

  return { init, getComponents, loadComponents, addComponent, removeComponent, clearAll, updateMonitor, updateDebugPanel, updateNodesPanel, updateAnalysisPanel, setStatus, setTheme, enableWireMode, resetView, undo, redo, pushHistory, setTool: _setTool, showGraphPanel };
})();
