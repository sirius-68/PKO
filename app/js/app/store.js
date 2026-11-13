import { getItem, setItem } from './native.js';
import { todayIso } from './lib.js';
function load(k, fallback) {
    try {
        const s = getItem(k);
        return s ? JSON.parse(s) : fallback;
    }
    catch {
        return fallback;
    }
}
function persist(k, v) { setItem(k, JSON.stringify(v)); }
const now = new Date();
export const S = {
    data: null,
    tab: 'home',
    chan: null,
    sort: 'For you',
    lib: 'Books',
    tvPane: 'chat',
    tvNow: 'live', // 'live' or a broadcast id
    tvCat: 'All',
    gal: 'All',
    tst: 'All',
    blogFlair: 'All',
    calY: now.getFullYear(),
    calM: now.getMonth(),
    calSel: todayIso(),
    // persisted on the device
    amen: {},
    saved: {},
    reminders: {},
    reading: {},
    member: null,
    readerSize: 21,
};
export function hydrate() {
    S.amen = load('pko.amen', {});
    S.saved = load('pko.saved', {});
    S.reminders = load('pko.reminders', {});
    S.reading = load('pko.reading', {});
    S.member = load('pko.member', null);
    S.readerSize = load('pko.readerSize', 21);
}
export const save = {
    amen: () => persist('pko.amen', S.amen),
    saved: () => persist('pko.saved', S.saved),
    reminders: () => persist('pko.reminders', S.reminders),
    reading: () => persist('pko.reading', S.reading),
    member: () => persist('pko.member', S.member),
    readerSize: () => persist('pko.readerSize', S.readerSize),
};
export const STORAGE_KEYS = ['pko.session', 'pko.demo', 'pko.member', 'pko.amen', 'pko.saved', 'pko.reminders', 'pko.reading', 'pko.readerSize', 'pko.theme', 'pko.onboarded', 'pko.bundle'];
export function D() {
    if (!S.data)
        throw new Error('Content not loaded');
    return S.data;
}
