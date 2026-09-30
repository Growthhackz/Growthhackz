const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LAMPORTS = 1e9;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const walletUrl = (label, suffix = '') => `/api/wallets/${encodeURIComponent(label)}${suffix}`;

let wallets = [];
let balances = {};
let receiver = null;
let minInterval = 1;
const VENUE_LABEL = { raydium: 'Raydium', pumpswap: 'PumpSwap' };

const short = (a) => a.slice(0, 4) + '…' + a.slice(-4);
const fmt = (n, d = 6) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));

function toast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.append(box); }
  box.append(el);
  setTimeout(() => el.remove(), 4000);
}

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
}

// Close buttons on every dialog.
for (const b of $$('[data-close]')) b.onclick = () => b.closest('dialog').close();

// ---- table ----------------------------------------------------------------

async function refresh() {
  try {
    const data = await api('/api/wallets');
    wallets = data.wallets;
    receiver = data.receiver;
    minInterval = data.minIntervalMinutes;
  } catch (e) {
    return toast(e.message, true);
  }
  render();
  const entries = await Promise.all(wallets.map(async (w) => {
    try { return [w.label, await api(walletUrl(w.label, '/balance'))]; }
    catch (e) { return [w.label, { error: e.message }]; }
  }));
  balances = Object.fromEntries(entries);
  render();
}

function render() {
  const tbody = $('#wallets tbody');
  tbody.replaceChildren();
  $('#empty').hidden = wallets.length > 0;

  for (const w of wallets) {
    const b = balances[w.label];
    const s = w.settings;
    const activeRules = w.rules.filter((r) => r.enabled).length;

    const code = el('code', { textContent: short(w.pubkey), title: w.pubkey });
    code.onclick = () => { navigator.clipboard.writeText(w.pubkey); toast('address copied'); };

    const bal = el('td');
    if (!b) bal.append(el('span', { className: 'muted', textContent: '…' }));
    else if (b.error) bal.append(el('span', { className: 'error', textContent: 'error', title: b.error }));
    else {
      bal.append(`${fmt(b.sol)} SOL`);
      if (b.tokens != null) bal.append(el('div', { className: 'small', textContent: `${fmt(b.tokens, 4)} tokens` }));
      if (b.tokenAccounts > 0) {
        bal.append(el('div', {
          className: 'muted small',
          textContent: `${b.tokenAccounts} token acct${b.tokenAccounts > 1 ? 's' : ''}`
        }));
      }
    }

    const mintCell = el('td');
    mintCell.append(el('span', { className: `venue ${s.venue}`, textContent: VENUE_LABEL[s.venue] }), ' ');
    if (s.mint) {
      const m = el('code', { textContent: short(s.mint), title: s.mint });
      m.onclick = () => { navigator.clipboard.writeText(s.mint); toast('mint copied'); };
      mintCell.append(m);
    } else {
      mintCell.append(el('span', { className: 'muted', textContent: 'not set' }));
    }

    const price = w.lastPrice
      ? el('td', { textContent: `${fmt(w.lastPrice.price, 9)} SOL`, title: `as of ${new Date(w.lastPrice.at).toLocaleTimeString()}` })
      : el('td', { className: 'muted', textContent: '—' });

    const toggle = el('button', {
      className: s.running ? 'pill on' : 'pill',
      textContent: s.running ? 'Running' : 'Stopped',
      title: s.running ? 'click to pause automation' : 'click to start automation'
    });
    toggle.onclick = () => setRunning(w, !s.running);
    const auto = el('td', {}, toggle,
      el('div', { className: 'muted small', textContent: `${activeRules}/${w.rules.length} rules on` }));

    const btn = (text, fn, cls) => {
      const x = el('button', { textContent: text, className: cls ?? '' });
      x.onclick = fn;
      return x;
    };
    const actions = el('td', {}, el('div', { className: 'actions' },
      btn('Trade', () => openTrade(w)),
      btn('Manage', () => openManage(w)),
      btn('Log', () => openLog(w)),
      btn('Stop', () => openStop(w), 'stop'),
      btn('Delete', () => removeWallet(w, b), 'danger')
    ));

    tbody.append(el('tr', {},
      el('td', { textContent: w.label }), el('td', {}, code), bal, mintCell, price, auto, actions));
  }
}

