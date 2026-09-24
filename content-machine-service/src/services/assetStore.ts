import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** Where generated media lives. The filesystem store is the default; swap in an object store behind the same interface. */
export interface AssetStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

export class FsAssetStore implements AssetStore {
  private readonly root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  private path(key: string): string {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid asset key');
    return p;
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p + '.tmp', bytes);
    await rename(p + '.tmp', p);
  }
  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }
}

export class MemoryAssetStore implements AssetStore {
  readonly files = new Map<string, Buffer>();
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.files.set(key, Buffer.from(bytes));
  }
  async get(key: string): Promise<Buffer | null> {
    return this.files.get(key) ?? null;
  }
}
