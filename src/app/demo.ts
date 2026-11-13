/**
 * Demo mode (PKO_CONFIG.demo = true): the app runs with no backend at all.
 * Content and media are bundled in the app (app/demo/), and everything a member
 * does — signing in with a name, Amens, comments, chat, testimonies — stays on
 * the device. Used for preview APKs before Supabase is connected.
 */
import { getItem, setItem } from './native.js';
import type { Bundle, ChatMsg, Comment, Member } from './api.js';

interface SeedItem { collection: string; hoursAgo: number; data: Record<string, unknown> }
interface Seed { settings: Record<string, unknown>; live: Record<string, unknown>; items: SeedItem[] }
interface Local { amens: Record<string, boolean>; comments: Record<string, Comment[]>; chat: ChatMsg[]; member: Member | null }

const KEY = 'pko.demo';
let seed: Seed | null = null;
let chapters = new Map<string, { id: string; title: string; body: string[] }[]>();
const local = (): Local => { try { return { amens: {}, comments: {}, chat: [], member: null, ...JSON.parse(getItem(KEY) || '{}') }; } catch { return { amens: {}, comments: {}, chat: [], member: null }; } };
const saveLocal = (l: Local) => setItem(KEY, JSON.stringify(l));
const uid = () => Math.random().toString(36).slice(2, 10);
const words = (paras: string[]) => paras.join(' ').split(/\s+/).filter(Boolean).length;

export async function demoBundle(): Promise<Bundle> {
  if (!seed) {
    const r = await fetch('demo/content.json');
    if (!r.ok) throw new Error('Demo content missing');
    seed = (await r.json()) as Seed;
  }
  const now = Date.now();
  const by: Record<string, Record<string, unknown>[]> = { posts: [], broadcasts: [], books: [], albums: [], events: [], testimonies: [], photos: [], schedule: [] };
  chapters = new Map();
  seed.items.forEach((it, i) => {
    const id = `${it.collection.slice(0, 2)}_${i}`;
    const d: Record<string, unknown> = { ...it.data, id, publishedAt: new Date(now - it.hoursAgo * 3600e3).toISOString() };
    if (it.collection === 'books') {
      const chs = ((it.data.chapters as { title: string; body: string[] }[]) || []).map((c, j) => ({ id: `ch${j}`, title: c.title, body: c.body }));
      chapters.set(id, chs);
      d.chapters = chs.map((c) => ({ id: c.id, title: c.title, words: words(c.body) }));
    }
    if (it.collection === 'albums') d.tracks = ((it.data.tracks as Record<string, unknown>[]) || []).map((t, j) => ({ audio: null, duration: null, ...t, id: `tr${j}` }));
    by[it.collection]?.push(d);
  });
  const desc = (a: Record<string, unknown>, b: Record<string, unknown>) => String(b.publishedAt).localeCompare(String(a.publishedAt));
  for (const k of ['posts', 'broadcasts', 'albums', 'testimonies', 'photos']) by[k].sort(desc);
  by.events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const l = local();
  const amens: Record<string, number> = {};
  for (const [t, on] of Object.entries(l.amens)) if (on) amens[t] = 1;
  const comments: Record<string, number> = {};
  for (const [t, list] of Object.entries(l.comments)) comments[t] = list.length;
  return {
    version: 1, settings: seed.settings as unknown as Bundle['settings'], live: seed.live as unknown as Bundle['live'],
    ...(by as unknown as Pick<Bundle, 'posts' | 'broadcasts' | 'books' | 'albums' | 'events' | 'testimonies' | 'photos' | 'schedule'>),
    amens, comments,
  };
}

export async function demoChapter(book: string, chapter: string) {
  if (!chapters.size) await demoBundle();
  const list = chapters.get(book) || [];
  const index = list.findIndex((c) => c.id === chapter);
  if (index < 0) throw new Error('Chapter not found');
  return { ...list[index], index };
}

