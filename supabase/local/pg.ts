/**
 * LOCAL TESTING ONLY — a tiny PostgreSQL wire-protocol client (trust auth, simple
 * queries, LISTEN/NOTIFY). It lets the local Supabase stand-in run without npm packages.
 */
import { connect, type Socket } from 'node:net';

export interface PgError extends Error { code: string; detail?: string; hint?: string }
type Row = Record<string, string | null>;

export class Pg {
  private sock!: Socket;
  private buf = Buffer.alloc(0);
  private queue: { sql: string; resolve: (r: Row[]) => void; reject: (e: unknown) => void }[] = [];
  private running = false;
  private rows: Row[] = [];
  private fields: string[] = [];
  private err: PgError | null = null;
  private ready!: () => void;
  onNotify: (channel: string, payload: string) => void = () => {};

  private opts: { host: string; port: number; user: string; database: string };
  constructor(opts: { host: string; port: number; user: string; database: string }) { this.opts = opts; }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ready = resolve;
      this.sock = connect(this.opts.port, this.opts.host, () => {
        const params = Buffer.from(`user\0${this.opts.user}\0database\0${this.opts.database}\0client_encoding\0UTF8\0\0`);
        const len = Buffer.alloc(8);
        len.writeInt32BE(8 + params.length, 0);
        len.writeInt32BE(196608, 4);
        this.sock.write(Buffer.concat([len, params]));
      });
      this.sock.on('data', (d) => this.onData(d));
      this.sock.on('error', reject);
    });
  }

  query(sql: string): Promise<Row[]> {
    return new Promise((resolve, reject) => { this.queue.push({ sql, resolve, reject }); this.pump(); });
  }

  close(): void { try { this.sock.write(Buffer.from([0x58, 0, 0, 0, 4])); this.sock.end(); } catch { /* closed */ } }

  private pump() {
    if (this.running || !this.queue.length) return;
    this.running = true;
    this.rows = []; this.err = null;
    const q = Buffer.from(this.queue[0].sql + '\0');
    const head = Buffer.alloc(5);
    head[0] = 0x51; head.writeInt32BE(4 + q.length, 1);
    this.sock.write(Buffer.concat([head, q]));
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 5) {
      const type = String.fromCharCode(this.buf[0]);
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) return;
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      this.handle(type, body);
    }
  }

  private handle(type: string, b: Buffer) {
    switch (type) {
      case 'R': if (b.readInt32BE(0) !== 0) throw new Error('Only trust auth is supported by the local test client'); break;
      case 'Z': // ReadyForQuery
        if (this.ready) { const r = this.ready; this.ready = undefined as unknown as () => void; r(); }
        if (this.running) {
          const job = this.queue.shift()!;
          this.running = false;
          if (this.err) job.reject(this.err); else job.resolve(this.rows);
          this.pump();
        }
        break;
      case 'T': { // RowDescription
        const n = b.readInt16BE(0); let o = 2; this.fields = []; this.rows = []; // keep only the last statement's rows
        for (let i = 0; i < n; i++) { const end = b.indexOf(0, o); this.fields.push(b.toString('utf8', o, end)); o = end + 1 + 18; }
        break;
      }
      case 'D': { // DataRow
        const n = b.readInt16BE(0); let o = 2; const row: Row = {};
        for (let i = 0; i < n; i++) { const l = b.readInt32BE(o); o += 4; row[this.fields[i]] = l < 0 ? null : b.toString('utf8', o, o + l); if (l > 0) o += l; }
        this.rows.push(row);
        break;
      }
      case 'E': { // ErrorResponse
        const f: Record<string, string> = {}; let o = 0;
        while (b[o] !== 0) { const code = String.fromCharCode(b[o]); const end = b.indexOf(0, o + 1); f[code] = b.toString('utf8', o + 1, end); o = end + 1; }
        const e = new Error(f.M) as PgError; e.code = f.C; e.detail = f.D; e.hint = f.H;
        this.err = e;
        break;
      }
      case 'A': { // NotificationResponse
        let o = 4; const e1 = b.indexOf(0, o); const ch = b.toString('utf8', o, e1); o = e1 + 1; const e2 = b.indexOf(0, o);
        this.onNotify(ch, b.toString('utf8', o, e2));
        break;
      }
      default: break; // S (params), K (key data), C (complete), N (notice), I (empty)
    }
  }
}

/** SQL string literal (standard_conforming_strings = on). */
export const lit = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.includes('\0')) throw new Error('NUL byte not allowed');
  return `'${s.replace(/'/g, "''")}'`;
};
