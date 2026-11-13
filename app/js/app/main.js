import { $, $$, html, ic, setHTML, must, fmt, parseD } from './lib.js';
import { ApiError, cachedBundle, fetchBundle, shareUrl, mediaUrl, myAmens, toggleAmen as apiToggleAmen, postChat, supa } from './api.js';
import { D, S, hydrate, save, STORAGE_KEYS } from './store.js';
import { getItem, hideSplash, loadStorage, onAppUrlOpen, onResume, scheduleReminder, cancelReminder, setItem, setStatusBar, share, tap, isNative } from './native.js';
import { closeAllPages, closeDrawer, closeLightbox, closeSheet, currentSheet, enableEdgeSwipe, focusTrapKeys, handleBack, initBack, openDrawer, openSheet, pageDepth, popPage, toast, topPage } from './ui.js';
import { CH, chav, logo, pic, renderChannel, renderEvents, renderFeed, renderHome, renderLibrary, renderTV, songs, trackRow, tvCurrent, byId, amenCount, evRow } from './views.js';
import { armIdle, chatPane, leaveTV, miniPlayer, mountTV, onLiveChange, onPlayerChange, pauseTV, playSong, renderChat, seekMusic, skip, startChat, stopChat, togglePlay, tvFullscreen, tvMute, tvSeek, tvToggle, player } from './media.js';
import { PAGES, SHEETS, pageHooks, bumpFont, cancelReply, deleteComment, doSearch, goChapter, addToCalendar, isDark, loadComments, openPage, openPdf, openSignIn, pickVideo, rerenderTop, setWriteTab, signOut, signedInHooks, startReply, submitComment, submitSignIn, submitTestimony } from './pages.js';
/* =========================================================
   BOOT
   ========================================================= */
