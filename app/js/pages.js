import { $, $$, html, raw, ic, art, avi, fmt, mmss, ago, when, readMins, parseD, MONTHS, DOW, setHTML } from './lib.js';
import { api, ApiError, API_BASE, mediaUrl, upload } from './api.js';
import { D, S, save } from './store.js';
import { closeSheet, openSheet, popPage, pushPage, refreshPage, setBusy, toast, topPage } from './ui.js';
import { acts, amenCount, byId, chav, commentCount, cover, leaderPfp, logo, look, pic, songs, trackRow, bookProgress, videoSrc } from './views.js';
import { currentSong, player } from './media.js';
import { openExternal, setItem } from './native.js';
const phead = (title = '', over = false, right = '') => html `<div class="phead ${over ? 'over' : ''}"><button class="ibtn" data-back aria-label="Back">${ic('back')}</button><span class="t">${title}</span>${right || raw('<span style="width:40px"></span>')}</div>`;
const shareBtn = (id) => html `<button class="ibtn" data-share="${id}" aria-label="Share">${ic('share')}</button>`;
const notFound = (what) => ({ html: html `${phead()}<div class="state"><b>${what} not found</b>It may have been removed by the media team.</div>` });
/* =========================================================
   COMMENTS (shared by articles, testimonies, broadcasts)
   ========================================================= */
