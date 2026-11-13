import { $, $$, api, ApiError, NotAdminError, bytes, confirmDialog, html, ic, mediaUrl, raw, rel, setHTML, setUnauthorizedHandler, toast, toLocalInput, uploadFile } from './lib.js';
import { SchemaForm, thumb } from './form.js';
import { APP_URL, claimOwner, createAccount, supa } from './backend.js';
import { importStarterContent } from './seed.js';
import { validate } from '../shared/schema.js';
import { onNow, upNext, airLabel, SOURCES } from '../shared/channel.js';
let me = null;
let schema;
let currentForm = null;
let pendingName = '';
let liveRoom = null;
const view = () => $('#view');
/* ---------- boot / auth ---------- */
async function boot() {
    setUnauthorizedHandler(() => { if (me) {
        me = null;
        showLogin('Your session ended. Please sign in again.');
    } });
    if (!supa.configured) {
        setHTML($('#app'), html `<main class="login"><div class="card"><h1>Not connected</h1><p class="muted">This dashboard isn't linked to a Supabase project yet. Set <code>supabaseUrl</code> and <code>supabaseAnonKey</code> in <code>config.js</code> (the GitHub build does this for you).</p></div></main>`);
        return;
    }
    try {
        me = (await api('/api/admin/me')).admin;
    }
    catch {
        showLogin();
        return;
    }
    await startApp();
}
function showLogin(msg = '', mode = 'signin') {
    stopChat();
    document.body.classList.add('auth');
    const create = mode === 'create';
    setHTML($('#app'), html `<main class="login"><form class="card" id="loginForm" data-mode="${mode}" novalidate>
    <img src="../app/icons/logo.webp" alt="" class="login-logo">
    <h1>${create ? 'Create your account' : 'Creator dashboard'}</h1><p class="muted">${create ? 'For the media team. The first account becomes the dashboard owner.' : 'Sign in to publish to the app.'}</p>
    ${msg ? html `<p class="note" role="status">${msg}</p>` : ''}
    ${create ? html `<label class="fld"><span class="lbl">Your name</span><input class="inp" name="name" autocomplete="name" required></label>` : ''}
    <label class="fld"><span class="lbl">Email</span><input class="inp" name="email" type="email" autocomplete="username" required></label>
    <label class="fld"><span class="lbl">Password${create ? ' (10+ characters)' : ''}</span><input class="inp" name="password" type="password" autocomplete="${create ? 'new-password' : 'current-password'}" required></label>
    <p class="err" data-loginerr hidden></p>
    <button class="btn primary block" type="submit">${create ? 'Create account' : 'Sign in'}</button>
    <button class="btn ghost block" type="button" data-loginmode="${create ? 'signin' : 'create'}">${create ? 'I already have an account' : 'Create an account'}</button>
  </form></main>`);
    $(create ? '[name=name]' : '[name=email]')?.focus();
}
/** Signed in, but not on the team yet: either claim ownership (first ever) or ask for access. */
function showNoAccess(hasOwner, email) {
    document.body.classList.add('auth');
    setHTML($('#app'), html `<main class="login"><div class="card" data-noaccess>
    <img src="../app/icons/logo.webp" alt="" class="login-logo">
    ${hasOwner
        ? html `<h1>Almost there</h1><p class="muted">You're signed in as <b>${email}</b>, but you don't have dashboard access yet. Ask the dashboard owner to add this email under <i>Team &amp; password</i>.</p>`
        : html `<h1>Set up the dashboard</h1><p class="muted">No one owns this dashboard yet. Become the owner as <b>${email}</b>? You can add the rest of the media team afterwards.</p>
        <label class="fld"><span class="lbl">Your name</span><input class="inp" name="ownername" autocomplete="name" value="${pendingName}"></label>
        <p class="err" data-claimerr hidden></p>
        <button class="btn primary block" data-claim>Become the owner</button>`}
    <button class="btn ghost block" data-logout style="margin-top:10px">Sign out</button></div></main>`);
}
async function startApp() {
    document.body.classList.remove('auth');
    schema = await api('/api/admin/schema');
    setHTML($('#app'), html `<div class="shell">
    <aside class="side" id="side"><div class="brand"><img src="../app/icons/logo.webp" alt=""><div><b>PKO Studio</b><small>Creator dashboard</small></div></div>
      <nav>${navItem('#/', 'home', 'Overview')}${navItem('#/live', 'live', 'Live & chat')}
        <div class="navsec">Content</div>${schema.collections.map((c) => navItem(`#/c/${c.key}`, c.icon, c.label, c.moderated ? html `<span class="badge" data-pending hidden></span>` : ''))}
        <div class="navsec">Community</div>${navItem('#/comments', 'comment', 'Comments')}${navItem('#/members', 'users', 'Members')}
        <div class="navsec">Manage</div>${navItem('#/media', 'folder', 'Media library')}${navItem('#/settings', 'gear', 'App settings')}${navItem('#/team', 'shield', 'Team & password')}</nav>
      <div class="side-foot"><a class="btn ghost sm block" href="${APP_URL}" target="_blank" rel="noopener">${ic('ext')}Open the app</a><div class="who">${me.name}<small>${me.email}</small></div><button class="btn ghost sm block" data-logout>${ic('logout')}Sign out</button></div></aside>
    <div class="scrim" data-closeside></div>
    <div class="content"><header class="top"><button class="ib menu" data-openside aria-label="Menu">${ic('menu')}</button><h1 id="title"></h1><div id="actions" class="row"></div></header><main id="view" tabindex="-1"></main></div>
  </div>`);
    window.addEventListener('hashchange', route);
    route();
    refreshPending();
}
const navItem = (href, icon, label, extra = '') => html `<a href="${href}" data-nav="${href}">${ic(icon)}<span>${label}</span>${extra}</a>`;
async function refreshPending() {
    try {
        const s = await api('/api/admin/stats');
        for (const b of $$('[data-pending]')) {
            b.hidden = !s.pendingTestimonies;
            b.textContent = String(s.pendingTestimonies);
        }
    }
    catch { /* ignore */ }
}
/* ---------- router ---------- */
let lastHash = location.hash;
let routeSeq = 0;
/** Returns a check that is false once the user has navigated elsewhere (stale async redraws bail out). */
const alive = () => { const seq = routeSeq; return () => seq === routeSeq; };
async function route() {
    if (currentForm?.dirty && location.hash !== lastHash) {
        const leave = await confirmDialog('Leave without saving?', 'You have unsaved changes on this page.', 'Leave', true);
        if (!leave) {
            history.replaceState(null, '', lastHash || '#/');
            return;
        }
    }
    lastHash = location.hash;
    routeSeq++;
    currentForm = null;
    stopChat();
    document.body.classList.remove('side-open');
    const h = location.hash.replace(/^#/, '').split('?')[0] || '/';
    for (const a of $$('[data-nav]'))
        a.classList.toggle('on', h === a.dataset.nav.slice(1) || (a.dataset.nav !== '#/' && h.startsWith(a.dataset.nav.slice(1) + '/')));
    setHTML($('#actions'), html ``);
    const parts = h.split('/').filter(Boolean);
    try {
        if (!parts.length)
            await overview();
        else if (parts[0] === 'live')
            await livePage();
        else if (parts[0] === 'c' && parts[1] && parts[2])
            await editor(parts[1], parts[2]);
        else if (parts[0] === 'c' && parts[1])
            await listPage(parts[1]);
        else if (parts[0] === 'media')
            await mediaPage();
        else if (parts[0] === 'comments')
            await commentsPage();
        else if (parts[0] === 'members')
            await membersPage();
        else if (parts[0] === 'settings')
            await settingsPage();
        else if (parts[0] === 'team')
            await teamPage();
        else {
            title('Not found');
            setHTML(view(), html `<p class="muted">That page doesn't exist.</p>`);
        }
    }
    catch (e) {
        if (e instanceof ApiError && e.status === 401)
            return;
        setHTML(view(), html `<div class="card"><b>Couldn't load this page</b><p class="muted">${e.message}</p><button class="btn" data-reload>Try again</button></div>`);
    }
    view().focus({ preventScroll: true });
    window.scrollTo(0, 0);
}
const title = (t) => { $('#title').textContent = t; document.title = `${t} · PKO Studio`; };
const coll = (k) => { const c = schema.collections.find((x) => x.key === k); if (!c)
    throw new ApiError(404, 'Unknown content type'); return c; };
