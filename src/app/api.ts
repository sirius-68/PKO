import { getItem, setItem } from './native.js';
import { Supa, SupaError } from '../shared/supa.js';
import * as demo from './demo.js';

/* ---------- content types (mirror src/shared/schema.ts) ---------- */
interface Base { id: string; publishedAt: string }
export interface Post extends Base { title: string; flair: string; verse: string | null; ref: string | null; body: string[]; image: string | null; imagePos: string | null }
export interface Broadcast extends Base { title: string; ref: string | null; category: string; video: string | null; url: string | null; poster: string; duration?: number | null }
export interface Chapter { id: string; title: string; words: number }
export interface Book extends Base { title: string; description: string; year: number | null; pages: number | null; image: string; imagePos: string | null; pdf: string | null; chapters: Chapter[] }
export interface Track { id: string; title: string; audio: string | null; duration: number | null }
export interface Album extends Base { title: string; artist: string; year: number | null; image: string; imagePos: string | null; tracks: Track[] }
export interface EventItem extends Base { title: string; date: string; time: string; place: string; description: string; image: string | null; imagePos: string | null }
export interface Testimony extends Base { title: string; name: string; place: string | null; quote: string | null; body: string[]; video: string | null }
export interface Photo extends Base { image: string; caption: string; album: string }
export interface Slot extends Base { time: string; end?: string | null; days?: string | null; title: string; subtitle: string | null; source?: string | null; broadcast?: string | null }
export interface Settings { appName: string; ministry: string; tvName: string; recordsName: string; leader: string; aboutText: string; aboutVerse: string; aboutVerseRef: string; logo: string | null; leaderPhoto: string | null }
export interface Live {
  onAir: boolean; title: string; ref: string | null; video: string | null; url: string | null; poster: string | null;
  /** 24/7 channel: schedule time zone, keep playing between live programmes. */
  timezone?: string | null; channel24?: boolean; status?: string | null; programme?: string | null;
}
export interface Bundle {
  version: number; settings: Settings; live: Live;
  posts: Post[]; broadcasts: Broadcast[]; books: Book[]; albums: Album[]; events: EventItem[]; testimonies: Testimony[]; photos: Photo[]; schedule: Slot[];
  amens: Record<string, number>; comments: Record<string, number>;
}
export interface Comment { id: string; name: string; body: string; parentId: string | null; createdAt: string; memberId: string; amens: number }
export interface ChatMsg { id: number; name: string; body: string; isMod: boolean; createdAt: string }
export interface Member { id: string; name: string }

/* ---------- Supabase connection ---------- */
const cfg = (window as unknown as { PKO_CONFIG?: { supabaseUrl?: string; supabaseAnonKey?: string; appUrl?: string; demo?: boolean } }).PKO_CONFIG || {};
/** Demo build: bundled content, everything stays on the device (see demo.ts). */
export const DEMO = !!cfg.demo;
export const supa = new Supa(cfg.supabaseUrl || '', cfg.supabaseAnonKey || '', { get: getItem, set: setItem }, 'pko.session');
export const ApiError = SupaError;
export type ApiError = SupaError;

