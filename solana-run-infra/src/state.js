import fs from 'node:fs/promises';
import path from 'node:path';

export async function saveState(statePath, state) {
  const tmp = `${statePath}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, statePath);

  const dir = await fs.open(path.dirname(statePath), 'r');
  try { await dir.sync(); } catch { /* not supported everywhere */ } finally { await dir.close(); }
}

export async function loadState(statePath) {
  try {
    return JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
