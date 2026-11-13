/**
 * Demo mode (PKO_CONFIG.demo = true): the app runs with no backend at all.
 * Content and media are bundled in the app (app/demo/), and everything a member
 * does — signing in with a name, Amens, comments, chat, testimonies — stays on
 * the device. Used for preview APKs before Supabase is connected.
 */
import { airings, SOURCES } from '../shared/channel.js';
import { getItem, setItem } from './native.js';
const KEY = 'pko.demo';
let seed = null;
let chapters = new Map();
const local = () => { try {
    return { amens: {}, comments: {}, chat: [], member: null, ...JSON.parse(getItem(KEY) || '{}') };
}
catch {
    return { amens: {}, comments: {}, chat: [], member: null };
} };
const saveLocal = (l) => setItem(KEY, JSON.stringify(l));
const uid = () => Math.random().toString(36).slice(2, 10);
const words = (paras) => paras.join(' ').split(/\s+/).filter(Boolean).length;
export async function demoBundle() {
    if (!seed) {
        const r = await fetch('demo/content.json');
        if (!r.ok)
            throw new Error('Demo content missing');
        seed = (await r.json());
    }
    const now = Date.now();
    const by = { posts: [], broadcasts: [], books: [], albums: [], events: [], testimonies: [], photos: [], schedule: [] };
    chapters = new Map();
    seed.items.forEach((it, i) => {
        const id = `${it.collection.slice(0, 2)}_${i}`;
        const d = { ...it.data, id, publishedAt: new Date(now - it.hoursAgo * 3600e3).toISOString() };
        if (it.collection === 'books') {
            const chs = (it.data.chapters || []).map((c, j) => ({ id: `ch${j}`, title: c.title, body: c.body }));
            chapters.set(id, chs);
            d.chapters = chs.map((c) => ({ id: c.id, title: c.title, words: words(c.body) }));
        }
        if (it.collection === 'albums')
            d.tracks = (it.data.tracks || []).map((t, j) => ({ audio: null, duration: null, ...t, id: `tr${j}` }));
        by[it.collection]?.push(d);
    });
    // Schedule slots name their past message by title ("@Christ the Rock").
    for (const s of by.schedule)
        if (typeof s.broadcast === 'string' && s.broadcast.startsWith('@'))
            s.broadcast = by.broadcasts.find((b) => b.title === s.broadcast.slice(1))?.id || null;
    const desc = (a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt));
    for (const k of ['posts', 'broadcasts', 'albums', 'testimonies', 'photos'])
        by[k].sort(desc);
    by.events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const l = local();
    const amens = {};
    for (const [t, on] of Object.entries(l.amens))
        if (on)
            amens[t] = 1;
    const comments = {};
    for (const [t, list] of Object.entries(l.comments))
        comments[t] = list.length;
    // The demo studio is "on air" during the schedule's live programmes, like the real channel
    // when vMix is streaming; the rest of the time the 24/7 channel plays replays.
    const live = { ...seed.live };
    const at = new Date();
    live.onAir = airings({ live, schedule: by.schedule, broadcasts: by.broadcasts }, at, new Date(at.getTime() + 1))
        .some((a) => (a.slot.source || SOURCES.live) === SOURCES.live && a.start <= at && at < a.end);
    return {
        version: live.onAir ? 2 : 1, settings: seed.settings, live,
        ...by,
        amens, comments,
    };
}
export async function demoChapter(book, chapter) {
    if (!chapters.size)
        await demoBundle();
    const list = chapters.get(book) || [];
    const index = list.findIndex((c) => c.id === chapter);
    if (index < 0)
        throw new Error('Chapter not found');
    return { ...list[index], index };
}
export const demoMyAmens = async () => Object.keys(local().amens).filter((k) => local().amens[k]);
export async function demoToggleAmen(target, on) {
    const l = local();
    if (on)
        l.amens[target] = true;
    else
        delete l.amens[target];
    saveLocal(l);
    return { on, count: on ? 1 : 0 };
}
export async function demoSignIn(name) {
    const n = name.replace(/\s+/g, ' ').trim();
    if (n.length < 2)
        throw new Error('Please enter your name');
    const l = local();
    l.member = { id: l.member?.id || 'demo_' + uid(), name: n };
    saveLocal(l);
    return l.member;
}
export async function demoSignOut() { const l = local(); l.member = null; saveLocal(l); }
export const demoComments = async (target) => local().comments[target] || [];
export async function demoPostComment(target, body, parentId) {
    const l = local();
    if (!l.member)
        throw Object.assign(new Error('Please sign in first'), { status: 401 });
    const b = body.trim();
    if (!b)
        throw new Error('Comment is empty');
    const list = l.comments[target] || [];
    const parent = parentId ? list.find((c) => c.id === parentId) : null;
    const c = { id: 'c_' + uid(), name: l.member.name, body: b.slice(0, 1000), parentId: parent ? parent.parentId || parent.id : null, createdAt: new Date().toISOString(), memberId: l.member.id, amens: 0 };
    l.comments[target] = [...list, c];
    saveLocal(l);
    return c;
}
export async function demoDeleteComment(id) {
    const l = local();
    for (const t of Object.keys(l.comments))
        l.comments[t] = l.comments[t].filter((c) => c.id !== id && c.parentId !== id);
    saveLocal(l);
}
/* ---------- live chat: your messages plus a simulated congregation ---------- */
const CROWD = [
    ['Pastor Ruth', 'Good morning family. Put your prayer points in the chat and we will pray over them.', true],
    ['Brenda M.', 'Amen from Douala'], ['Kwame A.', 'Watching from Kumasi with my whole house'], ['Joy O.', 'The Spirit of the Lord is upon me!'],
    ['Peter N.', 'Praying for my mother’s surgery today'], ['Aisha B.', 'Amen Amen'], ['Chris E.', 'Joined from London, God bless you Prophet'],
    ['Linda T.', 'I receive the anointing in Jesus’ name'], ['Samuel K.', 'Luke 4:18, this is my portion'], ['Esther F.', 'My exam is at 10, please pray'], ['Michael D.', 'Hallelujah!'],
];
let timer;
let n = 0;
const crowdMsg = (i) => { const [name, body, mod] = CROWD[i % CROWD.length]; return { id: -(i + 1), name, body, isMod: !!mod, createdAt: new Date().toISOString() }; };
export function demoChatStart(onMessage, onViewers) {
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
export async function demoPostChat(body) {
    const l = local();
    if (!l.member)
        throw Object.assign(new Error('Please sign in first'), { status: 401 });
    const m = { id: Date.now(), name: l.member.name, body: body.trim().slice(0, 300), isMod: false, createdAt: new Date().toISOString() };
    l.chat = [...l.chat, m].slice(-50);
    saveLocal(l);
    return m;
}
