import type { ServerResponse } from 'node:http';
import type { DB } from './db.ts';
import { nowIso } from './auth.ts';
import { HttpError } from './http.ts';

export interface ChatMessage { id: number; name: string; body: string; isMod: boolean; createdAt: string }

interface Client { res: ServerResponse; id: number }

/**
 * Live room: Server-Sent Events fan-out for chat messages, viewer counts and
 * on-air changes. SSE works through proxies, auto-reconnects in the browser and
 * needs no extra dependency.
 */
export class LiveHub {
  private clients = new Set<Client>();
  private seq = 0;
  private db: DB;
  private heartbeat: NodeJS.Timeout;
  private viewerTimer: NodeJS.Timeout | null = null;

  constructor(db: DB) {
    this.db = db;
    this.heartbeat = setInterval(() => this.write(': ping\n\n'), 20_000);
    this.heartbeat.unref();
  }

  get viewers(): number { return this.clients.size; }

  recent(limit = 40): ChatMessage[] {
    const rows = this.db.prepare('SELECT id, name, body, is_mod, created_at FROM chat WHERE deleted = 0 ORDER BY id DESC LIMIT ?').all(limit) as
      { id: number; name: string; body: string; is_mod: number; created_at: string }[];
    return rows.reverse().map((r) => ({ id: r.id, name: r.name, body: r.body, isMod: !!r.is_mod, createdAt: r.created_at }));
  }

  subscribe(res: ServerResponse, live: unknown): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const c: Client = { res, id: ++this.seq };
    this.clients.add(c);
    this.send(res, 'hello', { viewers: this.viewers, messages: this.recent(), live });
    this.scheduleViewers();
    res.on('close', () => { this.clients.delete(c); this.scheduleViewers(); });
  }

  post(name: string, body: unknown, opts: { memberId?: string | null; isMod?: boolean } = {}): ChatMessage {
    const text = typeof body === 'string' ? body.replace(/\s+/g, ' ').trim() : '';
    if (!text) throw new HttpError(400, 'Message is empty');
    if (text.length > 300) throw new HttpError(400, 'Messages can be up to 300 characters');
    const createdAt = nowIso();
    const r = this.db.prepare('INSERT INTO chat (member_id, name, body, is_mod, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(opts.memberId || null, name, text, opts.isMod ? 1 : 0, createdAt);
    const msg: ChatMessage = { id: Number(r.lastInsertRowid), name, body: text, isMod: !!opts.isMod, createdAt };
    this.broadcast('message', msg);
    // keep the table bounded
    this.db.prepare('DELETE FROM chat WHERE id < ?').run(msg.id - 5000);
    return msg;
  }

  remove(id: number): void {
    const r = this.db.prepare('UPDATE chat SET deleted = 1 WHERE id = ?').run(id);
    if (!r.changes) throw new HttpError(404, 'Message not found');
    this.broadcast('delete', { id });
  }

  broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.write(frame);
  }

  close(): void {
    clearInterval(this.heartbeat);
    if (this.viewerTimer) clearTimeout(this.viewerTimer);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }

  private send(res: ServerResponse, event: string, data: unknown) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  private write(frame: string) { for (const c of this.clients) c.res.write(frame); }
  /** Coalesce join/leave bursts into one viewer-count update. */
  private scheduleViewers() {
    if (this.viewerTimer) return;
    this.viewerTimer = setTimeout(() => { this.viewerTimer = null; this.broadcast('viewers', { viewers: this.viewers }); }, 400);
    this.viewerTimer.unref();
  }
}
