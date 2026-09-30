const $ = (s, r = document) => r.querySelector(s);
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

const short = (a) => a.slice(0, 4) + '…' + a.slice(-4);

function toast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

async function refresh() {
  try {
    wallets = await api('/api/wallets');
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

function cell(text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function render() {
  const tbody = $('#wallets tbody');
  tbody.replaceChildren();
  $('#empty').hidden = wallets.length > 0;

  for (const w of wallets) {
    const b = balances[w.label];
    const tr = document.createElement('tr');

    tr.append(cell(w.label));

    const addr = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = short(w.pubkey);
    code.title = w.pubkey;
    code.onclick = () => {
      navigator.clipboard.writeText(w.pubkey);
      toast('address copied');
    };
    addr.append(code);
    tr.append(addr);

    const bal = document.createElement('td');
    if (!b) {
      bal.textContent = '…';
      bal.className = 'muted';
    } else if (b.error) {
      bal.textContent = 'error';
      bal.className = 'error';
    } else {
      bal.textContent = `${b.sol.toFixed(6)} SOL`;
      if (b.tokenAccounts > 0) {
        const t = document.createElement('span');
        t.className = 'muted small';
        t.textContent = ` · ${b.tokenAccounts} token acct${b.tokenAccounts > 1 ? 's' : ''}`;
        bal.append(t);
      }
    }
    tr.append(bal);

    tr.append(cell(`${w.settings.spendPct}%`));
    tr.append(cell(`${w.settings.sellPct}%`));
    tr.append(cell(String(w.settings.tradeCount)));

    const actions = document.createElement('td');
    actions.className = 'actions';

    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.onclick = () => openSettings(w);
    actions.append(edit);

    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'danger';
    del.onclick = () => removeWallet(w, b);
    actions.append(del);

    tr.append(actions);
    tbody.append(tr);
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

const dialog = $('#settings-dialog');
const form = $('#settings-form');
let editing = null;

function openSettings(w) {
  editing = w;
  $('#settings-label').textContent = w.label;
  form.spendPct.value = w.settings.spendPct;
  form.sellPct.value = w.settings.sellPct;
  form.tradeCount.value = w.settings.tradeCount;
  form.slippageBps.value = w.settings.slippageBps;
  form.solFloor.value = (w.settings.solFloorLamports / LAMPORTS).toFixed(3);
  form.useBundles.checked = w.settings.useBundles;
  dialog.showModal();
}

form.onsubmit = async (e) => {
  if (e.submitter?.value === 'cancel' || !editing) return;
  e.preventDefault();
  const fd = new FormData(form);
  const patch = {
    spendPct: Number(fd.get('spendPct')),
    sellPct: Number(fd.get('sellPct')),
    tradeCount: Number(fd.get('tradeCount')),
    slippageBps: Number(fd.get('slippageBps')),
    solFloorLamports: Math.round(Number(fd.get('solFloor')) * LAMPORTS),
    useBundles: form.useBundles.checked
  };
  try {
    await api(walletUrl(editing.label), { method: 'PATCH', body: patch });
    dialog.close();
    await refresh();
    toast('settings saved');
  } catch (err) {
    toast(err.message, true);
  }
};

async function removeWallet(w, b) {
  if (b && !b.error && b.lamports > 0) return toast('wallet still holds SOL', true);
  if (b && !b.error && b.tokenAccounts > 0) return toast('close token accounts first', true);
  if (!confirm(`Delete "${w.label}"? The keypair becomes unrecoverable.`)) return;
  try {
    await api(walletUrl(w.label), { method: 'DELETE' });
    await refresh();
    toast('deleted');
  } catch (err) {
    toast(err.message, true);
  }
}

refresh().catch((e) => toast(e.message, true));
setInterval(refresh, 30_000);
