import { html, raw, ic, art, avi, fmt, mmss, ago, when, readMins, parseD, iso, todayIso, MON3, MONTHS, DOW, dayLabel, type SafeHTML } from './lib.js';
import { mediaUrl, type Album, type Book, type Broadcast, type EventItem, type Post, type Testimony, type Track } from './api.js';
import { D, S } from './store.js';
import { player } from './media.js';

/* ---------- media helpers ---------- */
export const pic = (id: string | null | undefined, pos: string | null = 'center', cls = '', alt = ''): SafeHTML =>
  id ? html`<img class="ph ${cls}" src="${mediaUrl(id)}" style="object-position:${pos || 'center'}" alt="${alt}" loading="lazy" decoding="async">` : art('choir', String(alt || 'x'));
export const look = (x: { id: string; image?: string | null; imagePos?: string | null }, kind: 'portrait' | 'water' | 'choir' = 'choir'): SafeHTML =>
  x.image ? pic(x.image, x.imagePos) : art(kind, x.id);
export function logo(h = 30): SafeHTML {
  const s = D().settings;
  return s.logo
    ? html`<img class="logo" src="${mediaUrl(s.logo)}" style="height:${h}px;width:${Math.round(h * 0.907)}px" alt="${s.ministry}">`
    : html`<span class="logo" style="height:${h}px;width:${h}px;border-radius:50%;background:var(--fill);color:var(--on-fill);display:grid;place-items:center;font-weight:800;font-size:${Math.round(h * 0.42)}px">${s.ministry.slice(0, 1)}</span>`;
}
export const leaderPfp = (s = 40): SafeHTML => {
  const p = D().settings.leaderPhoto;
  return p ? html`<span class="pfp" style="width:${s}px;height:${s}px"><img src="${mediaUrl(p)}" alt=""></span>` : avi(D().settings.leader, s);
};

/* ---------- channels ---------- */
export function CH(): Record<string, { name: string; full?: string; icon: string; about?: string; banner?: [string | null, string] }> {
  const st = D().settings;
  const firstPhoto = (alb?: string) => D().photos.find((p) => !alb || p.album === alb)?.image || null;
  return {
    home: { name: 'Home', icon: 'home' },
    tv: { name: st.tvName, icon: 'tv' },
    library: { name: 'Library', icon: 'book' },
    songs: { name: st.recordsName, icon: 'music' },
    blog: { name: 'Blog', full: `${possessive(st.leader)} Blog`, icon: 'pen', about: `A new word from ${st.leader}. Read it, say Amen, and carry it into your day.`, banner: [D().posts[0]?.image || firstPhoto(), 'center 30%'] },
    gallery: { name: 'Gallery', full: 'Ministry Gallery', icon: 'image', about: 'Moments from services, crusade nights and ministry trips.', banner: [firstPhoto('Crusade nights') || firstPhoto(), 'center 35%'] },
    events: { name: 'Events', icon: 'cal' },
    testimonies: { name: 'Testimonies', full: 'Testimonies', icon: 'quote', about: 'What God has done for His people, written and on video. Read one, then share yours.', banner: [firstPhoto('Services'), 'center'] },
  };
}
const possessive = (n: string) => (n.endsWith('s') ? `${n}’` : `${n}’s`);
export const chav = (k: string, cls = ''): SafeHTML => html`<span class="chav c-${k} ${cls}">${ic(CH()[k]?.icon || 'home')}</span>`;

