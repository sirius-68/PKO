import type { Bundle, Member } from './api.js';
import { getItem, setItem } from './native.js';
import { todayIso } from './lib.js';

export type Tab = 'home' | 'tv' | 'library' | 'events';
export type Channel = 'blog' | 'gallery' | 'testimonies' | null;

function load<T>(k: string, fallback: T): T {
  try { const s = getItem(k); return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
}
function persist(k: string, v: unknown): void { setItem(k, JSON.stringify(v)); }

export interface SavedRef { kind: 'post' | 'book' | 'album' | 'broadcast' | 'testimony' | 'event'; id: string; at: string }
export interface ReadPos { chapter: number; pct: number; at?: number }

const now = new Date();
export const S = {
  data: null as Bundle | null,
  tab: 'home' as Tab,
  chan: null as Channel,
  sort: 'For you',
  lib: 'Books',
  tvPane: 'chat',
  tvNow: 'live',   // 'live' or a broadcast id
  tvCat: 'All',
  gal: 'All',
  tst: 'All',
  blogFlair: 'All',
  calY: now.getFullYear(),
  calM: now.getMonth(),
  calSel: todayIso(),
  // persisted on the device
  amen: {} as Record<string, boolean>,
  saved: {} as Record<string, SavedRef>,
  reminders: {} as Record<string, boolean>,
  reading: {} as Record<string, ReadPos>,
  member: null as Member | null,
  readerSize: 21,
};

export function hydrate(): void {
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

export const STORAGE_KEYS = ['pko.session', 'pko.member', 'pko.amen', 'pko.saved', 'pko.reminders', 'pko.reading', 'pko.readerSize', 'pko.theme', 'pko.onboarded', 'pko.bundle'];

export function D(): Bundle {
  if (!S.data) throw new Error('Content not loaded');
  return S.data;
}
