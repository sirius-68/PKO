/**
 * The 24/7 channel. Works out what is on Transfiguration TV at any moment from
 * the schedule the media team keeps, the same way for every viewer:
 *
 *   1. Studio live (vMix is streaming and the channel is on air)  -> the live stream
 *   2. A schedule slot that plays a past message                  -> that message, from
 *      wherever it would be if it had started on time
 *   3. Anything else                                              -> the latest messages on
 *      rotation, positioned by the wall clock so everyone sees the same moment
 *
 * Schedule times are in the channel's time zone (set on the dashboard's Live page)
 * and shown to each viewer in their own time zone. No dependencies: this file
 * runs in the app, the dashboard and the tests.
 */
export const DAY_OPTIONS = ['Every day', 'Weekdays', 'Weekends', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
export const SOURCES = { live: 'Live from the studio', replay: 'A past message', rotation: 'Latest messages on rotation' };
export const SOURCE_OPTIONS = Object.values(SOURCES);
/** Rotation is anchored here so every device agrees on the position. */
const EPOCH = Date.UTC(2026, 0, 1);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** A live slot with no end time runs this long (or until the next programme). */
const LIVE_DEFAULT = 2 * HOUR;
const ROTATION_SIZE = 12;
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const minutes = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const fmts = new Map();
function fmt(tz) {
    let f = fmts.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
        fmts.set(tz, f);
    }
    return f;
}
/** A usable IANA zone name, or UTC. */
export function safeTz(tz) {
    if (!tz)
        return 'UTC';
    try {
        fmt(tz);
        return tz;
    }
    catch {
        return 'UTC';
    }
}
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** The wall clock in `tz` at instant `t`. dow: 1 = Monday ... 7 = Sunday. */
export function wall(t, tz) {
    const p = {};
    for (const x of fmt(tz).formatToParts(t))
        p[x.type] = x.value;
    return { y: +p.year, m: +p.month, d: +p.day, dow: WEEKDAYS.indexOf(p.weekday) + 1, mins: (+p.hour % 24) * 60 + +p.minute };
}
/** Milliseconds `tz` is ahead of UTC at instant `t`. */
export function tzOffset(t, tz) {
    const p = {};
    for (const x of fmt(tz).formatToParts(t))
        p[x.type] = x.value;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUtc - Math.floor(t.getTime() / 1000) * 1000;
}
/** The instant a wall-clock time happens in `tz` (y-m-d, minutes after midnight). */
export function zoned(y, m, d, mins, tz) {
    const guess = Date.UTC(y, m - 1, d, 0, mins);
    let t = guess - tzOffset(new Date(guess), tz);
    const again = guess - tzOffset(new Date(t), tz);
    if (again !== t)
        t = again; // crossed a daylight-saving change
    return new Date(t);
}
export function dayMatches(days, dow) {
    switch (days || 'Every day') {
        case 'Every day': return true;
        case 'Weekdays': return dow <= 5;
        case 'Weekends': return dow >= 6;
        default: {
            const i = DAY_OPTIONS.indexOf(days) - 3; // Mondays = index 3
            return i >= 0 && i + 1 === dow;
        }
    }
}
const playable = (v) => !!v && !!(v.video || v.url) && (v.duration || 0) > 0;
/** Every airing that overlaps [from, to), in start order. */
export function airings(input, from, to) {
    const tz = safeTz(input.live.timezone);
    const slots = input.schedule.filter((s) => isTime(s.time));
    const videos = new Map(input.broadcasts.map((b) => [b.id, b]));
    const starts = [];
    // Walk calendar days in the channel's zone, one day either side so overnight slots are caught.
    const first = wall(new Date(from.getTime() - DAY), tz);
    let day = Date.UTC(first.y, first.m - 1, first.d);
    const last = to.getTime() + DAY;
    for (let guard = 0; guard < 60; guard++, day += DAY) {
        const dt = new Date(day);
        const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
        const dow = ((dt.getUTCDay() + 6) % 7) + 1;
        const midnight = zoned(y, m, d, 0, tz);
        if (midnight.getTime() > last)
            break;
        for (const slot of slots)
            if (dayMatches(slot.days, dow))
                starts.push({ slot, start: zoned(y, m, d, minutes(slot.time), tz), y, m, d });
    }
    starts.sort((a, b) => a.start.getTime() - b.start.getTime());
    const out = [];
    starts.forEach((a, i) => {
        const next = starts.slice(i + 1).find((b) => b.start > a.start)?.start.getTime() ?? a.start.getTime() + DAY;
        let end;
        if (isTime(a.slot.end)) {
            end = zoned(a.y, a.m, a.d, minutes(a.slot.end), tz).getTime();
            if (end <= a.start.getTime())
                end += DAY; // runs past midnight
        }
        else {
            const src = a.slot.source || SOURCES.live;
            const v = videos.get(a.slot.broadcast || '');
            const natural = src === SOURCES.replay && playable(v) ? v.duration * 1000 : src === SOURCES.rotation ? DAY : LIVE_DEFAULT;
            end = Math.min(next, a.start.getTime() + natural);
        }
        if (end > from.getTime() && a.start < to)
            out.push({ slot: a.slot, start: a.start, end: new Date(end) });
    });
    return out;
}
/** What the channel is showing at `now`. */
export function onNow(input, now = new Date()) {
    const list = airings(input, new Date(now.getTime() - DAY), new Date(now.getTime() + 8 * DAY));
    // Latest-starting slot wins when two overlap.
    const air = [...list].reverse().find((a) => a.start <= now && now < a.end) || null;
    const nextStart = list.find((a) => a.start > now)?.start || null;
    const nextChange = [air?.end, nextStart].filter((x) => !!x).sort((a, b) => a.getTime() - b.getTime())[0] || null;
    if (input.live.onAir)
        return { kind: 'live', airing: air, video: null, offset: 0, until: null };
    if (!input.live.channel24)
        return { kind: 'off', airing: air, video: null, offset: 0, until: nextChange };
    if (air && (air.slot.source || SOURCES.live) === SOURCES.replay) {
        const v = input.broadcasts.find((b) => b.id === air.slot.broadcast);
        const off = (now.getTime() - air.start.getTime()) / 1000;
        if (playable(v) && off < v.duration) {
            const done = new Date(air.start.getTime() + v.duration * 1000);
            return { kind: 'replay', airing: air, video: v, offset: off, until: earliest(done, nextChange) };
        }
    }
    const rot = rotation(input.broadcasts);
    if (!rot.length)
        return { kind: 'off', airing: air, video: null, offset: 0, until: nextChange };
    const total = rot.reduce((s, v) => s + v.duration, 0);
    let pos = (((now.getTime() - EPOCH) / 1000) % total + total) % total;
    for (const v of rot) {
        if (pos < v.duration)
            return { kind: 'rotation', airing: air, video: v, offset: pos, until: earliest(new Date(now.getTime() + (v.duration - pos) * 1000), nextChange) };
        pos -= v.duration;
    }
    return { kind: 'off', airing: air, video: null, offset: 0, until: nextChange }; // unreachable
}
/** The latest playable messages, newest first: what fills the gaps. */
export function rotation(broadcasts) {
    return broadcasts.filter(playable).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, ROTATION_SIZE);
}
/** The next `n` programmes that start after `now` (within a week). */
export function upNext(input, now = new Date(), n = 8) {
    return airings(input, now, new Date(now.getTime() + 7 * DAY)).filter((a) => a.start > now).slice(0, n);
}
/** The next time a slot starts after `now`, or null. Used for reminders. */
export function nextAiring(input, slotId, now = new Date()) {
    return airings(input, now, new Date(now.getTime() + 8 * DAY)).find((a) => a.slot.id === slotId && a.start > now) || null;
}
/** "Now", "18:30", "Tomorrow 12:00", "Sat 09:00" in the viewer's own time zone. */
export function airLabel(start, now = new Date()) {
    const hm = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
    const days = Math.round((new Date(start).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
    if (days === 0)
        return hm;
    if (days === 1)
        return `Tomorrow ${hm}`;
    return `${start.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
}
const earliest = (a, b) => (b && b < a ? b : a);