async function boot() {
    await loadStorage(STORAGE_KEYS);
    supa.restore(); // the client was created before device storage finished loading
    hydrate();
    applyTheme(getItem('pko.theme') !== 'light');
    const cached = cachedBundle();
    if (cached)
        S.data = cached;
    const splashDone = splash();
    // Fetch fresh content in parallel with the splash animation.
    const fresh = fetchBundle(cached).then((r) => { S.data = r.bundle; return true; }).catch(() => false);
    await splashDone;
    const ok = await fresh;
    if (!S.data) {
        showFatal();
        return;
    }
    if (!ok)
        toast("You're offline — showing saved content.", 'err');
    syncAmens();
    if (getItem('pko.onboarded'))
        enterApp();
    else
        buildOnboarding();
}
function showFatal() {
    hideSplash();
    must('#splash').classList.add('leave');
    const sh = must('#shell');
    sh.hidden = false;
    setHTML(must('#main'), html `<div class="state">${ic('wifi', 'lg')}<b>Can’t connect</b>Check your internet connection and try again.<button class="btn fill" style="width:200px" data-retry>${ic('refresh', 'sm')}Try again</button></div>`);
}
/* ---------- splash ---------- */
function splash() {
    const logoImg = must('#spLogo');
    const logoSrc = S.data?.settings.logo ? mediaUrl(S.data.settings.logo) : 'icons/logo.webp';
    logoImg.src = logoSrc;
    const sh = must('#spShine');
    sh.style.webkitMaskImage = sh.style.maskImage = `url(${logoSrc})`;
    must('#spRays').innerHTML = Array.from({ length: 16 }, (_, i) => {
        const a = (i * 22.5 * Math.PI) / 180, L = i % 2 ? 26 : 48, r0 = 104;
        return `<line style="--i:${i};--l:${L}" stroke-width="${i % 2 ? 2 : 3}" x1="${(Math.sin(a) * r0).toFixed(1)}" y1="${(-Math.cos(a) * r0).toFixed(1)}" x2="${(Math.sin(a) * (r0 + L)).toFixed(1)}" y2="${(-Math.cos(a) * (r0 + L)).toFixed(1)}"/>`;
    }).join('');
    must('#spSpark').innerHTML = Array.from({ length: 18 }, () => {
        const a = Math.random() * Math.PI * 2, dist = 110 + Math.random() * 120;
        return `<i style="--s:${(2 + Math.random() * 3).toFixed(1)}px;--x:${(Math.cos(a) * dist).toFixed(0)}px;--y:${(Math.sin(a) * dist - 40).toFixed(0)}px;--t:${(1.6 + Math.random() * 1.2).toFixed(2)}s;--d:${(1.1 + Math.random() * 1.4).toFixed(2)}s"></i>`;
    }).join('');
    const name = S.data?.settings.appName || 'Prophet Kevin Online';
    const words = name.split(' ');
    const lines = words.length > 2 ? [words.slice(0, -1).join(' '), words[words.length - 1]] : [name];
    let k = 0;
    setHTML(must('#spWord'), html `${lines.map((line) => html `<span class="ln">${[...line].map((ch) => (ch === ' ' ? ' ' : html `<span class="ch" style="--d:${k++}">${ch}</span>`))}</span>`)}`);
    if (S.data)
        must('.sp-tag').textContent = S.data.settings.ministry;
    hideSplash(); // native splash hands over to the animated one
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Returning users get a shorter splash.
    const ms = reduce ? 500 : getItem('pko.onboarded') ? 1600 : 3800;
    return new Promise((done) => setTimeout(() => {
        must('#splash').classList.add('leave');
        setTimeout(() => $('#splash')?.remove(), 900);
        done();
    }, ms));
}
/* ---------- onboarding ---------- */
let obI = 0;
function slides() {
    const d = D(), st = d.settings;
    const img = (i) => d.photos[i]?.image || d.posts[i]?.image || null;
    return [
        { img: d.live.poster || img(11), pos: '55% center', h: 'Every service, wherever you are', p: `Watch ${st.tvName} live, or catch up on any message you missed.`, live: d.live.onAir },
        { img: img(10), pos: 'center 20%', h: 'Read and listen to the Word all week', p: `${st.leader}’s books, the daily blog and every ${st.recordsName} song in one library.` },
        { img: img(15) || img(2), pos: 'center 22%', h: 'One family, one altar', p: `${st.ministry}, led by ${st.leader}. Everything the ministry shares, in one place.` },
        { img: st.leaderPhoto || img(8), pos: 'center 18%', h: 'Join the family', p: 'Sign in to comment, join the live chat and share your testimony.', auth: true },
    ];
}
function buildOnboarding() {
    const ob = must('#onboard');
    ob.hidden = false;
    setHTML(must('#obBrand'), html `${logo(34)}<span>${D().settings.appName}<small>${D().settings.ministry}</small></span>`);
    const S_ = slides();
    setHTML(must('#obTrack'), html `${S_.map((s) => html `<div class="ob-slide">
    <div class="ob-art">${pic(s.img, s.pos)}</div>
    ${s.live ? html `<div class="ob-live"><span class="live-pill"><i></i>LIVE</span>${D().settings.tvName} is on air now</div>` : ''}<h2>${s.h}</h2><p>${s.p}</p>
    ${s.auth ? html `<div class="ob-auth"><button class="btn cream" data-enter="signin">${ic('user', 'sm')}Sign in with my name</button><button class="btn ghost" data-enter>Explore as guest</button></div>` : ''}
  </div>`)}`);
    setHTML(must('#obDots'), html `${S_.map((_, i) => html `<i class="${i === 0 ? 'on' : ''}"></i>`)}`);
    obGo(0);
    const track = must('#obTrack');
    let x0 = null;
    track.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    track.addEventListener('touchend', (e) => {
        if (x0 == null)
            return;
        const dx = e.changedTouches[0].clientX - x0;
        if (dx < -50 && obI < slides().length - 1)
            obGo(obI + 1);
        if (dx > 50 && obI > 0)
            obGo(obI - 1);
        x0 = null;
    });
    must('#obNext').onclick = () => (obI < slides().length - 1 ? obGo(obI + 1) : enterApp());
    must('#obSkip').onclick = () => obGo(slides().length - 1);
}
function obGo(i) {
    obI = i;
    must('#obTrack').style.transform = `translateX(${-100 * i}%)`;
    $$('#obDots i').forEach((d, j) => d.classList.toggle('on', j === i));
    const last = i === slides().length - 1;
    const n = must('#obNext');
    setHTML(n, last ? html `Explore as guest` : html `Next ${ic('right', 'sm')}`);
    n.hidden = last;
    must('#obSkip').hidden = last;
}
let entered = false;
function enterApp(signin = false) {
    setItem('pko.onboarded', '1');
    const ob = $('#onboard');
    if (ob && !ob.hidden) {
        ob.style.transition = 'opacity .45s';
        ob.style.opacity = '0';
        setTimeout(() => { ob.hidden = true; }, 460);
    }
    must('#shell').hidden = false;
    if (!entered) {
        entered = true;
        initBack(() => { if (S.chan || S.tab !== 'home') {
            go('home');
            return true;
        } return false; });
        enableEdgeSwipe(must('#phone'));
        focusTrapKeys();
        initPullToRefresh();
        setInterval(() => refresh(false), 5 * 60_000);
        onResume(() => refresh(false));
        window.addEventListener('online', () => { $('#netbar')?.remove(); refresh(false); });
        window.addEventListener('offline', showOffline);
    }
    renderTabbar();
    renderDrawer();
    go('home');
    if (signin)
        openSignIn('profile');
    openDeepLink(location.hash);
}
/* =========================================================
   SHELL
   ========================================================= */
