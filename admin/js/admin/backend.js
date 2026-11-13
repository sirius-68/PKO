/**
 * The dashboard's data layer on Supabase. The UI talks in simple REST-style
 * requests ("GET /items/posts"); this module maps each one onto the database
 * functions in supabase/migrations (admin_list, admin_save, …) and Storage.
 */
import { Supa, SupaError } from '../shared/supa.js';
import { COLLECTIONS, LIVE_FIELDS, SETTINGS_FIELDS } from '../shared/schema.js';
const cfg = window.PKO_CONFIG || {};
const store = {
    get: (k) => { try {
        return localStorage.getItem(k);
    }
    catch {
        return null;
    } },
    set: (k, v) => { try {
        if (v === null)
            localStorage.removeItem(k);
        else
            localStorage.setItem(k, v);
    }
    catch { /* private mode */ } },
};
export const supa = new Supa(cfg.supabaseUrl || '', cfg.supabaseAnonKey || '', store, 'pko.studio.session');
export const APP_URL = cfg.appUrl || new URL('../app/', location.href).href;
export const ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/quicktime', 'video/webm',
    'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/flac', 'application/pdf'];
/** Supabase free plan: 50 MB per file. Raise this when you upgrade (and in the bucket settings). */
export const MAX_UPLOAD_BYTES = Number(cfg.maxUploadMb || 50) * 1e6;
export class NotAdminError extends Error {
    hasOwner;
    email;
    constructor(hasOwner, email) { super('not admin'); this.hasOwner = hasOwner; this.email = email; }
}
const META_KEYS = new Set(['id', 'status', 'publishedAt', 'sort', 'createdAt', 'updatedAt', 'memberId', 'amens', 'commentCount']);
const splitMeta = (b) => {
    const data = {};
    for (const [k, v] of Object.entries(b))
        if (!META_KEYS.has(k))
            data[k] = v;
    return { data, status: b.status || null, publishedAt: b.publishedAt || null };
};
/** REST-style facade over the Supabase RPCs. */
export async function request(method, path, body) {
    const url = new URL(path, 'http://x');
    const p = url.pathname.replace(/^\/api\/admin/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const q = url.searchParams;
    const r = supa.rpc.bind(supa);
    const key = `${method} /${p[0] || ''}${p.length > 1 ? '/' + (p[0] === 'items' ? (p.length === 2 ? ':c' : p[2] === 'reorder' ? ':c/reorder' : ':c/:id') : p[0] === 'media' && p[2] === 'usage' ? ':id/usage' : p[0] === 'members' ? ':id/ban' : ':id') : ''}`;
    switch (key) {
        case 'POST /login': {
            await supa.signIn(String(body?.email || '').trim(), String(body?.password || ''));
            const me = await r('admin_me');
            if (!me)
                throw new NotAdminError(await r('dashboard_has_owner'), supa.session?.user.email || '');
            return { admin: me };
        }
        case 'POST /logout':
            await supa.signOut();
            return { ok: true };
        case 'GET /me': {
            if (!supa.session || supa.session.user.is_anonymous)
                throw new SupaError(401, 'Please sign in');
            const me = await r('admin_me');
            if (!me)
                throw new SupaError(401, 'Please sign in');
            return { admin: me };
        }
        case 'GET /schema': return { collections: COLLECTIONS, settings: SETTINGS_FIELDS, live: LIVE_FIELDS, accept: ACCEPT, maxUploadBytes: MAX_UPLOAD_BYTES };
        case 'GET /stats': return { viewers: 0, ...(await r('admin_stats')) };
        case 'GET /items/:c': return { items: await r('admin_list', { p_collection: p[1], p_status: q.get('status') || 'all' }) };
        case 'GET /items/:c/:id': return { item: await r('admin_get', { p_collection: p[1], p_id: p[2] }) };
        case 'POST /items/:c': {
            const m = splitMeta(body || {});
            return { item: await r('admin_save', { p_collection: p[1], p_id: null, p_data: m.data, p_status: m.status, p_published_at: m.publishedAt }) };
        }
        case 'PATCH /items/:c/:id': {
            const m = splitMeta(body || {});
            return { item: await r('admin_save', { p_collection: p[1], p_id: p[2], p_data: m.data, p_status: m.status, p_published_at: m.publishedAt }) };
        }
        case 'DELETE /items/:c/:id': return r('admin_delete', { p_collection: p[1], p_id: p[2] });
        case 'POST /items/:c/reorder': return r('admin_reorder', { p_collection: p[1], p_ids: body?.ids || [] });
        case 'GET /media': return { media: await r('admin_list_media', { p_kind: q.get('kind') || null }) };
        case 'GET /media/:id/usage': return { usedBy: await r('admin_media_usage', { p_id: p[1] }) };
        case 'DELETE /media/:id': {
            await r('admin_delete_media', { p_id: p[1], p_force: q.get('force') === '1' });
            await supa.remove([p[1]]).catch(() => { }); // registry row is gone; a leftover object is harmless
            return { ok: true };
        }
        case 'GET /settings': return { settings: (await r('get_settings')).settings };
        case 'PUT /settings': return { settings: await r('admin_save_settings', { p: body || {} }) };
        case 'GET /live': return { live: (await r('get_settings')).live, viewers: 0 };
        case 'PUT /live': return { live: await r('admin_save_live', { p: body || {} }) };
        case 'GET /comments': return { comments: await r('admin_comments', { p_q: q.get('q') || null }) };
        case 'DELETE /comments/:id': return r('admin_delete_comment', { p_id: p[1] });
        case 'GET /chat': return { messages: (await r('get_live')).messages, viewers: 0 };
        case 'POST /chat': return { message: await r('admin_chat_post', { p_body: body?.body, p_name: body?.name || null }) };
        case 'DELETE /chat/:id': return r('admin_chat_delete', { p_id: Number(p[1]) });
        case 'GET /members': return { members: await r('admin_members') };
        case 'POST /members/:id/ban': return r('admin_ban', { p_user: p[1], p_banned: !!body?.banned });
        case 'GET /admins': return { admins: await r('admin_team') };
        case 'POST /admins': return { admin: await r('admin_grant', { p_email: body?.email, p_name: body?.name }) };
        case 'DELETE /admins/:id': return r('admin_revoke', { p_user: p[1] });
        case 'POST /password': {
            const next = String(body?.next || '');
            if (next.length < 10)
                throw new SupaError(400, 'New password must be at least 10 characters');
            const email = supa.session?.user.email;
            if (!email)
                throw new SupaError(401, 'Please sign in');
            try {
                await supa.signIn(email, String(body?.current || ''));
            }
            catch {
                throw new SupaError(400, 'Current password is incorrect');
            }
            await supa.updatePassword(next);
            return { ok: true };
        }
    }
    throw new SupaError(404, `Unknown dashboard request: ${key}`);
}
/* ---------- account creation & first owner ---------- */
export async function createAccount(email, password, name) {
    if (password.length < 10)
        throw new SupaError(400, 'Use a password of at least 10 characters');
    const s = await supa.signUp(email.trim(), password, { name });
    return s ? 'signed-in' : 'confirm-email';
}
export const claimOwner = (name) => supa.rpc('claim_first_admin', { p_name: name });
const EXT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', pdf: 'application/pdf' };
/** Reads the first bytes so a renamed file (e.g. a .exe called .jpg) is refused before upload. */
async function sniffOk(file, type) {
    const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const s = (a, z) => String.fromCharCode(...b.slice(a, z));
    if (type === 'image/jpeg')
        return b[0] === 0xff && b[1] === 0xd8;
    if (type === 'image/png')
        return s(1, 4) === 'PNG';
    if (type === 'image/webp')
        return s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP';
    if (type === 'image/gif')
        return s(0, 3) === 'GIF';
    if (type === 'application/pdf')
        return s(0, 5) === '%PDF-';
    if (type === 'audio/wav' || type === 'audio/x-wav')
        return s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE';
    if (type === 'audio/mpeg')
        return s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    if (type === 'audio/ogg')
        return s(0, 4) === 'OggS';
    if (type === 'audio/flac')
        return s(0, 4) === 'fLaC';
    if (type === 'video/webm')
        return b[0] === 0x1a && b[1] === 0x45;
    if (/^(video\/(mp4|quicktime)|audio\/(mp4|x-m4a)|image\/avif)$/.test(type))
        return ['ftyp', 'moov', 'wide', 'mdat', 'free'].includes(s(4, 8));
    return true;
}
export async function uploadFile(file, onProgress) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const type = file.type && ACCEPT.includes(file.type) ? file.type : EXT_TYPES[ext];
    if (!type || !ACCEPT.includes(type))
        throw new SupaError(415, `This file type isn't supported (${file.type || ext || 'unknown'}). Use JPG, PNG, WebP, MP4, MP3, M4A, WAV or PDF.`);
    if (file.size === 0)
        throw new SupaError(400, 'The file is empty');
    if (file.size > MAX_UPLOAD_BYTES)
        throw new SupaError(413, `This file is ${(file.size / 1e6).toFixed(0)} MB — the limit is ${(MAX_UPLOAD_BYTES / 1e6).toFixed(0)} MB. For long videos, use a streaming link instead.`);
    if (!(await sniffOk(file, type)))
        throw new SupaError(415, "The file's contents don't match its type. Re-export it and try again.");
    const d = new Date();
    const safe = file.name.replace(/\.[^.]+$/, '').normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'file';
    const path = `uploads/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-${safe}.${ext || type.split('/')[1]}`;
    await supa.upload(path, file, onProgress, { contentType: type });
    return supa.rpc('admin_register_media', { p_id: path, p_mime: type, p_size: file.size, p_name: file.name });
}
export const mediaUrl = (id) => (/^https:\/\//.test(id) ? id : supa.publicUrl(id));
export { SupaError };
