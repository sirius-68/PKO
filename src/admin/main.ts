import { $, $$, api, ApiError, bytes, confirmDialog, html, ic, mediaUrl, raw, rel, setHTML, setUnauthorizedHandler, toast, toLocalInput, uploadFile, type Collection, type MediaRow, type Schema, type SafeHTML } from './lib.js';
import { SchemaForm, thumb } from './form.js';

interface Admin { id: string; email: string; name: string }
interface Item { id: string; status: string; publishedAt: string; updatedAt: string; createdAt: string; sort: number; amens?: number; commentCount?: number; memberId?: string | null; [k: string]: unknown }

let me: Admin | null = null;
let schema: Schema;
let currentForm: SchemaForm | null = null;
let chatES: EventSource | null = null;
const view = () => $('#view')!;

/* ---------- boot / auth ---------- */
async function boot() {
  setUnauthorizedHandler(() => { if (me) { me = null; showLogin('Your session ended. Please sign in again.'); } });
  try {
    me = (await api<{ admin: Admin }>('/api/admin/me')).admin;
  } catch { showLogin(); return; }
  await startApp();
}
function showLogin(msg = '') {
  stopChat();
  document.body.classList.add('auth');
  setHTML($('#app')!, html`<main class="login"><form class="card" id="loginForm" novalidate>
    <img src="/app/icons/logo.webp" alt="" class="login-logo">
    <h1>Creator dashboard</h1><p class="muted">Sign in to publish to the app.</p>
    ${msg ? html`<p class="note">${msg}</p>` : ''}
    <label class="fld"><span class="lbl">Email</span><input class="inp" name="email" type="email" autocomplete="username" required></label>
    <label class="fld"><span class="lbl">Password</span><input class="inp" name="password" type="password" autocomplete="current-password" required></label>
    <p class="err" data-loginerr hidden></p>
    <button class="btn primary block" type="submit">Sign in</button>
  </form></main>`);
  $<HTMLInputElement>('[name=email]')?.focus();
}
async function startApp() {
  document.body.classList.remove('auth');
  schema = await api<Schema>('/api/admin/schema');
  setHTML($('#app')!, html`<div class="shell">
    <aside class="side" id="side"><div class="brand"><img src="/app/icons/logo.webp" alt=""><div><b>PKO Studio</b><small>Creator dashboard</small></div></div>
      <nav>${navItem('#/', 'home', 'Overview')}${navItem('#/live', 'live', 'Live & chat')}
        <div class="navsec">Content</div>${schema.collections.map((c) => navItem(`#/c/${c.key}`, c.icon, c.label, c.moderated ? html`<span class="badge" data-pending hidden></span>` : ''))}
        <div class="navsec">Community</div>${navItem('#/comments', 'comment', 'Comments')}${navItem('#/members', 'users', 'Members')}
        <div class="navsec">Manage</div>${navItem('#/media', 'folder', 'Media library')}${navItem('#/settings', 'gear', 'App settings')}${navItem('#/team', 'shield', 'Team & password')}</nav>
      <div class="side-foot"><a class="btn ghost sm block" href="/app/" target="_blank" rel="noopener">${ic('ext')}Open the app</a><div class="who">${me!.name}<small>${me!.email}</small></div><button class="btn ghost sm block" data-logout>${ic('logout')}Sign out</button></div></aside>
    <div class="scrim" data-closeside></div>
    <div class="content"><header class="top"><button class="ib menu" data-openside aria-label="Menu">${ic('menu')}</button><h1 id="title"></h1><div id="actions" class="row"></div></header><main id="view" tabindex="-1"></main></div>
  </div>`);
  window.addEventListener('hashchange', route);
  route();
  refreshPending();
}
const navItem = (href: string, icon: string, label: string, extra: SafeHTML | string = '') => html`<a href="${href}" data-nav="${href}">${ic(icon)}<span>${label}</span>${extra}</a>`;

async function refreshPending() {
  try {
    const s = await api<{ pendingTestimonies: number }>('/api/admin/stats');
    for (const b of $$('[data-pending]')) { b.hidden = !s.pendingTestimonies; b.textContent = String(s.pendingTestimonies); }
  } catch { /* ignore */ }
}

/* ---------- router ---------- */
let lastHash = location.hash;
let routeSeq = 0;
/** Returns a check that is false once the user has navigated elsewhere (stale async redraws bail out). */
const alive = () => { const seq = routeSeq; return () => seq === routeSeq; };
async function route() {
  if (currentForm?.dirty && location.hash !== lastHash) {
    const leave = await confirmDialog('Leave without saving?', 'You have unsaved changes on this page.', 'Leave', true);
    if (!leave) { history.replaceState(null, '', lastHash || '#/'); return; }
  }
  lastHash = location.hash;
  routeSeq++;
  currentForm = null;
  stopChat();
  document.body.classList.remove('side-open');
  const h = location.hash.replace(/^#/, '').split('?')[0] || '/';
  for (const a of $$('[data-nav]')) a.classList.toggle('on', h === a.dataset.nav!.slice(1) || (a.dataset.nav !== '#/' && h.startsWith(a.dataset.nav!.slice(1) + '/')));
  setHTML($('#actions')!, html``);
  const parts = h.split('/').filter(Boolean);
  try {
    if (!parts.length) await overview();
    else if (parts[0] === 'live') await livePage();
    else if (parts[0] === 'c' && parts[1] && parts[2]) await editor(parts[1], parts[2]);
    else if (parts[0] === 'c' && parts[1]) await listPage(parts[1]);
    else if (parts[0] === 'media') await mediaPage();
    else if (parts[0] === 'comments') await commentsPage();
    else if (parts[0] === 'members') await membersPage();
    else if (parts[0] === 'settings') await settingsPage();
    else if (parts[0] === 'team') await teamPage();
    else { title('Not found'); setHTML(view(), html`<p class="muted">That page doesn't exist.</p>`); }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return;
    setHTML(view(), html`<div class="card"><b>Couldn't load this page</b><p class="muted">${(e as Error).message}</p><button class="btn" data-reload>Try again</button></div>`);
  }
  view().focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
const title = (t: string) => { $('#title')!.textContent = t; document.title = `${t} · PKO Studio`; };
const coll = (k: string) => { const c = schema.collections.find((x) => x.key === k); if (!c) throw new ApiError(404, 'Unknown content type'); return c; };
const appLink = (c: Collection, id: string) => ({ posts: `#/article/${id}`, testimonies: `#/testimony/${id}`, books: `#/book/${id}`, albums: `#/album/${id}`, broadcasts: `#/watch/${id}`, events: `#/event/${id}` } as Record<string, string>)[c.key];

/* ---------- overview ---------- */
async function overview() {
  title('Overview');
  const s = await api<{ items: Record<string, Record<string, number>>; members: number; membersWeek: number; amens: number; amensWeek: number; comments: number; commentsWeek: number; pendingTestimonies: number; media: { n: number; bytes: number }; viewers: number; onAir: boolean; top: { id: string; collection: string; label: string; title: string; amens: number }[] }>('/api/admin/stats');
  const stat = (label: string, n: number, sub: string) => html`<div class="stat"><span>${label}</span><b>${n.toLocaleString()}</b><small>${sub}</small></div>`;
  setHTML(view(), html`
  <div class="stats">${stat('Members', s.members, `+${s.membersWeek} this week`)}${stat('Amens', s.amens, `+${s.amensWeek} this week`)}${stat('Comments', s.comments, `+${s.commentsWeek} this week`)}${stat('Watching live', s.viewers, s.onAir ? 'On air now' : 'Off air')}</div>
  ${s.pendingTestimonies ? html`<a class="card attn" href="#/c/testimonies?pending">${ic('quote')}<div><b>${s.pendingTestimonies} testimon${s.pendingTestimonies === 1 ? 'y is' : 'ies are'} waiting for review</b><span class="muted">Approve them to publish in the app.</span></div></a>` : ''}
  <div class="card live-card ${s.onAir ? 'on' : ''}"><div><b>${s.onAir ? 'You are on air' : 'Transfiguration TV is off air'}</b><span class="muted">${s.onAir ? 'Members see the live service on the TV tab.' : 'Go live to show the stream and open the chat.'}</span></div><a class="btn ${s.onAir ? '' : 'primary'}" href="#/live">${ic('live')}Manage live</a></div>
  <h2 class="h2">Create</h2>
  <div class="quick">${schema.collections.map((c) => html`<a class="qbtn" href="#/c/${c.key}/new">${ic(c.icon)}<span>New ${c.singular.toLowerCase()}</span></a>`)}</div>
  <div class="cols">
    <section class="card"><h2 class="h2">Content</h2><table class="tbl"><tbody>${schema.collections.map((c) => { const x = s.items[c.key] || {}; return html`<tr><td><a href="#/c/${c.key}">${c.label}</a></td><td class="num">${x.published || 0} live</td><td class="num muted">${x.draft ? `${x.draft} drafts` : ''}${x.pending ? ` ${x.pending} pending` : ''}</td></tr>`; })}</tbody></table>
      <p class="muted small">${s.media.n} media files · ${bytes(s.media.bytes)}</p></section>
    <section class="card"><h2 class="h2">Most Amens</h2>${s.top.length ? html`<ol class="toplist">${s.top.map((t) => html`<li><a href="#/c/${t.collection}/${t.id}">${t.title}</a><span class="muted">${t.label} · ${t.amens} Amens</span></li>`)}</ol>` : html`<p class="muted">Amens from members will show here.</p>`}</section>
  </div>`);
}

/* ---------- list ---------- */
async function listPage(key: string) {
  const c = coll(key);
  title(c.label);
  setHTML($('#actions')!, html`<a class="btn primary" href="#/c/${key}/new">${ic('plus')}New ${c.singular.toLowerCase()}</a>`);
  const okList = alive();
  const { items } = await api<{ items: Item[] }>(`/api/admin/items/${key}`);
  if (!okList()) return;
  const statuses = ['all', 'published', 'draft', ...(c.moderated ? ['pending', 'rejected'] : [])];
  let filter = location.hash.includes('?pending') ? 'pending' : 'all';
  let q = '';
  const draw = () => {
    const list = items.filter((i) => (filter === 'all' || i.status === filter) && (!q || JSON.stringify(i).toLowerCase().includes(q)));
    const manual = c.sort === 'manual' && filter === 'all' && !q;
    setHTML(view(), html`<div class="toolbar"><div class="seg">${statuses.map((s) => html`<button class="${filter === s ? 'on' : ''}" data-filter="${s}">${s[0].toUpperCase() + s.slice(1)} <span class="muted">${s === 'all' ? items.length : items.filter((i) => i.status === s).length}</span></button>`)}</div>
      <label class="search">${ic('search')}<input class="inp" type="search" placeholder="Search ${c.label.toLowerCase()}" value="${q}" data-q aria-label="Search"></label></div>
    ${list.length ? html`<div class="items">${list.map((it, i) => itemRow(c, it, manual, i, list.length))}</div>` : html`<div class="card empty">${items.length ? 'Nothing matches.' : html`No ${c.label.toLowerCase()} yet. <a href="#/c/${key}/new">Create the first one</a>.`}</div>`}`);
    const qi = $<HTMLInputElement>('[data-q]'); if (qi && q) { qi.focus(); qi.setSelectionRange(q.length, q.length); }
  };
  draw();
  view().onclick = async (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.dataset.filter) { filter = t.dataset.filter; draw(); return; }
    const id = t.dataset.id;
    if (!id) return;
    const it = items.find((x) => x.id === id)!;
    if (t.dataset.act === 'status') {
      try { const r = await api<{ item: Item }>(`/api/admin/items/${key}/${id}`, { method: 'PATCH', body: { status: t.dataset.to } }); Object.assign(it, r.item); toast(t.dataset.to === 'published' ? 'Published' : t.dataset.to === 'rejected' ? 'Rejected' : 'Moved to drafts'); draw(); refreshPending(); }
      catch (err) { toast((err as Error).message, 'err'); }
    }
    if (t.dataset.act === 'delete') {
      if (!(await confirmDialog(`Delete this ${c.singular.toLowerCase()}?`, `“${String(it[c.titleField] || '')}” and its comments and Amens will be removed from the app. This can't be undone.`))) return;
      try { await api(`/api/admin/items/${key}/${id}`, { method: 'DELETE' }); items.splice(items.indexOf(it), 1); toast('Deleted'); draw(); refreshPending(); }
      catch (err) { toast((err as Error).message, 'err'); }
    }
    if (t.dataset.act === 'move') {
      const i = items.indexOf(it), j = i + Number(t.dataset.dir);
      if (j < 0 || j >= items.length) return;
      [items[i], items[j]] = [items[j], items[i]];
      draw();
      try { await api(`/api/admin/items/${key}/reorder`, { method: 'POST', body: { ids: items.map((x) => x.id) } }); }
      catch (err) { toast((err as Error).message, 'err'); }
    }
  };
  view().oninput = (e) => { const t = e.target as HTMLInputElement; if (t.matches('[data-q]')) { q = t.value.trim().toLowerCase(); draw(); } };
}
function itemRow(c: Collection, it: Item, manual: boolean, i: number, n: number): SafeHTML {
  const img = c.imageField ? (it[c.imageField] as string | null) : null;
  const scheduled = it.status === 'published' && Date.parse(it.publishedAt) > Date.now();
  const sub = [
    c.key === 'events' ? String(it.date) : c.key === 'schedule' ? String(it.time) : rel(it.publishedAt),
    c.key === 'photos' ? String(it.album) : c.key === 'posts' ? String(it.flair) : c.key === 'broadcasts' ? String(it.category) : c.key === 'testimonies' ? `${it.name}${it.place ? ', ' + it.place : ''}` : c.key === 'albums' ? `${(it.tracks as unknown[]).length} tracks` : c.key === 'books' ? `${(it.chapters as unknown[]).length} chapters` : '',
  ].filter(Boolean).join(' · ');
  return html`<div class="irow">
    ${manual ? html`<div class="mv"><button class="ib" data-act="move" data-dir="-1" data-id="${it.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${ic('up')}</button><button class="ib" data-act="move" data-dir="1" data-id="${it.id}" ${i === n - 1 ? 'disabled' : ''} aria-label="Move down">${ic('down')}</button></div>` : ''}
    <a class="ithumb" href="#/c/${c.key}/${it.id}" aria-label="Edit ${String(it[c.titleField] || c.singular)}" tabindex="-1">${img ? html`<img src="${mediaUrl(img)}" alt="" loading="lazy">` : ic(c.icon)}</a>
    <a class="imain" href="#/c/${c.key}/${it.id}"><b>${String(it[c.titleField] || '(untitled)')}</b><span class="muted">${sub}</span></a>
    <span class="pill ${scheduled ? 'scheduled' : it.status}">${scheduled ? 'Scheduled' : it.status}</span>
    <span class="imeta muted" title="Amens · comments">${ic('star', 'sm')}${it.amens || 0} ${c.key === 'posts' || c.key === 'testimonies' || c.key === 'broadcasts' ? html`${ic('comment', 'sm')}${it.commentCount || 0}` : ''}</span>
    <div class="iact">${c.moderated && it.status === 'pending' ? html`<button class="btn sm primary" data-act="status" data-to="published" data-id="${it.id}">${ic('check')}Approve</button><button class="btn sm" data-act="status" data-to="rejected" data-id="${it.id}">Reject</button>`
      : it.status === 'published' ? html`<button class="btn sm ghost" data-act="status" data-to="draft" data-id="${it.id}">Unpublish</button>` : html`<button class="btn sm" data-act="status" data-to="published" data-id="${it.id}">Publish</button>`}
      <button class="ib danger" data-act="delete" data-id="${it.id}" aria-label="Delete">${ic('trash')}</button></div></div>`;
}

/* ---------- editor ---------- */
async function editor(key: string, id: string) {
  const c = coll(key);
  const isNew = id === 'new';
  let item: Item | null = null;
  const okEd = alive();
  if (!isNew) item = (await api<{ item: Item }>(`/api/admin/items/${key}/${id}`)).item;
  if (!okEd()) return;
  title(isNew ? `New ${c.singular.toLowerCase()}` : `Edit ${c.singular.toLowerCase()}`);
  const status = item?.status || 'published';
  const statuses = ['published', 'draft', ...(c.moderated ? ['pending', 'rejected'] : [])];
  const link = item && appLink(c, item.id);
  setHTML($('#actions')!, html`${link && item?.status === 'published' ? html`<a class="btn ghost" href="/app/${link}" target="_blank" rel="noopener">${ic('eye')}View in app</a>` : ''}<a class="btn ghost" href="#/c/${key}">${ic('back')}Back</a>`);
  setHTML(view(), html`<form class="editor" novalidate data-editor>
    <div class="ed-main card"><div data-form></div></div>
    <aside class="ed-side card">
      <div class="fld"><label class="lbl" for="ed-status">Status</label><select class="inp" id="ed-status" name="status">${statuses.map((s) => html`<option value="${s}" ${s === status ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`)}</select></div>
      ${c.sort !== 'manual' ? html`<div class="fld"><label class="lbl" for="ed-pub">Publish date</label><input class="inp" type="datetime-local" id="ed-pub" name="publishedAt" value="${item ? toLocalInput(item.publishedAt) : ''}"><small class="help">Leave empty to publish now. A future time schedules it.</small></div>` : ''}
      ${item ? html`<p class="muted small">Created ${rel(item.createdAt)} · updated ${rel(item.updatedAt)}${item.memberId ? html`<br>Submitted by a member in the app` : ''}</p>
        <p class="muted small">${ic('star', 'sm')} ${item.amens ?? 0} Amens</p>` : ''}
      <button class="btn primary block" type="submit">${ic('check')}${isNew ? 'Create' : 'Save changes'}</button>
      ${item ? html`<button class="btn ghost danger block" type="button" data-del>${ic('trash')}Delete</button>` : ''}
    </aside></form>
    <datalist id="pos-presets"><option value="center"><option value="center 20%"><option value="center 30%"><option value="center 40%"><option value="top"><option value="bottom"><option value="left center"><option value="right center"></datalist>`);
  const form = new SchemaForm($('[data-form]')!, c.fields, item || {});
  currentForm = form;
  await form.loadMediaMeta();
  form.render();
  const ed = $<HTMLFormElement>('[data-editor]')!;
  ed.addEventListener('change', (e) => { if ((e.target as HTMLElement).closest('.ed-side')) form.dirty = true; });
  ed.onsubmit = async (e) => {
    e.preventDefault();
    if (form.busy) { toast('Wait for the upload to finish', 'err'); return; }
    const missing = form.missingRequired();
    if (Object.keys(missing).length) { form.showErrors(missing)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); toast('Please fill in the required fields', 'err'); return; }
    const fd = new FormData(ed);
    const pub = String(fd.get('publishedAt') || '');
    const body = { ...form.state, status: fd.get('status'), ...(pub ? { publishedAt: new Date(pub).toISOString() } : {}) };
    const btn = $<HTMLButtonElement>('button[type=submit]', ed)!;
    btn.disabled = true;
    try {
      const r = isNew
        ? await api<{ item: Item }>(`/api/admin/items/${key}`, { method: 'POST', body })
        : await api<{ item: Item }>(`/api/admin/items/${key}/${id}`, { method: 'PATCH', body });
      form.dirty = false;
      toast(isNew ? `${c.singular} created` : 'Saved');
      refreshPending();
      if (isNew) location.hash = `#/c/${key}/${r.item.id}`; else { item = r.item; }
    } catch (err) {
      if (err instanceof ApiError && err.details) form.showErrors(err.details)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      toast((err as Error).message, 'err');
    } finally { btn.disabled = false; }
  };
  $('[data-del]', ed)?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete this ${c.singular.toLowerCase()}?`, 'It will be removed from the app along with its comments and Amens.'))) return;
    try { await api(`/api/admin/items/${key}/${id}`, { method: 'DELETE' }); form.dirty = false; toast('Deleted'); location.hash = `#/c/${key}`; }
    catch (err) { toast((err as Error).message, 'err'); }
  });
}

