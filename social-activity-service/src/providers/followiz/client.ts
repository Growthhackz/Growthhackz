import { ProviderAmbiguousError, ProviderRejectedError } from '../types.js';

export interface ProviderCallRecord {
  provider: string;
  action: string;
  /** Request params with the API key removed. */
  request: Record<string, string>;
  httpStatus: number | null;
  responseBody: string | null;
  durationMs: number;
  error: string | null;
}

export type ProviderCallRecorder = (record: ProviderCallRecord) => void;

export interface FollowizClientOptions {
  apiUrl: string;
  apiKey: string;
  timeoutMs: number;
  minIntervalMs: number;
  fetchImpl?: typeof fetch;
  recorder?: ProviderCallRecorder;
}

/**
 * Thin transport for the Followiz (Perfect Panel v2) API: every call is a
 * form-encoded POST with `key` + `action`. Calls are serialized and spaced by
 * `minIntervalMs` to stay under panel rate limits.
 */
export class FollowizClient {
  private readonly fetchImpl: typeof fetch;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(private readonly opts: FollowizClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  call<T = unknown>(action: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const run = this.queue.then(() => this.throttled<T>(action, params));
    // Keep the chain alive regardless of this call's outcome.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async throttled<T>(action: string, params: Record<string, string | number | undefined>): Promise<T> {
    const wait = this.lastCallAt + this.opts.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await this.send<T>(action, params);
    } finally {
      this.lastCallAt = Date.now();
    }
  }

  private async send<T>(action: string, params: Record<string, string | number | undefined>): Promise<T> {
    const request: Record<string, string> = { action };
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) request[k] = String(v);
    }
    const body = new URLSearchParams({ key: this.opts.apiKey, ...request });

    const started = Date.now();
    let httpStatus: number | null = null;
    let text: string | null = null;
    let errorMessage: string | null = null;
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.opts.apiUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        throw new ProviderAmbiguousError(`Followiz ${action} request failed: ${describe(err)}`, action, err);
      }
      httpStatus = res.status;
      text = await res.text().catch(() => null);

      if (res.status >= 500 || text === null) {
        throw new ProviderAmbiguousError(`Followiz ${action} returned HTTP ${res.status}`, action);
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        if (res.status >= 400) {
          throw new ProviderRejectedError(`Followiz ${action} returned HTTP ${res.status}`, action);
        }
        throw new ProviderAmbiguousError(`Followiz ${action} returned a non-JSON body`, action);
      }

      if (isErrorBody(json)) {
        throw new ProviderRejectedError(json.error, action);
      }
      if (res.status >= 400) {
        throw new ProviderRejectedError(`Followiz ${action} returned HTTP ${res.status}`, action);
      }
      return json as T;
    } catch (err) {
      errorMessage = describe(err);
      throw err;
    } finally {
      this.opts.recorder?.({
        provider: 'followiz',
        action,
        request,
        httpStatus,
        responseBody: text,
        durationMs: Date.now() - started,
        error: errorMessage,
      });
    }
  }
}

function isErrorBody(json: unknown): json is { error: string } {
  return (
    typeof json === 'object' &&
    json !== null &&
    !Array.isArray(json) &&
    typeof (json as { error?: unknown }).error === 'string'
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
