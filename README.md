# CampaignDesk — WhatsApp Campaign Management Workspace

CampaignDesk is a self-hosted Next.js dashboard and persistent WhatsApp worker built on `whatsapp-web.js`, Prisma/PostgreSQL and BullMQ/Redis. It manages WhatsApp Web sessions, discovers accessible contacts and groups, records permissions, builds shared contact segments, and runs one-time or recurring text, image or PDF campaigns.

> **Important:** `whatsapp-web.js` uses the unofficial WhatsApp Web interface. Its behavior can change without notice, and using it for unauthorized or bulk promotional messaging can lead to account restrictions. For high-volume commercial campaigns use the official WhatsApp Business Platform. Do not message group members privately unless they independently opted in; group membership is not marketing consent.

## Requirements

- Node.js 22+ and npm.
- Either Docker + Compose, or native PostgreSQL server binaries. Native services on Linux/macOS need `make`, a C compiler and `tar` if the installed Redis is older than 6.2. On Ubuntu: `sudo apt install postgresql build-essential`.
- A WhatsApp account eligible for linked-device pairing.
- Linux/macOS for the persistent Chromium worker (Linux desktop or VPS recommended).
- Chromium dependencies for Puppeteer. The worker must run on an always-on machine; Vercel/serverless is **not** suitable for the worker.

## Run locally

You can start the platform by double-clicking the **CampaignDesk** shortcut on your Linux desktop and choosing **Development** or **Production**. If prompted, select **Allow Launching**. Alternatively, right-click one of the executable scripts below in the project folder and choose **Run as a Program** / **Run in Terminal**. The launcher opens a terminal for logs and automatically opens your browser when the app is ready.

- **run.sh** — choose a mode from the menu.
- **run-dev.sh** — start development with automatic reloads.
- **run-production.sh** — build the production app, then run the production web server and WhatsApp worker together.

All three scripts work from any working directory. They start PostgreSQL/Redis, check the configuration and start both web and worker. Missing dependencies are installed automatically, and first-time configuration runs if `.env` is missing. Keep the launcher window open; **Ctrl+C** stops web and worker, then Enter closes the window. Database services retain their data and remain running. Stop the previous platform window before starting another mode on the same port.

`run-production.sh --skip-build` restarts an existing production build without rebuilding. `--no-browser` skips automatic browser opening. The generated `CampaignDesk.desktop` contains this checkout's absolute path; if you move the project, run `run.sh` directly or regenerate the shortcut with `npm run launcher:install`. Setup generates the shortcut automatically.

The equivalent terminal commands are:

```bash
npm ci
npm run setup
npm run dev:all
```

`setup` creates a private `.env` when needed, replaces the shipped placeholder secrets with random values, starts project services, generates Prisma, creates the schema and provisions the administrator. Existing custom settings are preserved. Sign in at **http://localhost:3000** using `ADMIN_EMAIL` and `ADMIN_PASSWORD` in your local `.env`. The generated password is never printed or committed.

PostgreSQL uses **127.0.0.1:55432** and Redis uses **127.0.0.1:56379** so existing machine services on 5432/6379 do not conflict. With a working Docker daemon, setup runs Compose. Without Docker, it creates an isolated PostgreSQL cluster and Redis under the ignored `.local/` directory using your current user; no system database roles or services are modified. If necessary, it downloads Redis 7.4.6 from the official release server, verifies its SHA-256 and builds it locally. The first native setup takes a few minutes.

```bash
npm run doctor          # validate configuration, database/schema/admin, Redis and Chromium
npm run services:up     # restart project services after reboot
npm run services:down   # stop project services, preserving their data
```

Set `SERVICES_BACKEND=native` or `SERVICES_BACKEND=docker` before setup to select a backend explicitly. Keep the selected backend consistent: Docker volumes and `.local/` contain separate data. Set `POSTGRES_BIN` if PostgreSQL tools are not in PATH or `/usr/lib/postgresql/<version>/bin`. Custom database/Redis URLs are treated as externally managed services and must already be reachable. If Docker or a native cluster has existing data, its credentials must match `.env`; setup never resets an existing database password.

To use another web port, set `PORT` in `.env` (for example `3001`). The app uses that exact port, so a conflict produces a clear error. Every process reads the same `.env`; do not place different database or queue settings in `.env.local`.

