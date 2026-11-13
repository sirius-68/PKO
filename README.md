# Prophet Kevin Online (PKO)

The Apostolic Gospel Mission's app: a **mobile app** for members, a **creator dashboard** for the media team, and **Supabase** as the backend. There's no server of your own to run.

```
 Android / iOS app (Capacitor) ─┐
 Web app  (GitHub Pages /app)   ├──►  Supabase: Postgres + Auth + Storage + Realtime
 Dashboard (GitHub Pages /admin)┘        (rules and functions in supabase/migrations)
```

| Part | What it is | Code |
|---|---|---|
| Member app | Android/iOS via Capacitor, also a web app (PWA). TypeScript, no framework. | `src/app` → `app/` |
| Creator dashboard | Upload and manage everything in the app; moderation; going live. | `src/admin` → `admin/` |
| Backend | One SQL migration with tables, row-level security, storage rules and every function the apps call. | `supabase/migrations/` |
| Supabase client | A small dependency-free client used by both apps: database calls, auth, storage uploads with progress, and live updates. | `src/shared/supa.ts` |
| 24/7 TV channel | vMix → streaming service → app. Plays live when the studio streams, scheduled replays and rotation the rest of the time; saves recordings to Past messages. **Setup: [docs/LIVE-TV.md](docs/LIVE-TV.md)** | `src/shared/channel.ts`, `supabase/functions/stream-webhook/` |

## Going live (test setup)

### 1. Create the Supabase project
1. Create a project at [supabase.com](https://supabase.com).
2. Apply the database schema. Either:
   - open the project's **SQL Editor**, paste `supabase/migrations/20261113000000_init.sql`, and click **Run**; or
   - use the Supabase CLI: `supabase link` then `supabase db push`.
3. **Authentication → Sign In / Providers:** turn on **Allow anonymous sign-ins**. Members use this to Amen, comment and chat after entering their name.
4. **Authentication → URL Configuration:** set **Site URL** to the dashboard address, `https://sirius-68.github.io/PKO/admin/`.
5. **Project Settings → API:** copy the **Project URL** and the **anon public** key into `supabase.config.json`. Both are public by design. **Never** use the `service_role` key.

### 2. Publish the dashboard and web app (GitHub Pages)
1. In the repo, open **Settings → Pages → Source** and choose **GitHub Actions**.
2. Push to `main`. The *Deploy* workflow publishes:
   - the dashboard at `https://sirius-68.github.io/PKO/admin/`
   - the web app at `https://sirius-68.github.io/PKO/app/`
3. Open the dashboard, choose **Create an account**, then **Become the owner**. The first account owns the dashboard.
4. On the Overview page, click **Import starter content** to load the original app's posts, books, albums, events, photos and the 4 TV clips.
5. To add teammates: they create an account first, then you add their email under **Team & password**.

### 3. Get the Android app
The same *Deploy* workflow builds an APK and attaches it to the **`android-latest` GitHub Release**. It does this whenever `supabase.config.json` is filled in. To install on Android:

1. Download the APK on the phone.
2. Open it.
3. Allow installs from that source.

This is a test build (debug-signed), for sideloading only. For the Play Store you need a signed release build; see *Store release* below.

### Store release (later)
- **Android:** create an upload keystore, then run `npm run native:sync`. Build a signed AAB in Android Studio (*Build → Generate Signed Bundle*) and upload it to Google Play.
- **iOS:** on a Mac, run `npm run native:ios`. Then:
  - set the team and bundle id;
  - add **Background Modes → Audio** so songs play when the phone locks;
  - archive and upload to App Store Connect.
- Change `appId` in `capacitor.config.json` to the id you register.

## Plan limits to know (Supabase free plan)

- **Projects pause after 7 days without activity.** That's fine for testing, but use the Pro plan ($25/month) for the real launch.
- **Uploads are capped at 50 MB per file.** Long sermon videos need the Pro plan or a streaming link; put HLS/MP4 links in the Live page or a broadcast's "video URL".
- Supabase's built-in email sender is rate-limited. For more than a few dashboard sign-ups, add your own SMTP.

## How the security works

- **Reading:** the apps read published content through `get_bundle()` and related functions. Drafts, scheduled posts and the media registry are never exposed.
- **Writing:** every write goes through a database function that checks who is calling.
  - **Guests** can only read.
  - **Members** get an anonymous account plus a name. They can Amen, comment, chat, and submit testimonies, which wait for approval.
  - **The media team** are email accounts listed in `admins`. Only they can create content, upload or delete files, moderate, and go live.
- **Storage:** only the media team can upload, replace or delete files. Members may upload a testimony video, and only into their own folder. The bucket refuses SVG/HTML and other unsafe types.
- **Abuse limits:** rate limits apply to comments, chat, Amens, testimonies and uploads. Blocked members can't post.
- **Removed chat messages:** a moderator's delete wipes the message text from the database, not just from the screen.

## Development and tests

You can run everything locally without a Supabase account. `supabase/local/` contains a small emulator of the Supabase APIs the apps use: auth, database calls, storage and live updates. It runs on a real Postgres with the **real migration** applied, so the database rules and functions behave exactly as they will in production.

```bash
npm install                       # TypeScript + Playwright
npm run dev                       # throwaway DB + emulator; prints app/dashboard URLs
npm test                          # backend + end-to-end UI tests
```

Both need a local Postgres 16 with trust auth (`PGHOST`, `PGPORT`, `PGUSER`). CI uses a Postgres service container.

**Tests (all passing):**
- **14 channel tests:** time zones and daylight saving, the weekly plan, replays joined at the right point, and rotation that stays in step across devices.
- **14 live-pipeline tests:** Cloudflare and Mux webhook signatures and payloads, going on air automatically, saving recordings once, and rejecting forged or stale calls.
- **30 backend tests:** what guests and members can and can't do, admin-only functions, storage rules, validation, rate limits, moderation, and live updates over WebSocket.
- **20 member-app tests:** Chrome on iPhone SE, iPhone 13, Pixel 7, iPad mini and desktop sizes.
- **9 dashboard tests,** including first-owner setup and the starter-content import.

A UI monitor fails a test on any JS error, failed request or server error. A layout audit checks every screen for sideways overflow, off-screen elements, broken images, unlabelled buttons and small tap targets. Screenshots go to `test-results/screens/`.

## Known limitations / next steps
- **Member sign-in uses a name only.** The phone number is stored but not verified. Supabase Auth can add SMS one-time codes (Twilio and others) and upgrade these anonymous accounts in place.
- **HLS streams** play natively on Android, iOS, Safari, and desktop Chrome and Edge (version 142+). Firefox shows a "watch on your phone" message.
- **Streaming costs** are per minute watched (see [docs/LIVE-TV.md](docs/LIVE-TV.md#costs)). YouTube Live is free but isn't playable in the app yet.
- **Seed content** is the prototype's placeholder copy, and songs show "Soon" until audio is uploaded.

## Layout
```
supabase/migrations/   the backend (schema, RLS, storage policies, RPCs)
supabase/functions/    stream-webhook Edge Function (streaming service → channel events)
supabase/local/        Supabase emulator + Postgres client for local dev/tests only
src/app/               member app        → app/js
src/admin/             dashboard         → admin/js   (backend.ts maps screens → RPCs)
src/shared/            supa.ts (Supabase client), schema.ts (content types + validation)
admin/seed/            starter content for "Import starter content"
scripts/               write-config, native-sync, dev
tests/                 backend.test.ts, e2e/ (Playwright + UI monitor), helpers
.github/workflows/     ci.yml (tests), deploy.yml (Pages + Android APK release)
```