/* ---------- lookups ---------- */
export const byId = <T extends { id: string }>(arr: T[], id: string): T | undefined => arr.find((x) => x.id === id);
export interface Song extends Track { key: string; album: Album }
export function songs(): Song[] {
  return D().albums.flatMap((a) => a.tracks.map((t) => ({ ...t, key: `${a.id}:${t.id}`, album: a })));
}
export const songByKey = (k: string): Song | undefined => songs().find((s) => s.key === k);
export const videoSrc = (b: { video: string | null; url: string | null }): string => (b.video ? mediaUrl(b.video) : b.url || '');
export const amenCount = (id: string): number => D().amens[id] || 0;
export const commentCount = (id: string): number => D().comments[id] || 0;
export function upcoming(): EventItem[] {
  const t = todayIso();
  return D().events.filter((e) => e.date >= t);
}
export function eventWhenLabel(e: EventItem): string {
  const days = Math.round((parseD(e.date).getTime() - parseD(todayIso()).getTime()) / 864e5);
  if (days === 0) return 'is tonight';
  if (days === 1) return 'is tomorrow';
  if (days < 7) return `is this ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][parseD(e.date).getDay()]}`;
  return `on ${dayLabel(e.date)}`;
}

/* ---------- actions row ---------- */
export function amenBtn(id: string): SafeHTML {
  const on = !!S.amen[id];
  return html`<button class="amen ${on ? 'on' : ''}" data-amen="${id}" aria-pressed="${on}">${ic('star', 'sm')}Amen <em>${fmt(amenCount(id))}</em></button>`;
}
export function acts(id: string, saveKind: string | null, opts: { comments?: boolean } = {}): SafeHTML {
  const saved = !!S.saved[id];
  return html`<div class="acts">${amenBtn(id)}${opts.comments === false ? '' : html`<button class="apill" data-open-comments="${id}">${ic('comment', 'sm')}${fmt(commentCount(id))}</button>`}<span class="sp"></span>${saveKind ? html`<button class="apill ${saved ? 'on' : ''}" data-save="${id}" data-kind="${saveKind}" aria-label="${saved ? 'Remove from saved' : 'Save'}" aria-pressed="${saved}">${ic('save', 'sm')}</button>` : ''}<button class="apill" data-share="${id}" aria-label="Share">${ic('share', 'sm')}</button></div>`;
}

/* ---------- feed ---------- */
interface FeedItem { ch: string; id: string; ts: string; amen: number }
export function feed(): FeedItem[] {
  const d = D();
  const items: FeedItem[] = [];
  for (const p of d.posts.slice(0, 8)) items.push({ ch: 'blog', id: p.id, ts: p.publishedAt, amen: amenCount(p.id) });
  for (const b of d.broadcasts.slice(0, 6)) items.push({ ch: 'tv', id: b.id, ts: b.publishedAt, amen: amenCount(b.id) });
  for (const t of d.testimonies.slice(0, 6)) items.push({ ch: 'testimonies', id: t.id, ts: t.publishedAt, amen: amenCount(t.id) });
  const albums = new Map<string, string>();
  for (const p of d.photos) if (!albums.has(p.album) || albums.get(p.album)! < p.publishedAt) albums.set(p.album, p.publishedAt);
  [...albums.entries()].sort((a, b) => b[1].localeCompare(a[1])).slice(0, 2).forEach(([a, ts]) => items.push({ ch: 'gallery', id: a, ts, amen: amenCount('gallery:' + a) }));
  const next = upcoming()[0];
  if (next) items.push({ ch: 'events', id: next.id, ts: new Date(Date.now() - 2 * 3600e3).toISOString(), amen: amenCount(next.id) });
  const alb = d.albums[0];
  if (alb && alb.tracks.length) items.push({ ch: 'songs', id: alb.id, ts: alb.publishedAt, amen: amenCount(alb.id) });

  if (S.sort === 'Popular') return items.sort((a, b) => b.amen - a.amen || b.ts.localeCompare(a.ts));
  const byTime = items.sort((a, b) => b.ts.localeCompare(a.ts));
  if (S.sort === 'Latest') return byTime;
  // For you: newest first, but avoid two cards from the same channel in a row.
  const out: FeedItem[] = [];
  const pool = [...byTime];
  while (pool.length) {
    const i = pool.findIndex((x) => x.ch !== out[out.length - 1]?.ch);
    out.push(pool.splice(i < 0 ? 0 : i, 1)[0]);
  }
  return out;
}

