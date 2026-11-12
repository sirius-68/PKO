import { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DB } from './db.ts';
import { HttpError, parseCookies } from './http.ts';

export const ADMIN_COOKIE = 'pko_admin';
const SESSION_DAYS = 14;

export const newId = (prefix = ''): string => prefix + randomUUID().replace(/-/g, '').slice(0, 16);
export const nowIso = (): string => new Date().toISOString();
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

export function validatePassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
  if (pw.length > 200) throw new HttpError(400, 'Password is too long');
  return pw;
}

/* ---------------- admins ---------------- */

export interface Admin { id: string; email: string; name: string }
let DUMMY_HASH: string | undefined;

export function createAdmin(db: DB, email: string, name: string, password: string): Admin {
  const id = newId('adm_');
  db.prepare('INSERT INTO admins (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, email.trim().toLowerCase(), name.trim(), hashPassword(validatePassword(password)), nowIso());
  return { id, email: email.trim().toLowerCase(), name: name.trim() };
}

export function loginAdmin(db: DB, email: string, password: string): { token: string; admin: Admin } {
  const row = db.prepare('SELECT id, email, name, password_hash FROM admins WHERE email = ?').get(String(email || '').trim()) as
    | { id: string; email: string; name: string; password_hash: string } | undefined;
  // Always run a full-cost hash so response time doesn't reveal whether the email exists.
  DUMMY_HASH ??= hashPassword('not-a-real-password');
  const ok = row ? verifyPassword(String(password || ''), row.password_hash) : (verifyPassword(String(password || ''), DUMMY_HASH), false);
  if (!row || !ok) throw new HttpError(401, 'Email or password is incorrect');
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO admin_sessions (token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha256(token), row.id, expires, nowIso());
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(nowIso());
  return { token, admin: { id: row.id, email: row.email, name: row.name } };
}

export function adminFromRequest(db: DB, req: IncomingMessage): Admin | null {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT a.id, a.email, a.name FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), nowIso()) as Admin | undefined;
  return row || null;
}

export function requireAdmin(db: DB, req: IncomingMessage): Admin {
  const a = adminFromRequest(db, req);
  if (!a) throw new HttpError(401, 'Please sign in');
  // CSRF defence: state-changing admin calls must come from our own JS (custom header can't be sent cross-site without CORS preflight).
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-pko-admin'] !== '1') throw new HttpError(403, 'Missing admin request header');
  return a;
}

export function logoutAdmin(db: DB, req: IncomingMessage): void {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}
export function clearCookie(secure: boolean): string {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

/* ---------------- members ---------------- */

export interface Member { id: string; name: string; phone: string | null; banned: number }

export function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (s.length < 2) throw new HttpError(400, 'Please enter your name');
  if (s.length > 60) throw new HttpError(400, 'Name must be 60 characters or fewer');
  return s;
}

export function cleanPhone(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).replace(/[\s().-]/g, '');
  if (!/^\+?\d{6,16}$/.test(s)) throw new HttpError(400, 'Please enter a valid phone number');
  return s;
}

/**
 * Creates a member and a bearer token. Phone numbers are stored for the ministry's
 * records but NOT used as a login identifier until an SMS-OTP provider is configured,
 * so nobody can take over another person's account by typing their number.
 */
export function registerMember(db: DB, name: unknown, phone: unknown): { token: string; member: Member } {
  const member: Member = { id: newId('mem_'), name: cleanName(name), phone: cleanPhone(phone), banned: 0 };
  db.prepare('INSERT INTO members (id, name, phone, created_at) VALUES (?, ?, ?, ?)').run(member.id, member.name, member.phone, nowIso());
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO member_tokens (token_hash, member_id, created_at) VALUES (?, ?, ?)').run(sha256(token), member.id, nowIso());
  return { token, member };
}

export function memberFromRequest(db: DB, req: IncomingMessage): Member | null {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const row = db.prepare(`SELECT m.id, m.name, m.phone, m.banned FROM member_tokens t JOIN members m ON m.id = t.member_id WHERE t.token_hash = ?`)
    .get(sha256(h.slice(7).trim())) as Member | undefined;
  return row || null;
}

export function requireMember(db: DB, req: IncomingMessage): Member {
  const m = memberFromRequest(db, req);
  if (!m) throw new HttpError(401, 'Please sign in first');
  if (m.banned) throw new HttpError(403, 'Your account cannot post right now. Contact the media team.');
  return m;
}

export function signOutMember(db: DB, req: IncomingMessage): void {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) db.prepare('DELETE FROM member_tokens WHERE token_hash = ?').run(sha256(h.slice(7).trim()));
}

/** Guests get a random device id from the app; it identifies their Amens without an account. */
export function actorFromRequest(db: DB, req: IncomingMessage): string {
  const m = memberFromRequest(db, req);
  if (m) return 'm:' + m.id;
  const dev = req.headers['x-device-id'];
  if (typeof dev === 'string' && /^[a-zA-Z0-9-]{16,64}$/.test(dev)) return 'd:' + dev;
  throw new HttpError(400, 'Missing device id');
}