const appLink = (c, id) => ({ posts: `#/article/${id}`, testimonies: `#/testimony/${id}`, books: `#/book/${id}`, albums: `#/album/${id}`, broadcasts: `#/watch/${id}`, events: `#/event/${id}` }[c.key]);
/* ---------- overview ---------- */
async function overview() {
    title('Overview');
    liveRoom = supa.realtime().channel('live-room').onPresence((n) => { const el = $('[data-watching]'); if (el)
        el.textContent = String(n); });
    const s = await api('/api/admin/stats');
    const stat = (label, n, sub) => html `<div class="stat"><span>${label}</span><b ${label === 'Watching live' ? raw('data-watching') : ''}>${n.toLocaleString()}</b><small>${sub}</small></div>`;
    const total = Object.values(s.items).reduce((a, x) => a + Object.values(x).reduce((b, n) => b + n, 0), 0);
    setHTML(view(), html `
  <div class="stats">${stat('Members', s.members, `+${s.membersWeek} this week`)}${stat('Amens', s.amens, `+${s.amensWeek} this week`)}${stat('Comments', s.comments, `+${s.commentsWeek} this week`)}${stat('Watching live', s.viewers, s.onAir ? 'On air now' : 'Off air')}</div>
  ${total === 0 ? html `<div class="card attn" data-starter>${ic('upload')}<div><b>Your app is empty</b><span class="muted">Load the starter content from the original app (posts, books, albums, events, photos and the 4 TV clips) — then edit or delete anything.</span><div class="prog" hidden style="margin-top:10px"><i></i></div></div><button class="btn primary" data-import>Import starter content</button></div>` : ''}
  ${s.pendingTestimonies ? html `<a class="card attn" href="#/c/testimonies?pending">${ic('quote')}<div><b>${s.pendingTestimonies} testimon${s.pendingTestimonies === 1 ? 'y is' : 'ies are'} waiting for review</b><span class="muted">Approve them to publish in the app.</span></div></a>` : ''}
  <div class="card live-card ${s.onAir ? 'on' : ''}"><div><b>${s.onAir ? 'You are on air' : 'Transfiguration TV is off air'}</b><span class="muted">${s.onAir ? 'Members see the live service on the TV tab.' : 'Go live to show the stream and open the chat.'}</span></div><a class="btn ${s.onAir ? '' : 'primary'}" href="#/live">${ic('live')}Manage live</a></div>
  <h2 class="h2">Create</h2>
  <div class="quick">${schema.collections.map((c) => html `<a class="qbtn" href="#/c/${c.key}/new">${ic(c.icon)}<span>New ${c.singular.toLowerCase()}</span></a>`)}</div>
  <div class="cols">
    <section class="card"><h2 class="h2">Content</h2><table class="tbl"><tbody>${schema.collections.map((c) => { const x = s.items[c.key] || {}; return html `<tr><td><a href="#/c/${c.key}">${c.label}</a></td><td class="num">${x.published || 0} live</td><td class="num muted">${x.draft ? `${x.draft} drafts` : ''}${x.pending ? ` ${x.pending} pending` : ''}</td></tr>`; })}</tbody></table>
      <p class="muted small">${s.media.n} media files · ${bytes(s.media.bytes)}</p></section>
    <section class="card"><h2 class="h2">Most Amens</h2>${s.top.length ? html `<ol class="toplist">${s.top.map((t) => html `<li><a href="#/c/${t.collection}/${t.id}">${t.title}</a><span class="muted">${t.label} · ${t.amens} Amens</span></li>`)}</ol>` : html `<p class="muted">Amens from members will show here.</p>`}</section>
  </div>`);
}
/* ---------- list ---------- */
async function listPage(key) {
    const c = coll(key);
    title(c.label);
    setHTML($('#actions'), html `${key === 'schedule' ? html `<button class="btn" data-import>${ic('upload')}Import</button>` : ''}<a class="btn primary" href="#/c/${key}/new">${ic('plus')}New ${c.singular.toLowerCase()}</a>`);
    $('[data-import]')?.addEventListener('click', () => importSchedule().then((n) => { if (n)
        route(); }));
    const okList = alive();
    const { items } = await api(`/api/admin/items/${key}`);
    if (!okList())
        return;
    const statuses = ['all', 'published', 'draft', ...(c.moderated ? ['pending', 'rejected'] : [])];
    let filter = location.hash.includes('?pending') ? 'pending' : 'all';
    let q = '';
    const draw = () => {
        const list = items.filter((i) => (filter === 'all' || i.status === filter) && (!q || JSON.stringify(i).toLowerCase().includes(q)));
        const manual = c.sort === 'manual' && filter === 'all' && !q;
        setHTML(view(), html `<div class="toolbar"><div class="seg">${statuses.map((s) => html `<button class="${filter === s ? 'on' : ''}" data-filter="${s}">${s[0].toUpperCase() + s.slice(1)} <span class="muted">${s === 'all' ? items.length : items.filter((i) => i.status === s).length}</span></button>`)}</div>
      <label class="search">${ic('search')}<input class="inp" type="search" placeholder="Search ${c.label.toLowerCase()}" value="${q}" data-q aria-label="Search"></label></div>
    ${list.length ? html `<div class="items">${list.map((it, i) => itemRow(c, it, manual, i, list.length))}</div>` : html `<div class="card empty">${items.length ? 'Nothing matches.' : html `No ${c.label.toLowerCase()} yet. <a href="#/c/${key}/new">Create the first one</a>.`}</div>`}`);
        const qi = $('[data-q]');
        if (qi && q) {
            qi.focus();
            qi.setSelectionRange(q.length, q.length);
        }
    };
    draw();
    view().onclick = async (e) => {
        const t = e.target.closest('button');
        if (!t)
            return;
        if (t.dataset.filter) {
            filter = t.dataset.filter;
            draw();
            return;
        }
        const id = t.dataset.id;
        if (!id)
            return;
        const it = items.find((x) => x.id === id);
        if (t.dataset.act === 'status') {
            try {
                const r = await api(`/api/admin/items/${key}/${id}`, { method: 'PATCH', body: { status: t.dataset.to } });
                Object.assign(it, r.item);
                toast(t.dataset.to === 'published' ? 'Published' : t.dataset.to === 'rejected' ? 'Rejected' : 'Moved to drafts');
                draw();
                refreshPending();
            }
            catch (err) {
                toast(err.message, 'err');
            }
        }
        if (t.dataset.act === 'delete') {
            if (!(await confirmDialog(`Delete this ${c.singular.toLowerCase()}?`, `“${String(it[c.titleField] || '')}” and its comments and Amens will be removed from the app. This can't be undone.`)))
                return;
            try {
                await api(`/api/admin/items/${key}/${id}`, { method: 'DELETE' });
                items.splice(items.indexOf(it), 1);
                toast('Deleted');
                draw();
                refreshPending();
            }
            catch (err) {
                toast(err.message, 'err');
            }
        }
        if (t.dataset.act === 'move') {
            const i = items.indexOf(it), j = i + Number(t.dataset.dir);
            if (j < 0 || j >= items.length)
                return;
            [items[i], items[j]] = [items[j], items[i]];
            draw();
            try {
                await api(`/api/admin/items/${key}/reorder`, { method: 'POST', body: { ids: items.map((x) => x.id) } });
            }
            catch (err) {
                toast(err.message, 'err');
            }
        }
    };
    view().oninput = (e) => { const t = e.target; if (t.matches('[data-q]')) {
        q = t.value.trim().toLowerCase();
        draw();
    } };
}
function itemRow(c, it, manual, i, n) {
    const img = c.imageField ? it[c.imageField] : null;
    const scheduled = it.status === 'published' && Date.parse(it.publishedAt) > Date.now();
    const sub = [
        c.key === 'events' ? String(it.date) : c.key === 'schedule' ? `${it.days || 'Every day'} ${it.time}${it.end ? `–${it.end}` : ''}` : rel(it.publishedAt),
        c.key === 'schedule' ? (it.source === SOURCES.replay ? 'Replay' : it.source === SOURCES.rotation ? 'Rotation' : 'Live') : '',
        c.key === 'photos' ? String(it.album) : c.key === 'posts' ? String(it.flair) : c.key === 'broadcasts' ? String(it.category) : c.key === 'testimonies' ? `${it.name}${it.place ? ', ' + it.place : ''}` : c.key === 'albums' ? `${it.tracks.length} tracks` : c.key === 'books' ? `${it.chapters.length} chapters` : '',
    ].filter(Boolean).join(' · ');
    return html `<div class="irow">
    ${manual ? html `<div class="mv"><button class="ib" data-act="move" data-dir="-1" data-id="${it.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${ic('up')}</button><button class="ib" data-act="move" data-dir="1" data-id="${it.id}" ${i === n - 1 ? 'disabled' : ''} aria-label="Move down">${ic('down')}</button></div>` : ''}
    <a class="ithumb" href="#/c/${c.key}/${it.id}" aria-label="Edit ${String(it[c.titleField] || c.singular)}" tabindex="-1">${img ? html `<img src="${mediaUrl(img)}" alt="" loading="lazy">` : ic(c.icon)}</a>
    <a class="imain" href="#/c/${c.key}/${it.id}"><b>${String(it[c.titleField] || '(untitled)')}</b><span class="muted">${sub}</span></a>
    <span class="pill ${scheduled ? 'scheduled' : it.status}">${scheduled ? 'Scheduled' : it.status}</span>
    <span class="imeta muted" title="Amens · comments">${ic('star', 'sm')}${it.amens || 0} ${c.key === 'posts' || c.key === 'testimonies' || c.key === 'broadcasts' ? html `${ic('comment', 'sm')}${it.commentCount || 0}` : ''}</span>
    <div class="iact">${c.moderated && it.status === 'pending' ? html `<button class="btn sm primary" data-act="status" data-to="published" data-id="${it.id}">${ic('check')}Approve</button><button class="btn sm" data-act="status" data-to="rejected" data-id="${it.id}">Reject</button>`
        : it.status === 'published' ? html `<button class="btn sm ghost" data-act="status" data-to="draft" data-id="${it.id}">Unpublish</button>` : html `<button class="btn sm" data-act="status" data-to="published" data-id="${it.id}">Publish</button>`}
      <button class="ib danger" data-act="delete" data-id="${it.id}" aria-label="Delete">${ic('trash')}</button></div></div>`;
}
/* ---------- editor ---------- */
async function editor(key, id) {
    const c = coll(key);
    const isNew = id === 'new';
    let item = null;
    const okEd = alive();
    if (!isNew)
        item = (await api(`/api/admin/items/${key}/${id}`)).item;
    if (!okEd())
        return;
    title(isNew ? `New ${c.singular.toLowerCase()}` : `Edit ${c.singular.toLowerCase()}`);
    const status = item?.status || 'published';
    const statuses = ['published', 'draft', ...(c.moderated ? ['pending', 'rejected'] : [])];
    const link = item && appLink(c, item.id);
    setHTML($('#actions'), html `${link && item?.status === 'published' ? html `<a class="btn ghost" href="${APP_URL}${link}" target="_blank" rel="noopener">${ic('eye')}View in app</a>` : ''}<a class="btn ghost" href="#/c/${key}">${ic('back')}Back</a>`);
    setHTML(view(), html `<form class="editor" novalidate data-editor>
    <div class="ed-main card"><div data-form></div></div>
    <aside class="ed-side card">
      <div class="fld"><label class="lbl" for="ed-status">Status</label><select class="inp" id="ed-status" name="status">${statuses.map((s) => html `<option value="${s}" ${s === status ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`)}</select></div>
      ${c.sort !== 'manual' ? html `<div class="fld"><label class="lbl" for="ed-pub">Publish date</label><input class="inp" type="datetime-local" id="ed-pub" name="publishedAt" value="${item ? toLocalInput(item.publishedAt) : ''}"><small class="help">Leave empty to publish now. A future time schedules it.</small></div>` : ''}
      ${item ? html `<p class="muted small">Created ${rel(item.createdAt)} · updated ${rel(item.updatedAt)}${item.memberId ? html `<br>Submitted by a member in the app` : ''}</p>
        <p class="muted small">${ic('star', 'sm')} ${item.amens ?? 0} Amens</p>` : ''}
      <button class="btn primary block" type="submit">${ic('check')}${isNew ? 'Create' : 'Save changes'}</button>
      ${item ? html `<button class="btn ghost danger block" type="button" data-del>${ic('trash')}Delete</button>` : ''}
    </aside></form>
    <datalist id="pos-presets"><option value="center"><option value="center 20%"><option value="center 30%"><option value="center 40%"><option value="top"><option value="bottom"><option value="left center"><option value="right center"></datalist>`);
    const fields = await withOptions(c.fields);
    if (!okEd())
        return;
    const form = new SchemaForm($('[data-form]'), fields, item || {});
    currentForm = form;
    await form.loadMediaMeta();
    form.render();
    const ed = $('[data-editor]');
    ed.addEventListener('change', (e) => { if (e.target.closest('.ed-side'))
        form.dirty = true; });
    ed.onsubmit = async (e) => {
        e.preventDefault();
        if (form.busy) {
            toast('Wait for the upload to finish', 'err');
            return;
        }
        const missing = form.missingRequired();
        if (Object.keys(missing).length) {
            form.showErrors(missing)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            toast('Please fill in the required fields', 'err');
            return;
        }
        if (key === 'schedule' && form.state.source === SOURCES.replay && !form.state.broadcast) {
            form.showErrors({ broadcast: 'Choose the past message to play' });
            toast('Choose the past message to play', 'err');
            return;
        }
        // The 24/7 channel needs each message's length; read it from the video itself.
        if (key === 'broadcasts' && !form.state.duration && (form.state.video || form.state.url)) {
            const d = await videoLength(form.state.video ? mediaUrl(String(form.state.video)) : String(form.state.url));
            if (d)
                form.state.duration = d;
        }
        const v = validate(c.fields, form.state);
        if (!v.ok) {
            form.showErrors(v.errors)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            toast('Please fix the highlighted fields', 'err');
            return;
        }
        const fd = new FormData(ed);
        const pub = String(fd.get('publishedAt') || '');
        const body = { ...v.data, status: fd.get('status'), ...(pub ? { publishedAt: new Date(pub).toISOString() } : {}) };
        const btn = $('button[type=submit]', ed);
        btn.disabled = true;
        try {
            const r = isNew
                ? await api(`/api/admin/items/${key}`, { method: 'POST', body })
                : await api(`/api/admin/items/${key}/${id}`, { method: 'PATCH', body });
            form.dirty = false;
            toast(isNew ? `${c.singular} created` : 'Saved');
            refreshPending();
            if (isNew)
                location.hash = `#/c/${key}/${r.item.id}`;
            else {
                item = r.item;
            }
        }
        catch (err) {
            if (err instanceof ApiError && err.details)
                form.showErrors(err.details)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            toast(err.message, 'err');
        }
        finally {
            btn.disabled = false;
        }
    };
    $('[data-del]', ed)?.addEventListener('click', async () => {
        if (!(await confirmDialog(`Delete this ${c.singular.toLowerCase()}?`, 'It will be removed from the app along with its comments and Amens.')))
            return;
        try {
            await api(`/api/admin/items/${key}/${id}`, { method: 'DELETE' });
            form.dirty = false;
            toast('Deleted');
            location.hash = `#/c/${key}`;
        }
        catch (err) {
            toast(err.message, 'err');
        }
    });
}
/** Fill "pick an item" selects (e.g. the past message a schedule slot plays). */
async function withOptions(fields) {
    return Promise.all(fields.map(async (f) => {
        if (!f.optionsFrom)
            return f;
        const { items } = await api(`/api/admin/items/${f.optionsFrom}`);
        const labels = Object.fromEntries(items.filter((i) => i.status === 'published').map((i) => [i.id, String(i.title ?? i.caption ?? i.id)]));
        return { ...f, options: Object.keys(labels), optionLabels: labels };
    }));
}
/** Length of a video in whole seconds, or null if the browser can't tell. */
function videoLength(src) {
    return new Promise((resolve) => {
        const v = document.createElement('video');
        const done = (n) => { clearTimeout(t); v.removeAttribute('src'); v.load(); resolve(n); };
        const t = setTimeout(() => done(null), 10000);
        v.preload = 'metadata';
        v.muted = true;
        v.onloadedmetadata = () => done(Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : null);
        v.onerror = () => done(null);
        v.src = src;
    });
}
/**
 * Paste the programme plan (e.g. exported from the vMix running order or a spreadsheet):
 * one programme per line — Days, Starts, Ends, Programme, Subtitle, What plays, Past message.
 */
