import { $, $$, html, ic, mmss, avColor, setHTML, esc, type SafeHTML } from './lib.js';
import { getLive, mediaUrl, supa, DEMO, chatHooks, type ChatMsg, type Live } from './api.js';
import { demoChatStart, demoChatStop } from './demo.js';
import { D, S } from './store.js';
import { keepAwake } from './native.js';
import { toast } from './ui.js';
import { logo, songByKey, songs, type Song } from './views.js';

/* =========================================================
   MUSIC — real <audio> playback + lock-screen / Bluetooth controls
   ========================================================= */
export const player = { key: null as string | null, playing: false, pos: 0, dur: 0, loading: false };
let audio: HTMLAudioElement | null = null;
let onChange: () => void = () => {};
export const onPlayerChange = (fn: () => void): void => { onChange = fn; };

function el(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'metadata';
  audio.addEventListener('timeupdate', () => { player.pos = audio!.currentTime; if (audio!.duration) player.dur = audio!.duration; progress(); });
  audio.addEventListener('loadedmetadata', () => { player.dur = audio!.duration || player.dur; progress(); });
  audio.addEventListener('playing', () => { player.playing = true; player.loading = false; onChange(); setSessionState(); });
  audio.addEventListener('pause', () => { player.playing = false; onChange(); setSessionState(); });
  audio.addEventListener('waiting', () => { player.loading = true; });
  audio.addEventListener('ended', () => skip(1));
  audio.addEventListener('error', () => {
    if (!player.key) return;
    player.playing = false; player.loading = false; onChange();
    toast("This song couldn't be played. Check your connection.", 'err');
  });
  const ms = navigator.mediaSession;
  if (ms) {
    const h = (a: MediaSessionAction, fn: MediaSessionActionHandler) => { try { ms.setActionHandler(a, fn); } catch { /* unsupported action */ } };
    h('play', () => togglePlay(true));
    h('pause', () => togglePlay(false));
    h('previoustrack', () => skip(-1));
    h('nexttrack', () => skip(1));
    h('seekto', (d) => { if (d.seekTime != null && audio) audio.currentTime = d.seekTime; });
  }
  return audio;
}

function setSessionState() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  ms.playbackState = player.playing ? 'playing' : 'paused';
}
function setSessionMeta(s: Song) {
  const ms = navigator.mediaSession;
  if (!ms || typeof MediaMetadata === 'undefined') return;
  const art = s.album.image ? [{ src: mediaUrl(s.album.image), sizes: '512x512' }] : [];
  ms.metadata = new MediaMetadata({ title: s.title, artist: s.album.artist, album: s.album.title, artwork: art });
}

export function playSong(key: string): void {
  const s = songByKey(key);
  if (!s) return;
  if (!s.audio) { toast(`Audio for “${s.title}” is coming soon`); return; }
  const a = el();
  if (player.key === key) { togglePlay(); return; }
  player.key = key; player.pos = 0; player.dur = s.duration || 0; player.loading = true;
  a.src = mediaUrl(s.audio);
  setSessionMeta(s);
  pauseTV();
  a.play().catch((e: Error) => { if (e.name !== 'AbortError') { player.playing = false; onChange(); toast('Tap play to start the song'); } });
  player.playing = true;
  onChange();
}
export function togglePlay(force?: boolean): void {
  if (!player.key || !audio) return;
  const want = force ?? audio.paused;
  if (want) { pauseTV(); audio.play().catch(() => {}); } else audio.pause();
}
export function pauseMusic(): void { if (audio && !audio.paused) audio.pause(); }
export function skip(d: number): void {
  const list = songs().filter((s) => s.audio);
  if (!list.length) return;
  const i = list.findIndex((x) => x.key === player.key);
  const n = list[(i + d + list.length) % list.length];
  if (n.key === player.key && audio) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  player.key = null;
  playSong(n.key);
}
export function seekMusic(frac: number): void {
  if (!audio || !player.dur) return;
  audio.currentTime = Math.max(0, Math.min(1, frac)) * player.dur;
}
function progress() {
  const p = player.dur ? (player.pos / player.dur) * 100 : 0;
  const mp = $('#miniProg'); if (mp) mp.style.width = p + '%';
  const nb = $('#npBar'); if (nb) nb.style.width = p + '%';
  const np = $('#npPos'); if (np) np.textContent = mmss(player.pos);
  const nr = $('#npRem'); if (nr) nr.textContent = '-' + mmss(Math.max(0, player.dur - player.pos));
}
export function currentSong(): Song | undefined { return player.key ? songByKey(player.key) : undefined; }

export function miniPlayer(): SafeHTML {
  const s = currentSong();
  if (!s) return html``;
  const p = player.dur ? (player.pos / player.dur) * 100 : 0;
  return html`<span class="cov">${s.album.image ? html`<img class="ph" src="${mediaUrl(s.album.image)}" alt="">` : ''}</span><button class="tx" data-sheet="player" style="text-align:left" aria-label="Open player"><b>${s.title}</b><span>${s.album.artist}</span></button>
   <button class="ibtn clear" data-toggleplay aria-label="${player.playing ? 'Pause' : 'Play'}">${ic(player.playing ? 'pause' : 'play')}</button><button class="ibtn clear" data-skip="1" aria-label="Next song">${ic('next', 'sm')}</button><span class="prog" id="miniProg" style="width:${p}%"></span>`;
}