function renderTabbar() {
    const t = [['home', 'home', 'Home'], ['tv', 'tv', 'TV'], null, ['library', 'lib', 'Library'], ['events', 'cal', 'Events']];
    setHTML(must('#tabbar'), html `${t.map((x) => x
        ? html `<button class="tab ${S.tab === x[0] && !S.chan ? 'on' : ''}" data-go="${x[0]}" aria-label="${x[2]}" aria-current="${S.tab === x[0] && !S.chan ? 'page' : 'false'}">${x[0] === 'tv' && D().live.onAir ? html `<span class="dot"></span>` : ''}${ic(x[1])}${x[2]}</button>`
        : html `<button class="tab-plus" data-sheet="create" aria-label="Share a testimony">${ic('plus', 'lg')}</button>`)}`);
}
function renderTopbar() {
    const d = D();
    let title;
    if (S.chan) {
        const c = CH()[S.chan];
        title = html `${chav(S.chan)}<span class="nm">${c.full || c.name}</span>`;
    }
    else if (S.tab === 'home')
        title = html `${logo(34)}<span class="nm">${d.settings.appName}<small>${d.settings.ministry}</small></span>`;
    else if (S.tab === 'tv') {
        const c = tvCurrent();
        title = html `${chav('tv')}<span class="nm">${d.settings.tvName}${c?.live ? html `<small style="color:var(--live)">Live now</small>` : c ? html `<small>Replay</small>` : html `<small>Off air</small>`}</span>`;
    }
    else if (S.tab === 'library')
        title = html `${chav('library')}<span class="nm">Library</span>`;
    else
        title = html `${chav('events')}<span class="nm">Events</span>`;
    setHTML(must('#topbar'), html `<button class="ibtn" data-drawer aria-label="Open menu">${ic('menu')}</button><div class="tb-title">${title}</div>
   <button class="ibtn" data-page="search" aria-label="Search">${ic('search')}</button>
   <button class="me" data-sheet="profile" aria-label="Your profile">${S.member ? html `<b style="font-size:14px">${S.member.name.slice(0, 1).toUpperCase()}</b>` : ic('user', 'sm')}</button>`);
}
function renderDrawer() {
    const d = D();
    const cur = S.chan || (S.tab === 'library' && S.lib === 'Songs' ? 'songs' : S.tab);
    const item = (k, attr, label, end = '') => html `<button class="dr-item ${cur === k ? 'on' : ''}" ${attr}>${chav(k)}${label}${end}</button>`;
    const next = d.events.find((e) => e.date >= new Date().toISOString().slice(0, 10));
    setHTML(must('#drawer'), html `
   <div class="dr-head">${logo(46)}<div class="nm">${d.settings.appName}<small>${d.settings.ministry}</small></div></div>
   ${d.live.onAir ? html `<button class="dr-feature" data-go="tv">${pic(d.live.poster, 'center 30%')}<div class="ov"><span class="live-pill" style="align-self:flex-start;margin-bottom:auto"><i></i>LIVE</span><b>${d.live.title}</b><span>${d.settings.tvName}${d.live.ref ? `, ${d.live.ref}` : ''}</span></div></button>` : ''}
   ${item('home', html `data-go="home"`, 'Home')}
   ${item('tv', html `data-go="tv"`, d.settings.tvName, d.live.onAir ? html `<span class="end"><span class="live-pill" style="height:18px;padding:0 6px;font-size:10px"><i></i>LIVE</span></span>` : '')}
   ${item('library', html `data-go="library" data-lib="Books"`, 'Library', html `<span class="end">${d.books.length} books</span>`)}
   ${item('songs', html `data-go="library" data-lib="Songs"`, 'Songs', html `<span class="end">${songs().length} songs</span>`)}
   ${item('blog', html `data-chan="blog"`, 'Blog', d.posts[0] && Date.now() - Date.parse(d.posts[0].publishedAt) < 864e5 ? html `<span class="end">New today</span>` : '')}
   ${item('gallery', html `data-chan="gallery"`, 'Gallery', html `<span class="end">${d.photos.length} photos</span>`)}
   ${item('events', html `data-go="events"`, 'Events', next ? html `<span class="end">${parseD(next.date).toDateString().slice(0, 10)}</span>` : '')}
   ${item('testimonies', html `data-chan="testimonies"`, 'Testimonies')}
   <div class="dr-sep"></div>
   <button class="dr-item" data-page="saved">${ic('save')}Saved</button>
   <button class="dr-item" data-sheet="about">${ic('info')}About the ministry</button>
   <button class="dr-item" data-theme-toggle role="switch" aria-checked="${isDark()}">${ic('moon')}Dark mode<span class="switch ${isDark() ? 'on' : ''}"></span></button>
   <button class="dr-item" data-sheet="profile">${ic('user')}Account</button>
   <button class="dr-item" data-replay>${ic('star')}Replay intro</button>`);
}
function go(tab, chan = null, opts = {}) {
    leaveTV();
    const same = S.tab === tab && S.chan === chan;
    S.tab = tab;
    S.chan = chan;
    if (opts.lib)
        S.lib = opts.lib;
    closeDrawer();
    closeSheet();
    closeLightbox();
    closeAllPages();
    renderTopbar();
    renderTabbar();
    renderDrawer();
    const m = must('#main');
    const st = m.scrollTop;
    const view = chan ? renderChannel(chan) : ({ home: renderHome, tv: renderTV, library: renderLibrary, events: renderEvents })[tab]();
    setHTML(m, html `<div class="view-in">${view}</div>`);
    m.scrollTop = opts.keepScroll && same ? st : 0;
    if (tab === 'tv' && !chan) {
        renderTvPane();
        const c = tvCurrent();
        if (c)
            mountTV(c.src, c.live);
        // Stay subscribed on the TV tab even when off air or watching a replay,
        // so "we're live" / "service ended" arrives instantly.
        startChat();
    }
}
const rerenderView = () => { const m = must('#main'); const st = m.scrollTop; const v = S.chan ? renderChannel(S.chan) : ({ home: renderHome, tv: renderTV, library: renderLibrary, events: renderEvents })[S.tab](); setHTML(m.firstElementChild, v); m.scrollTop = st; };
function renderTvPane() {
    const el = $('#tvpane');
    if (!el)
        return;
    const d = D();
    if (S.tvPane === 'chat' && tvCurrent()?.live) {
        setHTML(el, chatPane());
        renderChat();
        return;
    }
    if (S.tvPane === 'next') {
        setHTML(el, d.schedule.length ? html `<div style="padding-top:6px">${d.live.onAir ? html `<div class="sched"><span class="tm now">Now</span><div class="tx"><b>${d.live.title}</b><span>Live with ${d.settings.leader}</span></div><span class="live-pill"><i></i>LIVE</span></div>` : ''}
      ${d.schedule.map((s) => { const k = 's:' + s.id, on = !!S.reminders[k]; return html `<div class="sched"><span class="tm">${s.time}</span><div class="tx"><b>${s.title}</b><span>${s.subtitle || ''}</span></div><button class="remind ${on ? 'on' : ''}" data-remind="${k}" aria-pressed="${on}">${ic(on ? 'check' : 'bell', 'xs')}${on ? 'Reminder set' : 'Remind me'}</button></div>`; })}</div>`
            : html `<div class="empty">The schedule will be posted soon.</div>`);
        return;
    }
    S.tvPane = 'past';
    const cats = ['All', ...new Set(d.broadcasts.map((b) => b.category))];
    const list = d.broadcasts.filter((b) => S.tvCat === 'All' || b.category === S.tvCat);
    setHTML(el, html `<div class="chips" style="margin-top:12px">${cats.map((c) => html `<button class="chip ${S.tvCat === c ? 'on' : ''}" data-tvcat="${c}">${c}</button>`)}</div>
    <div style="margin-top:6px">${list.length ? list.map((b) => html `<button class="row ${S.tvNow === b.id ? 'on' : ''}" data-watch="${b.id}"><span class="th">${pic(b.poster)}</span><span class="tx"><b>${b.title}</b><span>${b.ref ? `${b.ref}, ` : ''}${new Date(b.publishedAt).toDateString().slice(4, 10)}</span></span></button>`) : html `<div class="empty">No past messages yet.</div>`}</div>`);
    $$('[data-tvpane]').forEach((b) => b.classList.toggle('on', b.dataset.tvpane === S.tvPane));
}
/* =========================================================
   DATA REFRESH
   ========================================================= */