/* ---------- live ---------- */
async function livePage() {
  title('Live & chat');
  const { live, viewers } = await api<{ live: Record<string, unknown>; viewers: number }>('/api/admin/live');
  const onAir = !!live.onAir;
  setHTML(view(), html`<div class="cols live">
    <section class="card"><div class="onair ${onAir ? 'on' : ''}"><div><b>${onAir ? 'On air' : 'Off air'}</b><span class="muted">${onAir ? 'Members can watch now and chat.' : 'The TV tab shows replays and the schedule.'}</span></div>
      <button class="btn ${onAir ? 'danger' : 'primary'}" data-onair="${onAir ? '0' : '1'}">${ic('live')}${onAir ? 'End live service' : 'Go live'}</button></div>
      <form data-liveform novalidate><div data-form></div><button class="btn primary" type="submit">${ic('check')}Save stream details</button></form></section>
    <section class="card chatbox"><div class="row between"><h2 class="h2">Live chat</h2><span class="muted" data-viewers>${viewers} watching</span></div>
      <div class="chatlog" data-chatlog aria-live="polite"></div>
      <form class="row" data-modchat><input class="inp grow" name="name" value="${me!.name}" aria-label="Post as" style="max-width:150px" maxlength="60"><input class="inp grow" name="body" placeholder="Message as moderator" maxlength="300" aria-label="Message" autocomplete="off"><button class="btn primary" aria-label="Send">${ic('send')}</button></form>
      <p class="muted small">Moderator messages appear in gold. Hover a message to remove it.</p></section></div>`);
  const fields = schema.live.filter((f) => f.key !== 'onAir');
  const form = new SchemaForm($('[data-form]')!, fields, live);
  currentForm = form;
  await form.loadMediaMeta();
  form.render();
  $<HTMLFormElement>('[data-liveform]')!.onsubmit = async (e) => {
    e.preventDefault();
    if (form.busy) { toast('Wait for the upload to finish', 'err'); return; }
    try { await api('/api/admin/live', { method: 'PUT', body: form.state }); form.dirty = false; toast('Stream details saved'); }
    catch (err) { if (err instanceof ApiError && err.details) form.showErrors(err.details); toast((err as Error).message, 'err'); }
  };
  $('[data-onair]')!.onclick = async (e) => {
    const want = (e.currentTarget as HTMLElement).dataset.onair === '1';
    if (want && !form.state.video && !form.state.url) { toast('Add a stream file or URL first', 'err'); return; }
    if (!want && !(await confirmDialog('End the live service?', 'The TV tab will switch to replays for everyone.', 'End live', true))) return;
    try { await api('/api/admin/live', { method: 'PUT', body: { ...form.state, onAir: want } }); form.dirty = false; toast(want ? 'You are live' : 'Live service ended'); route(); }
    catch (err) { if (err instanceof ApiError && err.details) form.showErrors(err.details); toast((err as Error).message, 'err'); }
  };
  // chat
  const log = $('[data-chatlog]')!;
  const msg = (m: { id: number; name: string; body: string; isMod: boolean; createdAt: string }) =>
    html`<div class="cmsg" data-mid="${m.id}"><b class="${m.isMod ? 'mod' : ''}">${m.name}</b> <span>${m.body}</span><time class="muted">${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><button class="ib danger" data-delmsg="${m.id}" aria-label="Remove message">${ic('trash', 'sm')}</button></div>`;
  chatES = new EventSource('/api/live/stream');
  chatES.addEventListener('hello', (e) => { const d = JSON.parse((e as MessageEvent).data); setHTML(log, d.messages.length ? html`${d.messages.map(msg)}` : html`<p class="muted" data-empty>No messages yet.</p>`); log.scrollTop = log.scrollHeight; });
  chatES.addEventListener('message', (e) => { $('[data-empty]', log)?.remove(); log.insertAdjacentHTML('beforeend', msg(JSON.parse((e as MessageEvent).data)).s); log.scrollTop = log.scrollHeight; });
  chatES.addEventListener('delete', (e) => $(`[data-mid="${JSON.parse((e as MessageEvent).data).id}"]`, log)?.remove());
  chatES.addEventListener('viewers', (e) => { const v = $('[data-viewers]'); if (v) v.textContent = `${Math.max(0, JSON.parse((e as MessageEvent).data).viewers - 1)} watching`; });
  log.onclick = async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-delmsg]');
    if (!b) return;
    try { await api(`/api/admin/chat/${b.dataset.delmsg}`, { method: 'DELETE' }); } catch (err) { toast((err as Error).message, 'err'); }
  };
  $<HTMLFormElement>('[data-modchat]')!.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget as HTMLFormElement;
    const fd = new FormData(f);
    const body = String(fd.get('body') || '').trim();
    if (!body) return;
    try { await api('/api/admin/chat', { method: 'POST', body: { body, name: fd.get('name') } }); (f.elements.namedItem('body') as HTMLInputElement).value = ''; }
    catch (err) { toast((err as Error).message, 'err'); }
  };
}
function stopChat() { chatES?.close(); chatES = null; }

