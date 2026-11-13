const cap = () => window.Capacitor;
const registered = {};
/** Native plugin proxy. Native builds load @capacitor/core (capacitor.js), whose registerPlugin wires calls to the native side. */
const plugin = (name) => {
    const c = cap();
    if (!c)
        return undefined;
    if (c.Plugins?.[name])
        return c.Plugins[name];
    if (name in registered)
        return registered[name];
    registered[name] = c.isNativePlatform?.() && c.registerPlugin ? c.registerPlugin(name) : undefined;
    return registered[name];
};
export const hasPlugin = (name) => !!plugin(name);
export const isNative = () => !!cap()?.isNativePlatform?.();
export const platform = () => cap()?.getPlatform?.() || 'web';
/* ---------- storage: Preferences survives iOS WebView storage eviction ---------- */
const MEM = {};
export async function loadStorage(keys) {
    const prefs = plugin('Preferences');
    for (const k of keys) {
        let v = null;
        if (prefs) {
            try {
                v = (await prefs.get({ key: k }))?.value ?? null;
            }
            catch { /* ignore */ }
        }
        if (v === null) {
            try {
                v = localStorage.getItem(k);
            }
            catch { /* private mode */ }
        }
        if (v !== null)
            MEM[k] = v;
    }
}
export function getItem(k) { return k in MEM ? MEM[k] : null; }
export function setItem(k, v) {
    if (v === null)
        delete MEM[k];
    else
        MEM[k] = v;
    try {
        if (v === null)
            localStorage.removeItem(k);
        else
            localStorage.setItem(k, v);
    }
    catch { /* quota/private */ }
    const prefs = plugin('Preferences');
    if (prefs)
        (v === null ? prefs.remove({ key: k }) : prefs.set({ key: k, value: v })).catch(() => { });
}
/* ---------- share ---------- */
export async function share(opts) {
    const p = plugin('Share');
    try {
        if (p) {
            await p.share({ title: opts.title, text: opts.text, url: opts.url, dialogTitle: 'Share' });
            return 'shared';
        }
        if (navigator.share) {
            await navigator.share(opts);
            return 'shared';
        }
    }
    catch (e) {
        if (e?.name === 'AbortError' || /cancel/i.test(String(e?.message)))
            return 'cancelled';
    }
    try {
        await navigator.clipboard.writeText(opts.url);
        return 'copied';
    }
    catch { /* fall through */ }
    const ta = document.createElement('textarea');
    ta.value = opts.url;
    ta.className = 'hidden-input';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
    }
    finally {
        ta.remove();
    }
    return 'copied';
}
/* ---------- haptics ---------- */
export function tap(style = 'LIGHT') {
    const p = plugin('Haptics');
    if (p) {
        p.impact({ style }).catch(() => { });
        return;
    }
    try {
        navigator.vibrate?.(8);
    }
    catch { /* unsupported */ }
}
/* ---------- status bar / splash ---------- */
export function setStatusBar(dark) {
    const p = plugin('StatusBar');
    if (!p)
        return;
    // Style "DARK" = light text (for dark backgrounds).
    p.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => { });
    if (platform() === 'android')
        p.setBackgroundColor({ color: dark ? '#130A20' : '#F6F1FA' }).catch(() => { });
}
export function hideSplash() { plugin('SplashScreen')?.hide({ fadeOutDuration: 250 }).catch(() => { }); }
/* ---------- hardware back button & deep links ---------- */
export function onBackButton(handler) {
    plugin('App')?.addListener?.('backButton', () => handler());
}
export function exitApp() { plugin('App')?.minimizeApp?.().catch(() => plugin('App')?.exitApp?.().catch(() => { })); }
export function onAppUrlOpen(handler) {
    plugin('App')?.addListener?.('appUrlOpen', (e) => handler(e.url));
}
export function onResume(handler) {
    plugin('App')?.addListener?.('resume', () => handler());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible')
        handler(); });
}
/* ---------- local notifications for reminders ---------- */
const notifId = (key) => { let h = 7; for (const c of key)
    h = (h * 31 + c.charCodeAt(0)) % 2_000_000_000; return h; };
/** Schedules a reminder notification. Returns false when notifications aren't available or allowed. */
export async function scheduleReminder(key, title, body, at) {
    const p = plugin('LocalNotifications');
    if (!p)
        return false;
    try {
        let perm = await p.checkPermissions();
        if (perm.display !== 'granted')
            perm = await p.requestPermissions();
        if (perm.display !== 'granted')
            return false;
        if (at.getTime() <= Date.now())
            return true; // nothing to schedule, still a valid reminder
        await p.schedule({ notifications: [{ id: notifId(key), title, body, schedule: { at, allowWhileIdle: true } }] });
        return true;
    }
    catch {
        return false;
    }
}
export async function cancelReminder(key) {
    try {
        await plugin('LocalNotifications')?.cancel({ notifications: [{ id: notifId(key) }] });
    }
    catch { /* ignore */ }
}
/* ---------- keep the screen awake while watching ---------- */
let wakeLock = null;
export async function keepAwake(on) {
    const p = plugin('KeepAwake');
    try {
        if (p) {
            await (on ? p.keepAwake() : p.allowSleep());
            return;
        }
        const wl = navigator.wakeLock;
        if (on && wl && !wakeLock)
            wakeLock = await wl.request('screen');
        if (!on && wakeLock) {
            await wakeLock.release();
            wakeLock = null;
        }
    }
    catch { /* not supported */ }
}
/* ---------- open external files (PDF editions) ---------- */
export function openExternal(url) {
    const b = plugin('Browser');
    if (b) {
        b.open({ url }).catch(() => window.open(url, '_blank', 'noopener'));
        return;
    }
    window.open(url, '_blank', 'noopener');
}
