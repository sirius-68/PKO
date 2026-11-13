# Transfiguration TV: the 24/7 channel

The TV tab works like a television channel. Everyone who opens it sees the same thing at the same moment:

| When | What plays |
|---|---|
| The media team is streaming from vMix | **The live stream**, with live chat. The app goes on air by itself. |
| A programme in the schedule is set to "A past message" | **That message**, joined at the right point. If it started at 18:30 and you open the app at 18:40, you join 10 minutes in. |
| Any other time | **The latest messages on rotation**, kept in step by the clock so viewers see the same moment |

**Up next** shows the programme plan in each viewer's own time zone, with reminders. When a live programme ends, its recording is saved under **Past messages** automatically.

```
vMix ──RTMPS──▶ Cloudflare Stream ──HLS link──▶ the app (TV tab)
                     │
                     └─ webhooks ──▶ Supabase Edge Function "stream-webhook"
                                       ├─ studio connected    → on air (title from the schedule)
                                       ├─ studio disconnected → off air; replays continue
                                       └─ recording ready     → new item in Past messages
```

## What the media team does each week

1. Plan the week on the dashboard: **TV schedule**. Add programmes one by one, or use **Import** to paste the running order from a spreadsheet (see below).
2. When it's time, press **Stream** in vMix. Within a few seconds the app shows **LIVE** with the programme's title from the schedule.
3. Stop the stream in vMix when you're done. The app goes back to replays, and about a minute later the recording appears in Past messages.

You can still switch the app on air or off air yourself with **Go live** / **End live service** on the Live page, for example if the webhook isn't set up yet.

## One-time setup

### 1. A streaming service

vMix can't send video straight to phones. A streaming service takes the vMix feed, converts it for phones, and gives you one permanent playback link. We recommend **Cloudflare Stream**:

- vMix sends to it over RTMPS or SRT.
- It records every live stream automatically.
- Pricing is simple (see Costs).

**Mux** also works; the webhook understands both.

In the Cloudflare dashboard, go to **Stream → Live inputs → Create live input**. Then:

- Set **Recording** to **Automatic**. This is what fills Past messages.
- Open the live input and copy three things:
  - the **RTMPS URL** and **Stream key**, for vMix;
  - the **HLS manifest URL** (ends in `.m3u8`), for the app.

The HLS link stays the same every week.

### 2. vMix

Go to **Settings → Streaming** (the cog next to the **Stream** button) and set:

- **Destination:** Custom RTMP Server
- **URL:** the RTMPS URL from Cloudflare
- **Stream Name or Key:** the stream key

Encoding settings that work well on phones:

- 1080p or 720p, H.264
- 4–6 Mbps
- keyframe every 2 seconds

vMix can stream to up to three destinations at once, so you can keep sending to YouTube or Facebook as well.

> **Keep the stream key in vMix only.** Anyone who has it can broadcast on your channel. Don't paste it into the dashboard.

### 3. The dashboard Live page

| Setting | What to enter |
|---|---|
| Stream playback URL | The HLS link (`…/manifest/video.m3u8`) |
| Channel time zone | Where the studio is, e.g. `Africa/Douala`. All schedule times are in this zone; each viewer sees them converted to their own time. |
| Run the channel 24/7 | On: replays and rotation between programmes. Off: the TV tab shows "off air" with the schedule. |
| Go on air when the studio starts streaming | On: the app follows vMix by itself (needs step 4). |
| Save each live programme to Past messages | On: every recording is published as a TV broadcast. |
| Category for saved programmes | E.g. `Services`. Viewers filter Past messages by category. |

### 4. The webhook (makes it automatic)

Deploy the Edge Function once from your computer, using the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy stream-webhook --no-verify-jwt
```

`--no-verify-jwt` is needed because Cloudflare isn't a Supabase user. Every call is checked against the secrets below instead, and anything else is refused.

Its address is `https://YOUR_PROJECT_REF.supabase.co/functions/v1/stream-webhook`. The Live page shows it with a copy button.

**Cloudflare Stream: recordings.** Register the webhook with the Cloudflare API. Use an API token with *Stream: Edit* permission.

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/stream/webhook" \
  -H "Authorization: Bearer CLOUDFLARE_API_TOKEN" \
  -d '{"notificationUrl":"https://YOUR_PROJECT_REF.supabase.co/functions/v1/stream-webhook"}'
