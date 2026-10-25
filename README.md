# CampaignDesk — WhatsApp Campaign Management Workspace

CampaignDesk is a self-hosted Next.js dashboard and persistent WhatsApp worker built on `whatsapp-web.js`, Prisma/PostgreSQL and BullMQ/Redis. It manages WhatsApp Web sessions, discovers accessible contacts and groups, records permissions, builds contact lists, and runs one-time or recurring text, image or PDF campaigns.

> **Important:** `whatsapp-web.js` uses the unofficial WhatsApp Web interface. Its behavior can change without notice, and using it for unauthorized or bulk promotional messaging can lead to account restrictions. For high-volume commercial campaigns use the official WhatsApp Business Platform. Do not message group members privately unless they independently opted in; group membership is not marketing consent.

## Requirements

- Node.js 22+, npm, Docker + Docker Compose.
- A WhatsApp account eligible for linked-device pairing.
- Linux/macOS for the persistent Chromium worker (Linux desktop or VPS recommended).
- Chromium dependencies for Puppeteer. The worker must run on an always-on machine; Vercel/serverless is **not** suitable for the worker.

## Run locally

```bash
git clone https://github.com/Elvinoacer/whatsapp_campaigns.git
cd whatsapp_campaigns
git checkout feat/complete-campaign-platform

cp .env.example .env
# Edit .env: ADMIN_EMAIL, ADMIN_PASSWORD (12+ chars), AUTH_SECRET (32+ random chars).
# Example generator: openssl rand -hex 32

docker compose up -d
npm install
npm run db:generate
npm run db:push
npm run db:seed
npm run dev:all
```

Open **http://localhost:3000** and sign in using `ADMIN_EMAIL` and `ADMIN_PASSWORD`. This repository deliberately does not ship default admin credentials.

For separate processes, use `npm run dev` in one terminal and `npm run worker` in another. Both processes must share the same database, Redis and working filesystem (for WhatsApp sessions). `npm run db:push` is suitable for initial local setup; use reviewed Prisma migrations before production.

**Production web build:** `npm run build` and `npm run start` alongside a separately supervised `npm run worker` process, on a server that supports persisted browser sessions. TLS/HTTPS is required for production auth cookies.

## How to use

1. **Sessions:** Add a session name → Connect → WhatsApp phone app → Linked devices → scan QR code. Wait for Connected, then Sync contacts.
2. **Groups:** Browse accessible WhatsApp groups and select groups to sync members, then inspect discovered participants. Enable "Posting authorization" only where you have permission to announce to the group.
3. **Contacts:** Sync or paste CSV records (phone,name); all discovered/imported contacts start at UNKNOWN consent. Mark OPTED_IN only after explicit consent and record when/how it was obtained. STOP/UNSUBSCRIBE replies automatically change the contact to OPTED_OUT.
4. **Contact lists:** Filter contacts by group or permission state, select contacts in the directory, click "Save to list", then create a new list or add them to an existing one. Lists can be reused across campaigns; duplicates are removed at send time.
5. **Campaigns:** Create a campaign draft, select one WhatsApp session, contacts/lists or authorized groups, optionally attach JPEG/PNG/WebP/PDF (up to 8 MB), choose Now / Once / Cron, save draft, inspect eligible recipients and Launch. A group campaign sends one message to each selected group, **not** a DM to every group member.
6. **Reports:** Inspect each run and its delivery records. Status can be SENT, DELIVERED or READ when WhatsApp provides acknowledgements; UNKNOWN means delivery is uncertain and requires human review.

## Cron examples

Five fields: minute, hour, day of month, month, day of week. Timezone defaults to `Africa/Nairobi`.

| Meaning | Cron |
| --- | --- |
| Every day at 9 AM | `0 9 * * *` |
| Every Monday at 9 AM | `0 9 * * 1` |
| Every weekday at 8 AM | `0 8 * * 1-5` |
| First day of the month at 10 AM | `0 10 1 * *` |

BullMQ Job Schedulers generate recurring jobs. The background worker must remain online. Paused/cancelled campaigns cannot send. One-off campaigns are not automatically retried after an uncertain message state.

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
- **Queue:** BullMQ/Redis; connection commands, group/contacts sync, one-time and cron campaign execution.
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
| Sync members of a selected group | `POST /api/v1/groups/:id/sync-members` |
| Read discovered group members | `GET /api/v1/groups/:id/members` |
| Create/manage lists | `GET/POST /api/v1/segments`, `POST /api/v1/segments/:id/members` |
| Upload campaign attachment | `POST /api/v1/media` (multipart file) |
| Create/manage campaigns | `GET/POST /api/v1/campaigns`, `GET /api/v1/campaigns/:id` |
| Edit a draft campaign | `PATCH /api/v1/campaigns/:id` |
| Preview eligible audience | `GET /api/v1/campaigns/:id/audience` |
| Launch/pause/resume/cancel | `POST /api/v1/campaigns/:id/action` |
| Delivery reports | `GET /api/v1/runs` |

`GET /api/v1/health` and `GET /api/v1/audit` are authenticated diagnostic endpoints.

## Security and behavior

- Every API operation validates a signed session and rejects cross-origin browser mutations.
- No opt-in is ever inferred from a saved WhatsApp contact, imported CSV or group membership.
- The session worker filters and revalidates contact consent/group authorization immediately before sending.
- Default campaign cap: **200 destinations per run**, configurable with `MAX_CAMPAIGN_RECIPIENTS`. Sending is serialized with `SEND_INTERVAL_MS` between sends. These are application safety controls, not a way to avoid WhatsApp's policies.
- Database has unique campaign run + destination keys. An interrupted/uncertain one-off send is *not* retried automatically, preventing silent duplicate sends.
- WhatsApp authentication artifacts must remain private and on persistent storage. Back up databases and audit consent evidence separately.
- Browser session QR codes are ephemeral and never stored in PostgreSQL.
- Syncing group member IDs may be incomplete because WhatsApp can expose opaque LIDs or omit participant data.
- This is a local-first implementation. Before exposing it publicly, add rate-limiting to authentication, monitoring/alerts, off-site backups, TLS termination and a stronger multi-user permissions model.

## Development checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Troubleshooting

- **QR never arrives:** check that the worker is running, Redis is reachable and Puppeteer can start Chromium. On Linux, install missing browser system libraries or set `PUPPETEER_EXECUTABLE_PATH`.
- **No contacts/groups:** connect the account successfully, then click Sync contacts. API commands enqueue asynchronous jobs; watch the worker terminal.
- **Campaign has zero recipients:** set verified opt-in consent for individuals, or authorize selected group announcements.
- **Scheduled campaign did not send:** check Redis, the worker terminal, session status and campaign status. A disconnected session cannot send.
- **Session logs out repeatedly:** persist `SESSION_DIR` between worker restarts and keep your WhatsApp Web dependency compatible with the current WhatsApp Web build.

## License and responsibility

You are responsible for applicable privacy/marketing laws and WhatsApp's terms. Do not scrape group members for unsolicited outreach. The official WhatsApp Business Platform is preferable for sustained commercial messaging.