/* =========================================================
   TV — video player
   ========================================================= */
let tvVideo: HTMLVideoElement | null = null;
let idleTimer: number | undefined;
export const tv = (): HTMLVideoElement | null => tvVideo;

/**
 * live:    the studio stream (loops if it's a file).
 * channel: the 24/7 channel playing a past message from `offset` seconds in, like
 *          tuning into a TV; no seeking, and `onEnded` asks what's on next.
 * vod:     a past message the member picked; normal player.
 */
export type TvMode = 'live' | 'channel' | 'vod';
export function mountTV(src: string, mode: TvMode, opts: { offset?: number; onEnded?: () => void } = {}): void {
  const v = $<HTMLVideoElement>('#tvv');
  if (!v) return;
  tvVideo = v;
  if (!src) { overlayMsg('This video is not available yet.'); return; }
  if (/\.m3u8(\?|$)/i.test(src) && !v.canPlayType('application/vnd.apple.mpegurl')) {
    overlayMsg('This stream format plays in the mobile app. Open it on your phone to watch.');
    return;
  }
  const live = mode === 'live';
  v.src = src;
  v.loop = live;
  v.muted = mode !== 'vod'; // muted autoplay is allowed everywhere; user taps for sound
  v.dataset.mode = mode;
  v.addEventListener('timeupdate', tvProg);
  v.addEventListener('loadedmetadata', () => {
    const d = $('#tvdur');
    if (d && !live && v.duration) d.textContent = mmss(v.duration);
    // Join the programme where it is now, as if it had been playing all along.
    if (mode === 'channel' && opts.offset && v.duration && opts.offset < v.duration - 1) v.currentTime = opts.offset;
  }, { once: true });
  if (mode === 'channel' && opts.onEnded) v.addEventListener('ended', opts.onEnded, { once: true });
  for (const ev of ['play', 'pause', 'ended', 'volumechange', 'playing']) v.addEventListener(ev, tvSync);
  v.addEventListener('error', () => overlayMsg("The video couldn't load. Check your connection and try again."));
  const p = v.play();
  if (p) p.catch(() => { v.muted = true; v.play().catch(() => {}).finally(tvSync); });
  tvSync();
  armIdle();
}
function overlayMsg(msg: string) {
  const p = $('#player');
  if (!p) return;
  const ctr = $('.ctr', p);
  if (ctr) ctr.remove();
  if (!$('.vmsg', p)) p.insertAdjacentHTML('beforeend', `<div class="vmsg" style="position:absolute;inset:auto 16px 44px;text-align:center;font-size:13px;color:#fff;background:rgba(0,0,0,.55);padding:8px 12px;border-radius:10px">${esc(msg)}</div>`);
}
export function tvSync(): void {
  const v = tvVideo;
  if (!v) return;
  const playing = !v.paused && !v.ended;
  $('#player')?.classList.toggle('playing', playing);
  const c = $('[data-tvplay]'); if (c) setHTML(c, ic(playing ? 'pause' : 'play', 'lg'));
  const m = $('#tvmute'); if (m) setHTML(m, ic(v.muted ? 'mute' : 'vol', 'sm'));
  const u = $('#unmute'); if (u) u.hidden = !(v.muted && playing);
  keepAwake(playing);
  if (playing) pauseMusic();
}
function tvProg() {
  const v = tvVideo;
  if (!v || v.loop || !v.duration) return;
  const b = $('#tvbar'); if (b) b.style.width = (v.currentTime / v.duration) * 100 + '%';
  const t = $('#tvt'); if (t) t.textContent = mmss(v.currentTime);
}
export function tvToggle(): void {
  const v = tvVideo; if (!v || !v.src) return;
  if (v.paused || v.ended) { pauseMusic(); v.play().catch(() => {}); } else v.pause();
  armIdle();
}
export function tvMute(): void { const v = tvVideo; if (!v) return; v.muted = !v.muted; if (!v.muted && v.paused) v.play().catch(() => {}); tvSync(); armIdle(); }
export function tvSeek(frac: number): void { const v = tvVideo; if (!v || !v.duration || v.dataset.mode === 'channel') return; v.currentTime = Math.max(0, Math.min(1, frac)) * v.duration; tvProg(); armIdle(); }
export function tvFullscreen(): void {
  const v = tvVideo as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
  if (!v) return;
  if (v.requestFullscreen) v.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
  else v.webkitEnterFullscreen?.();
}
export function armIdle(): void {
  clearTimeout(idleTimer);
  const p = $('#player'); if (!p) return;
  p.classList.remove('idle');
  idleTimer = window.setTimeout(() => p.classList.add('idle'), 2800);
}
export function pauseTV(): void { if (tvVideo && !tvVideo.paused) tvVideo.pause(); }
export function leaveTV(): void {
  stopChat();
  keepAwake(false);
  if (tvVideo) { tvVideo.pause(); tvVideo.removeAttribute('src'); tvVideo.load(); tvVideo = null; }
}

