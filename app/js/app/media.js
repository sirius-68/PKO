import { $, $$, html, ic, mmss, avColor, setHTML, esc } from './lib.js';
import { getLive, mediaUrl, supa } from './api.js';
import { S } from './store.js';
import { keepAwake } from './native.js';
import { toast } from './ui.js';
import { logo, songByKey, songs } from './views.js';
/* =========================================================
   MUSIC — real <audio> playback + lock-screen / Bluetooth controls
   ========================================================= */
export const player = { key: null, playing: false, pos: 0, dur: 0, loading: false };
let audio = null;
let onChange = () => { };
export const onPlayerChange = (fn) => { onChange = fn; };
function el() {
    if (audio)
        return audio;
    audio = new Audio();
    audio.preload = 'metadata';
    audio.addEventListener('timeupdate', () => { player.pos = audio.currentTime; if (audio.duration)
        player.dur = audio.duration; progress(); });
    audio.addEventListener('loadedmetadata', () => { player.dur = audio.duration || player.dur; progress(); });
    audio.addEventListener('playing', () => { player.playing = true; player.loading = false; onChange(); setSessionState(); });
    audio.addEventListener('pause', () => { player.playing = false; onChange(); setSessionState(); });
    audio.addEventListener('waiting', () => { player.loading = true; });
    audio.addEventListener('ended', () => skip(1));
    audio.addEventListener('error', () => {
        if (!player.key)
            return;
        player.playing = false;
        player.loading = false;
        onChange();
        toast("This song couldn't be played. Check your connection.", 'err');
    });
    const ms = navigator.mediaSession;
    if (ms) {
        const h = (a, fn) => { try {
            ms.setActionHandler(a, fn);
        }
        catch { /* unsupported action */ } };
        h('play', () => togglePlay(true));
        h('pause', () => togglePlay(false));
        h('previoustrack', () => skip(-1));
        h('nexttrack', () => skip(1));
        h('seekto', (d) => { if (d.seekTime != null && audio)
            audio.currentTime = d.seekTime; });
    }
    return audio;
}
function setSessionState() {
    const ms = navigator.mediaSession;
    if (!ms)
        return;
    ms.playbackState = player.playing ? 'playing' : 'paused';
}
function setSessionMeta(s) {
    const ms = navigator.mediaSession;
    if (!ms || typeof MediaMetadata === 'undefined')
        return;
    const art = s.album.image ? [{ src: mediaUrl(s.album.image), sizes: '512x512' }] : [];
    ms.metadata = new MediaMetadata({ title: s.title, artist: s.album.artist, album: s.album.title, artwork: art });
}
export function playSong(key) {
    const s = songByKey(key);
    if (!s)
        return;
    if (!s.audio) {
        toast(`Audio for “${s.title}” is coming soon`);
        return;
    }
    const a = el();
    if (player.key === key) {
        togglePlay();
        return;
    }
    player.key = key;
    player.pos = 0;
    player.dur = s.duration || 0;
    player.loading = true;
    a.src = mediaUrl(s.audio);
    setSessionMeta(s);
    pauseTV();
    a.play().catch((e) => { if (e.name !== 'AbortError') {
        player.playing = false;
        onChange();
        toast('Tap play to start the song');
    } });
    player.playing = true;
    onChange();
}
export function togglePlay(force) {
    if (!player.key || !audio)
        return;
    const want = force ?? audio.paused;
    if (want) {
        pauseTV();
        audio.play().catch(() => { });
    }
    else
        audio.pause();
}
export function pauseMusic() { if (audio && !audio.paused)
    audio.pause(); }