async function importSchedule() {
    const c = coll('schedule');
    const { items: broadcasts } = await api('/api/admin/items/broadcasts');
    const d = document.createElement('dialog');
    d.className = 'dlg wide';
    setHTML(d, html `<form method="dialog"><h3>Import the programme plan</h3>
    <p class="muted">One programme per line, separated by commas or tabs (paste straight from a spreadsheet):<br>
    <code>Days, Starts, Ends, Programme, Subtitle, What plays, Past message</code><br>
    Days: Every day, Weekdays, Weekends, Mondays … Sundays. What plays: live, replay or rotation. Ends and the rest are optional.</p>
    <textarea class="inp" name="csv" rows="9" aria-label="Programme plan" placeholder="Sundays, 09:00, 12:00, Sunday Service, Live from Douala, live&#10;Every day, 18:30, , Christ the Rock, Replay with live chat, replay, Christ the Rock"></textarea>
    <p class="err" data-ierr hidden></p>
    <div class="row end"><button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn primary" data-go>Import</button></div></form>`);
    document.body.appendChild(d);
    d.showModal();
    return new Promise((resolve) => {
        let created = 0;
        d.addEventListener('close', () => { d.remove(); resolve(created); });
        $('[data-go]', d).addEventListener('click', async (e) => {
            e.preventDefault();
            const errBox = $('[data-ierr]', d);
            const lines = String(d.querySelector('textarea').value).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            const rows = [];
            const errors = [];
            const kind = { live: SOURCES.live, replay: SOURCES.replay, rotation: SOURCES.rotation };
            lines.forEach((line, i) => {
                const cols = line.split(line.includes('\t') ? '\t' : ',').map((x) => x.trim());
                if (i === 0 && /^days$/i.test(cols[0]))
                    return; // header row
                const [days, time, end, title, subtitle, what, past] = cols;
                const src = kind[(what || 'live').toLowerCase()] || what;
                const b = past ? broadcasts.find((x) => String(x.title).toLowerCase() === past.toLowerCase()) : undefined;
                const pad = (t) => (t && /^\d:\d\d$/.test(t) ? '0' + t : t || '');
                const v = validate(c.fields, { days: days || 'Every day', time: pad(time), end: pad(end), title, subtitle, source: src, broadcast: b?.id || '' });
                if (src === SOURCES.replay && !b)
                    v.errors.broadcast = past ? `no past message called “${past}”` : 'name the past message to play';
                const msgs = Object.values(v.errors);
                if (msgs.length)
                    errors.push(`Line ${i + 1}: ${msgs.join('; ')}`);
                else
                    rows.push(v.data);
            });
            if (!rows.length && !errors.length) {
                errBox.textContent = 'Paste at least one line.';
                errBox.hidden = false;
                return;
            }
            if (errors.length) {
                errBox.textContent = errors.slice(0, 6).join(' · ');
                errBox.hidden = false;
                return;
            }
            try {
                for (const r of rows) {
                    await api('/api/admin/items/schedule', { method: 'POST', body: { ...r, status: 'published' } });
                    created++;
                }
                toast(`Imported ${created} programme${created === 1 ? '' : 's'}`);
                d.close();
            }
            catch (err) {
                errBox.textContent = err.message;
                errBox.hidden = false;
            }
        });
    });
}
/* ---------- live ---------- */
async function livePage() {
    title('Live & chat');
    const okLive = alive();
    const [{ live }, sch, brs] = await Promise.all([
        api('/api/admin/live'),
        api('/api/admin/items/schedule'),
        api('/api/admin/items/broadcasts'),
    ]);
    if (!okLive())
        return;
    const viewers = 0;
    const onAir = !!live.onAir;
    const shown = (xs) => xs.filter((i) => i.status === 'published' && Date.parse(i.publishedAt) <= Date.now());
    const input = { live, schedule: shown(sch.items), broadcasts: shown(brs.items) };
    const n = onNow(input);
    const next = upNext(input, new Date(), 3);
    const feed = live.status === 'live' ? html `<span class="dotlive"></span>Studio is streaming${live.statusAt ? html ` <span class="muted">since ${new Date(String(live.statusAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` : ''}`
        : live.status === 'idle' ? html `Studio not streaming <span class="muted">· last stream ended ${rel(String(live.statusAt))}</span>`
            : html `<span class="muted">No signal from the streaming service yet. Finish the setup below.</span>`;
    const nowText = n.kind === 'live' ? `Live: ${live.title}` : n.video ? `${n.kind === 'replay' ? 'Replay' : 'Rotation'}: ${n.video.title}` : 'Off air';
    const webhook = `${String(window.PKO_CONFIG?.supabaseUrl || 'https://YOUR-PROJECT.supabase.co').replace(/\/$/, '')}/functions/v1/stream-webhook`;
    setHTML(view(), html `<div class="cols live">
    <section class="card"><div class="onair ${onAir ? 'on' : ''}"><div><b>${onAir ? 'On air' : 'Off air'}</b><span class="muted">${onAir ? 'Members can watch now and chat.' : live.channel24 ? 'The channel is playing replays between programmes.' : 'The TV tab shows past messages and the schedule.'}</span></div>
      <button class="btn ${onAir ? 'danger' : 'primary'}" data-onair="${onAir ? '0' : '1'}">${ic('live')}${onAir ? 'End live service' : 'Go live'}</button></div>
      <div class="chan" data-channel><div><span class="lbl">Studio feed</span><p>${feed}</p></div>
        <div><span class="lbl">On the channel now</span><p>${nowText}</p></div>
        <div><span class="lbl">Up next</span><p>${next.length ? next.map((a, i) => html `${i ? ' · ' : ''}${airLabel(a.start)} ${a.slot.title}`) : html `<span class="muted">Nothing scheduled. <a href="#/c/schedule">Add programmes</a></span>`}</p></div></div>
      <form data-liveform novalidate><div data-form></div><button class="btn primary" type="submit">${ic('check')}Save stream details</button></form></section>
    <section class="card chatbox"><div class="row between"><h2 class="h2">Live chat</h2><span class="muted" data-viewers>${viewers} watching</span></div>
      <div class="chatlog" data-chatlog aria-live="polite"></div>
      <form class="row" data-modchat><input class="inp grow" name="name" value="${me.name}" aria-label="Post as" style="max-width:150px" maxlength="60"><input class="inp grow" name="body" placeholder="Message as moderator" maxlength="300" aria-label="Message" autocomplete="off"><button class="btn primary" aria-label="Send">${ic('send')}</button></form>
      <p class="muted small">Moderator messages appear in gold. Hover a message to remove it.</p></section></div>
    <details class="card setup" ${live.status ? '' : 'open'}><summary><b>Connect vMix to the app</b> <span class="muted">one-time setup</span></summary>
      <ol>
        <li>At your streaming service (Cloudflare Stream recommended), create a <b>live input</b> with recording set to <b>automatic</b>.</li>
        <li>In vMix: <b>Settings → Streaming → Destination: Custom RTMP Server</b>. Paste the service's RTMPS URL and stream key, then press <b>Stream</b>. Keep the stream key in vMix only; never paste it here.</li>
        <li>Copy the live input's <b>HLS playback link</b> (.m3u8) into <b>Stream playback URL</b> above and save. It stays the same every week.</li>
        <li>Add this webhook at the streaming service so the app goes on air by itself and saves each programme to Past messages:<br><code class="copy" data-copy="${webhook}">${webhook}</code></li>
      </ol>
      <p class="muted small">Full guide with the webhook secrets: <code>docs/LIVE-TV.md</code> in the repository.</p></details>`);
    $('[data-copy]')?.addEventListener('click', (e) => { navigator.clipboard?.writeText(e.currentTarget.dataset.copy).then(() => toast('Webhook address copied'), () => { }); });
    const fields = schema.live.filter((f) => f.key !== 'onAir' && !f.hidden);
    const form = new SchemaForm($('[data-form]'), fields, live);
    currentForm = form;
    await form.loadMediaMeta();
    form.render();
    $('[data-liveform]').onsubmit = async (e) => {
        e.preventDefault();
        if (form.busy) {
            toast('Wait for the upload to finish', 'err');
            return;
        }
        const v = validate(fields, form.state);
        if (!v.ok) {
            form.showErrors(v.errors);
            toast('Please fix the highlighted fields', 'err');
            return;
        }
        try {
            await api('/api/admin/live', { method: 'PUT', body: v.data });
            form.dirty = false;
            toast('Stream details saved');
        }
        catch (err) {
            if (err instanceof ApiError && err.details)
                form.showErrors(err.details);
            toast(err.message, 'err');
        }
    };
    $('[data-onair]').onclick = async (e) => {
        const want = e.currentTarget.dataset.onair === '1';
        if (want && !form.state.video && !form.state.url) {
            toast('Add a stream file or URL first', 'err');
            return;
        }
        if (!want && !(await confirmDialog('End the live service?', 'The TV tab will switch to replays for everyone.', 'End live', true)))
            return;
        try {
            await api('/api/admin/live', { method: 'PUT', body: { ...validate(fields, form.state).data, onAir: want } });
            form.dirty = false;
            toast(want ? 'You are live' : 'Live service ended');
            route();
        }
        catch (err) {
            if (err instanceof ApiError && err.details)
                form.showErrors(err.details);
            toast(err.message, 'err');
        }
    };
    // chat
    const log = $('[data-chatlog]');
    const msg = (m) => html `<div class="cmsg" data-mid="${m.id}"><b class="${m.isMod ? 'mod' : ''}">${m.name}</b> <span>${m.body}</span><time class="muted">${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><button class="ib danger" data-delmsg="${m.id}" aria-label="Remove message">${ic('trash', 'sm')}</button></div>`;
    const recent = (await api('/api/admin/chat')).messages;
    setHTML(log, recent.length ? html `${recent.map(msg)}` : html `<p class="muted" data-empty>No messages yet.</p>`);
    log.scrollTop = log.scrollHeight;
    liveRoom = supa.realtime().channel('live-room', { changes: [{ event: '*', table: 'chat' }] })
        .onChange((c) => {
        const r = c.record;
        if (c.type === 'INSERT' && !r.deleted) {
            if ($(`[data-mid="${r.id}"]`, log))
                return;
            $('[data-empty]', log)?.remove();
            log.insertAdjacentHTML('beforeend', msg({ id: Number(r.id), name: String(r.name), body: String(r.body), isMod: !!r.is_mod, createdAt: String(r.created_at) }).s);
            log.scrollTop = log.scrollHeight;
        }
        else if (c.type === 'UPDATE' && r.deleted)
            $(`[data-mid="${r.id}"]`, log)?.remove();
    })
        .onPresence((n) => { const v = $('[data-viewers]'); if (v)
        v.textContent = `${n} watching`; });
    log.onclick = async (e) => {
        const b = e.target.closest('[data-delmsg]');
        if (!b)
            return;
        try {
            await api(`/api/admin/chat/${b.dataset.delmsg}`, { method: 'DELETE' });
        }
        catch (err) {
            toast(err.message, 'err');
        }
    };
    $('[data-modchat]').onsubmit = async (e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const fd = new FormData(f);
        const body = String(fd.get('body') || '').trim();
        if (!body)
            return;
        try {
            await api('/api/admin/chat', { method: 'POST', body: { body, name: fd.get('name') } });
            f.elements.namedItem('body').value = '';
        }
        catch (err) {
            toast(err.message, 'err');
        }
    };
}
function stopChat() { liveRoom?.unsubscribe(); liveRoom = null; }
/* ---------- media ---------- */
async function mediaPage() {
    title('Media library');
    setHTML($('#actions'), html `<label class="btn primary">${ic('upload')}Upload files<input type="file" multiple hidden data-bulk accept="${schema.accept.join(',')}"></label>`);
    let kind = '';
    const ok = alive();
    const draw = async () => {
        const { media } = await api(`/api/admin/media${kind ? `?kind=${kind}` : ''}`);
        if (!ok())
            return;
        setHTML(view(), html `<div class="toolbar"><div class="seg">${[['', 'All'], ['image', 'Images'], ['video', 'Videos'], ['audio', 'Audio'], ['file', 'PDFs']].map(([k, l]) => html `<button class="${kind === k ? 'on' : ''}" data-kind="${k}">${l}</button>`)}</div><span class="muted">${media.length} files · ${bytes(media.reduce((s, m) => s + m.size, 0))}</span></div>
    <div class="uploads" data-uploads></div>
    ${media.length ? html `<div class="mgrid">${media.map((m) => html `<div class="mcard">${thumb(m)}<span title="${m.original_name}">${m.original_name}</span><small class="muted">${bytes(m.size)} · ${rel(m.created_at)}</small>
      <div class="row"><a class="ib" href="${mediaUrl(m.id)}" target="_blank" rel="noopener" aria-label="Open">${ic('ext', 'sm')}</a><button class="ib" data-copy="${m.id}" aria-label="Copy link">${ic('file', 'sm')}</button><button class="ib danger" data-delmedia="${m.id}" aria-label="Delete ${m.original_name}">${ic('trash', 'sm')}</button></div></div>`)}</div>` : html `<div class="card empty">No files yet. Upload photos, videos, songs or PDFs — or upload straight from any content form.</div>`}`);
    };
    await draw();
    view().onclick = async (e) => {
        const t = e.target.closest('button');
        if (!t)
            return;
        if (t.dataset.kind !== undefined) {
            kind = t.dataset.kind;
            await draw();
            return;
        }
        if (t.dataset.copy) {
            await navigator.clipboard?.writeText(mediaUrl(t.dataset.copy)).catch(() => { });
            toast('Link copied');
            return;
        }
        if (t.dataset.delmedia) {
            const id = t.dataset.delmedia;
            const { usedBy } = await api(`/api/admin/media/${encodeURIComponent(id)}/usage`);
            const ok = await confirmDialog('Delete this file?', usedBy.length ? `It's still used by: ${usedBy.join('; ')}. Those items will lose this file.` : 'It is not used anywhere in the app.');
            if (!ok)
                return;
            try {
                await api(`/api/admin/media/${encodeURIComponent(id)}${usedBy.length ? '?force=1' : ''}`, { method: 'DELETE' });
                toast('File deleted');
                await draw();
            }
            catch (err) {
                toast(err.message, 'err');
            }
        }
    };
    $('[data-bulk]').onchange = async (e) => {
        const files = [...(e.target.files || [])];
        e.target.value = '';
        const box = $('[data-uploads]');
        let ok = 0;
        for (const f of files) {
            const row = document.createElement('div');
            row.className = 'uprow';
            setHTML(row, html `<span>${f.name}</span><div class="prog"><i></i></div><small class="muted">0%</small>`);
            box.appendChild(row);
            try {
                await uploadFile(f, (p) => { $('i', row).style.width = Math.round(p * 100) + '%'; $('small', row).textContent = Math.round(p * 100) + '%'; });
                ok++;
                $('small', row).textContent = 'Done';
            }
            catch (err) {
                row.classList.add('bad');
                $('small', row).textContent = err.message;
            }
        }
        if (ok) {
            toast(`${ok} file${ok > 1 ? 's' : ''} uploaded`);
            setTimeout(draw, 600);
        }
    };
}
/* ---------- comments ---------- */
async function commentsPage() {
    title('Comments');
    let q = '';
    const ok = alive();
    const draw = async () => {
        if (!ok())
            return;
        const { comments } = await api(`/api/admin/comments${q ? `?q=${encodeURIComponent(q)}` : ''}`);
        const listEl = $('[data-list]');
        if (!ok() || !listEl)
            return;
        setHTML(listEl, comments.length ? html `${comments.map((c) => html `<div class="crow"><div><b>${c.name}</b> <span class="muted small">on ${c.on} · ${rel(c.createdAt)}</span><p>${c.body}</p></div><button class="btn sm ghost danger" data-delc="${c.id}">${ic('trash')}Remove</button></div>`)}` : html `<div class="card empty">${q ? 'No comments match.' : 'No comments yet.'}</div>`);
    };
    setHTML(view(), html `<div class="toolbar"><label class="search">${ic('search')}<input class="inp" type="search" placeholder="Search comments or names" data-q aria-label="Search comments"></label></div><div class="card" data-list></div>`);
    await draw();
    let t;
    $('[data-q]').oninput = (e) => { q = e.target.value.trim(); clearTimeout(t); t = window.setTimeout(draw, 250); };
    view().onclick = async (e) => {
        const b = e.target.closest('[data-delc]');
        if (!b || !(await confirmDialog('Remove this comment?', 'Replies to it will be removed too.', 'Remove')))
            return;
        try {
            await api(`/api/admin/comments/${b.dataset.delc}`, { method: 'DELETE' });
            toast('Comment removed');
            await draw();
        }
        catch (err) {
            toast(err.message, 'err');
        }
    };
}
/* ---------- members ---------- */
async function membersPage() {
    title('Members');
    const ok = alive();
    const draw = async () => {
        const { members } = await api('/api/admin/members');
        if (!ok())
            return;
        setHTML(view(), members.length ? html `<div class="card"><table class="tbl"><thead><tr><th>Name</th><th>Phone</th><th>Joined</th><th class="num">Comments</th><th></th></tr></thead><tbody>
      ${members.map((m) => html `<tr class="${m.banned ? 'muted' : ''}"><td><b>${m.name}</b>${m.banned ? html ` <span class="pill rejected">blocked</span>` : ''}</td><td>${m.phone || '—'}</td><td>${rel(m.created_at)}</td><td class="num">${m.comments}</td><td class="num"><button class="btn sm ${m.banned ? '' : 'ghost danger'}" data-ban="${m.id}" data-to="${m.banned ? '0' : '1'}">${m.banned ? 'Unblock' : 'Block'}</button></td></tr>`)}</tbody></table></div>`
            : html `<div class="card empty">No members yet. People appear here when they sign in on the app.</div>`);
    };
    await draw();
    view().onclick = async (e) => {
        const b = e.target.closest('[data-ban]');
        if (!b)
            return;
        if (b.dataset.to === '1' && !(await confirmDialog('Block this member?', 'They will no longer be able to comment, chat or send testimonies.', 'Block')))
            return;
        try {
            await api(`/api/admin/members/${b.dataset.ban}/ban`, { method: 'POST', body: { banned: b.dataset.to === '1' } });
            toast(b.dataset.to === '1' ? 'Member blocked' : 'Member unblocked');
            await draw();
        }
        catch (err) {
            toast(err.message, 'err');
        }
    };
}
/* ---------- settings ---------- */
async function settingsPage() {
    title('App settings');
    const { settings } = await api('/api/admin/settings');
    setHTML(view(), html `<form class="card narrow" data-settings novalidate><div data-form></div><button class="btn primary" type="submit">${ic('check')}Save settings</button></form>`);
    const form = new SchemaForm($('[data-form]'), schema.settings, settings);
    currentForm = form;
    await form.loadMediaMeta();
    form.render();
    $('[data-settings]').onsubmit = async (e) => {
        e.preventDefault();
        const v = validate(schema.settings, form.state);
        if (!v.ok) {
            form.showErrors(v.errors);
            toast('Please fix the highlighted fields', 'err');
            return;
        }
        try {
            await api('/api/admin/settings', { method: 'PUT', body: v.data });
            form.dirty = false;
            toast('Settings saved');
        }
        catch (err) {
            if (err instanceof ApiError && err.details)
                form.showErrors(err.details);
            toast(err.message, 'err');
        }
    };
}
/* ---------- team ---------- */
async function teamPage() {
    title('Team & password');
    const ok = alive();
    const draw = async () => {
        const { admins } = await api('/api/admin/admins');
        if (!ok())
            return;
        setHTML(view(), html `<div class="cols">
      <section class="card"><h2 class="h2">People with dashboard access</h2><table class="tbl"><tbody>${admins.map((a) => html `<tr><td><b>${a.name}</b><br><span class="muted small">${a.email}</span></td><td class="num">${a.id === me.id ? html `<span class="muted">You</span>` : html `<button class="btn sm ghost danger" data-rmadmin="${a.id}">Remove</button>`}</td></tr>`)}</tbody></table>
        <h2 class="h2" style="margin-top:20px">Add a person</h2>
        <form class="stack" data-addadmin novalidate><input class="inp" name="name" placeholder="Name" required aria-label="Name"><input class="inp" name="email" type="email" placeholder="Email" required aria-label="Email"><button class="btn primary">${ic('plus')}Give access</button><small class="muted">First ask them to open this dashboard and choose <b>Create an account</b> with this email. Then add them here.</small></form></section>
      <section class="card"><h2 class="h2">Change your password</h2><form class="stack" data-pw novalidate><input class="inp" name="current" type="password" placeholder="Current password" autocomplete="current-password" aria-label="Current password"><input class="inp" name="next" type="password" placeholder="New password (10+ characters)" autocomplete="new-password" aria-label="New password"><button class="btn primary">Update password</button></form></section></div>`);
    };
    await draw();
    view().onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        const fd = Object.fromEntries(new FormData(f));
        try {
            if (f.matches('[data-addadmin]')) {
                await api('/api/admin/admins', { method: 'POST', body: fd });
                toast('Access granted');
                await draw();
            }
            if (f.matches('[data-pw]')) {
                await api('/api/admin/password', { method: 'POST', body: fd });
                f.reset();
                toast('Password updated');
            }
        }
        catch (err) {
            toast(err.message, 'err');
        }
    };
    view().onclick = async (e) => {
        const b = e.target.closest('[data-rmadmin]');
        if (!b || !(await confirmDialog('Remove access?', 'They will be signed out of the dashboard.', 'Remove')))
            return;
        try {
            await api(`/api/admin/admins/${b.dataset.rmadmin}`, { method: 'DELETE' });
            toast('Access removed');
            await draw();
        }
        catch (err) {
            toast(err.message, 'err');
        }
    };
}
/* ---------- global events ---------- */
document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.id !== 'loginForm')
        return;
    e.preventDefault();
    const fd = new FormData(f);
    const err = $('[data-loginerr]');
    const btn = $('button[type=submit]', f);
    btn.disabled = true;
    const email = String(fd.get('email') || '').trim(), password = String(fd.get('password') || '');
    try {
        if (f.dataset.mode === 'create') {
            pendingName = String(fd.get('name') || '');
            const r = await createAccount(email, password, pendingName);
            if (r === 'confirm-email') {
                showLogin(`Check ${email} for a confirmation link, then sign in here.`);
                return;
            }
        }
        me = (await api('/api/admin/login', { method: 'POST', body: { email, password } })).admin;
        await startApp();
    }
    catch (x) {
        if (x instanceof NotAdminError) {
            showNoAccess(x.hasOwner, x.email);
            return;
        }
        err.hidden = false;
        err.textContent = x.message;
        btn.disabled = false;
    }
});
document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-logout],[data-openside],[data-closeside],[data-reload],[data-loginmode],[data-claim],[data-import]');
    if (!t)
        return;
    if (t.dataset.loginmode) {
        showLogin('', t.dataset.loginmode);
        return;
    }
    if (t.hasAttribute('data-import')) {
        const card = t.closest('[data-starter]');
        const prog = $('.prog', card), bar = $('i', prog);
        t.disabled = true;
        t.textContent = 'Importing…';
        prog.hidden = false;
        try {
            const n = await importStarterContent((d, total) => { bar.style.width = Math.round((d / total) * 100) + '%'; });
            toast(`Imported ${n} items`);
            refreshPending();
            route();
        }
        catch (x) {
            toast(x.message, 'err');
            t.disabled = false;
            t.textContent = 'Try again';
        }
        return;
    }
    if (t.hasAttribute('data-claim')) {
        t.disabled = true;
        try {
            me = (await claimOwner(String($('[name=ownername]')?.value || '')));
            await startApp();
        }
        catch (x) {
            const el = $('[data-claimerr]');
            if (el) {
                el.hidden = false;
                el.textContent = x.message;
            }
            t.disabled = false;
        }
        return;
    }
    if (t.hasAttribute('data-logout')) {
        await api('/api/admin/logout', { method: 'POST' }).catch(() => { });
        me = null;
        showLogin();
    }
    if (t.hasAttribute('data-openside'))
        document.body.classList.add('side-open');
    if (t.hasAttribute('data-closeside'))
        document.body.classList.remove('side-open');
    if (t.hasAttribute('data-reload'))
        route();
});
window.addEventListener('beforeunload', (e) => { if (currentForm?.dirty) {
    e.preventDefault();
    e.returnValue = '';
} });
window.__studio = { get form() { return currentForm; } };
void raw;
boot();
