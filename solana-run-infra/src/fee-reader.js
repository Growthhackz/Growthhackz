import { PublicKey } from '@solana/web3.js';
import { BorshCoder } from '@coral-xyz/anchor';

// Decodes Anchor events from "Program data:" log lines using whatever IDL you
// pass in, so no discriminator or struct layout is hardcoded.
function decodeEvents(tx, coder) {
  const out = [];
  for (const line of tx.meta?.logMessages ?? []) {
    const prefix = 'Program data: ';
    if (!line.startsWith(prefix)) continue;
    try {
      const ev = coder.events.decode(line.slice(prefix.length));
      if (ev) out.push(ev);
    } catch { /* not an event this IDL knows */ }
  }
  return out;
}

function toRow(ev, { signature, blockTime, slot, pool }) {
  const d = ev.data ?? ev;
  const num = (v) => (v == null ? null : (v.toString?.() ?? String(v)));
  return {
    signature, slot, blockTime, pool,
    name: ev.name,
    amountIn: num(d.amountIn),
    amountOut: num(d.amountOut),
    fee: num(d.fee),
    protocolFee: num(d.protocolFee),
    feeBps: num(d.feeBps ?? d.baseFeeBps),
    volatilityAccumulator: num(d.volatilityAccumulator),
    activeBinId: num(d.activeBinId)
  };
}

const SWAP_EVENT_NAMES = new Set(['Swap', 'SwapEvent', 'swap', 'swapEvent']);

export async function collectSwapEvents(connection, idl, {
  poolAddress, limit = 1000, before, until
} = {}) {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
  const coder = new BorshCoder(idl);
  const pool = new PublicKey(poolAddress);
  const rows = [];

  let cursor = before;
  while (rows.length < limit) {
    const page = Math.min(1000, limit - rows.length);
    const sigs = await connection.getSignaturesForAddress(
      pool, { limit: page, before: cursor }, 'confirmed'
    );
    if (sigs.length === 0) break;

    for (const { signature, blockTime, slot, err } of sigs) {
      if (err) continue;
      if (until && blockTime && blockTime < until) return rows;

      let tx;
      try {
        tx = await connection.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed'
        });
      } catch {
        continue; // transaction version this client can't decode
      }
      if (!tx) continue;

      for (const ev of decodeEvents(tx, coder)) {
        if (!SWAP_EVENT_NAMES.has(ev.name)) continue;
        rows.push(toRow(ev, { signature, blockTime, slot, pool: poolAddress }));
        if (rows.length >= limit) return rows;
      }
    }
    cursor = sigs[sigs.length - 1].signature;
  }
  return rows;
}

export function toCsv(rows) {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  return [
    cols.join(','),
    ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))
  ].join('\n');
}