let refreshing = false;
async function refresh(manual) {
    if (refreshing || !S.data)
        return;
    refreshing = true;
    try {
        const r = await fetchBundle(S.data);
        $('#netbar')?.remove();
        if (r.changed) {
            const liveChanged = S.data.live.onAir !== r.bundle.live.onAir;
            S.data = r.bundle;
            renderTopbar();
            renderTabbar();
            renderDrawer();
            // Don't yank the video out from under someone watching a replay.
            if (!(S.tab === 'tv' && !S.chan && !liveChanged))
                rerenderView();
        }
        if (manual)
            toast(r.changed ? 'Updated' : 'You’re up to date');
    }
    catch {
        if (manual)
            toast("Couldn't refresh. Check your connection.", 'err');
        else
            showOffline();
    }
    finally {
        refreshing = false;
    }
}
function showOffline() {
    if ($('#netbar') || navigator.onLine)
        return;
    must('#shell').insertAdjacentHTML('beforeend', html `<div class="netbar" id="netbar" role="status">${ic('wifi', 'xs')}Offline — showing saved content</div>`.s);
}
async function syncAmens() {
    try {
        const targets = await myAmens();
        S.amen = Object.fromEntries(targets.map((t) => [t, true]));
        save.amen();
    }
    catch { /* keep local copy */ }
}
onLiveChange((l) => {
    if (!S.data)
        return;
    const was = S.data.live.onAir;
    S.data.live = l;
    renderTabbar();
    renderDrawer();
    if (S.tab === 'tv' && !S.chan && S.tvNow === 'live' && was !== l.onAir) {
        toast(l.onAir ? `${S.data.settings.tvName} is live now` : 'The live service has ended');
        go('tv');
    }
    else if (S.tab === 'home' && !S.chan)
        rerenderView();
});
function initPullToRefresh() {
    const m = must('#main');
    let y0 = 0, pulling = false, dy = 0;
    const ind = document.createElement('div');
    ind.className = 'ptr';
    ind.setAttribute('aria-hidden', 'true');
    setHTML(ind, ic('refresh', 'sm'));
    must('#shell').appendChild(ind);
    m.addEventListener('touchstart', (e) => { if (m.scrollTop <= 0 && !pageDepth()) {
        y0 = e.touches[0].clientY;
        pulling = true;
        dy = 0;
    } }, { passive: true });
    m.addEventListener('touchmove', (e) => {
        if (!pulling)
            return;
        dy = e.touches[0].clientY - y0;
        if (dy > 0 && m.scrollTop <= 0)
            ind.classList.toggle('show', dy > 20), ind.style.transform = `translate(-50%, ${Math.min(dy, 110) * 0.6 - 60}px) rotate(${dy * 2}deg)`;
    }, { passive: true });
    m.addEventListener('touchend', async () => {
        if (!pulling)
            return;
        pulling = false;
        if (dy > 80) {
            ind.classList.add('busy');
            ind.style.transform = 'translate(-50%, 6px)';
            tap();
            await refresh(true);
            ind.classList.remove('busy');
        }
        ind.style.transform = '';
        ind.classList.remove('show');
    });
}
/* =========================================================
   PLAYER UI SYNC
   ========================================================= */