export function postCard(f: FeedItem): SafeHTML {
  const d = D();
  const head = (name: string, ch: string, ts: string) => html`<div class="pm">${chav(ch)}<b>${name}</b><span>${ago(ts)}</span></div>`;
  if (f.ch === 'blog') {
    const b = byId(d.posts, f.id)!;
    return html`<article class="post" data-page="article:${b.id}">${head('Blog', 'blog', b.publishedAt)}<h3>${b.title}</h3><span class="flair">${b.flair}</span>
      <p class="ex">${b.body[0]}</p>${b.image ? html`<div class="media tall">${look(b)}</div>` : ''}${acts(b.id, 'post')}</article>`;
  }
  if (f.ch === 'testimonies') {
    const t = byId(d.testimonies, f.id)!;
    return html`<article class="post" data-page="testimony:${t.id}">${head('Testimonies', 'testimonies', t.publishedAt)}<h3>${t.title}</h3><span class="flair">${t.video ? 'Video' : 'Written'} testimony</span>
      <p class="ex serif">“${t.quote || t.body[0]}”</p>${t.video ? html`<div class="media wide">${art('portrait', t.id)}<span class="playbtn">${ic('play', 'lg')}</span></div>` : ''}
      <div class="pm" style="margin-top:10px">${avi(t.name, 22)}<span>${t.name}${t.place ? `, ${t.place}` : ''}</span></div>${acts(t.id, 'testimony')}</article>`;
  }
  if (f.ch === 'tv') {
    const p = byId(d.broadcasts, f.id)!;
    return html`<article class="post" data-watch="${p.id}">${head(d.settings.tvName, 'tv', p.publishedAt)}<h3>${p.title}</h3>${p.ref ? html`<span class="flair">${p.ref}</span>` : ''}
      <div class="media wide">${pic(p.poster)}<span class="playbtn">${ic('play', 'lg')}</span></div>${acts(p.id, 'broadcast')}</article>`;
  }
  if (f.ch === 'gallery') {
    const ph = d.photos.filter((p) => p.album === f.id);
    return html`<article class="post" data-chan="gallery" data-galset="${f.id}">${head('Gallery', 'gallery', f.ts)}<h3>New photos: ${f.id}</h3>
      <div class="media"><div class="mgrid">${ph.slice(0, 3).map((p, i) => html`<div>${pic(p.image, 'center 25%', '', p.caption)}${i === 2 && ph.length > 3 ? html`<span class="more-n">+${ph.length - 3}</span>` : ''}</div>`)}</div></div>${acts('gallery:' + f.id, null, { comments: false })}</article>`;
  }
  if (f.ch === 'events') {
    const e = byId(d.events, f.id)!, dt = parseD(e.date);
    return html`<article class="post" data-sheet="event:${e.id}">${head('Events', 'events', f.ts)}<h3>${e.title} ${eventWhenLabel(e)}</h3>
      <p class="ex">${e.description}</p><div class="evbox"><div class="dateblk"><b>${dt.getDate()}</b><span>${MON3[dt.getMonth()]}</span></div><div class="t"><b>${e.title}</b><span>${e.time}</span></div></div>${acts(e.id, 'event', { comments: false })}</article>`;
  }
  if (f.ch === 'songs') {
    const a = byId(d.albums, f.id)!, s = a.tracks[0];
    return html`<article class="post" data-page="album:${a.id}">${head(d.settings.recordsName, 'songs', a.publishedAt)}<h3>New album: ${a.title}</h3>
      <p class="ex">${a.tracks.length} songs from ${a.artist}. Start with the opening track.</p>
      <div class="songbox"><div class="cov">${look(a)}</div><div class="t"><b>${s.title}</b><span>${a.artist}</span></div><button class="roundplay" data-play="${a.id}:${s.id}" aria-label="Play ${s.title}">${ic('play', 'sm')}</button></div>${acts(a.id, 'album', { comments: false })}</article>`;
  }
  return raw('');
}

