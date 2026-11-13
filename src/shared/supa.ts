/**
 * Minimal, dependency-free Supabase client used by both the member app and the
 * dashboard: PostgREST RPC, GoTrue auth (anonymous + email/password), Storage
 * uploads with progress, and Realtime (postgres_changes + presence).
 * We only need a small slice of supabase-js, and avoiding a bundler keeps the
 * Capacitor build simple.
 */

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: { id: string; email: string | null; is_anonymous: boolean };
}
export interface Store { get(k: string): string | null; set(k: string, v: string | null): void }

export class SupaError extends Error {
  status: number;
  code: string;
  details?: Record<string, string>;
  raw?: unknown;
  constructor(status: number, message: string, code = '', details?: Record<string, string>, raw?: unknown) {
    super(message); this.status = status; this.code = code; this.details = details; this.raw = raw;
  }
}

const OFFLINE = () => (typeof navigator !== 'undefined' && navigator.onLine === false
  ? "You're offline. Check your connection and try again."
  : "Couldn't reach the server. Please try again.");

export class Supa {
  url: string;
  anonKey: string;
  session: Session | null = null;
  private store: Store;
  private key: string;
  private refreshing: Promise<void> | null = null;
  onAuthChange: (s: Session | null) => void = () => {};

  constructor(url: string, anonKey: string, store: Store, storageKey = 'pko.session') {
    this.url = url.replace(/\/$/, '');
    this.anonKey = anonKey;
    this.store = store;
    this.key = storageKey;
    this.restore();
  }

  /** Re-read the saved session (call after async storage, e.g. Capacitor Preferences, has loaded). */
  restore(): void {
    try { const s = this.store.get(this.key); this.session = s ? (JSON.parse(s) as Session) : null; } catch { this.session = null; }
  }

  get configured(): boolean { return !!this.url && !!this.anonKey; }

  private setSession(s: Session | null) {
    this.session = s;
    this.store.set(this.key, s ? JSON.stringify(s) : null);
    this.onAuthChange(s);
  }

  /** A valid access token (refreshing it first when it's about to expire), or the anon key. */
  async token(): Promise<string> {
    const s = this.session;
    if (!s) return this.anonKey;
    if (s.expires_at * 1000 - Date.now() < 60_000) {
      this.refreshing ||= this.refresh().finally(() => { this.refreshing = null; });
      await this.refreshing;
    }
    return this.session?.access_token || this.anonKey;
  }

  private async refresh() {
    const s = this.session;
    if (!s) return;
    try {
      const r = await this.authFetch('/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
      this.setSession(toSession(r));
    } catch (e) {
      // Only drop the session if the server says the token is no good (not when offline).
      if (e instanceof SupaError && e.status >= 400 && e.status < 500) this.setSession(null);
    }
  }

  private async authFetch(path: string, body?: unknown, method = 'POST', bearer?: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${this.url}/auth/v1${path}`, {
        method,
        headers: { apikey: this.anonKey, Authorization: `Bearer ${bearer || this.anonKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new SupaError(0, OFFLINE()); }
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const msg = String(data.msg || data.error_description || data.message || data.error || 'Sign-in failed');
      throw new SupaError(res.status, friendlyAuth(msg), String(data.error_code || data.code || ''));
    }
    return data;
  }

  /* ---------- auth ---------- */
  async signInAnonymously(): Promise<Session> {
    const s = toSession(await this.authFetch('/signup', { data: {} }));
    this.setSession(s);
    return s;
  }
  async signUp(email: string, password: string, data: Record<string, unknown> = {}): Promise<Session | null> {
    const r = await this.authFetch('/signup', { email, password, data });
    if (r.access_token) { const s = toSession(r); this.setSession(s); return s; }
    return null; // email confirmation required
  }
  async signIn(email: string, password: string): Promise<Session> {
    const s = toSession(await this.authFetch('/token?grant_type=password', { email, password }));
    this.setSession(s);
    return s;
  }
  async signOut(): Promise<void> {
    const t = this.session?.access_token;
    this.setSession(null);
    if (t) await this.authFetch('/logout', undefined, 'POST', t).catch(() => {});
  }
  async updatePassword(password: string): Promise<void> {
    await this.authFetch('/user', { password }, 'PUT', await this.token());
  }