onPlayerChange(() => {
    const mini = must('#mini');
    mini.hidden = !player.key;
    setHTML(mini, miniPlayer());
    const sl = $('#songlist');
    if (sl)
        setHTML(sl, html `${songs().map((x) => trackRow(x))}`);
    for (const el of $$('[data-tracks]')) {
        const list = songs().filter((x) => x.album.id === el.dataset.tracks);
        setHTML(el, html `${list.map((x, i) => trackRow(x, i + 1))}`);
    }
    if (currentSheet() === 'player') {
        const h = SHEETS.player('');
        if (h)
            setHTML(must('#sheet'), h);
    }
});
/* =========================================================
   THEME
   ========================================================= */
function applyTheme(dark) {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $$('.switch').forEach((s) => s.classList.toggle('on', dark));
    $$('[data-theme-toggle]').forEach((s) => s.setAttribute('aria-checked', String(dark)));
    const meta = $('meta[name=theme-color]');
    if (meta)
        meta.content = dark ? '#130A20' : '#F6F1FA';
    setStatusBar(dark);
}
/* =========================================================
   ACTIONS
   ========================================================= */
async function toggleAmen(id, btns) {
    const want = !S.amen[id];
    S.amen[id] = want;
    const counts = D().amens;
    counts[id] = Math.max(0, (counts[id] || 0) + (want ? 1 : -1));
    paintAmen(id, btns);
    if (want) {
        tap();
        toast('Amen');
    }
    try {
        const r = await apiToggleAmen(id, want);
        S.amen[id] = r.on;
        counts[id] = r.count;
    }
    catch (e) {
        S.amen[id] = !want;
        counts[id] = Math.max(0, (counts[id] || 0) + (want ? -1 : 1));
        toast(e.message, 'err');
    }
    if (!S.amen[id])
        delete S.amen[id];
    save.amen();
    paintAmen(id, $$(`[data-amen="${CSS.escape(id)}"]`));
}
function paintAmen(id, btns) {
    const on = !!S.amen[id];
    for (const b of btns) {
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
        const em = b.querySelector('em');
        if (em)
            em.textContent = b.closest('.cm') ? (amenCount(id) || '') + '' : fmt(amenCount(id));
        b.classList.remove('pop');
        void b.offsetWidth;
        b.classList.add('pop');
    }
}
function toggleSave(id, kind) {
    if (S.saved[id])
        delete S.saved[id];
    else
        S.saved[id] = { kind: kind, id, at: new Date().toISOString() };
    save.saved();
    const on = !!S.saved[id];
    for (const b of $$(`[data-save="${CSS.escape(id)}"]`)) {
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
        b.style.color = on && !b.classList.contains('apill') ? 'var(--gold)' : '';
    }
    tap();
    toast(on ? 'Saved' : 'Removed from saved');
}
function sharePath(id) {
    const d = D();
    if (id === 'live')
        return { path: '/tv', title: d.live.title };
    const p = byId(d.posts, id);
    if (p)
        return { path: `/article/${id}`, title: p.title };
    const t = byId(d.testimonies, id);
    if (t)
        return { path: `/testimony/${id}`, title: t.title };
    const b = byId(d.broadcasts, id);
    if (b)
        return { path: `/watch/${id}`, title: b.title };
    const bk = byId(d.books, id);
    if (bk)
        return { path: `/book/${id}`, title: bk.title };
    const a = byId(d.albums, id);
    if (a)
        return { path: `/album/${id}`, title: a.title };
    const e = byId(d.events, id);
    if (e)
        return { path: `/event/${id}`, title: e.title };
    if (id.startsWith('gallery:'))
        return { path: '/gallery', title: `${id.slice(8)} photos` };
    return { path: '/', title: d.settings.appName };
}
async function doShare(id) {
    const { path, title } = sharePath(id);
    const r = await share({ title, text: `${title} — ${D().settings.appName}`, url: shareUrl(path) });
    if (r === 'copied')
        toast('Link copied');
}
function openDeepLink(hash) {
    const m = /^#\/(\w+)(?:\/([\w:-]+))?/.exec(hash || '');
    if (!m)
        return;
    history.replaceState(history.state, '', location.pathname + location.search);
    const [, kind, id] = m;
    if (kind === 'tv') {
        S.tvNow = 'live';
        go('tv');
    }
    else if (kind === 'watch' && id) {
        S.tvNow = id;
        S.tvPane = 'past';
        go('tv');
    }
    else if (kind === 'event' && id) {
        const s = SHEETS.event(id);
        if (s)
            openSheet('event:' + id, s);
    }
    else if (kind === 'gallery')
        go('home', 'gallery');
    else if (id && PAGES[kind])
        openPage(`${kind}:${id}`);
}
onAppUrlOpen((url) => { const i = url.indexOf('#'); if (i >= 0)
    openDeepLink(url.slice(i)); });
