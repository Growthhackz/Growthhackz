const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LAMPORTS = 1e9;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401) {
    location.replace('/login.html');
    throw new Error('login required');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const walletUrl = (label, suffix = '') => `/api/wallets/${encodeURIComponent(label)}${suffix}`;

let wallets = [];
let balances = {};
let receiver = null;
let minInterval = 1;
const VENUE_LABEL = { raydium: 'Raydium', pumpswap: 'PumpSwap', meteora: 'Meteora', pumpfun: 'pump.fun' };

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
      if (b.emptyAccounts > 0) {
        const reclaim = el('button', {
          className: 'link small',
          textContent: `Reclaim ${fmt(b.reclaimableSol, 4)} SOL`,
          title: `close ${b.emptyAccounts} empty or wrapped-SOL account${b.emptyAccounts > 1 ? 's' : ''} for the rent`
        });
        reclaim.onclick = () => reclaimRent(w, reclaim);
        bal.append(el('div', {}, reclaim));
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
      btn('Clone', () => openClone(w)),
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

async function reclaimRent(w, btn) {
  btn.disabled = true;
  btn.textContent = 'Reclaiming…';
  try {
    const r = await api(walletUrl(w.label, '/reclaim'), { method: 'POST' });
    toast(r.failed.length
      ? `closed ${r.closed}, ${r.failed.length} could not close (see Log)`
      : `closed ${r.closed} account${r.closed === 1 ? '' : 's'}, ${fmt(r.reclaimedSol, 6)} SOL back`, r.failed.length > 0);
  } catch (e) {
    toast(e.message, true);
  }
  await refresh();
}

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
  f('amountMax').value = rule.amountMax ?? '';
  f('triggerType').value = rule.trigger?.type ?? 'priceBelow';
  f('triggerValue').value = rule.trigger
    ? (rule.trigger.type === 'interval' ? rule.trigger.minutes : rule.trigger.price)
    : '';
  f('triggerMax').value = rule.trigger?.maxMinutes ?? '';
  f('repeat').checked = rule.repeat ?? false;
  f('maxRuns').value = rule.maxRuns ?? '';
  f('runs').textContent = rule.runs ? `ran ${rule.runs}×` : '';

  const syncTrigger = () => {
    const isInterval = f('triggerType').value === 'interval';
    f('triggerValue').placeholder = isInterval ? `≥ ${minInterval} min` : 'SOL per token';
    f('triggerValue').min = isInterval ? String(minInterval) : '0';
    f('repeat').closest('label').hidden = isInterval;
    f('triggerMax').hidden = !isInterval;
    f('toLabel').hidden = !isInterval;
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
      amountMax: f('amountMax').value === '' ? null : Number(f('amountMax').value),
      trigger: type === 'interval'
        ? { type, minutes: v, maxMinutes: f('triggerMax').value === '' ? null : Number(f('triggerMax').value) }
        : { type, price: v },
      repeat: f('repeat').checked,
      maxRuns: f('maxRuns').value === '' ? null : Number(f('maxRuns').value)
    };
  });
}

$('#add-rule').onclick = () => rulesBox.append(ruleRow());

const VENUE_HELP = {
  raydium: ['Raydium AMM v4, CPMM or CLMM pool address',
    'Trades go straight to this Raydium pool. The pool type is detected automatically; it must be paired with SOL.'],
  pumpswap: ["blank = the token's graduated PumpSwap pool",
    'Trades go straight to the PumpSwap pool. Leave the pool blank to use the canonical pool for the mint.'],
  meteora: ['Meteora DLMM pool address',
    'Trades go straight to this Meteora DLMM pool. It must be paired with SOL.'],
  pumpfun: ['derived from the token mint',
    "Trades go to the token's pump.fun bonding curve. Once the token graduates, switch this wallet to PumpSwap."]
};

function syncVenue() {
  const v = manageForm.venue.value;
  const [placeholder, hint] = VENUE_HELP[v];
  manageForm.pool.placeholder = placeholder;
  manageForm.pool.disabled = v === 'pumpfun';
  if (v === 'pumpfun') manageForm.pool.value = '';
  manageForm.mint.placeholder = v === 'pumpfun' ? 'token mint (required)' : 'filled in from the pool if left blank';
  $('#venue-hint').textContent = hint;
}
manageForm.venue.onchange = syncVenue;

function syncPriority() {
  $('#priority-label').textContent = manageForm.priorityMode.value === 'auto'
    ? 'Max µlamports per CU' : 'µlamports per CU';
}
manageForm.priorityMode.onchange = syncPriority;

