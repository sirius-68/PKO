/**
 * The live pipeline: streaming-service webhook -> Edge Function handler -> stream_ingest()
 * on the real migration. Covers signatures, provider payloads, going on air automatically,
 * and saving recordings to Past messages.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Client } from './helpers.ts';
import { signJwt } from '../supabase/local/emulator.ts';
import { handle, hmacHex, type StreamEvent, type Env } from '../supabase/functions/stream-webhook/handler.ts';

let srv: Awaited<ReturnType<typeof startTestServer>>;
let admin: Client;
let service: Client;
before(async () => {
  srv = await startTestServer();
  admin = new Client(srv.base); await admin.loginAdmin();
  service = new Client(srv.base);
  service.token = signJwt({ role: 'service_role', iss: 'supabase-local', iat: 1700000000, exp: 4102444800 });
});
after(async () => { await srv?.close(); });

const ENV: Env = { CLOUDFLARE_WEBHOOK_SECRET: 'cf-secret', CLOUDFLARE_NOTIFY_SECRET: 'notify-secret', MUX_WEBHOOK_SECRET: 'mux-secret', PKO_WEBHOOK_KEY: 'pko-key' };
const ingest = async (ev: StreamEvent) => service.rpcOk('stream_ingest', { p: ev });
const post = (body: unknown, headers: Record<string, string>) => new Request('https://x.supabase.co/functions/v1/stream-webhook', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });
async function signedReq(body: unknown, secret: string, header: string, t = Math.floor(Date.now() / 1000), names = ['time', 'sig1']) {
  const text = JSON.stringify(body);
  return post(text, { [header]: `${names[0]}=${t},${names[1]}=${await hmacHex(secret, `${t}.${text}`)}` });
}
/** "HH:MM" right now in Douala, the seed's channel time zone. */
const doualaNow = () => new Date(Date.now() + 3600e3).toISOString().slice(11, 16);

describe('stream_ingest is server-only', () => {
  test('members and the media team cannot call it', async () => {
    assert.equal((await new Client(srv.base).rpc('stream_ingest', { p: { type: 'live.started' } })).status, 401);
    assert.equal((await admin.rpc('stream_ingest', { p: { type: 'live.started' } })).status, 403);
  });
  test('unknown events are rejected', async () => {
    assert.equal((await service.rpc('stream_ingest', { p: { type: 'nope' } })).status, 400);
  });
});