/* ---------- media ---------- */
async function mediaPage() {
  title('Media library');
  setHTML($('#actions')!, html`<label class="btn primary">${ic('upload')}Upload files<input type="file" multiple hidden data-bulk accept="${schema.accept.join(',')}"></label>`);
  let kind = '';
  const ok = alive();
  const draw = async () => {
    const { media } = await api<{ media: MediaRow[] }>(`/api/admin/media${kind ? `?kind=${kind}` : ''}`);
    if (!ok()) return;
    setHTML(view(), html`<div class="toolbar"><div class="seg">${[['', 'All'], ['image', 'Images'], ['video', 'Videos'], ['audio', 'Audio'], ['file', 'PDFs']].map(([k, l]) => html`<button class="${kind === k ? 'on' : ''}" data-kind="${k}">${l}</button>`)}</div><span class="muted">${media.length} files · ${bytes(media.reduce((s, m) => s + m.size, 0))}</span></div>
    <div class="uploads" data-uploads></div>
    ${media.length ? html`<div class="mgrid">${media.map((m) => html`<div class="mcard">${thumb(m)}<span title="${m.original_name}">${m.original_name}</span><small class="muted">${bytes(m.size)} · ${rel(m.created_at)}</small>
      <div class="row"><a class="ib" href="${mediaUrl(m.id)}" target="_blank" rel="noopener" aria-label="Open">${ic('ext', 'sm')}</a><button class="ib" data-copy="${m.id}" aria-label="Copy link">${ic('file', 'sm')}</button><button class="ib danger" data-delmedia="${m.id}" aria-label="Delete ${m.original_name}">${ic('trash', 'sm')}</button></div></div>`)}</div>` : html`<div class="card empty">No files yet. Upload photos, videos, songs or PDFs — or upload straight from any content form.</div>`}`);
  };
  await draw();
  view().onclick = async (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.dataset.kind !== undefined) { kind = t.dataset.kind; await draw(); return; }
    if (t.dataset.copy) { await navigator.clipboard?.writeText(location.origin + mediaUrl(t.dataset.copy)).catch(() => {}); toast('Link copied'); return; }
    if (t.dataset.delmedia) {
      const id = t.dataset.delmedia;
      const { usedBy } = await api<{ usedBy: string[] }>(`/api/admin/media/${id}/usage`);
      const ok = await confirmDialog('Delete this file?', usedBy.length ? `It's still used by: ${usedBy.join('; ')}. Those items will lose this file.` : 'It is not used anywhere in the app.');
      if (!ok) return;
      try { await api(`/api/admin/media/${id}${usedBy.length ? '?force=1' : ''}`, { method: 'DELETE' }); toast('File deleted'); await draw(); }
      catch (err) { toast((err as Error).message, 'err'); }
    }
  };
  $<HTMLInputElement>('[data-bulk]')!.onchange = async (e) => {
    const files = [...((e.target as HTMLInputElement).files || [])];
    (e.target as HTMLInputElement).value = '';
    const box = $('[data-uploads]')!;
    let ok = 0;
    for (const f of files) {
      const row = document.createElement('div');
      row.className = 'uprow';
      setHTML(row, html`<span>${f.name}</span><div class="prog"><i></i></div><small class="muted">0%</small>`);
      box.appendChild(row);
      try {
        await uploadFile(f, (p) => { ($('i', row) as HTMLElement).style.width = Math.round(p * 100) + '%'; $('small', row)!.textContent = Math.round(p * 100) + '%'; });
        ok++; $('small', row)!.textContent = 'Done';
      } catch (err) { row.classList.add('bad'); $('small', row)!.textContent = (err as Error).message; }
    }
    if (ok) { toast(`${ok} file${ok > 1 ? 's' : ''} uploaded`); setTimeout(draw, 600); }
  };
}