function openManage(w) {
  managing = w;
  $('.dlg-label', manageDialog).textContent = w.label;
  manageForm.venue.value = w.settings.venue;
  manageForm.pool.value = w.settings.pool ?? '';
  manageForm.mint.value = w.settings.mint ?? '';
  manageForm.slippageBps.value = w.settings.slippageBps;
  manageForm.priorityMode.value = w.settings.priorityMode;
  manageForm.priorityMicroLamports.value = w.settings.priorityMicroLamports;
  manageForm.closeEmptyAccounts.checked = w.settings.closeEmptyAccounts;
  syncVenue();
  syncPriority();
  manageForm.solFloor.value = (w.settings.solFloorLamports / LAMPORTS).toFixed(3);
  rulesBox.replaceChildren(...w.rules.map(ruleRow));
  manageDialog.showModal();
}

manageForm.onsubmit = async (e) => {
  e.preventDefault();
  if (!managing) return;
  const patch = {
    venue: manageForm.venue.value,
    pool: manageForm.venue.value === 'pumpfun' ? null : (manageForm.pool.value.trim() || null),
    mint: manageForm.mint.value.trim() || null,
    slippageBps: Number(manageForm.slippageBps.value),
    priorityMode: manageForm.priorityMode.value,
    priorityMicroLamports: Number(manageForm.priorityMicroLamports.value),
    closeEmptyAccounts: manageForm.closeEmptyAccounts.checked,
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

// ---- clone ------------------------------------------------------------------

const cloneDialog = $('#clone-dialog');
const cloneForm = $('#clone-form');
let cloning = null;

function openClone(w) {
  cloning = w;
  $('.dlg-label', cloneDialog).textContent = w.label;
  cloneForm.reset();
  cloneForm.prefix.value = `${w.label}-`;
  $('#clone-result').replaceChildren();
  const others = wallets.filter((x) => x.label !== w.label);
  $('#clone-targets').replaceChildren(...(others.length
    ? others.map((x) => el('label', { className: 'check' },
      el('input', { type: 'checkbox', value: x.label }),
      el('span', { textContent: `${x.label} ` }),
      el('span', { className: 'muted small', textContent: x.settings.mint ? `· ${VENUE_LABEL[x.settings.venue]} ${short(x.settings.mint)}` : '· not set up' })))
    : [el('p', { className: 'muted small', textContent: 'No other wallets yet.' })]));
  $('#clone-submit').disabled = false;
  cloneDialog.showModal();
}

cloneForm.onsubmit = async (e) => {
  e.preventDefault();
  if (!cloning) return;
  const targets = $$('#clone-targets input:checked').map((i) => i.value);
  const body = { targets, create: { count: Number(cloneForm.count.value || 0), prefix: cloneForm.prefix.value.trim() } };
  const submit = $('#clone-submit');
  submit.disabled = true;
  try {
    const r = await api(walletUrl(cloning.label, '/clone'), { method: 'POST', body });
    const out = [];
    if (r.updated.length) out.push(el('p', { textContent: `Updated: ${r.updated.join(', ')}` }));
    if (r.created.length) {
      out.push(el('p', { textContent: `Created ${r.created.length} wallet${r.created.length > 1 ? 's' : ''}. Fund these addresses:` }));
      for (const c of r.created) {
        const code = el('code', { textContent: c.pubkey, title: 'click to copy' });
        code.onclick = () => navigator.clipboard.writeText(c.pubkey).then(() => toast('address copied'), () => {});
        out.push(el('div', { className: 'clone-new' }, el('span', { textContent: `${c.label} ` }), code));
      }
    }
    $('#clone-result').replaceChildren(...out);
    toast('cloned');
    await refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    submit.disabled = false;
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
  if (entry.type === 'reclaim') {
    li.append(el('strong', { textContent: `Reclaimed rent: ${entry.closed} closed, ${fmt(entry.reclaimedSol, 6)} SOL` }), ` · ${when}`);
    for (const f of entry.failed ?? []) {
      li.append(el('div', { className: 'small error', textContent: `✗ ${short(f.account)}: ${f.error}` }));
    }
    return li;
  }
  const what = entry.ok
    ? `${entry.side} ${fmt(entry.in)} → ${fmt(entry.out)}`
    : `${entry.side} ${entry.amount} ${entry.amountType} failed: ${entry.error}`;
  const costs = [
    entry.feeSol != null ? `fee ${fmt(entry.feeSol, 6)} SOL (${entry.cu?.toLocaleString()} CU at ${entry.microLamports?.toLocaleString()} µL)` : null,
    entry.rentReclaimed ? 'token account closed, rent returned' : null
  ].filter(Boolean).join(' · ');
  li.append(el('strong', { textContent: what }), ` · ${when}`,
    el('div', { className: 'muted small', textContent: entry.reason }),
    costs ? el('div', { className: 'muted small', textContent: costs }) : null);
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

const logout = $('#logout');
api('/api/session').then(({ auth }) => { logout.hidden = !auth; }).catch(() => {});
logout.onclick = async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login.html');
};

refresh().catch((e) => toast(e.message, true));
setInterval(refresh, 30_000);
