import { describe, expect, it } from 'vitest';
import { json, makeApp } from './helpers.js';

describe('source health', () => {
  it('stores worker checks and DMs admins only when a source breaks or recovers', async () => {
    const t = makeApp({ ADMIN_NOTIFY: 'all' });
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
    const broken = { source: 'gemfinder', ok: false, detail: 'login failed' };
    // A one-off failure that clears on the next check (a proxy blip) is never announced.
    await report([{ source: 'cmc', ok: true, detail: 'logged in' }, { source: 'freshcoins', ok: false, detail: 'ERR_TUNNEL_CONNECTION_FAILED' }]);
    await report([{ source: 'freshcoins', ok: true, detail: 'logged in' }]);
    expect(sent).toHaveLength(0);
    // Broken twice in a row: caught and worked on.
    await report([broken]);
    expect(sent).toHaveLength(0);
    await report([broken]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('🟡 Caught: <b>GemFinder</b>: login failed. Working on it');
    // Third failed attempt: escalated to a person, with what to do. Only once.
    await report([broken]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('🔴 Need you: <b>GemFinder</b> still fails after 3 automatic attempts');
    expect(sent[1]).toContain('GEMFINDER_EMAIL');
    await report([broken]);
    expect(sent).toHaveLength(2);
    // CMC breaks (twice), GemFinder recovers: one message with both.
    await report([{ source: 'cmc', ok: false, detail: 'human check on the profile page' }]);
    await report([{ source: 'cmc', ok: false, detail: 'human check on the profile page' }, { source: 'gemfinder', ok: true, detail: 'logged in' }]);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toContain('🟡 Caught: <b>CoinMarketCap</b>: human check on the profile page');
    expect(sent[2]).toContain('✅ Fixed: <b>GemFinder</b> is working again.');

    const sources = (await t.api('GET', '/v1/health/sources')).body.sources;
    expect(sources.cmc).toMatchObject({ ok: false, by: 'worker', stage: 'fixing', fails: 2 });
    expect(sources.gemfinder).toMatchObject({ ok: true, stage: 'ok', fails: 0 });
    expect((await report([{ source: 'Bad Name!', ok: true }])).status).toBe(400);
    // The ops agent's messages go through the same bot (admin only).
    expect((await t.api('POST', '/v1/ops/notify', { lines: ['🟡 Caught: test from the ops agent'] })).body.sent).toBe(true);
    expect(sent.at(-1)).toContain('🟡 Caught: test from the ops agent');
    expect((await t.api('POST', '/v1/ops/notify', { lines: [] })).status).toBe(400);
  });

  it('checks the API keys, bot, worker and WURK wallet, flagging a low balance', async () => {
    const t = makeApp({ SOCIAL_ACTIVITY_URL: 'http://social.internal:4010', SOCIAL_ACTIVITY_TOKEN: 'sat', ADMIN_NOTIFY: 'all' });
    const sent: string[] = [];
    let getMeCalls = 0;
    t.http
      .on('generativelanguage.googleapis.com/', () => json({ models: [{ name: 'models/x', supportedGenerationMethods: ['generateContent'] }] }))
      .on('api.telegram.org/botSTK/getMe', () => {
        // The first call drops (seen live from Railway); the retry goes through.
        if (!getMeCalls++) throw new Error('socket hang up');
        return json({ ok: true, result: { username: 'peakstickersbot' } });
      })
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
    // Announced on the second failed check (the API rechecks every 5 min while something is broken).
    expect(sent.join('\n')).not.toContain('WURK');
    await t.api('POST', '/v1/health/run');
    expect(sent.join('\n')).toContain('🟡 Caught: <b>WURK social boost</b>');
  });

  it('by default only messages admins when a person is needed, once, and never about the proxy alone', async () => {
    const t = makeApp();
    const sent: string[] = [];
    t.http.on('api.telegram.org/botSTK/sendMessage', (_u, init) => {
      sent.push(JSON.parse(String(init.body)).text);
      return json({ ok: true, result: {} });
    });
    await t.setSetting('TELEGRAM_BOT_TOKEN', 'STK');
    await t.setSetting('STICKER_OWNER_ID', '777');
    const report = (checks: unknown) => t.api('POST', '/v1/health/report', { checks });
    const broken = [{ source: 'gemfinder', ok: false, detail: 'login failed' }, { source: 'proxy', ok: false, detail: 'not answering' }];
    for (let i = 0; i < 5; i++) await report(broken);
    // No 🟡 caught, no proxy message; one 🔴 for GemFinder.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('🔴 Need you: <b>GemFinder</b>');
    expect(sent[0]).not.toContain('proxy');
    await report([{ source: 'gemfinder', ok: true, detail: 'logged in' }]);
    expect(sent).toHaveLength(1); // ✅ fixed is not sent
    // The same 🔴 line again (e.g. from the ops agent) within 12 hours is dropped.
    expect((await t.api('POST', '/v1/ops/notify', { lines: ['🔴 Need you: X'] })).body.sent).toBe(true);
    expect((await t.api('POST', '/v1/ops/notify', { lines: ['🔴 Need you: X'] })).body.sent).toBe(false);
    expect((await t.api('POST', '/v1/ops/notify', { lines: ['🟡 Caught: Y'] })).body.sent).toBe(false);
    expect(sent).toHaveLength(2);
  });
});
