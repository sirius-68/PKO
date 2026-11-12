import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, defaultConfig } from '../server/src/app.ts';
import { seed } from '../server/src/seed.ts';

export const ADMIN = { email: 'admin@test.local', password: 'correct-horse-battery' };

export async function startTestServer(opts: { seed?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pko-test-'));
  const cfg = { ...defaultConfig({ DATA_DIR: dir, LOG: '0' }), maxUploadBytes: 5e6, memberUploadMax: 2e6 };
  const app = createApp(cfg);
  seed(app.deps, { adminEmail: ADMIN.email, adminPassword: ADMIN.password, ...(opts.seed === false ? {} : {}) });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {
    base, app,
    async close() { await app.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export class Client {
  base: string;
  cookie = '';
  token = '';
  device = 'test-device-' + Math.random().toString(36).slice(2, 12).padEnd(10, 'x');
  constructor(base: string) { this.base = base; }
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { 'X-Device-Id': this.device, ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.token) h.Authorization = 'Bearer ' + this.token;
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) payload = body as unknown as BodyInit;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(this.base + path, { method, headers: h, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, headers: res.headers, text };
  }
  admin(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.req(method, path, body, { 'X-PKO-Admin': '1', ...headers });
  }
  async loginAdmin() {
    const r = await this.req('POST', '/api/admin/login', ADMIN);
    if (r.status !== 200) throw new Error('admin login failed ' + r.status);
    return r;
  }
  async signUp(name = 'Grace Test') {
    const r = await this.req('POST', '/api/members', { name, phone: '+237 600 000 000' });
    this.token = r.json.token;
    return r;
  }
}

/** Minimal valid files for upload tests. */
export const FILES = {
  png: new Uint8Array(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4540000000049454e44ae426082', 'hex')),
  wav(seconds = 1) {
    const rate = 8000, n = rate * seconds, buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), 44 + i * 2);
    return new Uint8Array(buf);
  },
};