/** Next occurrence of a schedule slot ("18:30"), or the start of an event, minus a lead time. */
function reminderTime(key) {
    const d = D();
    if (key.startsWith('s:')) {
        const s = byId(d.schedule, key.slice(2));
        if (!s)
            return null;
        const [h, mi] = s.time.split(':').map(Number);
        const at = new Date();
        at.setHours(h || 0, mi || 0, 0, 0);
        if (at.getTime() < Date.now())
            at.setDate(at.getDate() + 1);
        at.setMinutes(at.getMinutes() - 10);
        return { at, title: `${s.title} starts in 10 minutes`, body: `Watch on ${d.settings.tvName}` };
    }
    const e = byId(d.events, key);
    if (!e)
        return null;
    const tm = /(\d{1,2}):(\d{2})/.exec(e.time);
    const at = parseD(e.date);
    at.setHours(tm ? Number(tm[1]) : 9, tm ? Number(tm[2]) : 0, 0, 0);
    at.setHours(at.getHours() - 1);
    return { at, title: `${e.title} starts in an hour`, body: `${e.time} · ${e.place}` };
}
async function toggleReminder(key, btn) {
    const on = !S.reminders[key];
    if (on)
        S.reminders[key] = true;
    else
        delete S.reminders[key];
    save.reminders();
    const big = btn.hasAttribute('data-evremind');
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    setHTML(btn, html `${ic(on ? 'check' : 'bell', big ? 'sm' : 'xs')}${on ? 'Reminder set' : 'Remind me'}`);
    if (!on) {
        cancelReminder(key);
        toast('Reminder removed');
    }
    else {
        const r = reminderTime(key);
        const scheduled = r ? await scheduleReminder(key, r.title, r.body, r.at) : false;
        toast(scheduled || !isNative() ? 'Reminder set' : 'Reminder saved. Turn on notifications to get an alert.');
    }
    if (S.tab === 'events' && !S.chan)
        rerenderView();
}
/* =========================================================
   EVENT DELEGATION
   ========================================================= */
