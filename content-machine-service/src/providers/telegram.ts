import { SetupRequiredError, UpstreamError } from '../lib/errors.js';
import { jsonFetch } from '../lib/http.js';
import type { ServiceContext } from '../services/context.js';
import { setting } from '../services/settingsService.js';

export function botToken(ctx: ServiceContext): string {
  const token = setting(ctx, 'TELEGRAM_BOT_TOKEN');
  if (!token) throw new SetupRequiredError('Connect the Telegram delivery bot.');
  return token;
}

export async function telegram(ctx: ServiceContext, method: string, data: unknown): Promise<any> {
  const r = await jsonFetch(ctx.http, `https://api.telegram.org/bot${botToken(ctx)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new UpstreamError('Telegram rejected the request. Check bot permissions and the destination.');
  return r.result;
}

/** Sends the image with the caption as one message (caption max 1024 chars). */
export async function sendPhoto(ctx: ServiceContext, chatId: string, photo: Buffer, mime: string, name: string, caption: string) {
  const f = new FormData();
  f.set('chat_id', chatId);
  f.set('caption', caption.slice(0, 1024));
  f.set('photo', new Blob([new Uint8Array(photo)], { type: mime }), name);
  const r = await jsonFetch(ctx.http, `https://api.telegram.org/bot${botToken(ctx)}/sendPhoto`, { method: 'POST', body: f });
  if (!r.ok) throw new UpstreamError('Telegram rejected the request. Check bot permissions and the destination.');
  return r.result;
}

export async function uploadStickerFile(ctx: ServiceContext, userId: number, png: Buffer, name: string): Promise<string> {
  const f = new FormData();
  f.set('user_id', String(userId));
  f.set('sticker_format', 'static');
  f.set('sticker', new Blob([new Uint8Array(png)], { type: 'image/png' }), name);
  const r = await jsonFetch(ctx.http, `https://api.telegram.org/bot${botToken(ctx)}/uploadStickerFile`, { method: 'POST', body: f });
  if (!r.ok) throw new UpstreamError('Telegram rejected a sticker file.');
  return r.result.file_id;
}