describe('webhook handler', () => {
  test('Cloudflare: studio connects -> on air with the scheduled programme title', async () => {
    await admin.rpcOk('admin_save_live', { p: { onAir: false } });
    await admin.rpcOk('admin_save', { p_collection: 'schedule', p_id: null, p_status: 'published', p_data: { title: 'Evening Revival', subtitle: 'Live from Douala', days: 'Every day', time: doualaNow(), source: 'Live from the studio' } });
    const notify = { name: 'pko', text: '', data: { notification_name: 'Stream Live Input', input_id: 'in1', event_type: 'live_input.connected', updated_at: new Date().toISOString() }, ts: 1 };
    const r = await handle(post(notify, { 'cf-webhook-auth': 'notify-secret' }), ENV, ingest);
    assert.equal(r.status, 200, await r.clone().text());
    const { live } = await admin.bundle();
    assert.equal(live.onAir, true);
    assert.equal(live.status, 'live');
    assert.equal(live.title, 'Evening Revival');
    assert.equal(live.ref, 'Live from Douala');
  });
  test('Cloudflare: recording ready -> saved to Past messages once', async () => {
    const video = { uid: 'vid123', liveInput: 'in1', readyToStream: true, status: { state: 'ready' }, duration: 4521.6, thumbnail: 'https://customer-x.cloudflarestream.com/vid123/thumbnails/thumbnail.jpg', playback: { hls: 'https://customer-x.cloudflarestream.com/vid123/manifest/video.m3u8' }, meta: { name: 'Evening Revival 14 Nov' }, created: new Date(Date.now() - 2 * 3600e3).toISOString() };
    const r = await handle(await signedReq(video, 'cf-secret', 'webhook-signature'), ENV, ingest);
    assert.equal(r.status, 200, await r.clone().text());
    const b = (await admin.bundle()).broadcasts.find((x: any) => x.sourceId === 'cf:vid123');
    assert.ok(b, 'recording saved as a broadcast');
    assert.equal(b.title, 'Evening Revival 14 Nov');
    assert.equal(b.url, video.playback.hls);
    assert.equal(b.poster, video.thumbnail);
    assert.equal(b.duration, 4522);
    assert.equal(b.category, 'Services');
    // the same webhook again (retries happen) does not duplicate it
    const again = await (await handle(await signedReq(video, 'cf-secret', 'webhook-signature'), ENV, ingest)).json();
    assert.equal(again.results[0].archived, false);
    assert.equal((await admin.bundle()).broadcasts.filter((x: any) => x.sourceId === 'cf:vid123').length, 1);
  });
  test('Cloudflare: ordinary uploads and unfinished videos are ignored', async () => {
    const r = await (await handle(await signedReq({ uid: 'up1', readyToStream: true, status: { state: 'ready' }, playback: { hls: 'https://x/up1.m3u8' } }, 'cf-secret', 'webhook-signature'), ENV, ingest)).json();
    assert.deepEqual(r.handled, []);
    const r2 = await (await handle(await signedReq({ uid: 'v2', liveInput: 'in1', readyToStream: false, status: { state: 'inprogress' } }, 'cf-secret', 'webhook-signature'), ENV, ingest)).json();
    assert.deepEqual(r2.handled, []);
  });
  test('Cloudflare: studio disconnects -> off air', async () => {
    const notify = { data: { event_type: 'live_input.disconnected', input_id: 'in1' } };
    assert.equal((await handle(post(notify, { 'cf-webhook-auth': 'notify-secret' }), ENV, ingest)).status, 200);
    const { live } = await admin.bundle();
    assert.equal(live.onAir, false);
    assert.equal(live.status, 'idle');
  });
  test('Mux: active / idle / asset ready', async () => {
    const t = Math.floor(Date.now() / 1000);
    const muxReq = (body: unknown) => signedReq(body, 'mux-secret', 'mux-signature', t, ['t', 'v1']);
    await handle(await muxReq({ type: 'video.live_stream.active', data: { id: 'ls1' } }), ENV, ingest);
    assert.equal((await admin.bundle()).live.onAir, true);
    await handle(await muxReq({ type: 'video.live_stream.idle', data: { id: 'ls1' } }), ENV, ingest);
    assert.equal((await admin.bundle()).live.onAir, false);
    const asset = { type: 'video.asset.ready', data: { id: 'asset9', live_stream_id: 'ls1', duration: 1800.2, created_at: String(t - 3600), playback_ids: [{ id: 'pb9', policy: 'public' }] } };
    assert.equal((await handle(await muxReq(asset), ENV, ingest)).status, 200);
    const b = (await admin.bundle()).broadcasts.find((x: any) => x.sourceId === 'mux:asset9');
    assert.equal(b.url, 'https://stream.mux.com/pb9.m3u8');
    assert.equal(b.poster, 'https://image.mux.com/pb9/thumbnail.jpg');
    assert.equal(b.duration, 1800);
  });
  test('generic key format, for other services or a vMix script', async () => {
    const r = await handle(post({ type: 'recording.ready', id: 'abc', url: 'https://cdn.example.org/abc.m3u8', duration: 60, title: 'Bible study' }, { 'x-pko-key': 'pko-key' }), ENV, ingest);
    assert.equal(r.status, 200);
    assert.ok((await admin.bundle()).broadcasts.some((x: any) => x.sourceId === 'ext:abc' && x.poster), 'falls back to the live poster');
  });
  test('turning off "save each programme" stops new recordings', async () => {
    await admin.rpcOk('admin_save_live', { p: { autoArchive: false } });
    const r = await (await handle(post({ type: 'recording.ready', id: 'skip1', url: 'https://cdn.example.org/s.m3u8' }, { 'x-pko-key': 'pko-key' }), ENV, ingest)).json();
    assert.equal(r.results[0].archived, false);
    await admin.rpcOk('admin_save_live', { p: { autoArchive: true } });
  });
  test('turning off "go on air automatically" keeps the manual switch in charge', async () => {
    await admin.rpcOk('admin_save_live', { p: { autoOnAir: false, onAir: false } });
    await handle(post({ type: 'live.started' }, { 'x-pko-key': 'pko-key' }), ENV, ingest);
    const { live } = await admin.bundle();
    assert.equal(live.onAir, false);
    assert.equal(live.status, 'live', 'the feed status still shows on the Live page');
    await admin.rpcOk('admin_save_live', { p: { autoOnAir: true } });
  });
  test('rejects forged, stale and unknown calls', async () => {
    const body = { type: 'video.live_stream.active', data: { id: 'ls1' } };
    assert.equal((await handle(await signedReq(body, 'wrong', 'mux-signature', undefined, ['t', 'v1']), ENV, ingest)).status, 401);
    assert.equal((await handle(await signedReq(body, 'mux-secret', 'mux-signature', Math.floor(Date.now() / 1000) - 3600, ['t', 'v1']), ENV, ingest)).status, 401);
    assert.equal((await handle(post({}, { 'cf-webhook-auth': 'nope' }), ENV, ingest)).status, 401);
    assert.equal((await handle(post({ type: 'live.started' }, { 'x-pko-key': 'nope' }), ENV, ingest)).status, 401);
    assert.equal((await handle(post({ type: 'live.started' }, {}), ENV, ingest)).status, 401);
    assert.equal((await handle(post({ type: 'live.started' }, { 'x-pko-key': 'pko-key' }), {}, ingest)).status, 401, 'a provider is off until its secret is set');
    assert.equal((await handle(post('not json', { 'x-pko-key': 'pko-key' }), ENV, ingest)).status, 400);
    assert.equal((await handle(new Request('https://x/', { method: 'GET' }), ENV, ingest)).status, 405);
  });
  test('only reacts to the configured live input', async () => {
    const env = { ...ENV, CLOUDFLARE_LIVE_INPUT: 'in1' };
    const r = await (await handle(post({ data: { event_type: 'live_input.connected', input_id: 'other' } }, { 'cf-webhook-auth': 'notify-secret' }), env, ingest)).json();
    assert.deepEqual(r.handled, []);
  });
});

describe('schedule and live settings validation', () => {
  test('times, days and replays are checked', async () => {
    const save = (data: Record<string, unknown>) => admin.rpc('admin_save', { p_collection: 'schedule', p_id: null, p_data: { title: 'X', ...data } });
    assert.equal((await save({ time: '25:00' })).status, 400);
    assert.equal((await save({ time: '18:30', end: '7pm' })).status, 400);
    assert.equal((await save({ time: '18:30', days: 'Someday' })).status, 400);
    const r = await save({ time: '18:30', source: 'A past message' });
    assert.equal(r.status, 400);
    assert.ok(r.json.details.includes('broadcast'));
    assert.equal((await save({ time: '06:00', days: 'Weekends', source: 'Latest messages on rotation' })).status, 200);
  });
  test('channel time zone must be real', async () => {
    const r = await admin.rpc('admin_save_live', { p: { timezone: 'Mars/Olympus' } });
    assert.equal(r.status, 400);
    assert.equal((await admin.rpc('admin_save_live', { p: { timezone: 'Europe/London' } })).status, 200);
    await admin.rpcOk('admin_save_live', { p: { timezone: 'Africa/Douala' } });
  });
});
