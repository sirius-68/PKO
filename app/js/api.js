import { getItem, setItem } from './native.js';
/* ---------- client ---------- */
const cfg = window.PKO_CONFIG || {};
export const API_BASE = (cfg.apiBase || '').replace(/\/$/, '');
export const mediaUrl = (id) => (id ? `${API_BASE}/media/${encodeURIComponent(id)}` : '');
/** Public link for sharing. Native builds share the hosted web app URL. */
export const shareUrl = (path) => `${API_BASE || location.origin}/app/#${path}`;
export class ApiError extends Error {
    status;
    details;
    constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
export function deviceId() {
    let id = getItem('pko.device');
    if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
        setItem('pko.device', id);
    }
    return id;
}
export const token = () => getItem('pko.token');
export async function api(path, opts = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout ?? 15000);
    const headers = { 'X-Device-Id': deviceId(), ...opts.headers };
    const t = token();
    if (t)
        headers.Authorization = 'Bearer ' + t;
    if (opts.body !== undefined)
        headers['Content-Type'] = 'application/json';
    let res;
    try {
        res = await fetch(API_BASE + path, { method: opts.method || 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: ctl.signal });
    }
    catch {
        throw new ApiError(0, navigator.onLine ? "Couldn't reach the server. Please try again." : "You're offline. Check your connection and try again.");
    }
    finally {
        clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 401 && t && path !== '/api/members')
            setItem('pko.token', null);
        throw new ApiError(res.status, data.error || 'Something went wrong', data.details);
    }
    return data;
}
/** Upload with progress (fetch has no upload progress, so XHR it is). */
export function upload(path, file, onProgress) {
    return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('PUT', `${API_BASE}${path}?name=${encodeURIComponent(file.name)}`);
        x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        x.setRequestHeader('X-Device-Id', deviceId());
        const t = token();
        if (t)
            x.setRequestHeader('Authorization', 'Bearer ' + t);
        x.upload.onprogress = (e) => { if (e.lengthComputable)
            onProgress(e.loaded / e.total); };
        x.onload = () => {
            let d = {};
            try {
                d = JSON.parse(x.responseText);
            }
            catch { /* ignore */ }
            if (x.status >= 200 && x.status < 300 && d.id)
                resolve({ id: d.id });
            else
                reject(new ApiError(x.status, d.error || 'Upload failed'));
        };
        x.onerror = () => reject(new ApiError(0, 'Upload failed. Check your connection.'));
        x.send(file);
    });
}
/* ---------- content bundle with offline cache + ETag revalidation ---------- */
const CACHE_KEY = 'pko.bundle';
export function cachedBundle() {
    try {
        const s = getItem(CACHE_KEY);
        return s ? JSON.parse(s) : null;
    }
    catch {
        return null;
    }
}
export async function fetchBundle(current) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
        const res = await fetch(API_BASE + '/api/bundle', { headers: current ? { 'If-None-Match': `W/"v${current.version}"` } : {}, signal: ctl.signal, cache: 'no-cache' });
        if (res.status === 304 && current)
            return { bundle: current, changed: false };
        if (!res.ok)
            throw new ApiError(res.status, 'Could not load content');
        const b = (await res.json());
        try {
            setItem(CACHE_KEY, JSON.stringify(b));
        }
        catch { /* storage full: still usable in memory */ }
        return { bundle: b, changed: !current || current.version !== b.version || JSON.stringify(current.amens) !== JSON.stringify(b.amens) };
    }
    catch (e) {
        if (e instanceof ApiError)
            throw e;
        throw new ApiError(0, 'offline');
    }
    finally {
        clearTimeout(timer);
    }
}