/* =========================================================
   LIVE ROOM — chat + viewers over Server-Sent Events
   ========================================================= */
type Room = ReturnType<ReturnType<typeof supa.realtime>['channel']>;
let room: Room | null = null;
let messages: ChatMsg[] = [];
let viewers = 0;
let onLive: (l: Live) => void = () => {};
export const onLiveChange = (fn: (l: Live) => void): void => { onLive = fn; };

const toMsg = (r: Record<string, unknown>): ChatMsg => ({ id: Number(r.id), name: String(r.name), body: String(r.body), isMod: !!r.is_mod, createdAt: String(r.created_at) });
async function loadRecent() {
  try {
    const r = await getLive();
    messages = r.messages;
    renderChat();
    if (S.data && JSON.stringify(r.live) !== JSON.stringify(S.data.live)) onLive(r.live);
  } catch { /* offline: keep what we have */ }
}

/** Joins the live room: chat + live state changes (postgres_changes) and viewer presence. */
let demoOn = false;
function addMessage(m: ChatMsg) {
  if (messages.some((x) => x.id === m.id)) return;
  messages.push(m);
  if (messages.length > 80) messages.shift();
  appendChat(m);
}
export function startChat(): void {
  if (DEMO) {
    if (demoOn) return;
    demoOn = true;
    chatHooks.local = addMessage;
    messages = demoChatStart(addMessage, (n) => { viewers = n; paintViewers(); });
    renderChat();
    return;
  }
  if (room || !supa.configured) return;
  loadRecent();
  room = supa.realtime().channel('live-room', { changes: [{ event: '*', table: 'chat' }, { event: '*', table: 'settings' }] })
    .onChange((c) => {
      if (c.table === 'chat') {
        const m = toMsg(c.record);
        if (c.type === 'INSERT' && !c.record.deleted) {
          if (messages.some((x) => x.id === m.id)) return;
          messages.push(m);
          if (messages.length > 80) messages.shift();
          appendChat(m);
        } else if (c.type === 'UPDATE' && c.record.deleted) {
          messages = messages.filter((x) => x.id !== m.id);
          $(`[data-msg="${m.id}"]`)?.remove();
        }
      } else if (c.table === 'settings' && c.record.key === 'live') {
        onLive(c.record.value as Live);
      }
    })
    .onPresence((n) => { viewers = n; paintViewers(); })
    .onStatus((st) => { if (st === 'joined') loadRecent(); }) // catch up after a reconnect
    .track({ at: Date.now() });
}
export function stopChat(): void { if (demoOn) { demoChatStop(); demoOn = false; } room?.unsubscribe(); room = null; }
export function setViewers(n: number): void { viewers = n; paintViewers(); }
function paintViewers() {
  for (const x of $$('[data-viewers]')) { x.textContent = viewers.toLocaleString(); (x.parentElement as HTMLElement).style.visibility = viewers > 0 ? '' : 'hidden'; }
}

function chatMsg(c: ChatMsg): SafeHTML {
  const mine = S.member && c.name === S.member.name && !c.isMod;
  return html`<div class="cmsg ${mine ? 'mine' : ''}" data-msg="${c.id}"><span class="av" style="background:${avColor(c.name)}">${c.name[0]}</span><div><b class="${c.isMod ? 'mod' : ''}">${c.name}</b>${c.body}</div></div>`;
}
export function renderChat(): void {
  const ch = $('#chat');
  if (!ch) return;
  setHTML(ch, messages.length ? html`${messages.slice(-40).map(chatMsg)}` : html`<div class="chat-empty">Be the first to say Amen or share a prayer point.</div>`);
}
function appendChat(m: ChatMsg) {
  const ch = $('#chat');
  if (!ch) return;
  $('.chat-empty', ch)?.remove();
  ch.insertAdjacentHTML('beforeend', chatMsg(m).s);
  while (ch.children.length > 40) ch.firstElementChild?.remove();
  const main = $('#main');
  if (main && main.scrollHeight - main.scrollTop - main.clientHeight < 260) main.scrollTop = main.scrollHeight;
}
export const chatPane = (): SafeHTML => html`<div class="chat" id="chat" aria-live="polite"></div>
  ${S.member
    ? html`<form class="chatbar" data-chatform><input class="inp" id="chatIn" maxlength="300" placeholder="Say Amen or add a prayer point" aria-label="Chat message" autocomplete="off" enterkeyhint="send"><button class="ibtn" style="background:var(--fill);color:var(--on-fill)" aria-label="Send">${ic('send', 'sm')}</button></form>`
    : html`<button class="btn line chat-signin" style="width:calc(100% - 32px)" data-signin="chat">${ic('user', 'sm')}Sign in to join the chat</button>`}`;

export { logo };
