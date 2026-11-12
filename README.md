# Prophet Kevin Online (PKO)

The Apostolic Gospel Mission's app, rebuilt from the single-file prototype as three parts:

| Part | What it is | Where |
|---|---|---|
| **Member app** | The iOS and Android app (via **Capacitor**), also installable as a web app (PWA). TypeScript, no framework. | `src/app` → built to `app/` |
| **Creator dashboard** ("PKO Studio") | Where the media team uploads and manages everything shown in the app. | `src/admin` → built to `admin/` |
| **API server** | Node 22 with built-in SQLite. Content, uploads, live chat, comments, Amens, moderation. **No runtime dependencies.** | `server/` |

Everything in the prototype that was hard-coded or simulated now runs on real data: content, comments, live chat and viewer counts, Amens, testimony submissions, audio playback, reading progress, reminders and search.

---

## Quick start (local)

Requires **Node 22.18+**.

```bash
ADMIN_EMAIL=you@ministry.org ADMIN_PASSWORD='a-long-password' npm start
```

- Member app: http://localhost:8787/app/
- Creator dashboard: http://localhost:8787/admin/ (sign in with the email/password above)

On first run the server seeds the starter content from the prototype (posts, books, albums, events, testimonies, photos and the 4 broadcast videos) and creates the dashboard account. Data lives in `server/data/` (`DATA_DIR` to change).

The compiled browser code (`app/js`, `admin/js`) is committed, so `npm start` works without installing anything. After changing TypeScript in `src/`, run `npm install` once, then `npm run build`.

## Building the iOS and Android apps

1. Deploy the server somewhere with **https** (see *Deploying*), e.g. `https://api.yourministry.org`.
2. Install tooling and create/sync the native projects:
   ```bash
   npm install
   API_URL=https://api.yourministry.org npm run native:sync
   ```
   This creates `ios/` and `android/`, generates icons and splash screens from `app/icons/`, and points the bundled app at your API.