/* ---------- HOME ---------- */
export function renderHome(): SafeHTML {
  const d = D(), live = d.live;
  const b = d.posts[0], e = upcoming()[0], a = d.albums[0], last = d.broadcasts[0];
  const hero = live.onAir
    ? html`<button class="livecard" data-go="tv">${pic(live.poster, 'center 30%')}
      <div class="ov"><div class="row"><span class="live-pill"><i></i>LIVE</span><span>${d.settings.tvName}</span><span style="margin-left:auto;display:flex;gap:5px;align-items:center;visibility:hidden">${ic('eye', 'xs')}<span data-viewers>–</span></span></div>
      <div class="bottom"><div><h3>${live.title}</h3><div class="sub">${d.settings.leader}${live.ref ? `, ${live.ref}` : ''}</div></div><span class="watch">${ic('play', 'sm')}Watch</span></div></div></button>`
    : last ? html`<button class="livecard" data-watch="${last.id}">${pic(last.poster, 'center 30%')}
      <div class="ov"><div class="row"><span class="pill-off">REPLAY</span><span>${d.settings.tvName}</span></div>
      <div class="bottom"><div><h3>${last.title}</h3><div class="sub">${last.ref || last.category}</div></div><span class="watch">${ic('play', 'sm')}Watch</span></div></div></button>` : '';
  const cards: SafeHTML[] = [];
  if (b) cards.push(html`<button class="hcard" data-page="article:${b.id}"><div class="im">${look(b)}<span class="tag">${when(b.publishedAt) === 'Today' ? 'Today’s word' : 'Latest word'}</span></div><div class="bd"><b>${b.title}</b><span>${b.ref ? `${b.ref}, ` : ''}${readMins(b.body)} read</span></div></button>`);
  if (e) cards.push(html`<button class="hcard" data-sheet="event:${e.id}"><div class="im">${look(e, 'water')}<span class="tag">${dayLabel(e.date)}</span></div><div class="bd"><b>${e.title}</b><span>${e.time}</span></div></button>`);
  if (last) cards.push(html`<button class="hcard" data-watch="${last.id}"><div class="im">${pic(last.poster)}<span class="tag">Watch again</span></div><div class="bd"><b>${last.title}</b><span>${last.ref || last.category}</span></div></button>`);
  if (a) cards.push(html`<button class="hcard" data-page="album:${a.id}"><div class="im">${look(a)}<span class="tag">New album</span></div><div class="bd"><b>${a.title}</b><span>${d.settings.recordsName}</span></div></button>`);
  const items = feed();
  return html`${hero}
  ${cards.length ? html`<div class="sec"><h2>Highlights</h2></div><div class="hscroll">${cards}</div>` : ''}
  <div class="sortrow" style="margin-top:22px">${['For you', 'Latest', 'Popular'].map((s) => html`<button class="chip ${S.sort === s ? 'on' : ''}" data-sort="${s}" aria-pressed="${S.sort === s}">${s}</button>`)}</div>
  <div id="feed" style="margin-top:6px">${items.map(postCard)}</div>
  <div class="empty" style="margin-top:20px">${items.length ? 'You’re all caught up. Pull down to refresh.' : 'Nothing here yet. New posts from the ministry will appear here.'}</div>`;
}
export const renderFeed = (): SafeHTML => html`${feed().map(postCard)}`;