const commentCache = new Map();
let replyTo = null;
function commentsBlock(target) {
    return html `<div class="sec" id="comments-${target}"><h2>Comments</h2><span style="font-size:13px;color:var(--muted)" data-ccount="${target}">${commentCount(target)}</span></div>
  <div class="comments" data-comments="${target}"><div class="skel" style="height:64px;margin:8px 0"></div></div>
  <form class="compose" data-compose="${target}">${S.member
        ? html `<div class="replying" hidden></div><input class="inp" name="body" maxlength="1000" placeholder="Add a comment as ${S.member.name}" aria-label="Comment" autocomplete="off" enterkeyhint="send"><button class="ibtn" style="background:var(--fill);color:var(--on-fill)" aria-label="Post comment">${ic('send', 'sm')}</button>`
        : html `<button type="button" class="btn fill" style="flex:1;height:46px" data-signin="comment">${ic('user', 'sm')}Sign in to comment</button>`}</form>`;
}
function commentHtml(c) {
    const mine = S.member?.id === c.memberId;
    return html `<div class="cm ${c.parentId ? 'reply' : ''}" data-cid="${c.id}">${avi(c.name, 32)}<div class="body"><div class="h"><b>${c.name}</b> ${ago(c.createdAt)}</div><p>${c.body}</p>
    <div class="a"><button data-amen="${c.id}" class="${S.amen[c.id] ? 'on' : ''}" aria-pressed="${!!S.amen[c.id]}" aria-label="Amen">${ic('star', 'xs')}<em>${c.amens + (S.amen[c.id] && !c.amens ? 1 : 0) || ''}</em></button>
    ${c.parentId ? '' : html `<button data-reply="${c.id}" data-name="${c.name}">Reply</button>`}${mine ? html `<button data-delcomment="${c.id}">Delete</button>` : ''}</div></div></div>`;
}
function paintComments(target) {
    const box = $(`[data-comments="${target}"]`, topPage() || document);
    if (!box)
        return;
    const list = commentCache.get(target) || [];
    const tops = list.filter((c) => !c.parentId);
    const kids = (id) => list.filter((c) => c.parentId === id);
    setHTML(box, list.length ? html `${tops.map((c) => html `${commentHtml(c)}${kids(c.id).map(commentHtml)}`)}` : html `<div class="empty" style="margin:6px 0">No comments yet. Be the first to say something.</div>`);
    for (const x of $$(`[data-ccount="${target}"]`))
        x.textContent = String(list.length);
    D().comments[target] = list.length;
}
export async function loadComments(target) {
    if (commentCache.has(target))
        paintComments(target);
    try {
        const r = await api(`/api/comments?target=${encodeURIComponent(target)}`);
        commentCache.set(target, r.comments);
        paintComments(target);
    }
    catch (e) {
        const box = $(`[data-comments="${target}"]`);
        if (box && !commentCache.has(target))
            setHTML(box, html `<div class="empty" style="margin:6px 0">${e.message} <button class="chip" style="display:inline-flex;margin-top:8px" data-reloadcomments="${target}">Try again</button></div>`);
    }
}
export function startReply(id, name) {
    const form = $('form.compose', topPage() || document);
    if (!form || !S.member)
        return;
    replyTo = { id, name };
    const r = $('.replying', form);
    r.hidden = false;
    setHTML(r, html `Replying to ${name} <button type="button" data-cancelreply>Cancel</button>`);
    $('input', form)?.focus();
}
export function cancelReply() {
    replyTo = null;
    const r = $('.replying', topPage() || document);
    if (r) {
        r.hidden = true;
        r.textContent = '';
    }
}
export async function submitComment(form) {
    const target = form.dataset.compose;
    const input = $('input', form);
    const body = input.value.trim();
    if (!body)
        return;
    const btn = $('button[aria-label="Post comment"]', form);
    setBusy(btn, true);
    try {
        const r = await api('/api/comments', { method: 'POST', body: { target, body, parentId: replyTo?.id } });
        const list = commentCache.get(target) || [];
        list.push(r.comment);
        commentCache.set(target, list);
        input.value = '';
        cancelReply();
        paintComments(target);
        updateCommentPills(target);
        toast('Comment posted');
    }
    catch (e) {
        if (e instanceof ApiError && e.status === 401) {
            S.member = null;
            save.member();
            openSignIn('comment');
        }
        else
            toast(e.message, 'err');
    }
    finally {
        setBusy(btn, false);
    }
}
export async function deleteComment(id) {
    const page = topPage();
    const box = page ? $('[data-comments]', page) : null;
    const target = box?.dataset.comments;
    try {
        await api(`/api/comments/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (target) {
            commentCache.set(target, (commentCache.get(target) || []).filter((c) => c.id !== id && c.parentId !== id));
            paintComments(target);
            updateCommentPills(target);
        }
        toast('Comment deleted');
    }
    catch (e) {
        toast(e.message, 'err');
    }
}
function updateCommentPills(target) {
    for (const b of $$(`[data-open-comments="${target}"]`))
        setHTML(b, html `${ic('comment', 'sm')}${fmt(commentCount(target))}`);
}
/* =========================================================
   PAGES
   ========================================================= */
export const PAGES = {
    article(id) {
        const b = byId(D().posts, id);
        if (!b)
            return notFound('Post');
        const st = D().settings;
        return {
            html: html `${phead('', true, shareBtn(b.id))}
      <div class="hero">${look(b)}</div>
      <div style="padding:0 16px;margin-top:-24px;position:relative"><span class="flair" style="margin:0">${b.flair}</span></div>
      <h1 class="art-h1" style="margin-top:12px">${b.title}</h1>
      <div class="byline">${leaderPfp()}<div><b>${st.leader}</b>${when(b.publishedAt)}, ${readMins(b.body)} read</div></div>
      ${b.verse ? html `<div class="verse">${b.verse}${b.ref ? html `<cite>${b.ref} (KJV)</cite>` : ''}</div>` : ''}
      <div class="prose">${b.body.map((p) => html `<p>${p}</p>`)}</div>
      <div class="pad">${acts(b.id, 'post', { comments: false })}</div>
      ${commentsBlock(b.id)}`,
            after: () => loadComments(b.id),
        };
    },
    testimony(id) {
        const t = byId(D().testimonies, id);
        if (!t)
            return notFound('Testimony');
        return {
            html: html `${phead('Testimony', false, shareBtn(t.id))}
      ${t.video ? html `<div class="player" style="margin:0"><video controls playsinline preload="metadata" src="${mediaUrl(t.video)}" style="position:absolute;inset:0;width:100%;height:100%;background:#000"></video></div>` : ''}
      <div class="pad" style="padding-top:16px"><div style="display:flex;gap:12px;align-items:center">${avi(t.name, 44)}<div><b style="font-size:15px">${t.name}</b><div style="font-size:13px;color:var(--muted)">${t.place ? `${t.place}, ` : ''}${ago(t.publishedAt)} ago</div></div></div></div>
      <h1 class="art-h1" style="margin-top:14px">${t.title}</h1>
      ${t.quote ? html `<div class="verse" style="font-size:24px">“${t.quote}”</div>` : ''}
      <div class="prose">${t.body.map((p) => html `<p>${p}</p>`)}</div>
      <div class="pad">${acts(t.id, 'testimony', { comments: false })}</div>
      <button class="share-cta" style="margin-top:24px" data-write>${ic('quote', 'lg')}<div><b>Has God done something for you?</b><span>Share your testimony with the family</span></div><span class="ibtn">${ic('right', 'sm')}</span></button>
      ${commentsBlock(t.id)}`,
            after: () => loadComments(t.id),
        };
    },
    comments(id) {
        const b = byId(D().broadcasts, id);
        return {
            html: html `${phead(b ? b.title : 'Comments')}${b ? html `<button class="row" data-watch="${b.id}"><span class="th">${pic(b.poster)}</span><span class="tx"><b>${b.title}</b><span>${b.ref || b.category}</span></span></button>` : ''}${commentsBlock(id)}`,
            after: () => loadComments(id),
        };
    },
    book(id) {
        const b = byId(D().books, id);
        if (!b)
            return notFound('Book');
        const prog = bookProgress(b);
        const saved = !!S.saved[id];
        return {
            html: html `${phead('', false, html `<button class="ibtn ${saved ? 'on' : ''}" data-save="${id}" data-kind="book" aria-label="${saved ? 'Remove from saved' : 'Save'}" aria-pressed="${saved}" style="${saved ? 'color:var(--gold)' : ''}">${ic('save')}</button>`)}
      <div class="bookhero">${cover(b, true)}<h1>${b.title}</h1><div class="by">${D().settings.leader}</div></div>
      <div class="stats"><div><b>${b.pages || '–'}</b><span>Pages</span></div><div><b>${b.chapters.length}</b><span>Chapters</span></div><div><b>${b.year || '–'}</b><span>Published</span></div></div>
      <p class="lede" style="margin-top:18px;font-size:15.5px;color:var(--text);line-height:1.6">${b.description}</p>
      <div class="pad" style="margin-top:20px;display:grid;gap:10px">
        ${b.chapters.length ? html `<button class="btn fill" style="width:100%" data-page="reader:${b.id}">${ic('book', 'sm')}${prog > 0 ? `Continue reading (${Math.round(prog * 100)}%)` : 'Start reading'}</button>` : ''}
        ${b.pdf ? html `<button class="btn line" style="width:100%" data-pdf="${b.pdf}">${ic('file', 'sm')}Open the PDF edition</button>` : ''}
        ${!b.chapters.length && !b.pdf ? html `<div class="empty" style="margin:0">This book will be available to read in the app soon.</div>` : ''}
      </div>
      ${b.chapters.length ? html `<div class="sec"><h2>Chapters</h2></div><div class="chlist">${b.chapters.map((c, i) => html `<button class="row" data-page="reader:${b.id}:${i}"><span class="num">${i + 1}</span><span class="tx"><b>${c.title}</b><span>${Math.max(1, Math.round(c.words / 200))} min read</span></span>${ic('right', 'sm')}</button>`)}</div>` : ''}
      ${D().books.length > 1 ? html `<div class="sec"><h2>Also by ${D().settings.leader}</h2></div>
      <div class="hscroll">${D().books.filter((x) => x.id !== id).map((x) => html `<button class="bk" style="width:120px" data-page="book:${x.id}">${cover(x)}<b style="font-size:13.5px">${x.title}</b></button>`)}</div>` : ''}`,
        };
    },
    reader(id, chArg) {
        const b = byId(D().books, id);
        if (!b || !b.chapters.length)
            return notFound('Book');
        const saved = S.reading[id];
        const idx = Math.min(b.chapters.length - 1, Math.max(0, chArg !== undefined ? Number(chArg) || 0 : saved?.chapter || 0));
        const ch = b.chapters[idx];
        const resumePct = chArg === undefined && saved?.chapter === idx ? saved.pct : 0;
        return {
            html: html `${phead(b.title, false, html `<button class="ibtn" data-fontsize aria-label="Text size">${ic('text')}</button>`)}
      <div class="reader" style="--rs:${S.readerSize}px" data-reader="${b.id}" data-ch="${idx}"><div class="chn">Chapter ${idx + 1} of ${b.chapters.length}</div><h2>${ch.title}</h2><div data-chbody><div class="skel" style="height:18px;margin:12px 0"></div><div class="skel" style="height:18px;margin:12px 0;width:80%"></div><div class="skel" style="height:18px;margin:12px 0;width:90%"></div></div></div>
      <div class="chnav">${idx > 0 ? html `<button class="btn line" data-chgo="${idx - 1}">${ic('back', 'sm')}Previous</button>` : ''}${idx < b.chapters.length - 1 ? html `<button class="btn fill" data-chgo="${idx + 1}">Next chapter${ic('right', 'sm')}</button>` : html `<div class="empty" style="margin:0;flex:1;padding:14px">You’ve reached the end of this book.</div>`}</div>
      <div class="readbar"><span>Ch. ${idx + 1}</span><div class="progress"><i data-readprog style="width:${Math.round(((idx + resumePct) / b.chapters.length) * 100)}%"></i></div><span>${b.chapters.length}</span></div>`,
            after: (el) => loadChapter(el, b.id, ch.id, idx, b.chapters.length, resumePct),
            onClose: () => setTimeout(() => pageHooks.readerClosed(), 0),
        };
    },
    album(id) {
        const a = byId(D().albums, id);
        if (!a)
            return notFound('Album');
        const list = songs().filter((s) => s.album.id === id);
        const tot = list.reduce((s, x) => s + (x.duration || 0), 0);
        const first = list.find((s) => s.audio);
        const saved = !!S.saved[id];
        return {
            html: html `${phead('', true)}<div style="aspect-ratio:1;position:relative">${look(a)}<div style="position:absolute;inset:auto 0 0 0;height:60%;background:linear-gradient(180deg,transparent,var(--bg))"></div></div>
      <div class="pad" style="margin-top:-70px;position:relative"><div style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--muted)">${chav('songs')}${D().settings.recordsName}</div>
      <h1 class="art-h1" style="margin:12px 0 0">${a.title}</h1><div style="font-size:14px;color:var(--muted);margin-top:6px">${[a.artist, a.year, `${list.length} songs`, tot ? `${Math.round(tot / 60)} min` : ''].filter(Boolean).join(', ')}</div>
      <div style="display:flex;gap:10px;margin-top:18px"><button class="btn fill" style="flex:1" ${first ? raw(`data-play="${first.key}"`) : raw('disabled')}>${ic('play', 'sm')}${first ? 'Play' : 'Audio coming soon'}</button><button class="btn line ${saved ? 'on' : ''}" style="width:54px;${saved ? 'color:var(--gold)' : ''}" data-save="${id}" data-kind="album" aria-label="${saved ? 'Remove from saved' : 'Save album'}" aria-pressed="${saved}">${ic('heart', 'sm')}</button><button class="btn line" style="width:54px" data-share="${id}" aria-label="Share">${ic('share', 'sm')}</button></div></div>
      <div style="margin-top:12px" data-tracks="${id}">${list.map((s, i) => trackRow(s, i + 1))}</div>`,
        };
    },
    search() {
        return {
            html: html `<div class="phead"><button class="ibtn" data-back aria-label="Back">${ic('back')}</button><input class="inp" id="q" type="search" placeholder="Search messages, songs, books" aria-label="Search" style="height:42px" autocomplete="off" enterkeyhint="search"></div>
      <div id="sres"><div class="dr-sec" style="padding-left:16px">Try searching for</div><div class="chips" style="flex-wrap:wrap">${suggestions().map((s) => html `<button class="chip" data-q="${s}">${s}</button>`)}</div></div>`,
            after(el) { const q = $('#q', el); setTimeout(() => q.focus({ preventScroll: true }), 400); q.addEventListener('input', () => doSearch(q.value)); },
        };
    },
    saved() {
        const d = D();
        const refs = Object.values(S.saved).sort((a, b) => b.at.localeCompare(a.at));
        const rows = [];
        for (const r of refs) {
            if (r.kind === 'post') {
                const x = byId(d.posts, r.id);
                if (x)
                    rows.push(html `<button class="row" data-page="article:${x.id}"><span class="th">${look(x)}</span><span class="tx"><b>${x.title}</b><span>Blog, ${x.flair}</span></span></button>`);
            }
            if (r.kind === 'book') {
                const x = byId(d.books, r.id);
                if (x)
                    rows.push(html `<button class="row" data-page="book:${x.id}"><span class="th">${look(x)}</span><span class="tx"><b>${x.title}</b><span>Book</span></span></button>`);
            }
            if (r.kind === 'album') {
                const x = byId(d.albums, r.id);
                if (x)
                    rows.push(html `<button class="row" data-page="album:${x.id}"><span class="th">${look(x)}</span><span class="tx"><b>${x.title}</b><span>Album, ${x.artist}</span></span></button>`);
            }
            if (r.kind === 'broadcast') {
                const x = byId(d.broadcasts, r.id);
                if (x)
                    rows.push(html `<button class="row" data-watch="${x.id}"><span class="th">${pic(x.poster)}</span><span class="tx"><b>${x.title}</b><span>${d.settings.tvName}</span></span></button>`);
            }
            if (r.kind === 'testimony') {
                const x = byId(d.testimonies, r.id);
                if (x)
                    rows.push(html `<button class="row" data-page="testimony:${x.id}"><span class="th">${art('portrait', x.id)}</span><span class="tx"><b>${x.title}</b><span>Testimony, ${x.name}</span></span></button>`);
            }
            if (r.kind === 'event') {
                const x = byId(d.events, r.id);
                if (x)
                    rows.push(html `<button class="row" data-sheet="event:${x.id}"><span class="th">${look(x, 'water')}</span><span class="tx"><b>${x.title}</b><span>Event, ${x.time}</span></span></button>`);
            }
        }
        return { html: html `${phead('Saved')}${rows.length ? html `<div style="margin-top:6px">${rows}</div>` : html `<div class="empty saved-empty">Tap ${ic('save', 'xs')} on any post, book, album or message to keep it here.</div>`}` };
    },
    write(mode) {
        if (!S.member)
            return { html: html `${phead('Share your testimony')}<div class="state"><b>Sign in to share</b>So the media team can follow up with you.<button class="btn fill" style="width:220px" data-signin="write">${ic('user', 'sm')}Sign in</button></div>` };
        const video = mode === 'video';
        return {
            html: html `${phead('Share your testimony')}
      <div class="seg" style="margin-top:4px"><button type="button" class="${video ? '' : 'on'}" data-wtab="text">Write it</button><button type="button" class="${video ? 'on' : ''}" data-wtab="video">Record a video</button></div>
      <form class="form" style="margin-top:16px" data-testimony novalidate>
        <label>Title<input class="field" name="title" maxlength="140" required placeholder="For example: Healed after three years of pain"></label>
        <label>Your story<textarea class="field" name="body" rows="6" required placeholder="What happened, and what did God do?"></textarea></label>
        <div data-wvideo ${video ? '' : raw('hidden')}>
          <label class="drop" data-drop>${ic('upload', 'lg')}<b style="color:var(--text)" data-dropname>Add a video</b><span>Up to 5 minutes. Record now or choose from your phone.</span>
            <input type="file" name="video" accept="video/*" capture="user" class="hidden-input"></label>
          <div class="upbar" hidden style="margin-top:10px"><i></i></div>
        </div>
        <label>Name shown with your testimony<input class="field" name="name" maxlength="80" value="${S.member.name}"></label>
        <label>City<input class="field" name="place" maxlength="80" placeholder="Douala"></label>
        <div class="ferr" data-ferr hidden></div>
        <button class="btn fill" type="submit">${ic('send', 'sm')}Send testimony</button>
        <p style="font-size:12.5px;color:var(--muted);margin:0;line-height:1.5">The media team reviews every testimony before it appears in the app.</p>
      </form>`,
        };
    },
};
/** Set by main: refresh whatever shows reading progress once the reader closes. */
export const pageHooks = { readerClosed: () => { } };
export function openPage(key) {
    const [name, a, b] = key.split(':');
    const fn = PAGES[name];
    if (!fn)
        return null;
    return pushPage(key, fn(a, b));
}
/** Re-render the open page with the same key (e.g. after sign-in). */
export function rerenderTop() {
    const el = topPage();
    if (!el?.dataset.key)
        return;
    const [name, a, b] = el.dataset.key.split(':');
    const fn = PAGES[name];
    if (fn)
        refreshPage(el, fn(a, b));
}
/* ---------- reader ---------- */
let readTimer;
async function loadChapter(el, bookId, chId, idx, total, resumePct) {
    const body = $('[data-chbody]', el);
    try {
        const ch = await api(`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chId)}`);
        setHTML(body, html `${ch.body.map((p) => html `<p>${p}</p>`)}`);
        if (resumePct > 0)
            requestAnimationFrame(() => { el.scrollTop = resumePct * (el.scrollHeight - el.clientHeight); });
    }
    catch (e) {
        setHTML(body, html `<div class="empty" style="font-family:var(--sans)">${e.message}</div>`);
        return;
    }
    const record = () => {
        const max = el.scrollHeight - el.clientHeight;
        const pct = max > 0 ? Math.min(1, el.scrollTop / max) : 1;
        S.reading[bookId] = { chapter: idx, pct, at: Date.now() };
        const bar = $('[data-readprog]', el);
        if (bar)
            bar.style.width = Math.round(((idx + pct) / total) * 100) + '%';
        clearTimeout(readTimer);
        readTimer = window.setTimeout(save.reading, 400);
    };
    el.addEventListener('scroll', record, { passive: true });
    record();
}
export function goChapter(i) {
    const el = topPage();
    const r = el && $('[data-reader]', el);
    if (!el || !r)
        return;
    const id = r.dataset.reader;
    el.dataset.key = `reader:${id}:${i}`;
    refreshPage(el, PAGES.reader(id, String(i)));
    el.scrollTop = 0;
}
export function bumpFont() {
    S.readerSize = S.readerSize >= 27 ? 17 : S.readerSize + 2;
    save.readerSize();
    for (const r of $$('.reader'))
        r.style.setProperty('--rs', S.readerSize + 'px');
    toast(`Text size ${S.readerSize}`);
}
export const openPdf = (id) => openExternal(mediaUrl(id));
/* ---------- search ---------- */
function suggestions() {
    const d = D();
    return [d.live.onAir ? d.live.title : '', d.broadcasts[0]?.title, d.posts[0]?.title, 'Healing', d.albums[0]?.tracks[0]?.title, d.events[0]?.title].filter((x) => !!x).slice(0, 6);
}
export function doSearch(v) {
    const q = v.trim().toLowerCase();
    const el = $('#sres');
    if (!el)
        return;
    if (!q) {
        setHTML(el, html `<div class="dr-sec" style="padding-left:16px">Try searching for</div><div class="chips" style="flex-wrap:wrap">${suggestions().map((s) => html `<button class="chip" data-q="${s}">${s}</button>`)}</div>`);
        return;
    }
    const d = D();
    const hits = [];
    if (d.live.onAir)
        hits.push({ t: d.live.title, s: `Live now on ${d.settings.tvName}`, h: pic(d.live.poster), go: raw('data-go="tv"'), text: d.live.ref || '' });
    for (const b of d.broadcasts)
        hits.push({ t: b.title, s: `${d.settings.tvName}, ${b.ref || b.category}`, h: pic(b.poster), go: raw(`data-watch="${b.id}"`), text: `${b.ref} ${b.category}` });
    for (const b of d.posts)
        hits.push({ t: b.title, s: `Blog, ${b.flair}`, h: look(b), go: raw(`data-page="article:${b.id}"`), text: `${b.ref} ${b.verse} ${b.body.join(' ')}` });
    for (const t of d.testimonies)
        hits.push({ t: t.title, s: `Testimony, ${t.name}`, h: art('portrait', t.id), go: raw(`data-page="testimony:${t.id}"`), text: `${t.place} ${t.body.join(' ')}` });
    for (const s of songs())
        hits.push({ t: s.title, s: `Song, ${s.album.title}`, h: look(s.album), go: raw(`data-play="${s.key}"`), text: s.album.artist });
    for (const b of d.books)
        hits.push({ t: b.title, s: `Book${b.year ? ', ' + b.year : ''}`, h: look(b), go: raw(`data-page="book:${b.id}"`), text: b.description });
    for (const e of d.events)
        hits.push({ t: e.title, s: `Event, ${e.date}`, h: look(e, 'water'), go: raw(`data-sheet="event:${e.id}"`), text: `${e.place} ${e.description}` });
    // Title matches first, then body matches.
    const scored = hits.map((h) => ({ h, score: (h.t + ' ' + h.s).toLowerCase().includes(q) ? 2 : (h.text || '').toLowerCase().includes(q) ? 1 : 0 })).filter((x) => x.score).sort((a, b) => b.score - a.score).slice(0, 20);
    setHTML(el, scored.length
        ? html `<div class="sres">${scored.map(({ h }) => html `<button class="row" ${h.go}><span class="th">${h.h}</span><span class="tx"><b>${h.t}</b><span>${h.s}</span></span></button>`)}</div>`
        : html `<div class="empty">Nothing matches “${v}”. Try a message title, a scripture or a song.</div>`);
}
/* ---------- write testimony ---------- */
let pendingVideo = null;
export function setWriteTab(tab) {
    const pg = topPage();
    if (!pg)
        return;
    for (const b of $$('[data-wtab]', pg))
        b.classList.toggle('on', b.dataset.wtab === tab);
    const v = $('[data-wvideo]', pg);
    if (v)
        v.hidden = tab !== 'video';
    if (tab !== 'video')
        pendingVideo = null;
}
export function pickVideo(input) {
    const f = input.files?.[0] || null;
    const pg = topPage();
    if (!pg)
        return;
    if (f && f.size > 300e6) {
        toast('That video is too large. Please choose one under 300 MB.', 'err');
        input.value = '';
        return;
    }
    pendingVideo = f;
    const name = $('[data-dropname]', pg);
    if (name)
        name.textContent = f ? f.name : 'Add a video';
    $('[data-drop]', pg)?.classList.toggle('has', !!f);
}
export async function submitTestimony(form) {
    const fd = new FormData(form);
    const title = String(fd.get('title') || '').trim();
    const body = String(fd.get('body') || '').trim();
    const err = $('[data-ferr]', form);
    for (const f of $$('.field', form))
        f.classList.remove('bad');
    const problems = [];
    if (!title) {
        problems.push('Add a title');
        $('[name=title]', form)?.classList.add('bad');
    }
    if (body.length < 20) {
        problems.push('Tell your story in a few sentences');
        $('[name=body]', form)?.classList.add('bad');
    }
    const wantsVideo = !$('[data-wvideo]', form)?.hidden;
    if (wantsVideo && !pendingVideo)
        problems.push('Add your video, or switch to “Write it”');
    if (problems.length) {
        err.hidden = false;
        err.textContent = problems.join('. ') + '.';
        return;
    }
    err.hidden = true;
    const btn = $('button[type=submit]', form);
    setBusy(btn, true);
    try {
        let video = null;
        if (wantsVideo && pendingVideo) {
            const bar = $('.upbar', form);
            bar.hidden = false;
            const i = $('i', bar);
            video = (await upload('/api/uploads', pendingVideo, (p) => { i.style.width = Math.round(p * 100) + '%'; })).id;
        }
        await api('/api/testimonies', { method: 'POST', body: { title, body, name: fd.get('name'), place: fd.get('place'), video } });
        pendingVideo = null;
        popPage();
        toast('Thank you! Your testimony was sent for review.');
    }
    catch (e) {
        if (e instanceof ApiError && e.status === 401) {
            S.member = null;
            save.member();
            openSignIn('write');
        }
        else {
            err.hidden = false;
            err.textContent = e instanceof ApiError && e.details ? Object.values(e.details).join('. ') : e.message;
        }
    }
    finally {
        setBusy(btn, false);
    }
}
/* =========================================================
   SHEETS
   ========================================================= */
const REASONS = {
    chat: 'Sign in to send messages and prayer points to the live service.',
    comment: 'Sign in to join the conversation.',
    write: 'Sign in so the media team can follow up on your testimony.',
    profile: 'Sign in to comment, join the live chat and share your testimony.',
};
let afterSignIn = null;
export function openSignIn(reason = 'profile') {
    afterSignIn = reason;
    openSheet('signin', html `<div class="grab"></div><h3>Join the family</h3><p class="sub">${REASONS[reason] || REASONS.profile}</p>
  <form class="form" style="margin-top:16px" data-signinform novalidate>
    <label>Your name<input class="field" name="name" maxlength="60" autocomplete="name" required placeholder="e.g. Grace N." enterkeyhint="next"></label>
    <label>Phone number (optional)<input class="field" name="phone" type="tel" maxlength="20" autocomplete="tel" inputmode="tel" placeholder="+237 6 00 00 00 00" enterkeyhint="go"></label>
    <div class="ferr" data-ferr hidden></div>
    <button class="btn fill" type="submit">${ic('check', 'sm')}Continue</button>
  </form>
  <p class="signin-note" style="margin-top:12px">Your name is shown with your comments and chat messages. The ministry keeps your number private.</p>`, {
        after: (sh) => setTimeout(() => $('[name=name]', sh)?.focus({ preventScroll: true }), 350),
    });
}
export async function submitSignIn(form) {
    const fd = new FormData(form);
    const err = $('[data-ferr]', form);
    const btn = $('button[type=submit]', form);
    setBusy(btn, true);
    try {
        const r = await api('/api/members', { method: 'POST', body: { name: fd.get('name'), phone: fd.get('phone') } });
        setItem('pko.token', r.token);
        S.member = r.member;
        save.member();
        closeSheet();
        toast(`Welcome, ${r.member.name.split(' ')[0]}!`);
        signedInHooks.forEach((h) => h(afterSignIn));
    }
    catch (e) {
        err.hidden = false;
        err.textContent = e.message;
    }
    finally {
        setBusy(btn, false);
    }
}
export const signedInHooks = [];
export async function signOut() {
    try {
        await api('/api/me/session', { method: 'DELETE' });
    }
    catch { /* offline: still clear locally */ }
    setItem('pko.token', null);
    S.member = null;
    save.member();
    closeSheet();
    toast('Signed out');
    signedInHooks.forEach((h) => h(null));
}
export function isDark() { return document.documentElement.dataset.theme !== 'light'; }
export const SHEETS = {
    create() {
        return html `<div class="grab"></div><h3>Share with the family</h3><p class="sub">Everything you share is reviewed by the media team first.</p><div style="margin-top:12px">
    <button class="opt" data-write><span class="oi">${ic('text')}</span><div><b>Write a testimony</b><span>Tell what God has done</span></div></button>
    <button class="opt" data-write="video"><span class="oi">${ic('video')}</span><div><b>Record a video testimony</b><span>Up to 5 minutes</span></div></button>
    ${D().live.onAir ? html `<button class="opt" data-go="tv" data-tvpane-go="chat"><span class="oi">${ic('comment')}</span><div><b>Send a prayer point to the live service</b><span>Read out during ${D().settings.tvName}</span></div></button>` : ''}</div>`;
    },
    about() {
        const s = D().settings;
        return html `<div class="grab"></div><div class="about">${logo(132)}<h3>${s.ministry}</h3><p class="sub">${s.aboutText}</p></div>
    ${s.aboutVerse ? html `<div class="verse">${s.aboutVerse}${s.aboutVerseRef ? html `<cite>${s.aboutVerseRef}</cite>` : ''}</div>` : ''}
    <div class="btnrow"><button class="btn fill" data-go="tv">${ic('tv', 'sm')}${D().live.onAir ? 'Watch live' : 'Watch'}</button><button class="btn line" data-go="events">${ic('cal', 'sm')}Events</button></div>`;
    },
    profile() {
        const m = S.member;
        const savedN = Object.keys(S.saved).length;
        return html `<div class="grab"></div><div style="display:flex;flex-direction:column;align-items:center;padding:10px 20px 0;text-align:center">
      ${m ? html `<span class="avatar-me">${m.name.slice(0, 1).toUpperCase()}</span><h3 style="margin-top:14px">${m.name}</h3><p class="sub" style="margin:0">Signed in on this device</p>`
            : html `<span class="me" style="width:76px;height:76px">${ic('user', 'lg')}</span><h3 style="margin-top:14px">You’re browsing as a guest</h3><p class="sub" style="margin:0">Sign in to comment, join the live chat and share your testimony.</p>`}</div>
    ${m ? '' : html `<div style="display:grid;gap:10px;margin:20px"><button class="btn fill" data-signin="profile">${ic('user', 'sm')}Sign in</button></div>`}
    <div style="margin-top:${m ? 16 : 0}px">
    <button class="opt" data-page="saved"><span class="oi">${ic('save')}</span><div><b>Saved</b><span>${savedN ? `${savedN} item${savedN > 1 ? 's' : ''}` : 'Posts, books and messages you keep'}</span></div></button>
    <button class="opt" data-theme-toggle role="switch" aria-checked="${isDark()}"><span class="oi">${ic('moon')}</span><div><b>Dark mode</b><span>Royal purple, easy on the eyes at night services</span></div><span class="switch ${isDark() ? 'on' : ''}"></span></button>
    <button class="opt" data-sheet="about"><span class="oi">${ic('info')}</span><div><b>About the ministry</b><span>${D().settings.ministry}</span></div></button>
    ${m ? html `<button class="opt" data-signout><span class="oi">${ic('logout')}</span><div><b>Sign out</b><span>You can sign back in any time</span></div></button>` : ''}</div>`;
    },
    event(id) {
        const e = byId(D().events, id);
        if (!e)
            return null;
        const dt = parseD(e.date);
        const on = !!S.reminders[e.id];
        return html `<div class="grab"></div><div class="evhero">${look(e, 'water')}<div style="position:absolute;left:14px;top:14px"><div class="dateblk"><b>${dt.getDate()}</b><span>${MONTHS[dt.getMonth()].slice(0, 3)}</span></div></div></div>
    <h3 style="margin-top:16px;font-size:24px;font-weight:300;letter-spacing:-.04em">${e.title}</h3>
    <div class="evmeta"><div><span class="ibtn">${ic('cal', 'sm')}</span>${DOW[dt.getDay()]} ${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}</div><div><span class="ibtn">${ic('clock', 'sm')}</span>${e.time}</div><div><span class="ibtn">${ic('pin', 'sm')}</span>${e.place}</div></div>
    <p class="sub" style="font-size:15px;color:var(--text)">${e.description}</p>
    <div class="btnrow" style="margin-top:20px"><button class="btn fill" data-ics="${e.id}">${ic('cal', 'sm')}Add to calendar</button><button class="btn line ${on ? 'on' : ''}" data-remind="${e.id}" data-evremind aria-pressed="${on}">${ic(on ? 'check' : 'bell', 'sm')}${on ? 'Reminder set' : 'Remind me'}</button></div>
    <div class="pad" style="margin-top:14px">${acts(e.id, 'event', { comments: false })}</div>`;
    },
    player() {
        const s = currentSong();
        if (!s)
            return null;
        const p = player.dur ? (player.pos / player.dur) * 100 : 0;
        return html `<div class="grab"></div><div class="np"><div style="display:flex;align-items:center;justify-content:space-between"><button class="ibtn clear" data-closesheet aria-label="Close">${ic('back', 'sm')}</button><span style="font-size:13px;font-weight:600;color:var(--muted)">${s.album.title}</span><button class="ibtn clear" data-share="${s.album.id}" aria-label="Share">${ic('share', 'sm')}</button></div>
    <div class="cov ${player.playing ? '' : 'paused'}">${look(s.album)}</div>
    <h2>${s.title}</h2><div class="ar">${s.album.artist}</div>
    <div class="scrub" data-scrub role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p)}"><i id="npBar" style="width:${p}%"></i></div>
    <div class="times"><span id="npPos">${mmss(player.pos)}</span><span id="npRem">-${mmss(Math.max(0, player.dur - player.pos))}</span></div>
    <div class="ctrls"><button data-skip="-1" aria-label="Previous">${ic('prev', 'lg')}</button><button class="bigplay" data-toggleplay aria-label="${player.playing ? 'Pause' : 'Play'}">${ic(player.playing ? 'pause' : 'play', 'lg')}</button><button data-skip="1" aria-label="Next">${ic('next', 'lg')}</button></div></div>`;
    },
};
export function icsUrl(id) { return `${API_BASE || location.origin}/api/events/${encodeURIComponent(id)}.ics`; }
export { videoSrc, amenCount };
