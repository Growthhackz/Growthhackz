import { describe, expect, it } from 'vitest';
import { json, makeApp } from './helpers.js';

describe('source health', () => {
  it('stores worker checks and DMs admins only when a source breaks or recovers', async () => {
    const t = makeApp();
    const sent: string[] = [];
    t.http.on('api.telegram.org/botSTK/sendMessage', (_u, init) => {
      const b = JSON.parse(String(init.body));
      expect(b.chat_id).toBe('777');
      sent.push(b.text);
      return json({ ok: true, result: { message_id: 1 } });
    });
    await t.setSetting('TELEGRAM_BOT_TOKEN', 'STK');
    await t.setSetting('STICKER_OWNER_ID', '777');

    const report = (checks: unknown) => t.api('POST', '/v1/health/report', { checks });
    // First reports: working sources are recorded quietly, a broken one alerts.
    await report([{ source: 'cmc', ok: true, detail: 'logged in' }, { source: 'gemfinder', ok: false, detail: 'login failed' }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('🔴 <b>GemFinder</b>: login failed');
    // Same state again: no message.
    await report([{ source: 'cmc', ok: true, detail: 'logged in' }, { source: 'gemfinder', ok: false, detail: 'login failed' }]);
    expect(sent).toHaveLength(1);
    // CMC breaks, GemFinder recovers: one message with both.
    await report([{ source: 'cmc', ok: false, detail: 'human check on the profile page' }, { source: 'gemfinder', ok: true, detail: 'logged in' }]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('🔴 <b>CoinMarketCap</b>: human check on the profile page');
    expect(sent[1]).toContain('🟢 <b>GemFinder</b>: working again');

    const sources = (await t.api('GET', '/v1/health/sources')).body.sources;
    expect(sources.cmc).toMatchObject({ ok: false, by: 'worker' });
    expect((await report([{ source: 'Bad Name!', ok: true }])).status).toBe(400);
  });

  it('checks the API keys, bot, worker and WURK wallet, flagging a low balance', async () => {
    const t = makeApp({ SOCIAL_ACTIVITY_URL: 'http://social.internal:4010', SOCIAL_ACTIVITY_TOKEN: 'sat' });
    const sent: string[] = [];
    t.http
      .on('generativelanguage.googleapis.com/', () => json({ models: [{ name: 'models/x', supportedGenerationMethods: ['generateContent'] }] }))
      .on('api.telegram.org/botSTK/getMe', () => json({ ok: true, result: { username: 'peakstickersbot' } }))
      .on('api.telegram.org/botSTK/sendMessage', (_u, init) => {
        sent.push(JSON.parse(String(init.body)).text);
        return json({ ok: true, result: {} });
      })
      .on('social.internal:4010/v1/wurk/status', () => json({ liveReady: true, missingForLive: [], usdcBalance: 7.5, walletError: null }));
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('TELEGRAM_BOT_TOKEN', 'STK');
    await t.setSetting('STICKER_OWNER_ID', '777');
    await t.api('POST', '/v1/render/claim'); // the worker has been in touch

    const sources = (await t.api('POST', '/v1/health/run')).body.sources;
    expect(sources.gemini.ok).toBe(true);
    expect(sources.sticker_bot).toMatchObject({ ok: true, detail: '@peakstickersbot' });
    expect(sources.worker.ok).toBe(true);
    expect(sources.wurk).toMatchObject({ ok: false, detail: expect.stringContaining('7.50 USDC') });
    expect(sent.join('\n')).toContain('🔴 <b>WURK social boost</b>');
  });
});