document.addEventListener('click', (e) => {
    const t = e.target.closest('button,[data-seek],[data-page],[data-sheet],[data-go],[data-chan],[data-watch],[data-photo],[data-player],[data-scrub],a[data-ext]');
    if (!t || t.disabled)
        return;
    const d = t.dataset;
    if (d.retry !== undefined) {
        location.reload();
        return;
    }
    if (d.amen) {
        e.stopPropagation();
        toggleAmen(d.amen, $$(`[data-amen="${CSS.escape(d.amen)}"]`));
        return;
    }
    if (d.save) {
        e.stopPropagation();
        toggleSave(d.save, d.kind || 'post');
        return;
    }
    if (d.share !== undefined) {
        e.stopPropagation();
        doShare(d.share || '');
        return;
    }
    if (d.openComments) {
        e.stopPropagation();
        const card = t.closest('[data-page]');
        const pg = card ? openPage(card.dataset.page) : openPage('comments:' + d.openComments);
        if (pg)
            setTimeout(() => $(`#comments-${CSS.escape(d.openComments)}`, pg)?.scrollIntoView({ behavior: 'smooth' }), 450);
        return;
    }
    if (d.play) {
        e.stopPropagation();
        playSong(d.play);
        return;
    }
    if (d.toggleplay !== undefined) {
        e.stopPropagation();
        togglePlay();
        return;
    }
    if (d.skip) {
        e.stopPropagation();
        skip(Number(d.skip));
        return;
    }
    if (d.scrub !== undefined) {
        const r = t.getBoundingClientRect();
        seekMusic((e.clientX - r.left) / r.width);
        return;
    }
    // TV
    if (d.tvplay !== undefined) {
        e.stopPropagation();
        tvToggle();
        return;
    }
    if (d.mute !== undefined) {
        e.stopPropagation();
        tvMute();
        return;
    }
    if (d.seek !== undefined) {
        e.stopPropagation();
        const r = t.getBoundingClientRect();
        tvSeek((e.clientX - r.left) / r.width);
        return;
    }
    if (d.fs !== undefined) {
        e.stopPropagation();
        tvFullscreen();
        return;
    }
    if (d.player !== undefined) {
        armIdle();
        return;
    }
    if (d.remind) {
        e.stopPropagation();
        toggleReminder(d.remind, t);
        return;
    }
    if (d.ics) {
        addToCalendar(d.ics);
        return;
    }
    if (d.pdf) {
        openPdf(d.pdf);
        return;
    }
    // account
    if (d.signin !== undefined) {
        openSignIn(d.signin || 'profile');
        return;
    }
    if (d.signout !== undefined) {
        signOut();
        return;
    }
    if (d.enter !== undefined) {
        enterApp(d.enter === 'signin');
        return;
    }
    // navigation
    if (d.drawer !== undefined) {
        openDrawer();
        return;
    }
    if (d.back !== undefined) {
        handleBack();
        return;
    }
    if (d.closesheet !== undefined) {
        closeSheet();
        return;
    }
    if (d.themeToggle !== undefined) {
        const dark = !isDark();
        applyTheme(dark);
        setItem('pko.theme', dark ? 'dark' : 'light');
        return;
    }
    if (d.replay !== undefined) {
        setItem('pko.onboarded', null);
        location.reload();
        return;
    }
    if (d.write !== undefined) {
        closeSheet();
        openPage('write:' + (d.write || 'text'));
        return;
    }
    if (d.go) {
        if (d.go === 'tv') {
            S.tvNow = 'live';
            S.tvPane = d.tvpaneGo || 'chat';
        }
        go(d.go, null, { lib: d.lib });
        return;
    }
    if (d.chan) {
        if (d.galset)
            S.gal = d.galset;
        go(S.tab === 'tv' ? 'home' : S.tab, d.chan);
        return;
    }
    if (d.page) {
        openPage(d.page);
        return;
    }
    if (d.sheet) {
        const [n, a] = d.sheet.split(':');
        const h = SHEETS[n]?.(a);
        if (h)
            openSheet(d.sheet, h);
        return;
    }
    if (d.watch) {
        pauseTV();
        S.tvNow = d.watch;
        S.tvPane = 'past';
        go('tv');
        return;
    }
    if (d.golive !== undefined) {
        S.tvNow = 'live';
        S.tvPane = 'chat';
        go('tv');
        return;
    }
    if (d.photo) {
        openLb(d.photo);
        return;
    }
    if (d.lb) {
        lbStep(Number(d.lb));
        return;
    }
    if (d.lbclose !== undefined) {
        closeLightbox();
        return;
    }
    // in-view filters
    if (d.sort) {
        S.sort = d.sort;
        $$('[data-sort]').forEach((b) => { b.classList.toggle('on', b.dataset.sort === S.sort); b.setAttribute('aria-pressed', String(b.dataset.sort === S.sort)); });
        const f = $('#feed');
        if (f)
            setHTML(f, renderFeed());
        return;
    }
    if (d.libseg) {
        S.lib = d.libseg;
        rerenderView();
        renderDrawer();
        return;
    }
    if (d.tvpane) {
        S.tvPane = d.tvpane;
        $$('[data-tvpane]').forEach((b) => b.classList.toggle('on', b.dataset.tvpane === S.tvPane));
        renderTvPane();
        return;
    }
    if (d.tvcat) {
        S.tvCat = d.tvcat;
        renderTvPane();
        return;
    }
    if (d.calnav) {
        S.calM += Number(d.calnav);
        if (S.calM < 0) {
            S.calM = 11;
            S.calY--;
        }
        if (S.calM > 11) {
            S.calM = 0;
            S.calY++;
        }
        rerenderView();
        return;
    }
    if (d.day) {
        S.calSel = d.day;
        const dd = parseD(d.day);
        S.calM = dd.getMonth();
        S.calY = dd.getFullYear();
        rerenderView();
        return;
    }
    if (d.gal) {
        S.gal = d.gal;
        rerenderView();
        return;
    }
    if (d.tst) {
        S.tst = d.tst;
        rerenderView();
        return;
    }
    if (d.blogflair) {
        S.blogFlair = d.blogflair;
        rerenderView();
        return;
    }
    if (d.q) {
        const q = $('#q');
        if (q)
            q.value = d.q;
        doSearch(d.q);
        return;
    }
    if (d.wtab) {
        setWriteTab(d.wtab);
        return;
    }
    if (d.fontsize !== undefined) {
        bumpFont();
        return;
    }
    if (d.chgo) {
        goChapter(Number(d.chgo));
        return;
    }
    if (d.reply) {
        startReply(d.reply, d.name || '');
        return;
    }
    if (d.cancelreply !== undefined) {
        cancelReply();
        return;
    }
    if (d.delcomment) {
        deleteComment(d.delcomment);
        return;
    }
    if (d.reloadcomments) {
        loadComments(d.reloadcomments);
        return;
    }
});
document.addEventListener('submit', async (e) => {
    const f = e.target;
    e.preventDefault();
    if (f.matches('[data-signinform]'))
        submitSignIn(f);
    else if (f.matches('[data-compose]'))
        submitComment(f);
    else if (f.matches('[data-testimony]'))
        submitTestimony(f);
    else if (f.matches('[data-chatform]')) {
        const i = $('#chatIn', f);
        const body = i.value.trim();
        if (!body)
            return;
        i.value = '';
        try {
            await postChat(body);
        }
        catch (err) {
            i.value = body;
            if (err instanceof ApiError && err.status === 401) {
                S.member = null;
                save.member();
                openSignIn('chat');
            }
            else
                toast(err.message, 'err');
        }
    }
});
document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'video' && t.type === 'file')
        pickVideo(t);
});
pageHooks.readerClosed = () => {
    if (topPage()?.dataset.key?.startsWith('book:'))
        rerenderTop();
    if (S.tab === 'library' && !S.chan && S.lib === 'Books')
        rerenderView();
};
/* After signing in, refresh whatever needed the account. */
signedInHooks.push((reason) => {
    renderTopbar();
    if (reason === 'write' && !topPage()?.dataset.key?.startsWith('write')) {
        openPage('write:text');
        return;
    }
    if (topPage())
        rerenderTop();
    if (S.tab === 'tv' && S.tvPane === 'chat')
        renderTvPane();
});
/* ---------- lightbox ---------- */
let lbList = [], lbI = 0;
function openLb(id) {
    lbList = D().photos.filter((p) => S.gal === 'All' || p.album === S.gal);
    lbI = Math.max(0, lbList.findIndex((p) => p.id === id));
    drawLb();
    must('#lb').classList.add('on');
}
function lbStep(dir) { lbI = (lbI + dir + lbList.length) % lbList.length; drawLb(); }
function drawLb() {
    const p = lbList[lbI];
    if (!p)
        return;
    const lb = must('#lb');
    setHTML(lb, html `<div class="lbh"><button class="ibtn" data-lbclose aria-label="Close">${ic('close')}</button><span style="font-size:14px;font-weight:600">${lbI + 1} of ${lbList.length}</span><button class="ibtn" data-share="gallery:${p.album}" aria-label="Share">${ic('share')}</button></div>
   <div class="stage">${pic(p.image, 'center', '', p.caption)}${lbList.length > 1 ? html `<button class="nav l" data-lb="-1" aria-label="Previous photo">${ic('back')}</button><button class="nav r" data-lb="1" aria-label="Next photo">${ic('right')}</button>` : ''}</div>
   <div class="cap"><b>${p.caption}</b><span>${p.album}</span></div>`);
    const img = $('.stage img', lb);
    if (img) {
        img.className = '';
        img.loading = 'eager';
        img.style.objectPosition = '';
    }
}
{
    let x0 = null;
    document.addEventListener('touchstart', (e) => { if (e.target.closest('#lb .stage'))
        x0 = e.touches[0].clientX; }, { passive: true });
    document.addEventListener('touchend', (e) => {
        if (x0 == null)
            return;
        const dx = e.changedTouches[0].clientX - x0;
        x0 = null;
        if (Math.abs(dx) > 50)
            lbStep(dx < 0 ? 1 : -1);
    });
}
document.addEventListener('keydown', (e) => {
    if (!$('#lb.on'))
        return;
    if (e.key === 'ArrowRight')
        lbStep(1);
    if (e.key === 'ArrowLeft')
        lbStep(-1);
});
must('#main').addEventListener('scroll', (e) => must('#topbar').classList.toggle('scrolled', e.target.scrollTop > 4), { passive: true });
must('#scrim').addEventListener('click', () => closeDrawer());
// Safety net for older WebViews without overflow:clip — the frame itself must never scroll.
{
    const ph = must('#phone');
    ph.addEventListener('scroll', () => { if (ph.scrollLeft || ph.scrollTop) {
        ph.scrollLeft = 0;
        ph.scrollTop = 0;
    } });
}
must('#scrim2').addEventListener('click', () => closeSheet());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden')
    stopChat();
else if (S.tab === 'tv' && !S.chan)
    startChat(); });
// Service worker: offline app shell for the PWA build (native builds ship files locally).
if ('serviceWorker' in navigator && !isNative() && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { });
}
// Expose a tiny hook for automated UI tests.
window.__pko = { S, go, popPage, evRow, supa };
boot().catch((e) => { console.error(e); showFatal(); });
