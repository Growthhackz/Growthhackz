// Single-page dashboard served at `/`. No secrets are embedded: it logs in and talks to /api/* with a session cookie.
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sol Trigger</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --panel2: #1c2230; --line: #2a3140; --text: #e6edf3; --muted: #8b949e;
    --accent: #7c5cff; --accent2: #9d85ff; --ok: #3fb950; --warn: #d29922; --bad: #f85149;
    --radius: 10px; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 5; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; margin-right: auto; }
  main { max-width: 1200px; margin: 0 auto; padding: 20px 16px 60px; display: grid; gap: 16px; }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  section.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; min-width: 0; }
  section.card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
  section.card h2 .spacer { margin-left: auto; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 8px 0 4px; }
  input, select, textarea { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font: inherit; }
  input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  input[type=checkbox] { width: auto; }
  textarea { font-family: var(--mono); font-size: 12px; min-height: 64px; }
  button { background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 7px 12px; font: inherit; cursor: pointer; white-space: nowrap; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { background: var(--accent2); }
  button.danger { color: var(--bad); }
  button.small { padding: 3px 8px; font-size: 12px; }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: 8px; align-items: end; flex-wrap: wrap; }
  .row > * { flex: 1; min-width: 0; }
  .row > button { flex: 0 0 auto; }
  .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .mono { font-family: var(--mono); font-size: 12px; }
  .muted { color: var(--muted); }
  .big { font-size: 22px; font-weight: 600; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  td.wrap { white-space: normal; min-width: 180px; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 11px; border: 1px solid var(--line); }
  .pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
  .pill.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
  .pill.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
  .toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .switch { width: 40px; height: 22px; border-radius: 99px; background: var(--line); position: relative; transition: background .15s; }
  .switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }
  .toggle.on .switch { background: var(--ok); }
  .toggle.on .switch::after { left: 21px; }
  a { color: var(--accent2); }
  #toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 16px; display: none; z-index: 20; max-width: calc(100% - 32px); }
  #toast.bad { border-color: var(--bad); }
  #login { max-width: 360px; margin: 12vh auto; }
  dialog { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: var(--radius); width: min(480px, calc(100% - 32px)); }
  dialog::backdrop { background: rgba(0,0,0,.6); }
  .secret { background: var(--bg); border: 1px dashed var(--warn); padding: 10px; border-radius: 8px; word-break: break-all; }
  .hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .tabs { display: flex; gap: 6px; margin: 8px 0; }
  .tabs button.active { border-color: var(--accent); color: var(--accent2); }
  .hidden { display: none !important; }
</style>
</head>
<body>

<div id="login" class="hidden">
  <section class="card">
    <h2>Sol Trigger · Log in</h2>
    <form id="login-form">
      <label for="pw">Password</label>
      <input id="pw" type="password" autocomplete="current-password" required>
      <div class="actions"><button class="primary" type="submit">Log in</button></div>
    </form>
  </section>
</div>

