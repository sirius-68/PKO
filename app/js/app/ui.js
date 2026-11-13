import { $, $$, ic, html, must, setHTML } from './lib.js';
import { exitApp, hasPlugin, isNative, onBackButton } from './native.js';
/* ---------- toast ---------- */
let tt;
export function toast(msg, kind = 'ok') {
    const t = must('#toast');
    setHTML(t, html `${ic(kind === 'err' ? 'info' : 'check', 'sm')}<span>${msg}</span>`);
    t.classList.toggle('err', kind === 'err');
    t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    t.classList.add('on');
    clearTimeout(tt);
    tt = window.setTimeout(() => t.classList.remove('on'), kind === 'err' ? 3600 : 2200);
}
const stack = [];
export const pageDepth = () => stack.length;
export const topPage = () => stack[stack.length - 1]?.el || null;
export function pushPage(key, def) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.key = key;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    setHTML(el, def.html);
    for (const x of stack)
        x.el.classList.add('under');
    must('#pages').appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
    stack.push({ el, onClose: def.onClose, key });
    closeSheet();
    closeDrawer();
    def.after?.(el);
    return el;
}
/** Re-render the top page in place (keeps scroll position). */
export function refreshPage(el, def) {
    const st = el.scrollTop;
    setHTML(el, def.html);
    el.scrollTop = st;
    def.after?.(el);
}
export function popPage() {
    const top = stack.pop();
    if (!top)
        return false;
    top.onClose?.();
    top.el.classList.remove('in');
    setTimeout(() => top.el.remove(), 400);
    stack[stack.length - 1]?.el.classList.remove('under');
    return true;
}
export function closeAllPages() {
    while (stack.length) {
        const p = stack.pop();
        p.onClose?.();
        p.el.remove();
    }
}
/* ---------- bottom sheet ---------- */
let sheetKey = '';
let sheetClose;
export const currentSheet = () => sheetKey;
export function openSheet(key, body, opts = {}) {
    const sh = must('#sheet');
    setHTML(sh, body);
    sheetKey = key;
    sheetClose = opts.onClose;
    sh.dataset.k = key;
    closeDrawer();
    requestAnimationFrame(() => { sh.classList.add('on'); must('#scrim2').classList.add('on'); opts.after?.(sh); });
}
export function closeSheet() {
    const sh = $('#sheet');
    if (!sh || !sh.classList.contains('on'))
        return false;
    sh.classList.remove('on');
    must('#scrim2').classList.remove('on');
    sh.dataset.k = '';
    sheetKey = '';
    const c = sheetClose;
    sheetClose = undefined;
    c?.();
    document.activeElement?.blur?.();
    return true;
}
/* ---------- drawer ---------- */
export function openDrawer() { must('#drawer').classList.add('on'); must('#scrim').classList.add('on'); }
export function closeDrawer() {
    const d = $('#drawer');
    if (!d || !d.classList.contains('on'))
        return false;
    d.classList.remove('on');
    must('#scrim').classList.remove('on');
    return true;
}
/* ---------- lightbox ---------- */
export function closeLightbox() {
    const lb = $('#lb');
    if (!lb || !lb.classList.contains('on'))
        return false;
    lb.classList.remove('on');
    return true;
}
/* ---------- back navigation (Android hardware back, iOS edge swipe in PWA, browser back) ---------- */
let fallback = () => false;
/** Closes the top-most layer. Returns false when there is nothing left to close (app should exit). */
export function handleBack() {
    if (closeLightbox() || closeSheet() || closeDrawer() || popPage())
        return true;
    return fallback();
}
export function initBack(onRootBack) {
    fallback = onRootBack;
    const hasNativeBack = isNative() && hasPlugin('App');
    if (hasNativeBack) {
        onBackButton(() => { if (!handleBack())
            exitApp(); });
        return;
    }
    // A single "trap" history entry: each back press is turned into handleBack().
    history.pushState({ pko: 'trap' }, '');
    window.addEventListener('popstate', () => {
        if (handleBack())
            history.pushState({ pko: 'trap' }, '');
        else
            history.back();
    });
}
/* ---------- swipe-back on pushed pages (iOS feel) ---------- */
export function enableEdgeSwipe(root) {
    let x0 = 0, y0 = 0, el = null, dx = 0, active = false;
    root.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        el = topPage();
        if (!el || t.clientX - root.getBoundingClientRect().left > 28) {
            el = null;
            return;
        }
        x0 = t.clientX;
        y0 = t.clientY;
        dx = 0;
        active = false;
    }, { passive: true });
    root.addEventListener('touchmove', (e) => {
        if (!el)
            return;
        const t = e.touches[0];
        dx = t.clientX - x0;
        if (!active) {
            if (Math.abs(t.clientY - y0) > 12 && Math.abs(t.clientY - y0) > Math.abs(dx)) {
                el = null;
                return;
            }
            if (dx > 10) {
                active = true;
                el.style.transition = 'none';
            }
        }
        if (active)
            el.style.transform = `translateX(${Math.max(0, dx)}px)`;
    }, { passive: true });
    root.addEventListener('touchend', () => {
        if (!el)
            return;
        const page = el;
        el = null;
        page.style.transition = '';
        if (active && dx > page.clientWidth * 0.33) {
            page.style.transform = '';
            handleBack();
        }
        else
            page.style.transform = '';
    });
}
export function setBusy(btn, busy) {
    if (!btn)
        return;
    btn.disabled = busy;
    btn.setAttribute('aria-busy', String(busy));
}
export const focusTrapKeys = () => {
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape')
            return;
        if ($$('.page.in').length || $('#sheet.on') || $('#drawer.on') || $('#lb.on')) {
            e.preventDefault();
            handleBack();
        }
    });
};