export function skip(d) {
    const list = songs().filter((s) => s.audio);
    if (!list.length)
        return;
    const i = list.findIndex((x) => x.key === player.key);
    const n = list[(i + d + list.length) % list.length];
    if (n.key === player.key && audio) {
        audio.currentTime = 0;
        audio.play().catch(() => { });
        return;
    }
    player.key = null;
    playSong(n.key);
}
export function seekMusic(frac) {
    if (!audio || !player.dur)
        return;
    audio.currentTime = Math.max(0, Math.min(1, frac)) * player.dur;
}
function progress() {
    const p = player.dur ? (player.pos / player.dur) * 100 : 0;
    const mp = $('#miniProg');
    if (mp)
        mp.style.width = p + '%';
    const nb = $('#npBar');
    if (nb)
        nb.style.width = p + '%';
    const np = $('#npPos');
    if (np)
        np.textContent = mmss(player.pos);
    const nr = $('#npRem');
    if (nr)
        nr.textContent = '-' + mmss(Math.max(0, player.dur - player.pos));
}
export function currentSong() { return player.key ? songByKey(player.key) : undefined; }
export function miniPlayer() {
    const s = currentSong();
    if (!s)
        return html ``;
    const p = player.dur ? (player.pos / player.dur) * 100 : 0;
    return html `<span class="cov">${s.album.image ? html `<img class="ph" src="${mediaUrl(s.album.image)}" alt="">` : ''}</span><button class="tx" data-sheet="player" style="text-align:left" aria-label="Open player"><b>${s.title}</b><span>${s.album.artist}</span></button>
   <button class="ibtn clear" data-toggleplay aria-label="${player.playing ? 'Pause' : 'Play'}">${ic(player.playing ? 'pause' : 'play')}</button><button class="ibtn clear" data-skip="1" aria-label="Next song">${ic('next', 'sm')}</button><span class="prog" id="miniProg" style="width:${p}%"></span>`;
}
/* =========================================================
   TV — video player
   ========================================================= */
let tvVideo = null;
let idleTimer;
export const tv = () => tvVideo;
export function mountTV(src, live) {
    const v = $('#tvv');
    if (!v)
        return;
    tvVideo = v;
    if (!src) {
        overlayMsg('This video is not available yet.');
        return;
    }
    if (/\.m3u8(\?|$)/i.test(src) && !v.canPlayType('application/vnd.apple.mpegurl')) {
        overlayMsg('This stream format plays in the mobile app. Open it on your phone to watch.');
        return;
    }
    v.src = src;
    v.loop = live;
    v.muted = live; // muted autoplay is allowed everywhere; user taps for sound
    v.addEventListener('timeupdate', tvProg);
    v.addEventListener('loadedmetadata', () => { const d = $('#tvdur'); if (d && !live && v.duration)
        d.textContent = mmss(v.duration); });
    for (const ev of ['play', 'pause', 'ended', 'volumechange', 'playing'])
        v.addEventListener(ev, tvSync);
    v.addEventListener('error', () => overlayMsg("The video couldn't load. Check your connection and try again."));
    const p = v.play();
    if (p)
        p.catch(() => { v.muted = true; v.play().catch(() => { }).finally(tvSync); });
    tvSync();
    armIdle();
}
function overlayMsg(msg) {
    const p = $('#player');
    if (!p)
        return;
    const ctr = $('.ctr', p);
    if (ctr)
        ctr.remove();
    if (!$('.vmsg', p))
        p.insertAdjacentHTML('beforeend', `<div class="vmsg" style="position:absolute;inset:auto 16px 44px;text-align:center;font-size:13px;color:#fff;background:rgba(0,0,0,.55);padding:8px 12px;border-radius:10px">${esc(msg)}</div>`);
}
export function tvSync() {
    const v = tvVideo;
    if (!v)
        return;
    const playing = !v.paused && !v.ended;
    $('#player')?.classList.toggle('playing', playing);
    const c = $('[data-tvplay]');
    if (c)
        setHTML(c, ic(playing ? 'pause' : 'play', 'lg'));
    const m = $('#tvmute');
    if (m)
        setHTML(m, ic(v.muted ? 'mute' : 'vol', 'sm'));
    const u = $('#unmute');
    if (u)
        u.hidden = !(v.muted && playing);
    keepAwake(playing);
    if (playing)
        pauseMusic();
}
function tvProg() {
    const v = tvVideo;
    if (!v || v.loop || !v.duration)
        return;
    const b = $('#tvbar');
    if (b)
        b.style.width = (v.currentTime / v.duration) * 100 + '%';
    const t = $('#tvt');
    if (t)
        t.textContent = mmss(v.currentTime);
}
export function tvToggle() {
    const v = tvVideo;
    if (!v || !v.src)
        return;
    if (v.paused || v.ended) {
        pauseMusic();
        v.play().catch(() => { });
    }
    else
        v.pause();
    armIdle();
}
export function tvMute() { const v = tvVideo; if (!v)
    return; v.muted = !v.muted; if (!v.muted && v.paused)
    v.play().catch(() => { }); tvSync(); armIdle(); }
export function tvSeek(frac) { const v = tvVideo; if (!v || !v.duration)
    return; v.currentTime = Math.max(0, Math.min(1, frac)) * v.duration; tvProg(); armIdle(); }