3. Open and run them: `npm run native:ios` (Xcode) or `npm run native:android` (Android Studio).
4. Before you submit to the stores:
   - Change `appId` in `capacitor.config.json` (it's currently `org.apostolicgospelmission.pko`) to the bundle id you've registered.
   - **iOS:** in Xcode, under *Signing & Capabilities*, add **Background Modes → Audio** so songs keep playing when the phone locks.
   - **Android:** notification permission is requested automatically the first time someone taps "Remind me".
   - Commit the generated `ios/` and `android/` folders.

Native features are used when available and fall back to web APIs otherwise:

| Feature | How it works |
|---|---|
| Hardware back button | Closes lightbox → sheet → drawer → page, then returns to Home, then exits. Also handles the browser back button and iOS edge-swipe. |
| Share | The native share sheet; copies the link on the web. |
| Haptics | Light tap when you Amen or save something. |
| Reminders | Local notifications 1 hour before events and 10 minutes before TV programmes. |
| Lock-screen and Bluetooth music controls | Media Session API. |
| Storage | Capacitor Preferences, which survives iOS storage eviction. |
| Status bar | Follows the dark/light theme. |
| Screen stays awake | While a video is playing. |
| PDF books | Open in the in-app browser. |

> **Verify on a device:** the app reaches native plugins through `window.Capacitor.Plugins` without a bundler. Each one is feature-detected, so a missing plugin falls back to the web behaviour instead of crashing. Do a quick pass on a real phone (share, back button, reminder, lock-screen audio) the first time you build. I could only test in browser emulation here.

## Creator dashboard

Every content type is defined once in `server/src/schema.ts`. The API validates against it and the dashboard builds its forms from it, so adding a field there adds it everywhere.

- **Content:** blog posts, TV broadcasts, books (with chapters, plus an optional PDF edition), albums (tracks with audio), events, testimonies, gallery photos and the TV schedule.
- **Uploads:** drag and drop or pick files, with a progress bar. A media library lets you reuse files. Uploading audio fills in the track length automatically. Files are checked by their actual contents, not just their names. SVG and HTML uploads are refused.
- **Publishing:** publish, save as draft, schedule a future date, reorder books and the schedule, and use "View in app".
- **Live:** one button to go live or end the service. Set a looping stream file or an HLS/MP4 URL, watch the live chat, post as a moderator and remove messages. Members' apps update instantly.
- **Moderation:** member testimonies wait in a "pending" queue, with a badge in the menu. You can approve or reject them, remove comments, and block members.
- **Settings and team:** names, logo, about text and verse. Invite colleagues and change passwords.
- Works on a phone. The menu becomes a drawer.

## Deploying

The server is a single Node process with no dependencies:

```bash
docker build -t pko . && docker run -p 8787:8787 -v pko-data:/data \
  -e ADMIN_EMAIL=you@ministry.org -e ADMIN_PASSWORD='a-long-password' pko
```

Put it behind HTTPS (Caddy, nginx, a cloud load balancer). Environment variables:

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | |
| `DATA_DIR` | `server/data` | SQLite database and uploaded media. Back this up. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | – | Creates the first dashboard account if none exists. |
| `MAX_UPLOAD_MB` | `1024` | Largest file the dashboard accepts. |
| `MEMBER_UPLOAD_MB` | `300` | Largest testimony video a member can upload. |
| `CORS_ORIGINS` | `*` | The public API uses bearer tokens, never cookies, so `*` is safe. |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy so rate limits see real client IPs. |
| `SECURE_COOKIES` | on when `NODE_ENV=production` | |

For a very large audience, put the `/media/` path behind a CDN. For real live streaming, use a streaming provider's HLS URL in the Live page.

## Tests

```bash
npm test          # everything (needs `npm install` + `npx playwright install chromium`)
npm run test:api  # API only, no browser needed
```

**56 tests, all passing.**

- **28 API tests:** validation, auth and CSRF, rate limits, uploads (type sniffing, size limits, range requests, path traversal), scheduling, moderation, Amens, comments and threading, and live chat over Server-Sent Events.
- **20 member-app tests:** run in Chrome on iPhone SE, iPhone 13, Pixel 7, iPad mini and desktop sizes.
- **8 dashboard tests.**

The end-to-end tests drive the real UI. They cover onboarding, every tab and channel, Amen/save/share, sign-in, comments (including script injection attempts), live video and two-way chat, off-air switching, music, the book reader, the calendar and reminders, the gallery lightbox, testimony submission → approval, search, theme, back-button handling, deep links, offline start, and every dashboard flow.

A **UI bug monitor** runs during every test. It fails the test on:

- any JS error, server error (5xx) or failed request;
- a layout audit of every screen: sideways overflow, elements off-screen, broken images, unlabelled buttons and tap targets under 24px.

Screenshots of every screen land in `test-results/screens/`.

### Bugs the tests found and fixed

- The video player's sound and full-screen buttons were 18×18 px, too small to tap reliably.
- On 320 px phones, the search page was wider than the screen. Separately, focusing a field could scroll the whole app frame sideways with no way back (`overflow: hidden` allows programmatic scroll; now `overflow: clip` plus a guard).
- The "Add a comment" bar and the reader's progress bar scrolled away with the page instead of staying pinned. The original prototype had this bug too.
- Album and book cards in a row were vertically misaligned when titles had different lengths.
- After going off-air, the TV tab stopped listening, so viewers never saw "we're live" again without restarting the app.
- "Continue reading" didn't appear after closing a book until the Library tab was re-opened.
- The comment Amen button had no accessible name.
- Dashboard: the "testimonies waiting for review" link opened an error page. Fast navigation could crash a list redraw. Thumbnail links had no accessible name.
- Server: the dashboard login limit counted successful sign-ins, so a busy team could lock itself out. Sign-ups were capped at 10/hour per IP, which would block a congregation sharing church Wi-Fi.

## Known limitations / next steps

- **Phone sign-in has no SMS verification yet.** Members enter a name, with phone optional. The phone number is stored but is not used as a login, so nobody can take over an account by typing someone's number. Wire an SMS-OTP provider (Twilio, Firebase Auth) into `registerMember` when ready. The prototype's "Continue with Google" button was dropped until OAuth is configured.
- **HLS live streams** play natively on iOS, Android and Safari. Desktop Chrome and Firefox users get a "watch on your phone" message unless you add hls.js.
- **Seed content** is the prototype's placeholder copy. The books have sample chapters. Replace it from the dashboard. Songs show "Soon" until audio is uploaded.
- **Server types:** `npm run typecheck` checks the server TypeScript against `@types/node`. It couldn't be run in the build environment (no package registry access), but the server is exercised end to end by the test suite.

## Project layout

```
server/src/
  index.ts       entry: config, seed, listen
  app.ts         HTTP server, static hosting, CORS, CSP
  schema.ts      content types → validation + dashboard forms
  content.ts     items, settings, live state, public bundle
  routes/        public.ts (app API), admin.ts (dashboard API)
  auth.ts        scrypt passwords, sessions, member tokens
  media.ts       uploads (streamed, sniffed), range serving
  live.ts        Server-Sent Events: chat, viewers, on-air changes
  seed.ts        starter content
src/app/         member app (lib, api, store, native, ui, views, media, pages, main)
src/admin/       dashboard (lib, form, main)
app/, admin/     web roots served at /app and /admin (compiled JS in js/)
tests/           api/, e2e/ (Playwright + UI monitor), helpers
```