export const mediaUrl = (id: string | null | undefined): string => (id ? (/^https?:\/\//.test(id) ? id : DEMO ? `demo/media/${id.split('/').pop()}` : supa.publicUrl(id)) : '');
/** Link that opens the web app on a given screen (shared from the native app too). */
export const shareUrl = (path: string): string => `${(cfg.appUrl || location.origin + location.pathname).replace(/#.*$/, '')}#${path}`;

/** Guests get an anonymous Supabase account the first time they Amen something. */
async function ensureSession(): Promise<void> {
  if (!supa.session) await supa.signInAnonymously();
}

/* ---------- content bundle with offline cache ---------- */
const CACHE_KEY = 'pko.bundle';
export function cachedBundle(): Bundle | null {
  try { const s = getItem(CACHE_KEY); return s ? (JSON.parse(s) as Bundle) : null; } catch { return null; }
}
export async function fetchBundle(current: Bundle | null): Promise<{ bundle: Bundle; changed: boolean }> {
  const b = DEMO ? await demo.demoBundle() : await supa.rpc<Bundle>('get_bundle', {}, { anon: !supa.session });
  try { setItem(CACHE_KEY, JSON.stringify(b)); } catch { /* storage full: still usable in memory */ }
  const changed = !current || current.version !== b.version || JSON.stringify(current.amens) !== JSON.stringify(b.amens)
    || JSON.stringify(current.comments) !== JSON.stringify(b.comments) || JSON.stringify(current.live) !== JSON.stringify(b.live);
  return { bundle: b, changed };
}

/* ---------- reads ---------- */
export const getChapter = (book: string, chapter: string) => DEMO ? demo.demoChapter(book, chapter) : supa.rpc<{ id: string; title: string; body: string[]; index: number }>('get_chapter', { p_book: book, p_chapter: chapter });
export const getComments = (target: string) => DEMO ? demo.demoComments(target) : supa.rpc<Comment[]>('get_comments', { p_target: target });
export const getLive = () => supa.rpc<{ live: Live; messages: ChatMsg[] }>('get_live');
export async function myAmens(): Promise<string[]> { return DEMO ? demo.demoMyAmens() : supa.session ? supa.rpc<string[]>('my_amens') : []; }

/* ---------- member actions ---------- */
export async function signInMember(name: string, phone: string): Promise<Member> {
  if (DEMO) return demo.demoSignIn(name);
  await ensureSession();
  try { return await supa.rpc<Member>('set_profile', { p_name: name, p_phone: phone || null }); }
  catch (e) {
    // A stale session (e.g. project reset) — start fresh once.
    if (e instanceof SupaError && (e.status === 401 || e.status === 403)) { await supa.signOut(); await supa.signInAnonymously(); return supa.rpc<Member>('set_profile', { p_name: name, p_phone: phone || null }); }
    throw e;
  }
}
export async function signOutMember(): Promise<void> { if (DEMO) return demo.demoSignOut(); await supa.signOut(); }
export async function toggleAmen(target: string, on: boolean): Promise<{ on: boolean; count: number }> {
  if (DEMO) return demo.demoToggleAmen(target, on);
  await ensureSession();
  return supa.rpc('toggle_amen', { p_target: target, p_on: on });
}
export const postComment = (target: string, body: string, parentId?: string | null) => DEMO ? demo.demoPostComment(target, body, parentId) : supa.rpc<Comment>('post_comment', { p_target: target, p_body: body, p_parent: parentId || null });
export const deleteComment = (id: string) => DEMO ? demo.demoDeleteComment(id) : supa.rpc('delete_comment', { p_id: id });
export const chatHooks = { local: (_m: ChatMsg) => {} };
export async function postChat(body: string): Promise<ChatMsg> {
  if (DEMO) { const m = await demo.demoPostChat(body); chatHooks.local(m); return m; }
  return supa.rpc<ChatMsg>('post_chat', { p_body: body });
}
export const submitTestimony = (t: { title: string; body: string; name?: string; place?: string; video?: string | null }) =>
  DEMO ? Promise.resolve({ id: 'demo', status: 'pending' }) : supa.rpc<{ id: string; status: string }>('submit_testimony', { p_title: t.title, p_body: t.body, p_place: t.place || null, p_name: t.name || null, p_video: t.video || null });

/** Members upload a testimony video into their own folder, then register it. */
export async function uploadTestimonyVideo(file: File, onProgress: (p: number) => void): Promise<string> {
  if (DEMO) { onProgress(1); return 'demo-video'; }
  if (!supa.session) throw new SupaError(401, 'Please sign in first');
  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'mp4';
  const path = `members/${supa.session.user.id}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const type = file.type || (ext === 'mov' ? 'video/quicktime' : 'video/mp4');
  await supa.upload(path, file, onProgress, { contentType: type });
  await supa.rpc('register_member_upload', { p_path: path, p_mime: type, p_size: file.size, p_name: file.name });
  return path;
}