export function tvFullscreen() {
    const v = tvVideo;
    if (!v)
        return;
    if (v.requestFullscreen)
        v.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
    else
        v.webkitEnterFullscreen?.();
}
export function armIdle() {
    clearTimeout(idleTimer);
    const p = $('#player');
    if (!p)
        return;
    p.classList.remove('idle');
    idleTimer = window.setTimeout(() => p.classList.add('idle'), 2800);
}
export function pauseTV() { if (tvVideo && !tvVideo.paused)
    tvVideo.pause(); }
export function leaveTV() {
    stopChat();
    keepAwake(false);
    if (tvVideo) {
        tvVideo.pause();
        tvVideo.removeAttribute('src');
        tvVideo.load();
        tvVideo = null;
    }
}
let room = null;
let messages = [];
let viewers = 0;
let onLive = () => { };
export const onLiveChange = (fn) => { onLive = fn; };
const toMsg = (r) => ({ id: Number(r.id), name: String(r.name), body: String(r.body), isMod: !!r.is_mod, createdAt: String(r.created_at) });
async function loadRecent() {
    try {
        const r = await getLive();
        messages = r.messages;
        renderChat();
        if (S.data && JSON.stringify(r.live) !== JSON.stringify(S.data.live))
            onLive(r.live);
    }
    catch { /* offline: keep what we have */ }
}
/** Joins the live room: chat + live state changes (postgres_changes) and viewer presence. */
export function startChat() {
    if (room || !supa.configured)
        return;
    loadRecent();
    room = supa.realtime().channel('live-room', { changes: [{ event: '*', table: 'chat' }, { event: '*', table: 'settings' }] })
        .onChange((c) => {
        if (c.table === 'chat') {
            const m = toMsg(c.record);
            if (c.type === 'INSERT' && !c.record.deleted) {
                if (messages.some((x) => x.id === m.id))
                    return;
                messages.push(m);
                if (messages.length > 80)
                    messages.shift();
                appendChat(m);
            }
            else if (c.type === 'UPDATE' && c.record.deleted) {
                messages = messages.filter((x) => x.id !== m.id);
                $(`[data-msg="${m.id}"]`)?.remove();
            }
        }
        else if (c.table === 'settings' && c.record.key === 'live') {
            onLive(c.record.value);
        }
    })
        .onPresence((n) => { viewers = n; paintViewers(); })
        .onStatus((st) => { if (st === 'joined')
        loadRecent(); }) // catch up after a reconnect
        .track({ at: Date.now() });
}
export function stopChat() { room?.unsubscribe(); room = null; }
export function setViewers(n) { viewers = n; paintViewers(); }
function paintViewers() {
    for (const x of $$('[data-viewers]')) {
        x.textContent = viewers.toLocaleString();
        x.parentElement.style.visibility = viewers > 0 ? '' : 'hidden';
    }
}
function chatMsg(c) {
    const mine = S.member && c.name === S.member.name && !c.isMod;
    return html `<div class="cmsg ${mine ? 'mine' : ''}" data-msg="${c.id}"><span class="av" style="background:${avColor(c.name)}">${c.name[0]}</span><div><b class="${c.isMod ? 'mod' : ''}">${c.name}</b>${c.body}</div></div>`;
}
export function renderChat() {
    const ch = $('#chat');
    if (!ch)
        return;
    setHTML(ch, messages.length ? html `${messages.slice(-40).map(chatMsg)}` : html `<div class="chat-empty">Be the first to say Amen or share a prayer point.</div>`);
}
function appendChat(m) {
    const ch = $('#chat');
    if (!ch)
        return;
    $('.chat-empty', ch)?.remove();
    ch.insertAdjacentHTML('beforeend', chatMsg(m).s);
    while (ch.children.length > 40)
        ch.firstElementChild?.remove();
    const main = $('#main');
    if (main && main.scrollHeight - main.scrollTop - main.clientHeight < 260)
        main.scrollTop = main.scrollHeight;
}
export const chatPane = () => html `<div class="chat" id="chat" aria-live="polite"></div>
  ${S.member
    ? html `<form class="chatbar" data-chatform><input class="inp" id="chatIn" maxlength="300" placeholder="Say Amen or add a prayer point" aria-label="Chat message" autocomplete="off" enterkeyhint="send"><button class="ibtn" style="background:var(--fill);color:var(--on-fill)" aria-label="Send">${ic('send', 'sm')}</button></form>`
    : html `<button class="btn line chat-signin" style="width:calc(100% - 32px)" data-signin="chat">${ic('user', 'sm')}Sign in to join the chat</button>`}`;
export { logo };