  /* ---------- database (RPC) ---------- */
  async rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}, opts: { timeout?: number; anon?: boolean } = {}): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout ?? 15000);
    const bearer = opts.anon ? this.anonKey : await this.token();
    let res: Response;
    try {
      res = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: this.anonKey, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: ctl.signal,
      });
    } catch { throw new SupaError(0, OFFLINE()); } finally { clearTimeout(timer); }
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const e = (data || {}) as { message?: string; details?: string | null; code?: string };
      if (res.status === 401 && this.session && /JWT/i.test(String(e.message))) this.setSession(null);
      let details: Record<string, string> | undefined;
      if (e.details) { try { const d = JSON.parse(e.details); if (d && typeof d === 'object') details = d; } catch { /* plain text */ } }
      throw new SupaError(res.status, e.message || 'Something went wrong', e.code || '', details, data);
    }
    return data as T;
  }

  /* ---------- storage ---------- */
  publicUrl(path: string, bucket = 'media'): string {
    return `${this.url}/storage/v1/object/public/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  upload(path: string, file: Blob, onProgress: (p: number) => void = () => {}, opts: { bucket?: string; upsert?: boolean; contentType?: string } = {}): Promise<void> {
    return this.token().then((tok) => new Promise<void>((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', `${this.url}/storage/v1/object/${opts.bucket || 'media'}/${path.split('/').map(encodeURIComponent).join('/')}`);
      x.setRequestHeader('apikey', this.anonKey);
      x.setRequestHeader('Authorization', `Bearer ${tok}`);
      x.setRequestHeader('Content-Type', opts.contentType || file.type || 'application/octet-stream');
      x.setRequestHeader('x-upsert', opts.upsert ? 'true' : 'false');
      x.setRequestHeader('cache-control', 'max-age=31536000');
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) { resolve(); return; }
        let msg = 'Upload failed';
        try { const d = JSON.parse(x.responseText); msg = d.message || d.error || msg; } catch { /* ignore */ }
        if (x.status === 413 || /exceeded the maximum/i.test(msg)) msg = 'This file is larger than your storage plan allows (50 MB on the free plan).';
        else if (x.status === 415 || /mime type/i.test(msg)) msg = "This file type isn't supported. Use JPG, PNG, WebP, MP4, MP3, M4A, WAV or PDF.";
        else if (x.status === 403 || /row-level security/i.test(msg)) msg = "You don't have permission to upload here.";
        reject(new SupaError(x.status, msg));
      };
      x.onerror = () => reject(new SupaError(0, 'Upload failed. Check your connection and try again.'));
      x.send(file);
    }));
  }
  async remove(paths: string[], bucket = 'media'): Promise<void> {
    const res = await fetch(`${this.url}/storage/v1/object/${bucket}`, {
      method: 'DELETE',
      headers: { apikey: this.anonKey, Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths }),
    }).catch(() => null);
    if (!res || !res.ok) throw new SupaError(res?.status || 0, "Couldn't delete the file from storage");
  }

  private rt: Realtime | null = null;
  realtime(): Realtime {
    this.rt ||= new Realtime(this.url.replace(/^http/, 'ws') + `/realtime/v1/websocket?apikey=${encodeURIComponent(this.anonKey)}&vsn=1.0.0`, () => this.token());
    return this.rt;
  }
}

function toSession(r: Record<string, unknown>): Session {
  const u = (r.user || {}) as { id: string; email?: string | null; is_anonymous?: boolean };
  return {
    access_token: String(r.access_token), refresh_token: String(r.refresh_token),
    expires_at: Number(r.expires_at) || Math.floor(Date.now() / 1000) + Number(r.expires_in || 3600),
    user: { id: u.id, email: u.email ?? null, is_anonymous: !!u.is_anonymous },
  };
}
function friendlyAuth(msg: string): string {
  if (/invalid login credentials/i.test(msg)) return 'Email or password is incorrect';
  if (/email not confirmed/i.test(msg)) return 'Please confirm your email first — check your inbox for the link.';
  if (/already registered|already exists/i.test(msg)) return 'An account with this email already exists. Sign in instead.';
  if (/anonymous sign-ins are disabled/i.test(msg)) return 'Member sign-in is turned off on the server. (Enable anonymous sign-ins in Supabase → Authentication.)';
  if (/rate limit/i.test(msg)) return 'Too many attempts — please wait a few minutes and try again.';
  return msg;
}

/* ================= Realtime (Phoenix channels) ================= */
type ChangeCb = (c: { type: string; table: string; record: Record<string, unknown>; old_record?: Record<string, unknown> }) => void;
interface ChanState { topic: string; changes: { event: string; schema: string; table: string }[]; presenceKey: string; meta: Record<string, unknown> | null; joined: boolean; onChange: ChangeCb[]; onPresence: ((n: number) => void)[]; onStatus: ((s: string) => void)[]; presence: Map<string, Set<string>>; joinRef: string }

export class Realtime {
  private wsUrl: string;
  private tokenFn: () => Promise<string>;
  private ws: WebSocket | null = null;
  private ref = 0;
  private hb: ReturnType<typeof setInterval> | undefined;
  private retry = 0;
  private chans = new Map<string, ChanState>();
  private closedByUser = false;

  constructor(wsUrl: string, tokenFn: () => Promise<string>) { this.wsUrl = wsUrl; this.tokenFn = tokenFn; }

  channel(name: string, opts: { changes?: { event: string; table: string }[]; presence?: boolean } = {}) {
    const topic = `realtime:${name}`;
    const st: ChanState = {
      topic, changes: (opts.changes || []).map((c) => ({ ...c, schema: 'public' })), presenceKey: Math.random().toString(36).slice(2),
      meta: null, joined: false, onChange: [], onPresence: [], onStatus: [], presence: new Map(), joinRef: '',
    };
    this.chans.set(topic, st);
    this.closedByUser = false;
    if (this.ws?.readyState === WebSocket.OPEN) this.join(st); else this.connect();
    const api = {
      onChange: (cb: ChangeCb) => { st.onChange.push(cb); return api; },
      onPresence: (cb: (n: number) => void) => { st.onPresence.push(cb); return api; },
      onStatus: (cb: (s: string) => void) => { st.onStatus.push(cb); return api; },
      track: (meta: Record<string, unknown>) => { st.meta = meta; if (st.joined) this.push(topic, 'presence', { type: 'presence', event: 'track', payload: meta }); return api; },
      unsubscribe: () => {
        if (this.ws?.readyState === WebSocket.OPEN) this.push(topic, 'phx_leave', {});
        this.chans.delete(topic);
        if (!this.chans.size) this.disconnect();
      },
    };
    return api;
  }

  private connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    let ws: WebSocket;
    try { ws = new WebSocket(this.wsUrl); } catch { this.schedule(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      for (const st of this.chans.values()) this.join(st);
      clearInterval(this.hb);
      this.hb = setInterval(() => this.push('phoenix', 'heartbeat', {}), 25_000);
    };
    ws.onmessage = (ev) => { try { this.onMessage(JSON.parse(String(ev.data))); } catch { /* ignore */ } };
    ws.onclose = () => {
      clearInterval(this.hb);
      for (const st of this.chans.values()) { st.joined = false; st.presence.clear(); st.onPresence.forEach((f) => f(0)); st.onStatus.forEach((f) => f('closed')); }
      if (!this.closedByUser && this.chans.size) this.schedule();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }
  private schedule() { const d = Math.min(10_000, 1000 * 2 ** this.retry++); setTimeout(() => { if (this.chans.size && !this.closedByUser) this.connect(); }, d); }
  disconnect() { this.closedByUser = true; clearInterval(this.hb); try { this.ws?.close(); } catch { /* ignore */ } this.ws = null; }

  private async join(st: ChanState) {
    const token = await this.tokenFn().catch(() => undefined);
    st.joinRef = String(++this.ref);
    this.send({ topic: st.topic, event: 'phx_join', ref: st.joinRef, join_ref: st.joinRef, payload: {
      config: { broadcast: { ack: false, self: false }, presence: { key: st.presenceKey }, postgres_changes: st.changes, private: false },
      ...(token ? { access_token: token } : {}),
    } });
  }
  private push(topic: string, event: string, payload: unknown) { this.send({ topic, event, payload, ref: String(++this.ref) }); }
  private send(m: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }

  private onMessage(m: { topic: string; event: string; payload: Record<string, unknown>; ref: string | null }) {
    const st = this.chans.get(m.topic);
    if (!st) return;
    if (m.event === 'phx_reply' && m.ref === st.joinRef) {
      const ok = (m.payload as { status?: string }).status === 'ok';
      st.joined = ok;
      st.onStatus.forEach((f) => f(ok ? 'joined' : 'error'));
      if (ok && st.meta) this.push(st.topic, 'presence', { type: 'presence', event: 'track', payload: st.meta });
      return;
    }
    if (m.event === 'postgres_changes') {
      const d = (m.payload as { data?: { type: string; table: string; record: Record<string, unknown>; old_record?: Record<string, unknown> } }).data;
      if (d) st.onChange.forEach((f) => f(d));
      return;
    }
    if (m.event === 'presence_state') {
      st.presence.clear();
      for (const [k, v] of Object.entries(m.payload as Record<string, { metas: { phx_ref: string }[] }>)) st.presence.set(k, new Set(v.metas.map((x) => x.phx_ref)));
      st.onPresence.forEach((f) => f(st.presence.size));
      return;
    }
    if (m.event === 'presence_diff') {
      const { joins, leaves } = m.payload as { joins: Record<string, { metas: { phx_ref: string }[] }>; leaves: Record<string, { metas: { phx_ref: string }[] }> };
      for (const [k, v] of Object.entries(joins || {})) { const s = st.presence.get(k) || new Set(); v.metas.forEach((x) => s.add(x.phx_ref)); st.presence.set(k, s); }
      for (const [k, v] of Object.entries(leaves || {})) { const s = st.presence.get(k); if (!s) continue; v.metas.forEach((x) => s.delete(x.phx_ref)); if (!s.size) st.presence.delete(k); }
      st.onPresence.forEach((f) => f(st.presence.size));
      return;
    }
    if (m.event === 'system' || m.event === 'phx_error') st.onStatus.forEach((f) => f(m.event));
  }
}
