/**
 * stream-webhook: turns calls from the streaming service into channel events.
 *
 *   vMix ──RTMPS/SRT──▶ streaming service ──webhook──▶ this function ──▶ stream_ingest()
 *
 * Supported callers (each is switched on by setting its secret):
 *   Cloudflare Stream  video webhook ("recording ready")      CLOUDFLARE_WEBHOOK_SECRET
 *                      Notifications webhook (live input       CLOUDFLARE_NOTIFY_SECRET
 *                      connected / disconnected)
 *   Mux                video.live_stream.active / idle,         MUX_WEBHOOK_SECRET
 *                      video.asset.ready
 *   Anything else      JSON { "type": "live.started" | ... }    PKO_WEBHOOK_KEY  (header x-pko-key)
 *
 * Pure: no Deno or Node APIs beyond Web standards, so the tests run it under Node.
 */

export interface Env {
  CLOUDFLARE_WEBHOOK_SECRET?: string;
  CLOUDFLARE_NOTIFY_SECRET?: string;
  /** Only react to this Cloudflare live input (optional). */
  CLOUDFLARE_LIVE_INPUT?: string;
  MUX_WEBHOOK_SECRET?: string;
  /** Only react to this Mux live stream (optional). */
  MUX_LIVE_STREAM?: string;
  PKO_WEBHOOK_KEY?: string;
}

export type StreamEvent =
  | { type: 'live.started' }
  | { type: 'live.ended' }
  | { type: 'recording.ready'; id: string; url: string; poster?: string | null; duration?: number | null; title?: string | null; startedAt?: string | null };

export type Ingest = (ev: StreamEvent) => Promise<unknown>;

const TOLERANCE_S = 300;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function handle(req: Request, env: Env, ingest: Ingest, now: () => number = Date.now): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const body = await req.text();
  if (body.length > 256_000) return json(413, { error: 'Too large' });
  const h = (k: string) => req.headers.get(k) || '';
  let events: StreamEvent[] | null = null;
  let from = '';

  try {
    if (h('webhook-signature') && env.CLOUDFLARE_WEBHOOK_SECRET) {
      from = 'cloudflare';
      if (!(await signed(h('webhook-signature'), 'time', 'sig1', body, env.CLOUDFLARE_WEBHOOK_SECRET, now))) return json(401, { error: 'Bad signature' });
      events = cloudflareVideo(JSON.parse(body), env);
    } else if (h('cf-webhook-auth') && env.CLOUDFLARE_NOTIFY_SECRET) {
      from = 'cloudflare-notify';
      if (!same(h('cf-webhook-auth'), env.CLOUDFLARE_NOTIFY_SECRET)) return json(401, { error: 'Bad secret' });
      events = cloudflareNotify(JSON.parse(body), env);
    } else if (h('mux-signature') && env.MUX_WEBHOOK_SECRET) {
      from = 'mux';
      if (!(await signed(h('mux-signature'), 't', 'v1', body, env.MUX_WEBHOOK_SECRET, now))) return json(401, { error: 'Bad signature' });
      events = mux(JSON.parse(body), env);
    } else if (h('x-pko-key') && env.PKO_WEBHOOK_KEY) {
      from = 'key';
      if (!same(h('x-pko-key'), env.PKO_WEBHOOK_KEY)) return json(401, { error: 'Bad key' });
      events = generic(JSON.parse(body));
    } else {
      return json(401, { error: 'Unrecognised caller. Set the matching secret for your streaming service.' });
    }
  } catch {
    return json(400, { error: 'Body is not valid JSON' });
  }

  const results = [];
  for (const ev of events) results.push(await ingest(ev));
  return json(200, { ok: true, from, handled: events.map((e) => e.type), results });
}

