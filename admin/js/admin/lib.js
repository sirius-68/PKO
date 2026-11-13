export class SafeHTML {
    s;
    constructor(s) { this.s = s; }
    toString() { return this.s; }
}
export const raw = (s) => new SafeHTML(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
function part(v) {
    if (v === null || v === undefined || v === false)
        return '';
    if (v instanceof SafeHTML)
        return v.s;
    if (Array.isArray(v))
        return v.map(part).join('');
    return esc(v);
}
export function html(strings, ...vals) {
    let out = strings[0];
    for (let i = 0; i < vals.length; i++)
        out += part(vals[i]) + strings[i + 1];
    return new SafeHTML(out);
}
export const setHTML = (el, h) => { el.innerHTML = h.s; };
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
import { request, uploadFile as backendUpload, mediaUrl as backendMediaUrl, SupaError, NotAdminError } from './backend.js';
export const ApiError = SupaError;
export { NotAdminError };
let onUnauthorized = () => { };
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };
export async function api(path, opts = {}) {
    try {
        return (await request(opts.method || 'GET', path, opts.body));
    }
    catch (e) {
        if (e instanceof SupaError && (e.status === 401 || (e.status === 403 && e.code === '42501')) && !path.endsWith('/login') && !path.endsWith('/me'))
            onUnauthorized();
        throw e;
    }
}
export const uploadFile = (file, onProgress) => backendUpload(file, onProgress);
export const mediaUrl = (id) => backendMediaUrl(id);
export const bytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
export function rel(isoTs) {
    const s = (Date.now() - Date.parse(isoTs)) / 1000;
    if (s < 0) {
        const f = -s;
        return f < 3600 ? `in ${Math.ceil(f / 60)} min` : f < 86400 ? `in ${Math.round(f / 3600)} h` : `on ${new Date(isoTs).toLocaleDateString()}`;
    }
    if (s < 60)
        return 'just now';
    if (s < 3600)
        return `${Math.floor(s / 60)} min ago`;
    if (s < 86400)
        return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 30)
        return `${Math.floor(s / 86400)} d ago`;
    return new Date(isoTs).toLocaleDateString();
}
export function toLocalInput(isoTs) {
    const d = new Date(isoTs);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const ICONS = {
    pen: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    tv: '<rect x="3" y="6.5" width="18" height="12.5" rx="2.5"/><path d="m8.5 3 3.5 3.5L15.5 3"/>',
    book: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5z"/><path d="M5 20.5A2.5 2.5 0 0 0 7.5 23H19"/>',
    music: '<path d="M9 18V5.5l11-2.5v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    quote: '<path d="M5 18c2.5-1 4-3 4-6V7H4.5v5H8M15 18c2.5-1 4-3 4-6V7h-4.5v5H18"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-10 9"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    home: '<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19z"/>',
    live: '<circle cx="12" cy="12" r="3"/><path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9M4.6 4.6a10.4 10.4 0 0 0 0 14.8M19.4 4.6a10.4 10.4 0 0 1 0 14.8"/>',
    folder: '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z"/>',
    comment: '<path d="M4.5 5.5h15v10.5H10l-5.5 4z"/>',
    users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.5a3.5 3.5 0 0 1 0 6.5M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4.5 15v4.5h15V15"/>',
    trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/>',
    up: '<path d="m6 15 6-6 6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    star: '<path d="M12 3v5M12 16v5M3 12h5M16 12h5M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M17.7 6.3l-2.5 2.5M8.8 15.2l-2.5 2.5"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    logout: '<path d="M14 4.5h4.5v15H14M10 8l-4 4 4 4M6 12h10"/>',
    file: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/>',
    send: '<path d="M4 12 20 4l-4 16-4-7z"/><path d="m12 13 8-9"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    back: '<path d="M15 5 8 12l7 7"/>',
    ext: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 14v5.5H4.5V6H10"/>',
};
export const ic = (n, cls = '') => raw(`<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`);
let tt;
export function toast(msg, kind = 'ok') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast on ${kind}`;
    t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    clearTimeout(tt);
    tt = window.setTimeout(() => t.classList.remove('on'), kind === 'err' ? 5000 : 2500);
}
export function confirmDialog(title, body, okLabel = 'Delete', danger = true) {
    return new Promise((resolve) => {
        const d = document.createElement('dialog');
        d.className = 'dlg';
        setHTML(d, html `<form method="dialog"><h3>${title}</h3><p>${body}</p><div class="row end"><button value="cancel" class="btn">Cancel</button><button value="ok" class="btn ${danger ? 'danger' : 'primary'}">${okLabel}</button></div></form>`);
        document.body.appendChild(d);
        d.addEventListener('close', () => { resolve(d.returnValue === 'ok'); d.remove(); });
        d.showModal();
    });
}