For separate processes, use `npm run dev` in one terminal and `npm run worker` in another. Web and worker must share the database, Redis, session storage and `.uploads`. `npm run db:push` is suitable for initial local setup; use reviewed Prisma migrations before production.

**Production:** run `npm run build`, then supervise `npm run start` and `npm run worker` as persistent processes. TLS/HTTPS is required for production auth cookies. Back up your database, `.uploads` and WhatsApp session directory. Native `.local/` services are intended for local development; use supervised database/Redis services for production.

## How to use

1. **Sessions:** Add a session name → Connect → WhatsApp phone app → Linked devices → scan QR code. Once connected, contacts and groups sync automatically (and refresh every 30 minutes). **Sync contacts & groups** is also available on demand. Subsequent development/production launches reuse that same saved login automatically. Recoverable Chromium/transport failures reconnect with backoff without deleting LocalAuth or requiring another click. Campaign sending holds do not disconnect WhatsApp or block contact sync; they still prevent campaign delivery. A new QR is needed only if WhatsApp invalidates the link. Sessions explicitly disconnected or logged out stay disconnected.
2. **Groups:** Browse accessible WhatsApp groups and select groups to sync members, then inspect discovered participants. Enable "Posting authorization" only where you have permission to announce to the group.
3. **Contacts:** Sync or paste CSV records (phone,name); all discovered/imported contacts start at UNKNOWN consent. Use **Opt in all contacts**, update selected contacts, or **Opt in segment** to record your decision. Administrator confirmation records a dated audit entry; a note is optional. Existing opt-outs are skipped unless you separately confirm that they opted in again. STOP/UNSUBSCRIBE replies automatically change the contact to OPTED_OUT. Discovered private WhatsApp IDs (`@lid`) can receive campaigns after documented opt-in even when the phone number is hidden; the app sends to the saved WhatsApp ID. Display names and typed usernames are not guessed as destinations. Known phone/LID mappings are checked for suppression and duplicate attempts.
4. **Contact segments:** Filter the directory by phone contacts, group contacts, source account, group, consent or segment (including unsegmented contacts). Select individual rows across pages or **Select all matching**, then **Save to segment**. Add to several segments, move into several destinations, or remove memberships. Moving from a segment removes only that source membership; moving without a source replaces all current segment memberships. You can create and fill a segment in the same atomic operation, including while extracting group members; a failed extraction does not leave an empty new segment. Browse, rename and describe segments from **Contact segments**. Group membership and contact records are preserved when you move or remove segment memberships.
5. **Group → segments:** In **Groups**, choose **Save to segments**, select one or several destinations (or create one), and save. The worker discovers every available group member and saves contacts, group membership and all destination memberships together, including members beyond the preview limit. Check progress beside the group.
6. **Campaigns:** Follow **Audience → Message → Review & delivery**. Select a segment once to select every saved member across every page. Segment cards show total membership; the summary shows who is ready. Eligibility is not a count of previous sends. Only selected sources contribute recipients; the contact directory is never included automatically. Use **Opt in selected audience** to record opt-in without leaving the composer, or save a draft first. Optional individual contacts and saved group members have separate source tabs; the shared summary deduplicates all selected sources and explains exclusions. Choose a sending account independently of the source accounts. Write the message with WhatsApp formatting and personalization buttons, check the preview, and optionally attach JPEG/PNG/WebP/PDF (up to 8 MB). Review the exact recipients and delivery time, then save a draft, launch, or schedule. A group announcement posts once to each authorized group.
7. **Edit & relaunch:** Edit a completed, cancelled or fully stopped paused campaign in place. Save a draft or **Save & relaunch**. Every explicit launch starts a fresh send generation in the same campaign, so previously messaged recipients may receive it again. **Resume** keeps the current generation and skips previously attempted destinations. Active/scheduled campaigns must be paused before editing. Each new run stores its message template, attachment name and planned audience count; older history remains available.
8. **Reports:** Global totals include all runs; the table shows the latest 100. See pending, sent, received (delivered), read, replied, replies, opted out, failures and uncertain sends separately, then open a run to read its message and responses. Sent includes delivered/read; delivered includes read. UNKNOWN appears as Unconfirmed: a send receipt is unavailable, so the message may already have been sent and is never automatically retried. Sent receipts are resolved by the generated message ID even when WhatsApp reindexes a phone destination under a private LID. A budget/window delay keeps unsent recipients pending in the same run. A paused/interrupted run marks unsent work skipped; resume picks up eligible destinations that were not attempted.