/* ---------- adapters ---------- */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** Cloudflare Stream video webhook: fires when a video (here: a live recording) is ready. */
export function cloudflareVideo(v: Obj, env: Env): StreamEvent[] {
  const input = str(v.liveInput);
  if (!input) return []; // an ordinary upload, not a live recording
  if (env.CLOUDFLARE_LIVE_INPUT && input !== env.CLOUDFLARE_LIVE_INPUT) return [];
  if (v.readyToStream !== true || obj(v.status).state !== 'ready') return [];
  const url = str(obj(v.playback).hls);
  const id = str(v.uid);
  if (!url || !id) return [];
  return [{ type: 'recording.ready', id: `cf:${id}`, url, poster: str(v.thumbnail), duration: num(v.duration), title: str(obj(v.meta).name), startedAt: str(v.created) }];
}

/** Cloudflare Notifications ("Stream Live Input"): the studio connected or disconnected. */
export function cloudflareNotify(n: Obj, env: Env): StreamEvent[] {
  const d = obj(n.data);
  if (env.CLOUDFLARE_LIVE_INPUT && str(d.input_id) && d.input_id !== env.CLOUDFLARE_LIVE_INPUT) return [];
  switch (d.event_type) {
    case 'live_input.connected': return [{ type: 'live.started' }];
    case 'live_input.disconnected': case 'live_input.errored': return [{ type: 'live.ended' }];
    default: return [];
  }
}

/** Mux webhooks. */
export function mux(e: Obj, env: Env): StreamEvent[] {
  const d = obj(e.data);
  const ls = str(d.live_stream_id) || (e.type === 'video.live_stream.active' || e.type === 'video.live_stream.idle' ? str(d.id) : null);
  if (env.MUX_LIVE_STREAM && ls !== env.MUX_LIVE_STREAM) return [];
  switch (e.type) {
    case 'video.live_stream.active': return [{ type: 'live.started' }];
    case 'video.live_stream.idle': case 'video.live_stream.disconnected': return [{ type: 'live.ended' }];
    case 'video.asset.ready': {
      if (!str(d.live_stream_id)) return []; // not a live recording
      const pid = (Array.isArray(d.playback_ids) ? d.playback_ids.map(obj) : []).find((p) => p.policy === 'public');
      const id = str(d.id);
      if (!pid || !id || !str(pid.id)) return [];
      const created = Number(d.created_at);
      return [{
        type: 'recording.ready', id: `mux:${id}`, url: `https://stream.mux.com/${pid.id}.m3u8`,
        poster: `https://image.mux.com/${pid.id}/thumbnail.jpg`, duration: num(d.duration),
        startedAt: Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : null,
      }];
    }
    default: return [];
  }
}

/** Our own minimal format, for other services, vMix scripts or testing. */
export function generic(e: Obj): StreamEvent[] {
  if (e.type === 'live.started' || e.type === 'live.ended') return [{ type: e.type }];
  if (e.type === 'recording.ready' && str(e.id) && str(e.url)) {
    return [{ type: 'recording.ready', id: `ext:${e.id}`, url: e.url as string, poster: str(e.poster), duration: num(e.duration), title: str(e.title), startedAt: str(e.startedAt) }];
  }
  return [];
}

/* ---------- signatures ---------- */

/** Verify "t=<unix>,v1=<hex hmac of `${t}.${body}`>" style headers (Cloudflare & Mux). */
export async function signed(header: string, tKey: string, sKey: string, body: string, secret: string, now: () => number): Promise<boolean> {
  const parts: Record<string, string[]> = {};
  for (const kv of header.split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) (parts[kv.slice(0, i).trim()] ||= []).push(kv.slice(i + 1).trim());
  }
  const t = Number(parts[tKey]?.[0]);
  if (!Number.isFinite(t) || Math.abs(now() / 1000 - t) > TOLERANCE_S) return false;
  const want = await hmacHex(secret, `${parts[tKey][0]}.${body}`);
  return (parts[sKey] || []).some((sig) => same(sig.toLowerCase(), want));
}

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