<div id="app" class="hidden">
  <header>
    <h1>Sol Trigger</h1>
    <span class="toggle" id="triggers-toggle" role="switch" tabindex="0"><span class="switch"></span><span id="triggers-label">Triggers</span></span>
    <button id="refresh" class="small">Refresh</button>
    <button id="logout" class="small">Log out</button>
  </header>
  <main>
    <div class="grid">
      <section class="card">
        <h2>1 · Initial receiver</h2>
        <label for="s-initial">Wallet that gets SOL on each trigger</label>
        <input id="s-initial" class="mono" placeholder="Solana address (empty = skip this step)">
        <label for="s-amount">Amount (SOL)</label>
        <input id="s-amount" type="number" min="0" step="0.001">
        <div class="actions">
          <button class="primary" data-save="initial">Save</button>
          <button class="danger" data-clear="initial">Delete receiver</button>
        </div>
      </section>
      <section class="card">
        <h2>2 · Buy delay</h2>
        <label for="s-delay">Minutes after the trigger before trading wallets buy</label>
        <input id="s-delay" type="number" min="0" step="0.5">
        <div class="hint">Changing it also moves triggers that are still waiting.</div>
        <div class="actions"><button class="primary" data-save="delay">Save</button></div>
      </section>
      <section class="card">
        <h2>3 · Final receiver (sweep)</h2>
        <label for="s-final">Wallet that receives swept SOL</label>
        <input id="s-final" class="mono" placeholder="Solana address">
        <div class="actions">
          <button class="primary" data-save="final">Save</button>
          <button class="danger" data-clear="final">Delete receiver</button>
        </div>
      </section>
    </div>

    <section class="card">
      <h2>Funding wallet <span class="muted" style="text-transform:none;letter-spacing:0">(sends the initial receiver's SOL)</span></h2>
      <div id="funding"></div>
    </section>

    <section class="card">
      <h2>Trading wallets
        <span class="spacer"></span>
        <button class="small" id="add-wallet">+ Add wallet</button>
      </h2>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th><input type="checkbox" id="select-all" title="Select all for sweep"></th>
            <th>Name</th><th>Address</th><th>SOL</th><th>Buy % of SOL</th><th>Sell % of tokens</th><th>Every</th><th>Status</th><th></th>
          </tr></thead>
          <tbody id="wallets"></tbody>
        </table>
      </div>
      <div class="actions" style="align-items:center">
        <button class="primary" id="sweep-btn" disabled>Sweep selected → final receiver</button>
        <span class="muted" id="sweep-info"></span>
      </div>
    </section>

    <section class="card">
      <h2>Positions</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Wallet</th><th>Token</th><th>Status</th><th>SOL in</th><th>Sells</th><th>SOL out ≈</th><th>Next</th><th>Last error</th><th></th></tr></thead>
          <tbody id="positions"></tbody>
        </table>
      </div>
    </section>

    <div class="grid">
      <section class="card">
        <h2>Manual trigger</h2>
        <label for="m-ca">Contract address</label>
        <input id="m-ca" class="mono" placeholder="Token mint address">
        <div class="hint">Runs the full flow for real: funding transfer, then buys after the delay.</div>
        <div class="actions"><button class="primary" id="m-fire">Fire trigger</button></div>
      </section>
      <section class="card">
        <h2>Advanced</h2>
        <div class="row">
          <div><label for="s-slip">Slippage %</label><input id="s-slip" type="number" min="0.1" max="50" step="0.1"></div>
          <div><label for="s-reserve">Keep back (SOL)</label><input id="s-reserve" type="number" min="0.003" step="0.001"></div>
        </div>
        <div class="row">
          <div><label for="s-swapfee">Max swap priority fee (SOL)</label><input id="s-swapfee" type="number" min="0" step="0.0001"></div>
          <div><label for="s-xferfee">Transfer priority (µlamports/CU)</label><input id="s-xferfee" type="number" min="0" step="1000"></div>
        </div>
        <div class="hint">"Keep back" stays in each trading wallet on a buy, for fees and the token account.</div>
        <div class="actions"><button class="primary" data-save="advanced">Save</button></div>
      </section>
    </div>

    <section class="card">
      <h2>Triggers</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Received</th><th>Contract</th><th>Source</th><th>Funding</th><th>Buys at</th><th>Note</th></tr></thead>
          <tbody id="triggers"></tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2>Activity</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Wallet</th><th>Amount</th><th>Status</th><th>Tx</th><th>Error</th></tr></thead>
          <tbody id="activity"></tbody>
        </table>
      </div>
    </section>
  </main>
</div>

<dialog id="wallet-dialog">
  <form method="dialog" id="wallet-form">
    <h2 style="margin-top:0;font-size:16px" id="wd-title">Add trading wallet</h2>
    <div id="wd-key-block">
      <div class="tabs">
        <button type="button" data-mode="import" class="active">Import private key</button>
        <button type="button" data-mode="generate">Generate new</button>
      </div>
      <div id="wd-import">
        <label for="wd-key">Private key (base58 or JSON byte array)</label>
        <textarea id="wd-key" autocomplete="off" spellcheck="false"></textarea>
        <div class="hint">Encrypted at rest; never shown again.</div>
      </div>
      <div id="wd-generate" class="hidden hint">A fresh wallet is created. Its private key is shown once so you can back it up.</div>
    </div>
    <label for="wd-label">Name</label>
    <input id="wd-label" maxlength="60" required>
    <div id="wd-trading">
      <div class="row">
        <div><label for="wd-buy">Buy: % of SOL balance</label><input id="wd-buy" type="number" min="0.01" max="100" step="0.01" required></div>
      </div>
      <div class="row">
        <div><label for="wd-sell">Sell: % of token holding</label><input id="wd-sell" type="number" min="0" max="100" step="0.01" required></div>
        <div><label for="wd-interval">Every (hours)</label><input id="wd-interval" type="number" min="0.01" step="0.01" required></div>
      </div>
      <div class="hint">Sell 0% = hold. Each interval sells that % of whatever the wallet still holds.</div>
      <label class="toggle" style="margin-top:10px"><input type="checkbox" id="wd-enabled" checked> Enabled (buys on new triggers, sells on schedule)</label>
    </div>
    <div class="actions" style="justify-content:flex-end">
      <button type="button" id="wd-cancel">Cancel</button>
      <button class="primary" type="submit" id="wd-submit">Save</button>
    </div>
  </form>
</dialog>

<dialog id="secret-dialog">
  <h2 style="margin-top:0;font-size:16px">Back up this private key</h2>
  <p class="muted">This is the only time it will be shown. Anyone with it controls the wallet.</p>
  <div class="secret mono" id="secret-value"></div>
  <p class="mono" id="secret-address"></p>
  <div class="actions" style="justify-content:flex-end">
    <button id="secret-copy">Copy</button>
    <button class="primary" id="secret-done">I saved it</button>
  </div>
</dialog>

<div id="toast"></div>

<script>
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (a) => a ? esc(a.slice(0, 4) + '…' + a.slice(-4)) : '';
  const solscan = (kind, v) => 'https://solscan.io/' + kind + '/' + encodeURIComponent(v);
  const addr = (a) => a ? '<a class="mono" target="_blank" rel="noopener noreferrer" href="' + solscan('account', a) + '" title="' + esc(a) + '">' + short(a) + '</a>' : '<span class="muted">—</span>';
  const token = (a) => '<a class="mono" target="_blank" rel="noopener noreferrer" href="https://dexscreener.com/solana/' + encodeURIComponent(a) + '" title="' + esc(a) + '">' + short(a) + '</a>';
  const time = (ms) => ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  const until = (ms, now) => {
    if (!ms) return '—';
    const d = ms - now;
    if (d <= 0) return 'now';
    const m = Math.round(d / 60000);
    return m < 60 ? 'in ' + m + 'm' : 'in ' + (m / 60).toFixed(1) + 'h';
  };
  const pill = (s) => {
    const cls = { confirmed: 'ok', holding: 'ok', closed: 'ok', active: 'ok', sent: 'warn', pending: 'warn', waiting: 'warn', buying: 'warn', selling: 'warn', failed: 'bad', expired: 'bad', ignored: 'bad' }[s] || '';
    return '<span class="pill ' + cls + '">' + esc(s) + '</span>';
  };

  let state = null;
  const selected = new Set();

  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = bad ? 'bad' : '';
    t.style.display = 'block';
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.style.display = 'none'), bad ? 6000 : 3000);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Log in first'); }
    if (!res.ok) {
      const d = data.error && data.error.details;
      const detail = d && typeof d === 'object' ? ' — ' + Object.entries(d).map(([k, v]) => k + ': ' + v).join('; ') : '';
      throw new Error(((data.error && data.error.message) || 'Request failed') + detail);
    }
    return data;
  }

  function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#pw').focus(); }
  function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); }

  function fillSettings(s) {
    $('#s-initial').value = s.initialReceiver || '';
    $('#s-amount').value = s.initialAmountSol;
    $('#s-delay').value = s.buyDelayMinutes;
    $('#s-final').value = s.finalReceiver || '';
    $('#s-slip').value = s.slippageBps / 100;
    $('#s-reserve').value = s.feeReserveSol;
    $('#s-swapfee').value = s.swapMaxPriorityFeeLamports / 1e9;
    $('#s-xferfee').value = s.transferPriorityMicroLamports;
  }

  function render() {
    const s = state;
    const t = $('#triggers-toggle');
    t.classList.toggle('on', s.settings.triggersEnabled);
    $('#triggers-label').textContent = s.settings.triggersEnabled ? 'Triggers ON' : 'Triggers PAUSED';

    const f = s.wallets.find((w) => w.role === 'funding');
    $('#funding').innerHTML = f
      ? '<div class="row" style="align-items:center"><div><div class="big">' + esc(f.balanceSol ?? '?') + ' SOL</div>' + addr(f.address) + '</div>' +
        '<label class="toggle" style="flex:0 0 auto;margin:0"><input type="checkbox" data-select="' + esc(f.id) + '"' + (selected.has(f.id) ? ' checked' : '') + '> include in sweep</label>' +
        '<button data-replace-funding>Replace key</button><button class="danger" data-remove="' + esc(f.id) + '">Remove</button></div>'
      : '<div class="row" style="align-items:center"><span class="muted">No funding wallet yet.</span><button class="primary" data-replace-funding>Add funding wallet key</button></div>';

    const traders = s.wallets.filter((w) => w.role === 'trading');
    $('#wallets').innerHTML = traders.length ? traders.map((w) =>
      '<tr><td><input type="checkbox" data-select="' + esc(w.id) + '"' + (selected.has(w.id) ? ' checked' : '') + '></td>' +
      '<td>' + esc(w.label) + '</td><td>' + addr(w.address) + '</td>' +
      '<td>' + esc(w.balanceSol ?? '?') + '</td>' +
      '<td>' + esc(w.buyPct) + '%</td><td>' + esc(w.sellPct) + '%</td><td>' + esc(w.sellIntervalHours) + 'h</td>' +
      '<td>' + (w.enabled ? pill('active') : '<span class="pill">disabled</span>') + '</td>' +
      '<td><button class="small" data-edit="' + esc(w.id) + '">Edit</button> <button class="small danger" data-remove="' + esc(w.id) + '">Remove</button></td></tr>'
    ).join('') : '<tr><td colspan="9" class="muted">No trading wallets yet. Add one to start buying on triggers.</td></tr>';

    for (const id of [...selected]) if (!s.wallets.some((w) => w.id === id)) selected.delete(id);
    const all = s.wallets.length > 0 && s.wallets.every((w) => selected.has(w.id));
    $('#select-all').checked = all;
    updateSweep();

    $('#positions').innerHTML = s.positions.length ? s.positions.map((p) =>
      '<tr><td>' + esc(p.wallet) + '</td><td>' + token(p.contractAddress) + '</td><td>' + pill(p.status) + '</td>' +
      '<td>' + esc(p.solSpent) + '</td><td>' + esc(p.sells) + '</td><td>' + esc(p.solReceived) + '</td>' +
      '<td>' + (['waiting', 'holding'].includes(p.status) ? until(p.nextActionAt || (p.status === 'waiting' ? (s.triggers.find((t) => t.id === p.triggerId) || {}).buysAt : null), s.now) : '—') + '</td>' +
      '<td class="wrap muted">' + esc(p.lastError || '') + '</td>' +
      '<td>' + (p.status === 'holding' ? '<button class="small" data-sellnow="' + esc(p.id) + '">Sell all now</button> ' : '') +
      (['waiting', 'holding'].includes(p.status) ? '<button class="small danger" data-cancel="' + esc(p.id) + '">Stop</button>' : '') + '</td></tr>'
    ).join('') : '<tr><td colspan="9" class="muted">Nothing yet.</td></tr>';

    $('#triggers').innerHTML = s.triggers.length ? s.triggers.map((t) =>
      '<tr><td>' + time(t.receivedAt) + '</td><td>' + token(t.contractAddress) + '</td><td>' + esc(t.source) + '</td>' +
      '<td>' + pill(t.funding) + (t.fundingSol ? ' <span class="muted">' + esc(t.fundingSol) + ' SOL</span>' : '') + '</td>' +
      '<td>' + (t.status === 'ignored' ? pill('ignored') : time(t.buysAt)) + '</td><td class="wrap muted">' + esc(t.note || '') + '</td></tr>'
    ).join('') : '<tr><td colspan="6" class="muted">No triggers yet.</td></tr>';

    $('#activity').innerHTML = s.activity.length ? s.activity.map((a) => {
      const amount = a.kind === 'buy' ? esc(a.amountIn) + ' SOL → ' + esc(a.expectedOut ?? '?') + ' tokens'
        : a.kind === 'sell' ? esc(a.amountIn) + ' tokens → ≈' + esc(a.expectedOut ?? '?') + ' SOL'
        : esc(a.amountIn) + ' SOL → ' + short(a.to);
      return '<tr><td>' + time(a.createdAt) + '</td><td>' + esc(a.kind) + '</td><td>' + esc(a.wallet) + '</td><td>' + amount + '</td>' +
        '<td>' + pill(a.status) + '</td><td><a class="mono" target="_blank" rel="noopener noreferrer" href="' + solscan('tx', a.signature) + '">' + short(a.signature) + '</a></td>' +
        '<td class="wrap muted">' + esc(a.error || '') + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">No transactions yet.</td></tr>';
  }

  function updateSweep() {
    if (!state) return;
    const picked = state.wallets.filter((w) => selected.has(w.id));
    const total = picked.reduce((n, w) => n + Number(w.balanceSol || 0), 0);
    $('#sweep-btn').disabled = picked.length === 0;
    $('#sweep-info').textContent = picked.length
      ? picked.length + ' wallet(s), ≈' + total.toFixed(4) + ' SOL → ' + (state.settings.finalReceiver ? state.settings.finalReceiver.slice(0, 4) + '…' + state.settings.finalReceiver.slice(-4) : 'no final receiver set')
      : 'Tick wallets (or the header box for all) to sweep.';
  }

  async function load(first) {
    try {
      state = await api('GET', '/api/state');
      showApp();
      if (first) fillSettings(state.settings);
      render();
    } catch (e) {
      if (!first) toast(e.message, true);
    }
  }

  async function saveSettings(patch, msg) {
    try {
      const r = await api('PUT', '/api/settings', patch);
      state.settings = r.settings;
      fillSettings(r.settings);
      render();
      toast(msg || 'Saved');
    } catch (e) { toast(e.message, true); }
  }

  // ---- login
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/login', { password: $('#pw').value });
      $('#pw').value = '';
      await load(true);
    } catch (err) { toast(err.message, true); }
  });
  $('#logout').addEventListener('click', async () => { await api('POST', '/api/logout', {}).catch(() => {}); showLogin(); });
  $('#refresh').addEventListener('click', () => load(false));

  // ---- settings
  const toggle = () => saveSettings({ triggersEnabled: !state.settings.triggersEnabled }, 'Updated');
  $('#triggers-toggle').addEventListener('click', toggle);
  $('#triggers-toggle').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  const num = (sel) => Number($(sel).value);
  document.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.save;
    if (k === 'initial') saveSettings({ initialReceiver: $('#s-initial').value, initialAmountSol: num('#s-amount') });
    if (k === 'delay') saveSettings({ buyDelayMinutes: num('#s-delay') });
    if (k === 'final') saveSettings({ finalReceiver: $('#s-final').value });
    if (k === 'advanced') saveSettings({
      slippageBps: Math.round(num('#s-slip') * 100),
      feeReserveSol: num('#s-reserve'),
      swapMaxPriorityFeeLamports: Math.round(num('#s-swapfee') * 1e9),
      transferPriorityMicroLamports: Math.round(num('#s-xferfee')),
    });
  }));
  document.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Delete this receiver?')) return;
    saveSettings(b.dataset.clear === 'initial' ? { initialReceiver: '' } : { finalReceiver: '' }, 'Receiver removed');
  }));

  // ---- wallets dialog
  const dlg = $('#wallet-dialog');
  let dlgMode = { kind: 'add-trading', id: null, keyMode: 'import' };
  function setKeyMode(m) {
    dlgMode.keyMode = m;
    document.querySelectorAll('#wd-key-block .tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    $('#wd-import').classList.toggle('hidden', m !== 'import');
    $('#wd-generate').classList.toggle('hidden', m !== 'generate');
  }
  document.querySelectorAll('#wd-key-block .tabs button').forEach((b) => b.addEventListener('click', () => setKeyMode(b.dataset.mode)));
  function openDialog(kind, w) {
    dlgMode = { kind, id: w ? w.id : null, keyMode: 'import' };
    setKeyMode('import');
    $('#wd-key').value = '';
    $('#wd-title').textContent = kind === 'edit' ? 'Edit ' + w.label : kind === 'funding' ? 'Funding wallet' : 'Add trading wallet';
    $('#wd-key-block').classList.toggle('hidden', kind === 'edit');
    $('#wd-trading').classList.toggle('hidden', kind === 'funding');
    const last = state.wallets.filter((x) => x.role === 'trading').slice(-1)[0];
    const src = w || last;
    $('#wd-label').value = w ? w.label : kind === 'funding' ? 'Funding wallet' : 'Wallet ' + (state.wallets.filter((x) => x.role === 'trading').length + 1);
    $('#wd-buy').value = src ? src.buyPct : 50;
    $('#wd-sell').value = src ? src.sellPct : 25;
    $('#wd-interval').value = src ? src.sellIntervalHours : 1;
    $('#wd-enabled').checked = w ? w.enabled : true;
    ['#wd-buy', '#wd-sell', '#wd-interval'].forEach((s) => ($(s).required = kind !== 'funding'));
    dlg.showModal();
  }
  $('#add-wallet').addEventListener('click', () => openDialog('add-trading'));
  $('#wd-cancel').addEventListener('click', () => dlg.close());
  $('#wallet-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const trading = { label: $('#wd-label').value, buyPct: num('#wd-buy'), sellPct: num('#wd-sell'), sellIntervalHours: num('#wd-interval'), enabled: $('#wd-enabled').checked };
    const key = dlgMode.keyMode === 'import' ? { secretKey: $('#wd-key').value.trim() } : { generate: true };
    if (dlgMode.kind !== 'edit' && dlgMode.keyMode === 'import' && !key.secretKey) return toast('Paste the private key', true);
    try {
      let r;
      if (dlgMode.kind === 'edit') r = await api('PATCH', '/api/wallets/' + encodeURIComponent(dlgMode.id), trading);
      else if (dlgMode.kind === 'funding') {
        if (state.wallets.some((w) => w.role === 'funding') && !confirm('Replace the current funding wallet? Sweep it first if it still holds SOL.')) return;
        r = await api('POST', '/api/wallets', { role: 'funding', label: $('#wd-label').value, ...key });
      } else r = await api('POST', '/api/wallets', { role: 'trading', ...trading, ...key });
      $('#wd-key').value = '';
      dlg.close();
      await load(false);
      if (r.generatedSecret) {
        $('#secret-value').textContent = r.generatedSecret;
        $('#secret-address').textContent = 'Address: ' + r.wallet.address;
        $('#secret-dialog').showModal();
      }
      toast('Saved');
    } catch (err) { toast(err.message, true); }
  });
  $('#secret-copy').addEventListener('click', () => navigator.clipboard.writeText($('#secret-value').textContent).then(() => toast('Copied')));
  $('#secret-done').addEventListener('click', () => { $('#secret-value').textContent = ''; $('#secret-dialog').close(); });

  // ---- delegated table actions
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !state) return;
    try {
      if (b.hasAttribute('data-replace-funding')) return openDialog('funding');
      if (b.dataset.edit) return openDialog('edit', state.wallets.find((w) => w.id === b.dataset.edit));
      if (b.dataset.remove) {
        const w = state.wallets.find((x) => x.id === b.dataset.remove);
        if (!confirm('Remove ' + w.label + '? It holds ' + (w.balanceSol ?? '?') + ' SOL; sweep it first. Its open positions stop.')) return;
        await api('POST', '/api/wallets/' + encodeURIComponent(w.id) + '/remove', {});
        toast('Removed'); return load(false);
      }
      if (b.dataset.sellnow) {
        if (!confirm('Sell 100% of this position now?')) return;
        await api('POST', '/api/positions/' + encodeURIComponent(b.dataset.sellnow) + '/sell-now', { pct: 100 });
        toast('Queued; sells on the next tick'); return load(false);
      }
      if (b.dataset.cancel) {
        if (!confirm('Stop this position? Tokens already bought stay in the wallet.')) return;
        await api('POST', '/api/positions/' + encodeURIComponent(b.dataset.cancel) + '/cancel', {});
        toast('Stopped'); return load(false);
      }
    } catch (err) { toast(err.message, true); }
  });
  document.addEventListener('change', (e) => {
    const c = e.target;
    if (c.dataset && c.dataset.select) { c.checked ? selected.add(c.dataset.select) : selected.delete(c.dataset.select); render(); }
  });
  $('#select-all').addEventListener('change', (e) => {
    if (e.target.checked) state.wallets.forEach((w) => selected.add(w.id)); else selected.clear();
    render();
  });

  // ---- sweep
  $('#sweep-btn').addEventListener('click', async () => {
    if (!state.settings.finalReceiver) return toast('Set a final receiver first', true);
    const picked = state.wallets.filter((w) => selected.has(w.id));
    if (!confirm('Send ALL SOL from ' + picked.map((w) => w.label).join(', ') + ' to ' + state.settings.finalReceiver + '?')) return;
    $('#sweep-btn').disabled = true;
    try {
      const r = await api('POST', '/api/sweep', { walletIds: picked.map((w) => w.id) });
      const lines = r.results.map((x) => x.label + ': ' + x.status + (x.reason ? ' (' + x.reason + ')' : ''));
      toast(lines.join(' · '), r.results.some((x) => x.status === 'failed'));
      selected.clear();
      load(false);
    } catch (err) { toast(err.message, true); updateSweep(); }
  });

  // ---- manual trigger
  $('#m-fire').addEventListener('click', async () => {
    const ca = $('#m-ca').value.trim();
    if (!ca) return toast('Enter a contract address', true);
    if (!confirm('Fire a real trigger for ' + ca + '? This sends SOL and buys.')) return;
    try {
      const r = await api('POST', '/api/trigger', { contractAddress: ca });
      toast('Trigger ' + r.status + ': ' + r.scheduledBuys + ' buy(s) scheduled' + (r.note ? ' — ' + r.note : ''));
      $('#m-ca').value = '';
      load(false);
    } catch (err) { toast(err.message, true); }
  });

  load(true).then(() => { if (!state) showLogin(); });
  setInterval(() => { if (state && !document.hidden && !dlg.open) load(false); }, 10000);
})();
</script>
</body>
</html>
`;