export const demoMyAmens = async () => Object.keys(local().amens).filter((k) => local().amens[k]);
export async function demoToggleAmen(target: string, on: boolean) {
  const l = local();
  if (on) l.amens[target] = true; else delete l.amens[target];
  saveLocal(l);
  return { on, count: on ? 1 : 0 };
}

export async function demoSignIn(name: string): Promise<Member> {
  const n = name.replace(/\s+/g, ' ').trim();
  if (n.length < 2) throw new Error('Please enter your name');
  const l = local();
  l.member = { id: l.member?.id || 'demo_' + uid(), name: n };
  saveLocal(l);
  return l.member;
}
export async function demoSignOut() { const l = local(); l.member = null; saveLocal(l); }

export const demoComments = async (target: string) => local().comments[target] || [];
export async function demoPostComment(target: string, body: string, parentId?: string | null): Promise<Comment> {
  const l = local();
  if (!l.member) throw Object.assign(new Error('Please sign in first'), { status: 401 });
  const b = body.trim();
  if (!b) throw new Error('Comment is empty');
  const list = l.comments[target] || [];
  const parent = parentId ? list.find((c) => c.id === parentId) : null;
  const c: Comment = { id: 'c_' + uid(), name: l.member.name, body: b.slice(0, 1000), parentId: parent ? parent.parentId || parent.id : null, createdAt: new Date().toISOString(), memberId: l.member.id, amens: 0 };
  l.comments[target] = [...list, c];
  saveLocal(l);
  return c;
}
export async function demoDeleteComment(id: string) {
  const l = local();
  for (const t of Object.keys(l.comments)) l.comments[t] = l.comments[t].filter((c) => c.id !== id && c.parentId !== id);
  saveLocal(l);
}

/* ---------- live chat: your messages plus a simulated congregation ---------- */
const CROWD: [string, string, boolean?][] = [
  ['Pastor Ruth', 'Good morning family. Put your prayer points in the chat and we will pray over them.', true],
  ['Brenda M.', 'Amen from Douala'], ['Kwame A.', 'Watching from Kumasi with my whole house'], ['Joy O.', 'The Spirit of the Lord is upon me!'],
  ['Peter N.', 'Praying for my mother’s surgery today'], ['Aisha B.', 'Amen Amen'], ['Chris E.', 'Joined from London, God bless you Prophet'],
  ['Linda T.', 'I receive the anointing in Jesus’ name'], ['Samuel K.', 'Luke 4:18, this is my portion'], ['Esther F.', 'My exam is at 10, please pray'], ['Michael D.', 'Hallelujah!'],
];
let timer: ReturnType<typeof setInterval> | undefined;
let n = 0;
const crowdMsg = (i: number): ChatMsg => { const [name, body, mod] = CROWD[i % CROWD.length]; return { id: -(i + 1), name, body, isMod: !!mod, createdAt: new Date().toISOString() }; };

export function demoChatStart(onMessage: (m: ChatMsg) => void, onViewers: (n: number) => void): ChatMsg[] {
  let viewers = 2418;
  onViewers(viewers);
  const initial = [0, 1, 2, 3, 4].map(crowdMsg);
  n = 5;
  clearInterval(timer);
  timer = setInterval(() => {
    viewers += Math.round((Math.random() - 0.35) * 9);
    onViewers(viewers);
    onMessage(crowdMsg(n++));
  }, 4200);
  return [...initial, ...local().chat.slice(-10)];
}
export function demoChatStop() { clearInterval(timer); timer = undefined; }
export async function demoPostChat(body: string): Promise<ChatMsg> {
  const l = local();
  if (!l.member) throw Object.assign(new Error('Please sign in first'), { status: 401 });
  const m: ChatMsg = { id: Date.now(), name: l.member.name, body: body.trim().slice(0, 300), isMod: false, createdAt: new Date().toISOString() };
  l.chat = [...l.chat, m].slice(-50);
  saveLocal(l);
  return m;
}