```

The response contains a `secret`. Store it in Supabase:

```bash
supabase secrets set CLOUDFLARE_WEBHOOK_SECRET=the-secret-from-the-response
```

**Cloudflare Stream: on air / off air.**

1. In the Cloudflare dashboard, go to **Notifications → Destinations → Webhooks** and create a webhook:
   - **URL:** the function's address
   - **Secret:** a long random string that you make up
2. Then go to **Notifications → Add** and choose **Stream Live Input**:
   - **Events:** connected, disconnected, errored
   - **Destination:** that webhook
3. Store the same secret, and the live input's ID so other inputs are ignored:

```bash
supabase secrets set CLOUDFLARE_NOTIFY_SECRET=the-secret-you-made-up CLOUDFLARE_LIVE_INPUT=your-live-input-id
```

**Mux instead of Cloudflare.**

1. Add the function's address as a webhook in the Mux dashboard.
2. Store the signing secret and the live stream's ID:

```bash
supabase secrets set MUX_WEBHOOK_SECRET=... MUX_LIVE_STREAM=...
```

**Any other service, or a vMix script.**

1. Set `PKO_WEBHOOK_KEY` to a random string.
2. Send a POST with the header `x-pko-key: <that string>` and one of these JSON bodies:
   - `{"type":"live.started"}`
   - `{"type":"live.ended"}`
   - `{"type":"recording.ready","id":"…","url":"https://…m3u8","duration":3600,"poster":"https://…jpg","title":"…"}`

To check it's working, start a short test stream from vMix:

- The Live page should show **Studio is streaming** within a few seconds.
- The app's TV tab should show **LIVE**.

## The programme plan

Each programme in **TV schedule** has these fields:

| Field | Notes |
|---|---|
| Programme, Subtitle | What viewers see in Up next |
| Days | Every day, Weekdays, Weekends, or one day (Mondays … Sundays). For Mon/Wed/Fri, add three programmes. |
| Starts / Ends | 24-hour channel time. **Ends** is optional: live programmes run 2 hours, replays run their own length. |
| What plays | **Live from the studio**: the vMix stream. If the studio isn't streaming yet, rotation keeps playing. **A past message**: a replay chosen below. **Latest messages on rotation**: filler. |
| Past message to play | For "A past message" |

**Import from a spreadsheet or the vMix running order.** Paste one programme per line, comma- or tab-separated:

```
Days, Starts, Ends, Programme, Subtitle, What plays, Past message
Sundays, 09:00, 12:00, Sunday Service, Live from Douala, live
Weekdays, 12:00, 12:15, Midday Word, 15 minutes in the Scriptures, rotation
Every day, 18:30, , Christ the Rock, Replay with live chat, replay, Christ the Rock
```

Every line is checked before anything is saved, and errors are reported by line number.

**The 24/7 channel only plays messages whose length it knows.**

- Uploaded videos get their length when you save them in the dashboard.
- Recordings get their length from Cloudflare or Mux.
- For a broadcast added by link, if its length is blank the channel skips it. Open it and save it again in a browser that can play the link, or type the length in seconds.

## Costs

The channel is delivered by your streaming service. Cloudflare Stream charges for **minutes delivered** (every minute watched by every viewer) and **minutes stored**. Prices were checked in November 2026; confirm them on Cloudflare's pricing page:

- $1 per 1,000 minutes delivered
- $5 per 1,000 minutes stored

Some examples:

| Scenario | Delivered minutes / month | Cost |
|---|---|---|
| Sunday service, 3 h, 300 viewers, 4 weeks | 300 × 180 × 4 = 216,000 | ≈ $216 |
| 24/7 channel, 10 people watching on average at any moment | 10 × 43,200 = 432,000 | ≈ $432 |
| 15 h of live programmes a week, recorded | 3,900 new stored minutes / month | ≈ $20 more each month, as recordings build up |

Ways to keep costs down:

- **Recordings:** set an auto-delete period on the live input (`deleteRecordingAfterDays`). Re-upload the ones you want to keep as MP4s.
- **Replays from your own uploads** (MP4s in the media library) are served by Supabase Storage, not Cloudflare. Supabase bandwidth is billed separately on its own plan.
- **Free option:** YouTube Live costs nothing to stream 24/7. vMix can send to YouTube at the same time as Cloudflare. The app doesn't play YouTube streams yet; ask if you'd like that added.

## Players

- **Android and iOS apps:** play HLS natively.
- **Desktop Chrome and Edge:** play HLS natively since version 142.
- **Firefox:** doesn't play HLS yet and shows a "watch in the mobile app" message.

## Troubleshooting

| Symptom | Check |
|---|---|
| Live page says "No signal from the streaming service yet" | The webhook isn't reaching Supabase. In Supabase, open **Edge Functions → stream-webhook → Logs**. A `401` means a secret doesn't match. |
| The app doesn't go live, but the Live page shows "Studio is streaming" | "Go on air when the studio starts streaming" is off, or **Stream playback URL** is empty. |
| A recording didn't appear in Past messages | "Save each live programme" is off, or the live input's recording mode isn't **Automatic**. Recordings arrive about a minute after the stream ends. |
| Rotation shows nothing, or the TV tab shows "off air" | No published broadcast has a known length. See "The programme plan" above. |
| Up next shows the wrong times | Check **Channel time zone** on the Live page. |
