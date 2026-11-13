import { getItem, setItem } from './native.js';
import { Supa, SupaError } from '../shared/supa.js';
import * as demo from './demo.js';
/* ---------- Supabase connection ---------- */
const cfg = window.PKO_CONFIG || {};
/** Demo build: bundled content, everything stays on the device (see demo.ts). */
export const DEMO = !!cfg.demo;
export const supa = new Supa(cfg.supabaseUrl || '', cfg.supabaseAnonKey || '', { get: getItem, set: setItem }, 'pko.session');
export const ApiError = SupaError;
export const mediaUrl = (id) => (id ? (/^https?:\/\//.test(id) ? id : DEMO ? `demo/media/${id.split('/').pop()}` : supa.publicUrl(id)) : '');
/** Link that opens the web app on a given screen (shared from the native app too). */
export const shareUrl = (path) => `${(cfg.appUrl || location.origin + location.pathname).replace(/#.*$/, '')}#${path}`;
/** Guests get an anonymous Supabase account the first time they Amen something. */
async function ensureSession() {
    if (!supa.session)
        await supa.signInAnonymously();
}
/* ---------- content bundle with offline cache ---------- */
const CACHE_KEY = 'pko.bundle';
export function cachedBundle() {
    try {
        const s = getItem(CACHE_KEY);
        return s ? JSON.parse(s) : null;
    }
    catch {
        return null;
    }
}
export async function fetchBundle(current) {
    const b = DEMO ? await demo.demoBundle() : await supa.rpc('get_bundle', {}, { anon: !supa.session });
    try {
        setItem(CACHE_KEY, JSON.stringify(b));
    }
    catch { /* storage full: still usable in memory */ }
    const changed = !current || current.version !== b.version || JSON.stringify(current.amens) !== JSON.stringify(b.amens)
        || JSON.stringify(current.comments) !== JSON.stringify(b.comments) || JSON.stringify(current.live) !== JSON.stringify(b.live);
    return { bundle: b, changed };
}
/* ---------- reads ---------- */
export const getChapter = (book, chapter) => DEMO ? demo.demoChapter(book, chapter) : supa.rpc('get_chapter', { p_book: book, p_chapter: chapter });
export const getComments = (target) => DEMO ? demo.demoComments(target) : supa.rpc('get_comments', { p_target: target });
export const getLive = () => supa.rpc('get_live');
export async function myAmens() { return DEMO ? demo.demoMyAmens() : supa.session ? supa.rpc('my_amens') : []; }
/* ---------- member actions ---------- */
export async function signInMember(name, phone) {
    if (DEMO)
        return demo.demoSignIn(name);
    await ensureSession();
    try {
        return await supa.rpc('set_profile', { p_name: name, p_phone: phone || null });
    }
    catch (e) {
        // A stale session (e.g. project reset) — start fresh once.
        if (e instanceof SupaError && (e.status === 401 || e.status === 403)) {
            await supa.signOut();
            await supa.signInAnonymously();
            return supa.rpc('set_profile', { p_name: name, p_phone: phone || null });
        }
        throw e;
    }
}
export async function signOutMember() { if (DEMO)
    return demo.demoSignOut(); await supa.signOut(); }
export async function toggleAmen(target, on) {
    if (DEMO)
        return demo.demoToggleAmen(target, on);
    await ensureSession();
    return supa.rpc('toggle_amen', { p_target: target, p_on: on });
}
export const postComment = (target, body, parentId) => DEMO ? demo.demoPostComment(target, body, parentId) : supa.rpc('post_comment', { p_target: target, p_body: body, p_parent: parentId || null });
export const deleteComment = (id) => DEMO ? demo.demoDeleteComment(id) : supa.rpc('delete_comment', { p_id: id });
export const chatHooks = { local: (_m) => { } };
export async function postChat(body) {
    if (DEMO) {
        const m = await demo.demoPostChat(body);
        chatHooks.local(m);
        return m;
    }
    return supa.rpc('post_chat', { p_body: body });
}
export const submitTestimony = (t) => DEMO ? Promise.resolve({ id: 'demo', status: 'pending' }) : supa.rpc('submit_testimony', { p_title: t.title, p_body: t.body, p_place: t.place || null, p_name: t.name || null, p_video: t.video || null });
/** Members upload a testimony video into their own folder, then register it. */
export async function uploadTestimonyVideo(file, onProgress) {
    if (DEMO) {
        onProgress(1);
        return 'demo-video';
    }
    if (!supa.session)
        throw new SupaError(401, 'Please sign in first');
    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'mp4';
    const path = `members/${supa.session.user.id}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const type = file.type || (ext === 'mov' ? 'video/quicktime' : 'video/mp4');
    await supa.upload(path, file, onProgress, { contentType: type });
    await supa.rpc('register_member_upload', { p_path: path, p_mime: type, p_size: file.size, p_name: file.name });
    return path;
}