async function setRunning(w, running) {
  try {
    await api(walletUrl(w.label), { method: 'PATCH', body: { running } });
    await refresh();
    toast(running ? 'automation started' : 'automation paused');
  } catch (e) {
    toast(e.message, true);
  }
}

$('#create-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = e.target.label;
  try {
    await api('/api/wallets', { method: 'POST', body: { label: input.value } });
    input.value = '';
    await refresh();
    toast('wallet created');
  } catch (err) {
    toast(err.message, true);
  }
};

async function removeWallet(w, b) {
  if (b && !b.error && b.lamports > 0) return toast('wallet still holds SOL — use Stop with sweep first', true);
  if (b && !b.error && b.tokenAccounts > 0) return toast('close token accounts first (Stop does this)', true);
  if (!confirm(`Delete "${w.label}"? The keypair becomes unrecoverable.`)) return;
  try {
    await api(walletUrl(w.label), { method: 'DELETE' });
    await refresh();
    toast('deleted');
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- manual trade ---------------------------------------------------------

const tradeDialog = $('#trade-dialog');
const tradeForm = $('#trade-form');
let trading = null;

const UNITS = {
  buy: [['sol', 'SOL'], ['pctSol', '% of SOL']],
  sell: [['pctToken', '% of tokens'], ['token', 'tokens']]
};

function fillUnits(select, side, keep) {
  select.replaceChildren(...UNITS[side].map(([v, t]) => el('option', { value: v, textContent: t })));
  if (keep && UNITS[side].some(([v]) => v === keep)) select.value = keep;
}

function syncTradeSide() {
  const side = tradeForm.side.value;
  fillUnits(tradeForm.amountType, side);
  const submit = $('#trade-submit');
  submit.textContent = side === 'buy' ? 'Buy' : 'Sell';
  submit.className = side === 'buy' ? 'primary' : 'primary sell';
}
for (const r of $$('input[name=side]', tradeForm)) r.onchange = syncTradeSide;

for (const q of $$('.quick button', tradeForm)) {
  q.onclick = () => {
    tradeForm.amountType.value = tradeForm.side.value === 'buy' ? 'pctSol' : 'pctToken';
    tradeForm.amount.value = q.dataset.pct;
  };
}

function openTrade(w) {
  trading = w;
  $('.dlg-label', tradeDialog).textContent = w.label;
  const b = balances[w.label];
  $('#trade-balances').textContent = b && !b.error
    ? `${fmt(b.sol)} SOL · ${b.tokens == null ? 'no token set' : `${fmt(b.tokens, 4)} tokens`} · SOL floor ${fmt(w.settings.solFloorLamports / LAMPORTS, 4)}`
    : '';
  tradeForm.reset();
  syncTradeSide();
  tradeDialog.showModal();
}

tradeForm.onsubmit = async (e) => {
  e.preventDefault();
  if (!trading) return;
  const submit = $('#trade-submit');
  const body = {
    side: tradeForm.side.value,
    amountType: tradeForm.amountType.value,
    amount: Number(tradeForm.amount.value)
  };
  submit.disabled = true;
  submit.textContent = 'Sending…';
  try {
    const r = await api(walletUrl(trading.label, '/trade'), { method: 'POST', body });
    tradeDialog.close();
    toast(`${r.side === 'buy' ? 'bought' : 'sold'}: ${fmt(r.in)} → ${fmt(r.out)}`);
    await refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    submit.disabled = false;
    syncTradeSide();
  }
};

// ---- settings + rules -----------------------------------------------------

const manageDialog = $('#manage-dialog');
const manageForm = $('#manage-form');
const rulesBox = $('#rules');
let managing = null;

function ruleRow(rule = {}) {
  const row = $('#rule-tpl').content.firstElementChild.cloneNode(true);
  const f = (name) => $(`[data-f="${name}"]`, row);
  row.dataset.id = rule.id ?? '';

  f('enabled').checked = rule.enabled ?? true;
  f('side').value = rule.side ?? 'buy';
  fillUnits(f('amountType'), f('side').value, rule.amountType);
  f('amount').value = rule.amount ?? '';
  f('triggerType').value = rule.trigger?.type ?? 'priceBelow';
  f('triggerValue').value = rule.trigger
    ? (rule.trigger.type === 'interval' ? rule.trigger.minutes : rule.trigger.price)
    : '';
  f('repeat').checked = rule.repeat ?? false;
  f('maxRuns').value = rule.maxRuns ?? '';
  f('runs').textContent = rule.runs ? `ran ${rule.runs}×` : '';

  const syncTrigger = () => {
    const isInterval = f('triggerType').value === 'interval';
    f('triggerValue').placeholder = isInterval ? `≥ ${minInterval} min` : 'SOL per token';
    f('triggerValue').min = isInterval ? String(minInterval) : '0';
    f('repeat').closest('label').hidden = isInterval;
  };
  f('side').onchange = () => fillUnits(f('amountType'), f('side').value, f('amountType').value);
  f('triggerType').onchange = syncTrigger;
  syncTrigger();
  $('[data-remove]', row).onclick = () => row.remove();
  return row;
}

function readRules() {
  return $$('.rule', rulesBox).map((row) => {
    const f = (name) => $(`[data-f="${name}"]`, row);
    const type = f('triggerType').value;
    const v = Number(f('triggerValue').value);
    return {
      ...(row.dataset.id ? { id: row.dataset.id } : {}),
      enabled: f('enabled').checked,
      side: f('side').value,
      amountType: f('amountType').value,
      amount: Number(f('amount').value),
      trigger: type === 'interval' ? { type, minutes: v } : { type, price: v },
      repeat: f('repeat').checked,
      maxRuns: f('maxRuns').value === '' ? null : Number(f('maxRuns').value)
    };
  });
}

$('#add-rule').onclick = () => rulesBox.append(ruleRow());

function syncVenue() {
  const pump = manageForm.venue.value === 'pumpswap';
  manageForm.pool.placeholder = pump
    ? "blank = the token's graduated PumpSwap pool"
    : 'Raydium AMM v4, CPMM or CLMM pool address';
  $('#venue-hint').textContent = pump
    ? 'Trades go straight to the PumpSwap pool. Leave the pool blank to use the canonical pool for the mint.'
    : 'Trades go straight to this Raydium pool. The pool type is detected automatically; it must be paired with SOL.';
}
manageForm.venue.onchange = syncVenue;

function openManage(w) {
  managing = w;
  $('.dlg-label', manageDialog).textContent = w.label;
  manageForm.venue.value = w.settings.venue;
  manageForm.pool.value = w.settings.pool ?? '';
  manageForm.mint.value = w.settings.mint ?? '';
  manageForm.slippageBps.value = w.settings.slippageBps;
  manageForm.priorityMicroLamports.value = w.settings.priorityMicroLamports;
  syncVenue();
  manageForm.solFloor.value = (w.settings.solFloorLamports / LAMPORTS).toFixed(3);
  rulesBox.replaceChildren(...w.rules.map(ruleRow));
  manageDialog.showModal();
}

manageForm.onsubmit = async (e) => {
  e.preventDefault();
  if (!managing) return;
  const patch = {
    venue: manageForm.venue.value,
    pool: manageForm.pool.value.trim() || null,
    mint: manageForm.mint.value.trim() || null,
    slippageBps: Number(manageForm.slippageBps.value),
    priorityMicroLamports: Number(manageForm.priorityMicroLamports.value),
    solFloorLamports: Math.round(Number(manageForm.solFloor.value) * LAMPORTS)
  };
  const rules = readRules();
  try {
    await api(walletUrl(managing.label), { method: 'PATCH', body: patch });
    await api(walletUrl(managing.label, '/rules'), { method: 'PUT', body: { rules } });
    manageDialog.close();
    await refresh();
    toast('saved');
  } catch (err) {
    toast(err.message, true);
  }
};

// ---- log ------------------------------------------------------------------

const logDialog = $('#log-dialog');

function logLine(entry) {
  const when = new Date(entry.at).toLocaleString();
  const li = el('li', { className: entry.ok ? '' : 'failed' });
  if (entry.type === 'emergencyStop') {
    li.append(el('strong', { textContent: 'Emergency stop' }), ` · ${when}`);
    for (const s of entry.report?.steps ?? []) {
      const detail = s.error ?? s.signature ?? (s.closed != null ? `${s.closed} closed` : '') ?? '';
      li.append(el('div', {
        className: 'small' + (s.ok ? ' muted' : ' error'),
        textContent: `${s.ok ? '✓' : '✗'} ${s.name}${s.mint ? ` ${short(s.mint)}` : ''} ${detail}`
      }));
    }
    return li;
  }
  const what = entry.ok
    ? `${entry.side} ${fmt(entry.in)} → ${fmt(entry.out)}`
    : `${entry.side} ${entry.amount} ${entry.amountType} failed: ${entry.error}`;
  li.append(el('strong', { textContent: what }), ` · ${when}`,
    el('div', { className: 'muted small', textContent: entry.reason }));
  if (entry.signature) {
    li.append(el('a', {
      href: `https://solscan.io/tx/${entry.signature}`, target: '_blank', rel: 'noopener',
      className: 'small', textContent: short(entry.signature)
    }));
  }
  return li;
}

async function openLog(w) {
  $('.dlg-label', logDialog).textContent = w.label;
  const list = $('#log-list');
  list.replaceChildren(el('li', { className: 'muted', textContent: 'loading…' }));
  logDialog.showModal();
  try {
    const entries = await api(walletUrl(w.label, '/log'));
    list.replaceChildren(...(entries.length
      ? entries.map(logLine)
      : [el('li', { className: 'muted', textContent: 'no activity yet' })]));
  } catch (e) {
    list.replaceChildren(el('li', { className: 'error', textContent: e.message }));
  }
}

// ---- emergency stop -------------------------------------------------------

const stopDialog = $('#stop-dialog');
const stopForm = $('#stop-form');
let stopping = null; // wallet, or 'all'

function openStop(target) {
  stopping = target;
  $('.dlg-label', stopDialog).textContent = target === 'all' ? 'ALL wallets' : target.label;
  stopForm.reset();
  stopForm.sweep.disabled = !receiver;
  $('#receiver-addr').textContent = receiver ? short(receiver) : '(set RECEIVER_PUBKEY)';
  $('#stop-report').replaceChildren();
  $('#stop-submit').disabled = false;
  $('#stop-submit').textContent = 'Stop now';
  stopDialog.showModal();
}
$('#stop-all').onclick = () => openStop('all');

function reportBlock(r) {
  const box = el('div', { className: 'report' },
    el('strong', { textContent: `${r.label}: ${r.ok ? 'done' : 'finished with problems'}` }));
  if (r.error) box.append(el('div', { className: 'error small', textContent: r.error }));
  for (const s of r.steps ?? []) {
    const detail = s.error
      ?? (s.name === 'cancelRules' ? `${s.cancelled} rule(s) disabled` : '')
      ?? '';
    const extra = s.solOut != null ? `→ ${fmt(s.solOut)} SOL`
      : s.name === 'closeTokenAccounts' ? `${s.closed} closed, ${s.stillOpen} still open`
      : s.sol != null ? `${fmt(s.sol)} SOL sent`
      : '';
    box.append(el('div', {
      className: 'small' + (s.ok ? '' : ' error'),
      textContent: `${s.ok ? '✓' : '✗'} ${s.name}${s.mint ? ` ${short(s.mint)}` : ''} ${extra} ${s.ok ? '' : detail}`.trim()
    }));
  }
  if (r.finalSol != null) box.append(el('div', { className: 'muted small', textContent: `SOL left in wallet: ${fmt(r.finalSol)}` }));
  return box;
}

stopForm.onsubmit = async (e) => {
  e.preventDefault();
  if (!stopping) return;
  const submit = $('#stop-submit');
  submit.disabled = true;
  submit.textContent = 'Stopping…';
  const body = { sweep: stopForm.sweep.checked, burnUnsellable: stopForm.burnUnsellable.checked };
  try {
    const out = stopping === 'all'
      ? await api('/api/emergency-stop', { method: 'POST', body })
      : [await api(walletUrl(stopping.label, '/emergency-stop'), { method: 'POST', body })];
    $('#stop-report').replaceChildren(...out.map(reportBlock));
    submit.textContent = 'Done';
    await refresh();
  } catch (err) {
    toast(err.message, true);
    submit.disabled = false;
    submit.textContent = 'Stop now';
  }
};

refresh().catch((e) => toast(e.message, true));
setInterval(refresh, 30_000);
