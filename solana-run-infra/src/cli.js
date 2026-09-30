import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'node:fs/promises';
import { createWallet, loadWallet, updateSettings, deleteWallet } from './custody.js';
import { FundingWatcher } from './watcher.js';
import { saveState } from './state.js';
import { teardown, recover } from './teardown.js';
import { collectSwapEvents, toCsv } from './fee-reader.js';
import { TradeEngine } from './engine.js';

const RPC = process.env.RPC_URL;
const STORE = process.env.WALLET_DIR ?? './wallets';
const PASS = process.env.WALLET_PASSPHRASE;
const STATE_DIR = './state';

const need = (name, value) => {
  if (!value) throw new Error(`set ${name}`);
  return value;
};

const connection = new Connection(need('RPC_URL', RPC), 'confirmed');
const [cmd, ...args] = process.argv.slice(2);

// Only teardown/recover sweep funds, so only they require a receiver.
const receiver = () => new PublicKey(need('RECEIVER_PUBKEY', process.env.RECEIVER_PUBKEY));

const ctxFor = async (label, { withReceiver = false } = {}) => {
  const { keypair, settings } = await loadWallet({
    label, passphrase: need('WALLET_PASSPHRASE', PASS), storeDir: STORE
  });
  return {
    connection,
    wallet: keypair,
    settings,
    receiver: withReceiver ? receiver() : null,
    statePath: `${STATE_DIR}/${label}.json`
  };
};

const engineFor = ({ withReceiver = false } = {}) => new TradeEngine({
  connection,
  storeDir: STORE,
  passphrase: need('WALLET_PASSPHRASE', PASS),
  logDir: process.env.LOG_DIR ?? './logs',
  receiver: withReceiver ? receiver() : null
});

switch (cmd) {
  case 'wallet:new':
    await fs.mkdir(STORE, { recursive: true, mode: 0o700 });
    console.log(await createWallet({
      label: args[0], passphrase: need('WALLET_PASSPHRASE', PASS), storeDir: STORE
    }));
    break;

  case 'wallet:settings':
    console.log(await updateSettings({
      label: args[0], storeDir: STORE, patch: JSON.parse(args[1])
    }));
    break;

  case 'wallet:rm':
    await deleteWallet({ label: args[0], storeDir: STORE, connection });
    console.log('removed');
    break;

  case 'watch': {
    const ctx = await ctxFor(args[0]);
    await fs.mkdir(STATE_DIR, { recursive: true });
    const watcher = new FundingWatcher({
      connection,
      botPubkey: ctx.wallet.publicKey,
      onFunded: async (ev) => {
        const state = {
          label: args[0],
          phase: 'funded',
          mint: ev.mint,
          fundingSig: ev.signature,
          depositLamports: ev.depositLamports,
          preRunBalance: ev.preRunBalance,
          startedAt: Date.now()
        };
        await saveState(ctx.statePath, state);
        console.log('funded:', ev);
      }
    });
    await watcher.start();
    process.on('SIGINT', async () => { await watcher.stop(); process.exit(0); });
    break;
  }

  case 'recover': {
    const ctx = await ctxFor(args[0], { withReceiver: true });
    console.log(await recover(ctx, { statePath: ctx.statePath }));
    break;
  }

  case 'teardown': {
    const ctx = await ctxFor(args[0], { withReceiver: true });
    console.log(await teardown(ctx, { statePath: ctx.statePath }));
    break;
  }

  // trade <label> <buy|sell> <sol|pctSol|token|pctToken> <amount>
  case 'trade': {
    const [label, side, amountType, amount] = args;
    console.log(await engineFor().trade(label, { side, amountType, amount: Number(amount) }));
    break;
  }

  // estop <label|--all> [--sweep] [--burn]
  case 'estop': {
    const opts = { sweep: args.includes('--sweep'), burnUnsellable: args.includes('--burn') };
    const eng = engineFor({ withReceiver: opts.sweep });
    const out = args[0] === '--all'
      ? await eng.emergencyStopAll(opts)
      : await eng.emergencyStop(args[0], opts);
    console.log(JSON.stringify(out, null, 2));
    break;
  }

  case 'fees': {
    const [pool, idlPath, limit, out] = args;
    const idl = JSON.parse(await fs.readFile(idlPath, 'utf8'));
    const rows = await collectSwapEvents(connection, idl, {
      poolAddress: pool, limit: Number(limit)
    });
    await fs.writeFile(out, toCsv(rows));
    console.log(`${rows.length} swaps -> ${out}`);
    break;
  }

  default:
    console.log([
      'wallet:new <label>',
      'wallet:settings <label> <json>',
      'wallet:rm <label>',
      'watch <label>',
      'recover <label>',
      'teardown <label>',
      'trade <label> <buy|sell> <sol|pctSol|token|pctToken> <amount>',
      'estop <label|--all> [--sweep] [--burn]',
      'fees <pool> <idl.json> <limit> <out.csv>'
    ].join('\n'));
}
