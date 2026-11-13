/* ---------- safe HTML templating ---------- */
// Every interpolated value is escaped unless it is already a SafeHTML (built by `html` or `raw`).
// Content comes from the dashboard and from members, so this is the XSS boundary.
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
export const setHTML = (el, h) => { el.innerHTML = typeof h === 'string' ? esc(h) : h.s; };
/* ---------- DOM ---------- */
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export function must(s, el = document) {
    const x = el.querySelector(s);
    if (!x)
        throw new Error('Missing element ' + s);
    return x;
}
/* ---------- formatting ---------- */
export const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.0', '') + 'k' : String(n));
export const mmss = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MON3 = MONTHS.map((m) => m.slice(0, 3));
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const parseD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const todayIso = () => { const d = new Date(); return iso(d.getFullYear(), d.getMonth(), d.getDate()); };
export const dayLabel = (s) => { const d = parseD(s); return `${DOW[d.getDay()]} ${d.getDate()} ${MON3[d.getMonth()]}`; };
/** "6h", "3d", "2w" — compact age used on cards. */
export function ago(isoTs) {
    const s = Math.max(0, (Date.now() - Date.parse(isoTs)) / 1000);
    if (s < 60)
        return 'now';
    if (s < 3600)
        return Math.floor(s / 60) + 'm';
    if (s < 86400)
        return Math.floor(s / 3600) + 'h';
    if (s < 86400 * 7)
        return Math.floor(s / 86400) + 'd';
    if (s < 86400 * 365)
        return Math.floor(s / (86400 * 7)) + 'w';
    return Math.floor(s / (86400 * 365)) + 'y';
}
/** "Today", "Yesterday", "Mon 2 Nov". */
export function when(isoTs) {
    const d = new Date(isoTs), t = new Date();
    const days = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 864e5);
    if (days <= 0)
        return 'Today';
    if (days === 1)
        return 'Yesterday';
    return `${DOW[d.getDay()]} ${d.getDate()} ${MON3[d.getMonth()]}`;
}
export const readMins = (paras) => Math.max(1, Math.round(paras.join(' ').split(/\s+/).length / 200)) + ' min';
export const initials = (name) => name.split(/\s+/).filter(Boolean).map((s) => s[0]).join('').slice(0, 2).toUpperCase();
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); }; };
/* ---------- icons ---------- */
const P = {
    menu: '<path d="M4 7h16M4 12h16M4 17h11"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    home: '<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19z"/>',
    tv: '<rect x="3" y="6.5" width="18" height="12.5" rx="2.5"/><path d="m8.5 3 3.5 3.5L15.5 3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    book: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5z"/><path d="M5 20.5A2.5 2.5 0 0 0 7.5 23H19"/>',
    lib: '<path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="m16 5 3.8-1 2.2 15.6-3.8 1z"/>',
    cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    music: '<path d="M9 18V5.5l11-2.5v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    pen: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-10 9"/>',
    quote: '<path d="M5 18c2.5-1 4-3 4-6V7H4.5v5H8M15 18c2.5-1 4-3 4-6V7h-4.5v5H18"/>',
    comment: '<path d="M4.5 5.5h15v10.5H10l-5.5 4z"/>',
    share: '<path d="M12 3.5v11M7.5 8 12 3.5 16.5 8M5 13.5v6h14v-6"/>',
    save: '<path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/>',
    play: '<path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
    back: '<path d="M15 5 8 12l7 7"/>',
    right: '<path d="m9 5 7 7-7 7"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    prev: '<path d="M6.5 5v14"/><path d="M19 5.5v13a.6.6 0 0 1-1 .5L9 12.5a.6.6 0 0 1 0-1L18 5a.6.6 0 0 1 1 .5z" fill="currentColor" stroke="none"/>',
    next: '<path d="M17.5 5v14"/><path d="M5 5.5v13a.6.6 0 0 0 1 .5l9-6.5a.6.6 0 0 0 0-1L6 5a.6.6 0 0 0-1 .5z" fill="currentColor" stroke="none"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    pin: '<path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.4 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10.5 5-3v9l-5-3z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    dots: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>',
    send: '<path d="M4 12 20 4l-4 16-4-7z"/><path d="m12 13 8-9"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>',
    star: '<path d="M12 3v5M12 16v5M3 12h5M16 12h5M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M17.7 6.3l-2.5 2.5M8.8 15.2l-2.5 2.5"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>',
    text: '<path d="M4 7V5h11v2M9.5 5v14M7.5 19h4M14 12v-1.5h7V12M17.5 10.5V19M16 19h3"/>',
    upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4.5 15v4.5h15V15"/>',
    download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 15v4.5h15V15"/>',
    phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/>',
    vol: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
    refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>',
    wifi: '<path d="M3 9a13 13 0 0 1 18 0M6 12.5a8.5 8.5 0 0 1 12 0M9 16a4 4 0 0 1 6 0"/><path d="M3 3l18 18"/>',
    logout: '<path d="M14 4.5h4.5v15H14M10 8l-4 4 4 4M6 12h10"/>',
    trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/>',
    file: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/>',
};
export const ic = (n, c = '') => raw(`<svg class="ico ${c}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`);
/* ---------- illustrated stand-ins for items without a photo ---------- */
const PAL = { royal: ['#14081F', '#3E1468', '#B98AF0', '#FFF1CF'], gold: ['#1A0E05', '#6A4410', '#E9B954', '#FFF3D2'], plum: ['#170717', '#5A1650', '#D77BC0', '#FFE8F6'], night: ['#0B0820', '#28206A', '#8C86F2', '#EFEAFF'] };
let UID = 0;
function rng(seed) { let s = seed; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++)
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return Math.abs(h); }
export function art(kind, seedKey) {
    const pals = Object.keys(PAL);
    const seed = hashStr(seedKey);
    const c = PAL[pals[seed % pals.length]], r = rng(seed * 7919 + kind.length * 31), id = 'a' + UID++;
    const d = `<linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c[1]}"/><stop offset="1" stop-color="${c[0]}"/></linearGradient><radialGradient id="${id}m" cx=".5" cy=".32" r=".6"><stop offset="0" stop-color="${c[3]}"/><stop offset=".25" stop-color="${c[2]}" stop-opacity=".55"/><stop offset="1" stop-color="${c[2]}" stop-opacity="0"/></radialGradient>`;
    const bokeh = (n, y0, y1) => { let s = ''; for (let i = 0; i < n; i++)
        s += `<circle cx="${(r() * 400).toFixed(0)}" cy="${(y0 + r() * (y1 - y0)).toFixed(0)}" r="${(6 + r() * 26).toFixed(0)}" fill="${r() > 0.5 ? c[2] : c[3]}" opacity="${(0.06 + r() * 0.22).toFixed(2)}"/>`; return s; };
    let b = `<rect width="400" height="300" fill="url(#${id}s)"/>`;
    if (kind === 'portrait')
        b += bokeh(18, 0, 300) + `<rect width="400" height="300" fill="url(#${id}m)" opacity=".7"/><ellipse cx="200" cy="130" rx="38" ry="46" fill="${c[0]}"/><path d="M182 168h36v30h-36z" fill="${c[0]}"/><path d="M106 300q10-92 94-104 84 12 94 104z" fill="${c[0]}"/>`;
    else if (kind === 'water') {
        b += `<rect width="400" height="300" fill="url(#${id}m)"/><circle cx="200" cy="150" r="36" fill="${c[3]}" opacity=".95"/><rect y="158" width="400" height="142" fill="${c[0]}" opacity=".88"/>`;
        for (let i = 0; i < 22; i++) {
            const y = 166 + i * 5 + r() * 3, w = Math.max(6, 20 + r() * 90 - i * 1.5);
            b += `<rect x="${(200 - w / 2 + (r() - 0.5) * 30).toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="2" rx="1" fill="${c[3]}" opacity="${(0.5 - i * 0.015).toFixed(2)}"/>`;
        }
    }
    else {
        b += `<rect width="400" height="300" fill="url(#${id}m)"/>` + bokeh(26, 0, 200);
        for (let i = 0; i < 9; i++) {
            const x = 22 + i * 45;
            b += `<circle cx="${x}" cy="230" r="13" fill="${c[0]}"/><path d="M${x - 26} 300q4-48 26-48t26 48z" fill="${c[0]}"/>`;
        }
    }
    return raw(`<svg class="art" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs>${d}</defs>${b}</svg>`);
}
const AV_COLORS = ['#B4842A', '#7A3FC4', '#C44B86', '#5E57D6', '#9A5A2E', '#8E3FA8', '#B06A1E'];
export const avColor = (name) => AV_COLORS[hashStr(name) % AV_COLORS.length];
export const avi = (name, size = 38) => html `<span class="avi" style="width:${size}px;height:${size}px;background:${avColor(name)};font-size:${Math.round(size * 0.38)}px">${initials(name)}</span>`;
