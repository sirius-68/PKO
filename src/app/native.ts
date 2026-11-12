/**
 * Thin bridge to Capacitor's native plugins. Every call feature-detects the plugin
 * on window.Capacitor.Plugins and falls back to a web API, so the same build runs
 * in the iOS/Android shells and in a browser (PWA).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyPlugin = Record<string, (...a: any[]) => Promise<any>> & { addListener?: (ev: string, cb: (e: any) => void) => Promise<{ remove: () => void }> | { remove: () => void } };

interface CapacitorGlobal { isNativePlatform?: () => boolean; getPlatform?: () => string; Plugins?: Record<string, AnyPlugin> }
const cap = (): CapacitorGlobal | undefined => (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
const plugin = (name: string): AnyPlugin | undefined => cap()?.Plugins?.[name];

export const isNative = (): boolean => !!cap()?.isNativePlatform?.();
export const platform = (): string => cap()?.getPlatform?.() || 'web';

/* ---------- storage: Preferences survives iOS WebView storage eviction ---------- */
const MEM: Record<string, string> = {};
export async function loadStorage(keys: string[]): Promise<void> {
  const prefs = plugin('Preferences');
  for (const k of keys) {
    let v: string | null = null;
    if (prefs) { try { v = (await prefs.get({ key: k }))?.value ?? null; } catch { /* ignore */ } }
    if (v === null) { try { v = localStorage.getItem(k); } catch { /* private mode */ } }
    if (v !== null) MEM[k] = v;
  }
}
export function getItem(k: string): string | null { return k in MEM ? MEM[k] : null; }
export function setItem(k: string, v: string | null): void {
  if (v === null) delete MEM[k]; else MEM[k] = v;
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* quota/private */ }
  const prefs = plugin('Preferences');
  if (prefs) (v === null ? prefs.remove({ key: k }) : prefs.set({ key: k, value: v })).catch(() => {});
}

/* ---------- share ---------- */
export async function share(opts: { title: string; text?: string; url: string }): Promise<'shared' | 'copied' | 'cancelled'> {
  const p = plugin('Share');
  try {
    if (p) { await p.share({ title: opts.title, text: opts.text, url: opts.url, dialogTitle: 'Share' }); return 'shared'; }
    if (navigator.share) { await navigator.share(opts); return 'shared'; }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError' || /cancel/i.test(String((e as Error)?.message))) return 'cancelled';
  }
  try { await navigator.clipboard.writeText(opts.url); return 'copied'; } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = opts.url; ta.className = 'hidden-input'; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } finally { ta.remove(); }
  return 'copied';
}

/* ---------- haptics ---------- */
export function tap(style: 'LIGHT' | 'MEDIUM' = 'LIGHT'): void {
  const p = plugin('Haptics');
  if (p) { p.impact({ style }).catch(() => {}); return; }
  try { navigator.vibrate?.(8); } catch { /* unsupported */ }
}

/* ---------- status bar / splash ---------- */
export function setStatusBar(dark: boolean): void {
  const p = plugin('StatusBar');
  if (!p) return;
  // Style "DARK" = light text (for dark backgrounds).
  p.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {});
  if (platform() === 'android') p.setBackgroundColor({ color: dark ? '#130A20' : '#F6F1FA' }).catch(() => {});
}
export function hideSplash(): void { plugin('SplashScreen')?.hide({ fadeOutDuration: 250 }).catch(() => {}); }

/* ---------- hardware back button & deep links ---------- */
export function onBackButton(handler: () => void): void {
  plugin('App')?.addListener?.('backButton', () => handler());
}
export function exitApp(): void { plugin('App')?.minimizeApp?.().catch(() => plugin('App')?.exitApp?.().catch(() => {})); }
export function onAppUrlOpen(handler: (url: string) => void): void {
  plugin('App')?.addListener?.('appUrlOpen', (e: { url: string }) => handler(e.url));
}
export function onResume(handler: () => void): void {
  plugin('App')?.addListener?.('resume', () => handler());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') handler(); });
}

/* ---------- local notifications for reminders ---------- */
const notifId = (key: string): number => { let h = 7; for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 2_000_000_000; return h; };

/** Schedules a reminder notification. Returns false when notifications aren't available or allowed. */
export async function scheduleReminder(key: string, title: string, body: string, at: Date): Promise<boolean> {
  const p = plugin('LocalNotifications');
  if (!p) return false;
  try {
    let perm = await p.checkPermissions();
    if (perm.display !== 'granted') perm = await p.requestPermissions();
    if (perm.display !== 'granted') return false;
    if (at.getTime() <= Date.now()) return true; // nothing to schedule, still a valid reminder
    await p.schedule({ notifications: [{ id: notifId(key), title, body, schedule: { at, allowWhileIdle: true } }] });
    return true;
  } catch { return false; }
}
export async function cancelReminder(key: string): Promise<void> {
  try { await plugin('LocalNotifications')?.cancel({ notifications: [{ id: notifId(key) }] }); } catch { /* ignore */ }
}

/* ---------- keep the screen awake while watching ---------- */
let wakeLock: { release: () => Promise<void> } | null = null;
export async function keepAwake(on: boolean): Promise<void> {
  const p = plugin('KeepAwake');
  try {
    if (p) { await (on ? p.keepAwake() : p.allowSleep()); return; }
    const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (on && wl && !wakeLock) wakeLock = await wl.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported */ }
}

/* ---------- open external files (PDF editions) ---------- */
export function openExternal(url: string): void {
  const b = plugin('Browser');
  if (b) { b.open({ url }).catch(() => window.open(url, '_blank', 'noopener')); return; }
  window.open(url, '_blank', 'noopener');
}
