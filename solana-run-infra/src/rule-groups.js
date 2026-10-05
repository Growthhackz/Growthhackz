import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRules } from './rules.js';

// Named sets of rules saved for reuse. A group holds only a rule's settings,
// never its run history; inserting one into a wallet makes ordinary rules that
// are validated again when that wallet's rules are saved.

export const GROUP_NAME_RE = /^[a-zA-Z0-9 _.+-]{1,40}$/;
const MAX_GROUPS = 100;

function settingsOnly(rule) {
  const { side, amountType, amount, amountMax, trigger, repeat, maxRuns, note, enabled } = rule;
  return {
    enabled, side, amountType, amount,
    ...(amountMax ? { amountMax } : {}),
    trigger, repeat, maxRuns, note
  };
}

export class RuleGroups {
  constructor(file) {
    this.file = file;
    this.pending = Promise.resolve();
  }

  async #read() {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw e;
    }
  }

  async #write(groups) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(groups, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  // Writes are queued so two saves can't drop each other's group.
  #serial(fn) {
    const run = this.pending.then(fn, fn);
    this.pending = run.catch(() => {});
    return run;
  }

  async list() {
    const groups = await this.#read();
    return Object.entries(groups)
      .map(([name, g]) => ({ name, rules: g.rules, savedAt: g.savedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  save(name, rules) {
    if (!GROUP_NAME_RE.test(name ?? '')) {
      throw new Error('group name must be 1-40 letters, numbers, spaces or _ . + -');
    }
    if (!Array.isArray(rules) || rules.length === 0) throw new Error('a group needs at least one rule');
    const clean = normalizeRules(rules).map(settingsOnly);
    return this.#serial(async () => {
      const groups = await this.#read();
      if (!groups[name] && Object.keys(groups).length >= MAX_GROUPS) {
        throw new Error(`at most ${MAX_GROUPS} saved groups`);
      }
      groups[name] = { rules: clean, savedAt: Date.now() };
      await this.#write(groups);
      return { name, rules: clean };
    });
  }

  remove(name) {
    return this.#serial(async () => {
      const groups = await this.#read();
      if (!groups[name]) return false;
      delete groups[name];
      await this.#write(groups);
      return true;
    });
  }
}