## Campaign sending controls

There is no ban-safe interval or volume for this unofficial WhatsApp Web connection. WhatsApp can restrict unauthorized bulk automation; recipient blocks/reports, unwanted contact, inappropriate content and misleading business identity also matter. Group membership, a public number/username, or a purchased list is not permission to send a campaign. Review [WhatsApp's messaging guidelines](https://www.whatsapp.com/legal/messaging-guidelines), [business policy](https://business.whatsapp.com/policy) and [restriction guidance](https://faq.whatsapp.com/717472490411581).

The defaults are internal workload limits, **not WhatsApp-approved allowances**: 30 seconds minimum spacing; 10 attempts per rolling 15 minutes, 30/hour and 100/24 hours shared across every campaign and account; one campaign attempt per recipient per seven days; 09:00–18:00 Africa/Nairobi. Set `CAMPAIGN_*` values in `.env` (see `.env.example`) and restart to change them. Large selections remain supported, but drain over multiple windows/days. Failed and unknown attempts consume capacity. A persistent reservation precedes each send; campaign deletion, reconnecting, switching accounts and restarting do not reset budgets. A new launch also respects the recipient cooldown.

Individual campaigns require a recorded opt-in decision and date. Administrator confirmation can record both from Contacts or directly from the campaign audience review. The campaign contact picker shows all saved contacts and is independent of directory filters; its readiness panel explains exclusions. Drafts can be saved before opt-in; launches require a ready audience. Each individual message includes the account's **public sender name** (or the explicit `CAMPAIGN_BUSINESS_NAME` workspace default) and STOP instructions. An internal connection label such as `second_account` is **never** added to a message. Go to **WhatsApp sessions → Edit names** to rename an existing connection and set the recognizable, truthful name recipients should see. The campaign preview displays the exact public sender. Direct sending is blocked until one of those public identities is configured; drafts and group announcements remain available. Explicit unsubscribe requests such as “please stop messaging me” and “remove me from your list” are suppressed as well as STOP.

Three consecutive failed/unknown sends or a failure/uncertainty rate of at least 20% in the latest 10–20 attempts first trigger **one automatic 15-minute transport recovery cooldown**. The run remains queued with its unsent recipients; the worker reconciles receipts and resumes automatically when connected, within the normal sending budget and permitted hours. Unknown attempts are **never resent**, and further transport failures after recovery cause a manual-review account hold. At least three opt-outs constituting 5% of recent attempts still cause an immediate manual hold. These are local review triggers, not Meta quality scores. The bridge cannot observe all blocks, spam reports or restrictions; unread messages alone do not establish a complaint. Explicit restriction/rate-limit signals and **Sessions → Report restriction & pause campaigns** place a local 24-hour review hold. Respect any longer restriction shown in WhatsApp. Holds survive restarts and do not clear when a timer expires or an account reconnects.

Use **Settings → Campaign sending controls** for quotas, emergency pause and documented hold reviews. Reviewing a hold neither resumes campaigns nor clears counters. Resume permitted campaigns individually afterwards. For sustained bulk messaging, use the official WhatsApp Business Platform with genuine opt-in, approved templates, permitted content, quality monitoring and the account's actual messaging limits. This app does not yet implement Cloud API transport or its webhooks.

**Automatic recovery schema:** The new `SendingRecovery` table persists account-level cooldowns across worker restarts and account switches. Run `npm run db:push` to add it before starting the updated worker. Previously imposed manual holds are not automatically removed; review them in Settings once WhatsApp access is verified.\n\n**After pulling this update on an existing installation**, run `npm run db:push` to add the optional `WaSession.publicSenderName` column and regenerate the Prisma client, before restarting `./run.sh dev`. This is an additive database schema change; the session ID, Chromium auth profile, contacts and connected devices are unchanged. Back up the database before schema updates. Existing accounts without a per-account sender name use `CAMPAIGN_BUSINESS_NAME` if configured; otherwise direct campaigns require you to set a public sender in the new editor.

Existing installations: run `npm run db:generate` and `npm run db:push` before restarting the updated worker. Its first start backfills recent send history into the independent safety ledger. This update's local workspace is held for review because restrictions were reported; reopening the app does not restart campaigns.

## Reply tracking

New incoming replies are recorded while the WhatsApp worker is online, from this update onward. Quoting a campaign message links a response to that exact delivery. Unquoted replies are attributed to the most recent campaign delivery to that destination from the same sending account within 30 days; reports clearly label this inference. Quotes of unrelated messages are not attributed. Duplicate inbound events are ignored. STOP/UNSUBSCRIBE continues to suppress future messages and is displayed as an opt-out response. Available historical replies are recovered by the bounded history checks described below.

## Cron examples

Five fields: minute, hour, day of month, month, day of week. Existing six-field schedules are supported when the seconds field is `0`. Sub-minute campaign recurrence is rejected. Timezone defaults to `Africa/Nairobi`; one-time dates and cron both use the selected schedule timezone. The composer provides common presets and previews the next three occurrences. Nonexistent local times during daylight-saving changes are rejected; repeated local times use the earlier occurrence.

| Meaning | Cron |
| --- | --- |
| Every day at 9 AM | `0 9 * * *` |
| Every Monday at 9 AM | `0 9 * * 1` |
| Every weekday at 8 AM | `0 8 * * 1-5` |
| First day of the month at 10 AM | `0 10 1 * *` |

[BullMQ Job Schedulers](https://docs.bullmq.io/guide/job-schedulers/) generate recurring jobs. The background worker must remain online. A busy queue can delay execution. The app serializes campaign delivery across worker processes, validates that recurrence leaves enough time for the audience, and skips occurrences overlapped by the preceding execution. Segment membership is resolved at each execution and rechecked before reserving each send. Removing or moving a queued contact out of every selected source prevents dispatch; explicit selections and other selected segments still apply. Future recurring runs use current members and permissions. Paused/cancelled campaigns cannot send, and queued jobs from an earlier launch/resume revision are ignored. One-off campaigns skip previously attempted WhatsApp destinations within the current launch generation, including deliveries recorded before this upgrade. An explicit relaunch or launch of an edited draft starts a new generation; pause/resume keeps the existing generation. An uncertain send is never automatically retried.

The default per-campaign interval is **5 seconds** (editable from 1.5 seconds to one hour); the effective interval is the larger of that value and the workspace `SEND_INTERVAL_MS`. A cooldown follows the final message too. The preview reports minimum sending time; network work and other campaigns may add time. If a segment grows beyond its permitted size or recurrence window, execution pauses with a recorded run error for review.

## Architecture

```
Next.js 16 dashboard + /api/v1 REST + auth
            |              |
      PostgreSQL         BullMQ/Redis
            |              |
    Prisma models    persistent Node worker
                           |
                 whatsapp-web.js + Puppeteer
                           |
                   WhatsApp Web
```

- **Web/UI:** Next.js App Router, React, Lucide, responsive CSS.
- **API:** authenticated JSON endpoints under `/api/v1`; cookie-based sessions with signed JWT.
- **Data:** Prisma/PostgreSQL; sessions, contacts, groups, membership, segments, campaigns, runs, deliveries, audit entries.
- **Queue:** BullMQ/Redis; session/sync commands and campaign delivery use separate queues, keeping session controls responsive during long campaigns. Deliveries remain serialized.
- **Media:** Uploaded JPEG, PNG, WebP or PDF up to 8 MB resides in `.uploads` (shared by web and worker). Back up or mount this folder on durable storage; it is not served as a public directory.
- **Worker:** `worker/index.ts`; `LocalAuth` session persistence, QR events (temporary Redis keys), inbound STOP suppression, WhatsApp receipt updates.

## API summary

All endpoints below require authentication:

| Action | Endpoint |
| --- | --- |
| Get totals | `GET /api/v1/overview` |
| List/create WhatsApp sessions | `GET/POST /api/v1/sessions` |
| Connect/disconnect/sync | `POST /api/v1/sessions/:id/connect\|disconnect\|sync` |
| Get transient QR string | `GET /api/v1/sessions/:id/qr` |
| List/create/consent contacts | `GET/POST /api/v1/contacts`, `PATCH /api/v1/contacts/:id` |
| Import authorized CSV data | `POST /api/v1/contacts/import` |
| List/authorize groups | `GET /api/v1/groups`, `PATCH /api/v1/groups/:id` |
| Save group contacts into segments | `POST /api/v1/groups/:id/save-contacts` with optional `segmentIds` and `newSegment: { name, description? }` (`sync-members` remains supported) |
| Read discovered group members | `GET /api/v1/groups/:id/members` |
| Create/manage shared segments | `GET/POST /api/v1/segments`, `PATCH/DELETE /api/v1/segments/:id` |
| Bulk add/move/remove memberships | `POST /api/v1/segments/members` (selection of IDs or a directory filter, multiple `segmentIds`, optional `sourceSegmentId` / `newSegment`) |
| Legacy single-segment membership | `POST /api/v1/segments/:id/members` |
| Preview draft recipients and timing | `POST /api/v1/campaigns/preview` |
| Upload campaign attachment | `POST /api/v1/media` (multipart file) |
| Create/manage campaigns | `GET/POST /api/v1/campaigns`, `GET /api/v1/campaigns/:id` |
| Edit a stopped campaign in place | `PATCH /api/v1/campaigns/:id` |
| Preview eligible audience | `GET /api/v1/campaigns/:id/audience` |
| Launch/pause/resume/cancel | `POST /api/v1/campaigns/:id/action` |
| Relaunch the same campaign now | `POST /api/v1/campaigns/:id/relaunch` |
| Delivery reports / global totals | `GET /api/v1/runs`, `GET /api/v1/report-summary` |

`GET /api/v1/health` and `GET /api/v1/audit` are authenticated diagnostic endpoints.

## Security and behavior

- Every API operation validates a signed session and rejects cross-origin browser mutations.
- No opt-in is ever inferred from a saved WhatsApp contact, imported CSV or group membership.
- A contact’s source session describes where it was discovered; it does not restrict which session can send to it. Phone addresses are deduplicated across source records and overlapping segments. Group announcements still require the sending session to have access to that group.
- The session worker filters and revalidates contact consent/group authorization immediately before sending. Contact consent edits apply to all known records for that phone address. STOP received by any session suppresses that address across the workspace, even if that sending session had not discovered the contact.
- Segments used by active, scheduled or paused campaigns cannot be deleted until those campaigns are cancelled.
- Default campaign cap: **1,500 destinations per run**, configurable with `MAX_CAMPAIGN_RECIPIENTS`. Sending is serialized, paced by the campaign interval and workspace `SEND_INTERVAL_MS` minimum. These are application safety controls, not a way to avoid WhatsApp's policies.
- Database has unique campaign run + destination keys. An interrupted/uncertain one-off send is *not* retried automatically, preventing silent duplicate sends.
- WhatsApp authentication artifacts must remain private and on persistent storage. Back up databases and audit consent evidence separately.
- Browser session QR codes are ephemeral and never stored in PostgreSQL.
- Syncing group member IDs may be incomplete because WhatsApp can expose opaque LIDs or omit participant data.
- This is a local-first implementation. Before exposing it publicly, add rate-limiting to authentication, monitoring/alerts, off-site backups, TLS termination and a stronger multi-user permissions model.

## Updating an existing installation

Stop the web and worker processes, run `npm run db:generate` and `npm run db:push`, then restart them (rebuild first for production). The schema update adds campaign launch generations, per-run message snapshots and audience counts, and reply records; it does not remove contact or segment data. As with all schema updates, keep a database backup for production and use reviewed migrations in managed environments.

## Development checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:integration
```

`test:integration` provisions and removes a temporary PostgreSQL schema and isolated Redis queues. It exercises authentication, audience/list management, attachments, schedules, pause/resume, crash recovery and reporting, then uses real headless Chromium to check the dashboard. WhatsApp transport is mocked; it never sends external messages. Screenshots and server logs are saved under `.local/verification/`. Use `npm run test:integration -- --api-only` to run API/database/queue checks without browser automation. Verification uses a separate Next.js output directory through `NEXT_DIST_DIR`, leaving an existing development server intact. PostgreSQL, Redis and the Puppeteer browser must be installed first (`npm run setup`). Actual pairing, live contact/group sync, inbound STOP and WhatsApp delivery acknowledgements require a linked phone and the live acceptance checks in `docs/TESTING.md`.

## Troubleshooting

- **Docker command missing:** run `npm run setup`; the native backend uses locally installed PostgreSQL tools and provisions a compatible Redis automatically.
- **Database authentication failed / P1000:** the shipped setup uses a separate database on 55432. Run `npm run setup` to replace only the original localhost:5432 example URL; for custom credentials, correct `DATABASE_URL` to match your database. Existing data is retained.
- **Redis 6.0 warning:** run `npm run setup` to provision Redis 7.4.6 on 56379, then verify `REDIS_URL`. The worker requires Redis 6.2+.
- **Port 3000 occupied:** set `PORT=3001` (or another free port) in `.env`, then restart. Web and worker continue to use the same service configuration.
- **Background worker offline:** start `npm run worker` or `npm run dev:all`; Settings & help shows the live service status. Session commands and campaign scheduling return an explicit error while the worker is offline.
- **Chromium missing:** run `npx puppeteer browsers install chrome`, or set `PUPPETEER_EXECUTABLE_PATH` to a working Chromium/Chrome executable. On Linux, run `ldd <browser-path>` to find missing system libraries; `npm run doctor` prints a browser startup error if needed.

- **QR never arrives:** check that the worker is running, Redis is reachable and Puppeteer can start Chromium. On Linux, install missing browser system libraries or set `PUPPETEER_EXECUTABLE_PATH`.
- **No contacts/groups:** connect the account; automatic sync starts when ready. You can also click Sync contacts & groups. API commands enqueue asynchronous jobs; watch the worker terminal.
- **Campaign has zero recipients:** review the audience summary and use **Opt in selected audience**, or authorize selected group announcements. A private WhatsApp ID does not need a visible phone number.
- **Scheduled campaign did not send:** check Redis, the worker terminal, session status and campaign status. A disconnected session cannot send.
- **Session says the browser is already running:** restart through `run.sh`, or choose **Restore session**. Recovery verifies which browser owns that specific profile, closes a proven orphan and keeps authentication data. A browser still owned by a live worker is left alone; stop the duplicate worker first. The worker also holds an exclusive session-storage lock, including direct `npm run worker` launches.
- **Previously paired session stays in Error after restart:** saved profiles for previously paired error sessions are restored automatically. Explicitly disconnected/logged-out accounts remain off. A real logout or expired link requires a new QR; profile locks do not require deleting sessions or contacts.
- **Session storage across launch modes/hosts:** relative `SESSION_DIR` paths are resolved from this project, independent of the launching shell. Development and production on the same machine share the same profile directory. A separate web host needs the same database and a persistent WhatsApp worker with its saved profiles; opening the website in another browser does not move authentication files.
- **Session logs out repeatedly:** persist `SESSION_DIR` between worker restarts and keep your WhatsApp Web dependency compatible with the current WhatsApp Web build.

## License and responsibility

You are responsible for applicable privacy/marketing laws and WhatsApp's terms. Do not scrape group members for unsolicited outreach. The official WhatsApp Business Platform is preferable for sustained commercial messaging.

### Reconcile old WhatsApp campaign results

Go to **Campaigns → Reconcile history** on an account's campaign. The connected WhatsApp worker scans a bounded window of its stored chat history without sending any messages. It first reads exact persisted message identifiers, then checks unresolved recent sends against uniquely matching chat messages (direction, full personalized text, destination, timestamp, WhatsApp acknowledgement). It can recover some historical replies, including exact quoted replies. **Unconfirmed does not mean failed or delivered**, and skipped deliveries across multiple runs must not be converted to sent. Results are not exhaustive: WhatsApp may no longer expose older chats or receipts, user/profile details may have changed, and ambiguous attempts are left untouched. The dashboard shows recovered counts, unresolved records, and partial/failed scans. The connected user's browser session and local database are needed; GitHub CI cannot reconcile real history.

Campaign receipts and available replies are reconciled automatically while accounts remain connected: every five minutes a bounded batch of recent chats is checked, rotating through the available list. The same queue handles manual history checks. Recovered opt-out replies suppress future sends, while older replies cannot reverse a later explicitly recorded renewed opt-in. **Opted out** counts campaign deliveries with an opt-out reply or a retained opt-out event on the send attempt (once per delivery), including historical runs; it is not a count of current directory consent states. These checks never send or repeat messages.