/* ---------- comments ---------- */
async function commentsPage() {
  title('Comments');
  let q = '';
  const ok = alive();
  const draw = async () => {
    if (!ok()) return;
    const { comments } = await api<{ comments: { id: string; name: string; body: string; createdAt: string; on: string; memberId: string }[] }>(`/api/admin/comments${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const listEl = $('[data-list]');
    if (!ok() || !listEl) return;
    setHTML(listEl, comments.length ? html`${comments.map((c) => html`<div class="crow"><div><b>${c.name}</b> <span class="muted small">on ${c.on} · ${rel(c.createdAt)}</span><p>${c.body}</p></div><button class="btn sm ghost danger" data-delc="${c.id}">${ic('trash')}Remove</button></div>`)}` : html`<div class="card empty">${q ? 'No comments match.' : 'No comments yet.'}</div>`);
  };
  setHTML(view(), html`<div class="toolbar"><label class="search">${ic('search')}<input class="inp" type="search" placeholder="Search comments or names" data-q aria-label="Search comments"></label></div><div class="card" data-list></div>`);
  await draw();
  let t: number | undefined;
  $<HTMLInputElement>('[data-q]')!.oninput = (e) => { q = (e.target as HTMLInputElement).value.trim(); clearTimeout(t); t = window.setTimeout(draw, 250); };
  view().onclick = async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-delc]');
    if (!b || !(await confirmDialog('Remove this comment?', 'Replies to it will be removed too.', 'Remove'))) return;
    try { await api(`/api/admin/comments/${b.dataset.delc}`, { method: 'DELETE' }); toast('Comment removed'); await draw(); } catch (err) { toast((err as Error).message, 'err'); }
  };
}

/* ---------- members ---------- */
async function membersPage() {
  title('Members');
  const ok = alive();
  const draw = async () => {
    const { members } = await api<{ members: { id: string; name: string; phone: string | null; banned: number; created_at: string; comments: number }[] }>('/api/admin/members');
    if (!ok()) return;
    setHTML(view(), members.length ? html`<div class="card"><table class="tbl"><thead><tr><th>Name</th><th>Phone</th><th>Joined</th><th class="num">Comments</th><th></th></tr></thead><tbody>
      ${members.map((m) => html`<tr class="${m.banned ? 'muted' : ''}"><td><b>${m.name}</b>${m.banned ? html` <span class="pill rejected">blocked</span>` : ''}</td><td>${m.phone || '—'}</td><td>${rel(m.created_at)}</td><td class="num">${m.comments}</td><td class="num"><button class="btn sm ${m.banned ? '' : 'ghost danger'}" data-ban="${m.id}" data-to="${m.banned ? '0' : '1'}">${m.banned ? 'Unblock' : 'Block'}</button></td></tr>`)}</tbody></table></div>`
      : html`<div class="card empty">No members yet. People appear here when they sign in on the app.</div>`);
  };
  await draw();
  view().onclick = async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ban]');
    if (!b) return;
    if (b.dataset.to === '1' && !(await confirmDialog('Block this member?', 'They will no longer be able to comment, chat or send testimonies.', 'Block'))) return;
    try { await api(`/api/admin/members/${b.dataset.ban}/ban`, { method: 'POST', body: { banned: b.dataset.to === '1' } }); toast(b.dataset.to === '1' ? 'Member blocked' : 'Member unblocked'); await draw(); } catch (err) { toast((err as Error).message, 'err'); }
  };
}

/* ---------- settings ---------- */
async function settingsPage() {
  title('App settings');
  const { settings } = await api<{ settings: Record<string, unknown> }>('/api/admin/settings');
  setHTML(view(), html`<form class="card narrow" data-settings novalidate><div data-form></div><button class="btn primary" type="submit">${ic('check')}Save settings</button></form>`);
  const form = new SchemaForm($('[data-form]')!, schema.settings, settings);
  currentForm = form;
  await form.loadMediaMeta();
  form.render();
  $<HTMLFormElement>('[data-settings]')!.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/admin/settings', { method: 'PUT', body: form.state }); form.dirty = false; toast('Settings saved'); }
    catch (err) { if (err instanceof ApiError && err.details) form.showErrors(err.details); toast((err as Error).message, 'err'); }
  };
}

/* ---------- team ---------- */
async function teamPage() {
  title('Team & password');
  const ok = alive();
  const draw = async () => {
    const { admins } = await api<{ admins: { id: string; email: string; name: string; created_at: string }[] }>('/api/admin/admins');
    if (!ok()) return;
    setHTML(view(), html`<div class="cols">
      <section class="card"><h2 class="h2">People with dashboard access</h2><table class="tbl"><tbody>${admins.map((a) => html`<tr><td><b>${a.name}</b><br><span class="muted small">${a.email}</span></td><td class="num">${a.id === me!.id ? html`<span class="muted">You</span>` : html`<button class="btn sm ghost danger" data-rmadmin="${a.id}">Remove</button>`}</td></tr>`)}</tbody></table>
        <h2 class="h2" style="margin-top:20px">Add a person</h2>
        <form class="stack" data-addadmin novalidate><input class="inp" name="name" placeholder="Name" required aria-label="Name"><input class="inp" name="email" type="email" placeholder="Email" required aria-label="Email"><input class="inp" name="password" type="password" placeholder="Temporary password (10+ characters)" minlength="10" required aria-label="Temporary password" autocomplete="new-password"><button class="btn primary">${ic('plus')}Give access</button><small class="muted">Share the password with them privately; they can change it here.</small></form></section>
      <section class="card"><h2 class="h2">Change your password</h2><form class="stack" data-pw novalidate><input class="inp" name="current" type="password" placeholder="Current password" autocomplete="current-password" aria-label="Current password"><input class="inp" name="next" type="password" placeholder="New password (10+ characters)" autocomplete="new-password" aria-label="New password"><button class="btn primary">Update password</button></form></section></div>`);
  };
  await draw();
  view().onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const fd = Object.fromEntries(new FormData(f));
    try {
      if (f.matches('[data-addadmin]')) { await api('/api/admin/admins', { method: 'POST', body: fd }); toast('Access granted'); await draw(); }
      if (f.matches('[data-pw]')) { await api('/api/admin/password', { method: 'POST', body: fd }); f.reset(); toast('Password updated'); }
    } catch (err) { toast((err as Error).message, 'err'); }
  };
  view().onclick = async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-rmadmin]');
    if (!b || !(await confirmDialog('Remove access?', 'They will be signed out of the dashboard.', 'Remove'))) return;
    try { await api(`/api/admin/admins/${b.dataset.rmadmin}`, { method: 'DELETE' }); toast('Access removed'); await draw(); } catch (err) { toast((err as Error).message, 'err'); }
  };
}

/* ---------- global events ---------- */
document.addEventListener('submit', async (e) => {
  const f = e.target as HTMLFormElement;
  if (f.id !== 'loginForm') return;
  e.preventDefault();
  const fd = new FormData(f);
  const err = $('[data-loginerr]')!;
  const btn = $<HTMLButtonElement>('button', f)!;
  btn.disabled = true;
  try {
    me = (await api<{ admin: Admin }>('/api/admin/login', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } })).admin;
    await startApp();
  } catch (x) { err.hidden = false; err.textContent = (x as Error).message; btn.disabled = false; }
});
document.addEventListener('click', async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-logout],[data-openside],[data-closeside],[data-reload]');
  if (!t) return;
  if (t.hasAttribute('data-logout')) { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); me = null; showLogin(); }
  if (t.hasAttribute('data-openside')) document.body.classList.add('side-open');
  if (t.hasAttribute('data-closeside')) document.body.classList.remove('side-open');
  if (t.hasAttribute('data-reload')) route();
});
window.addEventListener('beforeunload', (e) => { if (currentForm?.dirty) { e.preventDefault(); e.returnValue = ''; } });
(window as unknown as { __studio: unknown }).__studio = { get form() { return currentForm; } };
void raw;

boot();
