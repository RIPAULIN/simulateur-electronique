/**
 * main.js — CircuitLab Orchestration
 * DC simulation + Transient simulation + Graph visualization.
 */
document.addEventListener('DOMContentLoaded', () => {

  function showToast(msg, type = '') {
    const t = document.getElementById('toast'); if (!t) return;
    t.textContent = msg; t.className = 'toast'; if (type) t.classList.add(type);
    void t.offsetWidth; t.classList.add('show');
    clearTimeout(t._tmr); t._tmr = setTimeout(() => t.classList.remove('show'), 3200);
  }
  window.showToast = showToast;

  // ── Auth ──────────────────────────────────────────────────────────
  Auth.init();
  const sess = Auth.getSession();
  if (sess) { _boot(sess); }
  else {
    const urlData = Share.loadFromURL();
    if (urlData) { const el = document.getElementById('login-error'); if (el) { el.textContent = 'Circuit received. Log in to view it.'; el.style.color = 'var(--accent)'; } }
  }

  document.getElementById('btn-login')?.addEventListener('click', _login);
  document.getElementById('btn-register')?.addEventListener('click', _register);
  document.getElementById('btn-register')?.addEventListener('mouseover', () => { const ig = document.getElementById('invite-group'); if (ig) ig.style.display = 'flex'; });
  ['inp-user', 'inp-pass', 'inp-invite'].forEach(id => { document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') _login(); }); });

  function _login() {
    const u = (document.getElementById('inp-user')?.value || '').trim();
    const p = document.getElementById('inp-pass')?.value || '';
    if (!u || !p) { _lerr('Enter username and password.'); return; }
    const r = Auth.login(u, p);
    if (r.success) _boot(r.user); else _lerr(r.error);
  }
  function _register() {
    const u = (document.getElementById('inp-user')?.value || '').trim();
    const p = document.getElementById('inp-pass')?.value || '';
    const i = document.getElementById('inp-invite')?.value || '';
    if (!u || !p) { _lerr('Enter username and password.'); return; }
    const r = Auth.register(u, p, i);
    if (r.success) { showToast('Welcome, ' + u + '!', 'success'); _boot(r.user); } else _lerr(r.error);
  }
  function _lerr(m) { const el = document.getElementById('login-error'); if (el) { el.textContent = m; el.style.color = ''; } }

  function _boot(user) {
    const ls = document.getElementById('login-screen');
    const as = document.getElementById('app-screen');
    if (ls) ls.style.display = 'none';
    if (as) as.style.display = 'flex';
    const ul = document.getElementById('user-label');
    if (ul) ul.textContent = `${user.role === 'admin' ? '★' : '◦'} ${user.username}`;
    UI.init();
    UI.setTheme((localStorage.getItem('cl_theme') || 'dark') === 'dark');
    const urlData = Share.loadFromURL();
    if (urlData && Array.isArray(urlData.components)) {
      UI.loadComponents(urlData.components);
      const cn = document.getElementById('circuit-name'); if (urlData.name && cn) cn.value = urlData.name;
      Share.clearURLParam();
      showToast(`Circuit "${urlData.name || 'shared'}" loaded!`, 'success');
    }
    _bindEvents();
    setTimeout(_restoreAuto, 900);
  }

  // ── Bind all events ───────────────────────────────────────────────
  function _bindEvents() {
    document.getElementById('btn-logout')?.addEventListener('click', () => { Auth.logout(); Engine.stop(); location.reload(); });
    document.getElementById('btn-theme')?.addEventListener('click', () => { const dark = !document.body.classList.contains('light'); UI.setTheme(!dark); localStorage.setItem('cl_theme', !dark ? 'dark' : 'light'); });

    document.querySelectorAll('[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => { document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b === btn)); });
    });

    document.getElementById('tb-undo')?.addEventListener('click', () => UI.undo());
    document.getElementById('tb-redo')?.addEventListener('click', () => UI.redo());
    document.getElementById('tb-del')?.addEventListener('click', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
    document.getElementById('tb-rot')?.addEventListener('click', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true })));

    document.getElementById('btn-run')?.addEventListener('click', _runDC);
    document.getElementById('btn-stop')?.addEventListener('click', () => { Engine.stop(); UI.updateMonitor(null); UI.updateDebugPanel([]); UI.updateNodesPanel([]); UI.setStatus('Simulation stopped.'); showToast('Simulation stopped.', ''); });
    document.getElementById('btn-run-tr')?.addEventListener('click', _runTransient);

    document.getElementById('btn-undo')?.addEventListener('click', () => UI.undo());
    document.getElementById('btn-redo')?.addEventListener('click', () => UI.redo());
    document.getElementById('btn-clear')?.addEventListener('click', () => { if (confirm('Clear canvas?')) { UI.clearAll(); showToast('Canvas cleared.', ''); } });
    document.getElementById('btn-reset-view')?.addEventListener('click', () => UI.resetView());

    document.getElementById('btn-copy-link')?.addEventListener('click', async () => { const name = document.getElementById('circuit-name')?.value || 'Circuit'; const r = await Share.copyShareLink(UI.getComponents(), name); if (r && r.ok) { showToast('🔗 Link copied!', 'success'); UI.setStatus('Link copied.'); } });
    document.getElementById('btn-export-json')?.addEventListener('click', () => { Share.exportJSON(UI.getComponents(), document.getElementById('circuit-name')?.value || 'Circuit'); showToast('📤 JSON exported.', 'success'); });
    document.getElementById('btn-import-json')?.addEventListener('click', async () => { try { const d = await Share.importJSON(); if (!Array.isArray(d.components)) throw new Error('Invalid format.'); UI.loadComponents(d.components); const cn = document.getElementById('circuit-name'); if (d.name && cn) cn.value = d.name; showToast(`✅ "${d.name || 'Circuit'}" imported.`, 'success'); } catch (err) { showToast('❌ ' + (err.message || err), 'error'); } });
    document.getElementById('btn-export-png')?.addEventListener('click', () => { Share.exportPNG(document.getElementById('circuit-canvas'), document.getElementById('circuit-name')?.value || 'Circuit'); showToast('🖼 PNG exported.', 'success'); });
    document.getElementById('btn-qr')?.addEventListener('click', () => { const name = document.getElementById('circuit-name')?.value || 'Circuit', url = Share.buildShareURL(UI.getComponents(), name); const qrc = document.getElementById('qr-canvas'); if (qrc) Share.drawQR(qrc, url); const qru = document.getElementById('qr-url'); if (qru) qru.textContent = url.length > 80 ? url.slice(0, 77) + '…' : url; const qm = document.getElementById('qr-modal'); if (qm) qm.style.display = 'flex'; });
    document.getElementById('btn-close-qr')?.addEventListener('click', () => { const qm = document.getElementById('qr-modal'); if (qm) qm.style.display = 'none'; });
    document.getElementById('qr-modal')?.addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.style.display = 'none'; });
    document.getElementById('btn-dl-qr')?.addEventListener('click', () => { document.getElementById('qr-canvas')?.toBlob(blob => { if (!blob) return; const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = 'qr.png'; a.click(); URL.revokeObjectURL(u); }); });

    document.getElementById('btn-graph')?.addEventListener('click', () => { UI.showGraphPanel(true); UI.setStatus('Graph: ON — [G] or click component'); });
    document.getElementById('btn-tutorial')?.addEventListener('click', _openTut);
    document.getElementById('btn-close-tut')?.addEventListener('click', _closeTut);
    document.getElementById('tutorial-modal')?.addEventListener('click', e => { if (e.target === e.currentTarget) _closeTut(); });
    document.addEventListener('keydown', e => { if (e.key === 'F1') { e.preventDefault(); _openTut(); } });

    setInterval(_autoSave, 30000);
  }

  // ── DC Simulation ─────────────────────────────────────────────────
  function _runDC() {
    const comps = UI.getComponents();
    if (!Array.isArray(comps) || comps.length === 0) { showToast('Add components first.', 'error'); return; }
    Engine.setComponents(comps);
    const result = Engine.simulate();
    UI.updateMonitor(result.summary);
    UI.updateDebugPanel(result.errors || []);
    UI.updateNodesPanel(result.nodes || []);
    UI.updateAnalysisPanel(result.analysis || {});
    if (result.ok) {
      const s = result.summary || {};
      showToast(`▶ OK — ${s.voltage}V · ${s.current}mA · ${s.power}mW`, 'success');
      UI.setStatus(`Active: ${s.voltage}V, ${s.current}mA, ${s.power}mW`);
    } else {
      showToast(result.error || 'Error.', 'error');
      UI.setStatus('⚠ ' + (result.error || 'Error.'));
    }
  }

  // ── Transient Simulation ──────────────────────────────────────────
  function _runTransient() {
    const comps = UI.getComponents();
    if (!Array.isArray(comps) || comps.length === 0) { showToast('Add components first.', 'error'); return; }
    const dtEl = document.getElementById('tr-dt'), TEl = document.getElementById('tr-T');
    const dt = parseFloat(dtEl?.value) || 1;    // ms
    const T  = parseFloat(TEl?.value)  || 100;  // ms
    if (dt <= 0 || T <= 0) { showToast('Invalid time parameters.', 'error'); return; }
    Engine.setComponents(comps);
    UI.setStatus(`Running transient (dt=${dt}ms, T=${T}ms)…`);
    showToast('Transient running…', '');
    // Run async to not block UI
    setTimeout(() => {
      const result = Engine.simulateTransient(dt, T);
      if (result.ok) {
        showToast(`✅ Transient done: ${result.stepCount} steps`, 'success');
        UI.setStatus(`Transient complete: ${result.stepCount} steps. [G] to view graph.`);
        // Update node panel with last step
        if (result.history.length) {
          const lastDC = Engine.simulate();  // refresh DC display
          UI.updateMonitor(lastDC.summary);
          UI.updateDebugPanel(lastDC.errors || []);
          UI.updateNodesPanel(lastDC.nodes || []);
        }
        UI.showGraphPanel(true);
      } else {
        showToast('Transient error.', 'error');
        UI.setStatus('Transient error: ' + (result.errors[0]?.message || ''));
      }
    }, 10);
  }

  // ── Autosave ──────────────────────────────────────────────────────
  function _autoSave() {
    const comps = UI.getComponents();
    if (!Array.isArray(comps) || !comps.length) return;
    const name = document.getElementById('circuit-name')?.value || 'Circuit';
    try { localStorage.setItem('cl_autosave', JSON.stringify({ name, components: comps })); } catch (_) {}
  }
  function _restoreAuto() {
    if (Share.loadFromURL()) return;
    try {
      const saved = localStorage.getItem('cl_autosave'); if (!saved) return;
      const d = JSON.parse(saved);
      if (!Array.isArray(d.components) || !d.components.length) return;
      if (confirm(`Restore autosave: "${d.name}"?`)) {
        UI.loadComponents(d.components);
        const cn = document.getElementById('circuit-name'); if (cn) cn.value = d.name || 'Circuit';
        showToast('Autosave restored.', 'success');
      }
    } catch (_) {}
  }

  // ── Tutorial ──────────────────────────────────────────────────────
  const TUTS = [
    { title: '01 — Getting Started', text: 'Login: <code>admin / admin123</code>. <strong>S</strong>=Select, <strong>W</strong>=Wire, <strong>ESC</strong>=back to Select. Click sidebar items to place components. <strong>Del</strong>=delete, <strong>R</strong>=rotate, arrow keys=move.' },
    { title: '02 — Building Circuits', text: 'Click a component in the sidebar, then click the canvas to place it. Switch to Wire mode and click two points to draw a wire. Wires snap to component terminals (green ring) and other wire endpoints. Filled dot ● = connected, hollow ○ = free.' },
    { title: '03 — DC Simulation', text: 'Press <strong>▶ Simulate</strong> to run DC analysis using Modified Nodal Analysis (MNA). Results appear on the canvas (voltage, current) and in the right panel. Electrons animate along wires — speed and direction reflect real current.' },
    { title: '04 — Transient Simulation', text: 'Set Δt and T in the transient panel, then click <strong>▶ Transient</strong>. Capacitors charge/discharge using Backward Euler integration. Press <strong>G</strong> then click a component to view V(t) and I(t) waveforms.' },
    { title: '05 — Debug & Shortcuts', text: '<strong>N</strong> = node debug overlay (coloured dots show electrical nodes). <strong>G</strong> = graph panel. <strong>Ctrl+Z/Y</strong> = undo/redo. <strong>Ctrl+C/V</strong> = copy/paste. Right-click = delete. Double-click switch = toggle ON/OFF.' }
  ];
  let _ts = 0;
  function _openTut() { const m = document.getElementById('tutorial-modal'), s = document.getElementById('tut-steps'); if (!m || !s) return; s.innerHTML = TUTS.map((t, i) => `<div class="tut-step${i === 0 ? ' active' : ''}" data-step="${i}"><h3>${t.title}</h3><p>${t.text}</p></div>`).join(''); _ts = 0; _updTut(); m.style.display = 'flex'; document.getElementById('tut-prev').onclick = () => { if (_ts > 0) { _ts--; _updTut(); } }; document.getElementById('tut-next').onclick = () => { if (_ts < TUTS.length - 1) { _ts++; _updTut(); } else _closeTut(); }; }
  function _closeTut() { const m = document.getElementById('tutorial-modal'); if (m) m.style.display = 'none'; }
  function _updTut() { document.querySelectorAll('.tut-step').forEach((el, i) => el.classList.toggle('active', i === _ts)); const c = document.getElementById('tut-counter'); if (c) c.textContent = `${_ts + 1} / ${TUTS.length}`; const p = document.getElementById('tut-prev'); if (p) p.disabled = _ts === 0; const n = document.getElementById('tut-next'); if (n) n.textContent = _ts === TUTS.length - 1 ? '✓ Close' : 'Next →'; }
});