/* ---------- TV ---------- */
export function tvCurrent(): { live: boolean; title: string; sub: string; src: string; poster: string | null; id: string } | null {
  const d = D();
  if (S.tvNow === 'live') {
    if (!d.live.onAir) return null;
    return { live: true, title: d.live.title, sub: `${d.settings.leader}${d.live.ref ? `, ${d.live.ref}` : ''}`, src: videoSrc(d.live), poster: d.live.poster, id: 'live' };
  }
  const b = byId(d.broadcasts, S.tvNow);
  if (!b) return null;
  return { live: false, title: b.title, sub: `${b.ref ? b.ref + ', ' : ''}${when(b.publishedAt)}`, src: videoSrc(b), poster: b.poster, id: b.id };
}
export function renderTV(): SafeHTML {
  const d = D();
  const c = tvCurrent();
  if (!c) {
    if (S.tvPane === 'chat') S.tvPane = 'past';
    const next = d.schedule[0];
    return html`<div class="offair">${pic(d.live.poster || d.broadcasts[0]?.poster, 'center 30%')}<div class="ov"><span class="pill-off">OFF AIR</span><b>${d.settings.tvName} is off air right now</b><span>${next ? `Next: ${next.title} at ${next.time}. ` : ''}Watch a past message below.</span></div></div>
    <div class="seg" style="margin-top:18px">${[['next', 'Schedule'], ['past', 'Past messages']].map(([k, l]) => html`<button class="${S.tvPane === k ? 'on' : ''}" data-tvpane="${k}">${l}</button>`)}</div>
    <div id="tvpane"></div>`;
  }
  return html`
  <div class="player" id="player" data-player>
    <video id="tvv" playsinline webkit-playsinline preload="metadata" ${c.poster ? raw(`poster="${mediaUrl(c.poster)}"`) : ''}></video>
    <button class="unmute" id="unmute" data-mute hidden>${ic('vol', 'xs')}Tap for sound</button>
    <div class="pov">
      <div class="ptop">${c.live ? html`<span class="live-pill"><i></i>LIVE</span><span class="eye">${ic('eye', 'xs')}<span data-viewers>–</span></span>` : html`<span class="eye">Replay</span>`}
      <span style="margin-left:auto;display:flex;align-items:center;gap:6px;opacity:.95">${logo(18)}${d.settings.tvName}</span></div>
      <button class="ctr" data-tvplay aria-label="Play or pause">${ic('play', 'lg')}</button>
      <div class="pbot"><span id="tvt">${c.live ? 'LIVE' : '0:00'}</span><span class="bar ${c.live ? '' : 'vod'}" ${c.live ? '' : raw('data-seek role="slider" aria-label="Seek"')}><s><i id="tvbar" style="width:${c.live ? '100%' : '0%'}"></i></s></span><span id="tvdur"></span>
        <button data-mute aria-label="Sound" id="tvmute">${ic('vol', 'sm')}</button><button data-fs aria-label="Full screen">${ic('full', 'sm')}</button></div>
    </div>
  </div>
  <div class="tvinfo"><div class="brand">${chav('tv')}<span>${d.settings.tvName}</span>${!c.live && d.live.onAir ? html`<button class="chip" style="margin-left:auto;height:30px" data-golive><span class="live-pill" style="height:16px;padding:0 5px;font-size:9.5px"><i></i>LIVE</span>Back to live</button>` : ''}</div>
    <h1>${c.title}</h1><p>${c.sub}</p>
    <div class="acts">${amenBtn(c.live ? 'live' : c.id)}<button class="apill" data-share="${c.id}">${ic('share', 'sm')}Share</button>${c.live ? '' : html`<button class="apill ${S.saved[c.id] ? 'on' : ''}" data-save="${c.id}" data-kind="broadcast">${ic('save', 'sm')}Save</button>`}</div>
  </div>
  <div class="seg" style="margin-top:18px">${(c.live ? [['chat', 'Live chat'], ['next', 'Up next'], ['past', 'Past messages']] : [['past', 'Past messages'], ['next', 'Schedule']]).map(([k, l]) => html`<button class="${S.tvPane === k ? 'on' : ''}" data-tvpane="${k}">${l}</button>`)}</div>
  <div id="tvpane"></div>`;
}

/* ---------- LIBRARY ---------- */
export function cover(b: { id: string; title: string; image?: string | null; imagePos?: string | null }, big = false, showTitle = true): SafeHTML {
  return html`<div class="cover ${big ? 'big' : ''}">${look(b)}<div class="cv"><span class="ct">${showTitle ? b.title : ''}</span><span class="ca">${logo(big ? 22 : 16)}${D().settings.leader.toUpperCase()}</span></div></div>`;
}
export function trackRow(s: Song, num: number | null = null): SafeHTML {
  const on = player.key === s.key;
  const na = !s.audio;
  const lead = num != null
    ? html`<span class="num">${on ? html`<span class="eq ${player.playing ? '' : 'paused'}"><i></i><i></i><i></i></span>` : num}</span>`
    : html`<span class="cov">${look(s.album)}</span>`;
  return html`<button class="track ${on ? 'on' : ''} ${na ? 'na' : ''}" data-play="${s.key}" aria-label="${na ? `${s.title} (audio coming soon)` : `Play ${s.title}`}">${lead}<span class="tx"><b>${s.title}</b><span>${s.album.artist}</span></span>${na ? html`<span class="soon">Soon</span>` : html`<span class="d">${s.duration ? mmss(s.duration) : ''}</span>`}</button>`;
}
export function lastRead(): { book: Book; chapter: number; pct: number } | null {
  let best: { book: Book; chapter: number; pct: number; at: number } | null = null;
  for (const b of D().books) {
    const r = S.reading[b.id] as { chapter: number; pct: number; at?: number } | undefined;
    if (r && (!best || (r.at || 0) > best.at)) best = { book: b, chapter: r.chapter, pct: r.pct, at: r.at || 0 };
  }
  return best;
}
export function bookProgress(b: Book): number {
  const r = S.reading[b.id];
  if (!r || !b.chapters.length) return 0;
  return Math.min(1, (r.chapter + r.pct) / b.chapters.length);
}
export function renderLibrary(): SafeHTML {
  const d = D();
  const seg = html`<div class="seg">${['Books', 'Songs'].map((x) => html`<button class="${S.lib === x ? 'on' : ''}" data-libseg="${x}">${x}</button>`)}</div>`;
  if (S.lib === 'Books') {
    const lr = lastRead();
    return html`<h1 class="h-display">Library</h1>${seg}
    ${lr ? html`<div class="sec"><h2>Continue reading</h2></div>
    <button class="cont" data-page="reader:${lr.book.id}">${cover(lr.book, false, false)}
      <div class="tx"><small>Chapter ${lr.chapter + 1} of ${lr.book.chapters.length}</small><b>${lr.book.title}</b><div class="progress"><i style="width:${Math.round(bookProgress(lr.book) * 100)}%"></i></div><div class="pct">${Math.round(bookProgress(lr.book) * 100)}% read</div></div></button>` : ''}
    <div class="sec"><h2>Books by ${d.settings.leader}</h2><span style="font-size:13px;color:var(--muted)">${d.books.length} books</span></div>
    ${d.books.length ? html`<div class="bgrid">${d.books.map((b) => html`<button class="bk" data-page="book:${b.id}">${cover(b)}<b>${b.title}</b><span>${[b.year, b.pages ? `${b.pages} pages` : ''].filter(Boolean).join(', ')}</span></button>`)}</div>` : html`<div class="empty">Books will appear here soon.</div>`}`;
  }
  const all = songs();
  const firstPlayable = all.find((s) => s.audio);
  return html`<h1 class="h-display">Library</h1>${seg}
  <div class="recbanner">${pic(d.albums[0]?.image, '62% center')}<div class="ov">${logo(34)}<h3 style="margin-top:10px">${d.settings.recordsName}</h3><p>Every song recorded by the ministry, from the choir to live crusade nights.</p></div></div>
  <div class="sec"><h2>Albums</h2></div>
  <div class="hscroll">${d.albums.map((a) => html`<button class="alb" data-page="album:${a.id}"><div class="cov">${look(a)}</div><b>${a.title}</b><span>${[a.year, `${a.tracks.length} songs`].filter(Boolean).join(', ')}</span></button>`)}</div>
  <div class="sec"><h2>All songs</h2>${firstPlayable ? html`<button data-play="${firstPlayable.key}">Play all</button>` : ''}</div>
  <div id="songlist">${all.map((s) => trackRow(s))}</div>`;
}

/* ---------- EVENTS ---------- */
const evOn = (ds: string) => D().events.filter((e) => e.date === ds);
export function evRow(e: EventItem): SafeHTML {
  const dt = parseD(e.date);
  return html`<button class="evrow" data-sheet="event:${e.id}"><div class="dateblk ${e.date === S.calSel ? '' : 'soft'}"><b>${dt.getDate()}</b><span>${MON3[dt.getMonth()]}</span></div><div class="tx"><b>${e.title}</b><span>${ic('clock', 'xs')}${e.time}</span><span>${ic('pin', 'xs')}${e.place}</span></div>${S.reminders[e.id] ? html`<span style="color:var(--gold)" aria-label="Reminder set">${ic('bell', 'sm')}</span>` : ''}</button>`;
}
export function renderEvents(): SafeHTML {
  const y = S.calY, m = S.calM, first = new Date(y, m, 1), start = (first.getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate(), prevDays = new Date(y, m, 0).getDate();
  const total = Math.ceil((start + days) / 7) * 7;
  const today = todayIso();
  const cells: SafeHTML[] = [];
  for (let i = 0; i < total; i++) {
    let dd: number, mm = m, out = false;
    if (i < start) { dd = prevDays - start + i + 1; mm = m - 1; out = true; } else if (i >= start + days) { dd = i - start - days + 1; mm = m + 1; out = true; } else dd = i - start + 1;
    const dt = new Date(y, mm, dd), ds = iso(dt.getFullYear(), dt.getMonth(), dt.getDate()), n = evOn(ds).length;
    cells.push(html`<button class="${out ? 'out' : ''} ${ds === today ? 'today' : ''} ${ds === S.calSel ? 'sel' : ''}" data-day="${ds}" aria-label="${dayLabel(ds)}${n ? `, ${n} event${n > 1 ? 's' : ''}` : ''}" aria-pressed="${ds === S.calSel}">${dd}<span class="ds">${raw('<i></i>'.repeat(Math.min(n, 3)))}</span></button>`);
  }
  const sel = evOn(S.calSel), sd = parseD(S.calSel);
  const up = upcoming().slice(0, 12);
  return html`<h1 class="h-display">Events</h1><p class="lede">Services, conferences and gatherings. Tap a day to see what’s on.</p>
  <div class="cal" style="margin-top:16px"><div class="cal-h"><button class="ibtn clear" data-calnav="-1" aria-label="Previous month">${ic('back', 'sm')}</button><b aria-live="polite">${MONTHS[m]} ${y}</b><button class="ibtn clear" data-calnav="1" aria-label="Next month">${ic('right', 'sm')}</button></div>
  <div class="cal-g">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => html`<span class="wd">${w}</span>`)}${cells}</div></div>
  <div class="sec"><h2>${DOW[sd.getDay()]} ${sd.getDate()} ${MONTHS[sd.getMonth()]}</h2></div>
  ${sel.length ? sel.map(evRow) : html`<div class="empty">Nothing on this day. Pick a day with a dot, or watch a past message on ${D().settings.tvName}.</div>`}
  <div class="sec"><h2>Coming up</h2></div>
  ${up.length ? up.map(evRow) : html`<div class="empty">No upcoming events yet.</div>`}`;
}

/* ---------- CHANNELS ---------- */
function chanHeader(k: string, meta: string): SafeHTML {
  const c = CH()[k];
  return html`<div class="ch-banner">${pic(c.banner?.[0], c.banner?.[1] || 'center')}</div>
  <div class="ch-head">${chav(k, 'xl')}<h1>${c.full}</h1><div class="meta">${meta}</div><p>${c.about}</p></div>`;
}
export function renderChannel(k: string): SafeHTML {
  const d = D();
  if (k === 'blog') {
    const flairs = ['All', ...new Set(d.posts.map((p) => p.flair))];
    const list = d.posts.filter((b) => S.blogFlair === 'All' || b.flair === S.blogFlair);
    return html`${chanHeader(k, `${d.posts.length} posts`)}<div class="chips" style="margin-top:16px">${flairs.map((f) => html`<button class="chip ${S.blogFlair === f ? 'on' : ''}" data-blogflair="${f}">${f}</button>`)}</div>
    <div style="margin-top:6px">${list.map((b: Post) => html`<article class="post" data-page="article:${b.id}"><div class="pm">${leaderPfp(22)}<b>${d.settings.leader}</b><span>${when(b.publishedAt)}, ${readMins(b.body)} read</span></div>
      <div style="display:flex;gap:14px;margin-top:2px"><div style="flex:1"><h3>${b.title}</h3><span class="flair">${b.flair}</span></div><div style="width:92px;height:92px;border-radius:14px;overflow:hidden;flex:none;margin-top:8px">${look(b)}</div></div>
      ${acts(b.id, 'post')}</article>`)}</div>
    ${list.length ? '' : html`<div class="empty">No posts in this category yet.</div>`}`;
  }
  if (k === 'gallery') {
    const albums = ['All', ...new Set(d.photos.map((p) => p.album))];
    if (!albums.includes(S.gal)) S.gal = 'All';
    const list = d.photos.filter((p) => S.gal === 'All' || p.album === S.gal);
    return html`${chanHeader(k, `${d.photos.length} photos, ${albums.length - 1} albums`)}<div class="chips" style="margin:16px 0 12px">${albums.map((a) => html`<button class="chip ${S.gal === a ? 'on' : ''}" data-gal="${a}">${a}</button>`)}</div>
    ${list.length ? html`<div class="masonry">${list.map((p) => html`<button data-photo="${p.id}" aria-label="${p.caption}"><img src="${mediaUrl(p.image)}" alt="${p.caption}" loading="lazy" decoding="async"><span>${p.album}</span></button>`)}</div>` : html`<div class="empty">No photos yet.</div>`}`;
  }
  if (k === 'testimonies') {
    const list = d.testimonies.filter((t) => S.tst === 'All' || (S.tst === 'Video') === !!t.video);
    return html`${chanHeader(k, `${d.testimonies.length} testimonies`)}<button class="share-cta" style="margin-top:16px" data-write>${ic('quote', 'lg')}<div><b>Share your testimony</b><span>Write it or record a short video</span></div><span class="ibtn">${ic('plus', 'sm')}</span></button>
    <div class="chips" style="margin-bottom:12px">${['All', 'Written', 'Video'].map((x) => html`<button class="chip ${S.tst === x ? 'on' : ''}" data-tst="${x}">${x === 'Video' ? ic('video', 'xs') : x === 'Written' ? ic('text', 'xs') : ''}${x}</button>`)}</div>
    ${list.map((t: Testimony) => html`<article class="tcard" data-page="testimony:${t.id}"><div class="who">${avi(t.name)}<div><b>${t.name}</b><span>${t.place ? `${t.place}, ` : ''}${ago(t.publishedAt)} ago</span></div>${t.video ? html`<span class="apill" style="margin-left:auto">${ic('video', 'xs')}Video</span>` : ''}</div>
      ${t.video ? html`<div class="media wide">${art('portrait', t.id)}<span class="playbtn">${ic('play', 'lg')}</span></div>` : ''}
      <h3>${t.title}</h3><p class="q">“${t.quote || t.body[0]}”</p>${acts(t.id, 'testimony')}</article>`)}
    ${list.length ? '' : html`<div class="empty">No ${S.tst.toLowerCase()} testimonies yet. Be the first to share.</div>`}`;
  }
  return raw('');
}

export type { Broadcast };
