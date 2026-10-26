# Local verification

Verified on 25 October 2026 with Node.js 22.14, PostgreSQL 18, Redis 7.4.6 and headless Chromium.

| Check | Result |
| --- | --- |
| `npm run setup` | Passed, including repeated setup with persisted services |
| `npm run doctor` | Database/schema/admin, Redis, Chromium and web port passed |
| `npm ci --dry-run --offline --ignore-scripts --libc=glibc` | Lockfile consistency passed |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | 18 tests passed |
| `npm run build` | Passed; all authenticated API routes remain dynamic |
| `npm run test:integration` | Passed with isolated PostgreSQL schema, real Redis queues and real Chromium |
| Live worker/WhatsApp startup | Authenticated health check, both worker queues, real WhatsApp QR generation and disconnect passed |

The integration check covers authentication/cookies, cross-origin protection, offline-worker errors, contact import/consent, atomic multi-segment add/move/remove, directory-filter selection, inline segment creation, shared audience membership, attachment validation, draft editing, cross-account contact delivery (group targets still require account access), recipient deduplication, future schedules, cron timezones, pause/resume/cancel, uncertain-send recovery, failed-run reporting, STOP suppression and receipt ordering. The browser covers all eight views, composer search/pagination, sender-independent contact and segment selection, audience/timing preview, saving 602 group members into multiple segments and bulk moving all matching contacts, persistent login, mobile layout, dialog keyboard dismissal and logout. Screenshots/logs are under the ignored `.local/verification/` directory. Test data is removed afterwards.

WhatsApp message transport is mocked in the integration test. Separately, the actual worker launched Chromium against WhatsApp Web, generated a real QR code and disconnected successfully; its temporary session was removed. Phone pairing, live contact/group discovery, a real incoming STOP and actual WhatsApp delivery/read acknowledgements require a linked account. No real messages were sent during verification. Use the live checklist in [TESTING.md](TESTING.md) after pairing.

## Dependency audit

The audited install has **0 critical, 11 high and 2 moderate advisories**, down from the supplied log's 2 critical, 14 high and 1 moderate. The remaining reports involve the WhatsApp/Puppeteer dependency chain (including its separate Zod dependency) and Vitest's development mock tooling. Root Zod, Prisma's merge utility and the vulnerable test worker pool were updated; regression tests pass. Resolving the remaining reports needs upstream changes or broader upgrades to the browser/test toolchain. Do not treat passing functional tests as a clean security audit.

## File launchers — 26 October 2026

`run.sh` provides a development/production menu. `run-dev.sh` starts development directly; `run-production.sh` builds and starts production, with `--skip-build` available for subsequent restarts. Setup creates an executable, trusted CampaignDesk shortcut on the Linux desktop when that folder is available. The scripts locate the project independently of the current working directory, start services, run preflight checks, start web plus worker and open the browser after both are ready. Ctrl+C/SIGTERM stops their web and worker processes and retains database services/data.

Verified shell/JavaScript syntax, desktop-entry validity, lint and TypeScript. Real launcher smoke checks use an isolated PostgreSQL schema and queue names, including launching wrappers from `/tmp`, authenticated API/worker health, shutdown and production browser login with secure cookies on localhost. The production build completed successfully. The development check uses an isolated copy so the existing development server can keep running.

## WhatsApp session recovery and discovery — 26 October 2026

The reported `Execution context was destroyed` crash came from an async SDK frame-navigation listener whose rejection escaped the worker. A versioned patch for pinned `whatsapp-web.js` 1.34.7 now uses navigation-aware waits, ignores iframe navigation, serializes reinjection, retries transient context failures and reports exhausted recovery to the owning session. Worker recovery retains the auth profile and does not retry message sends. Installation and worker startup apply the patch automatically.

Directory discovery now reads the required contact/group fields without the SDK's full business-profile/message serializers. Read operations wait for a connected store and retry navigation failures. Known phone mappings are deduplicated; unresolved private IDs retain a null phone number. Member sync refreshes only the selected group, preserving existing memberships when metadata cannot be fetched. The dashboard exposes queued/running/completed/failed sync results.

Verified:

- All 30 unit/regression tests, TypeScript and ESLint pass; the production build succeeds.
- `npm run test:whatsapp` passes against real WhatsApp Web and Chromium under Node.js 22.14.0 and 24.3.0: QR generation, two main-frame reloads and ignored iframe navigation. The temporary authentication profiles were removed.
- `npm run test:integration` passes: authenticated API → Redis queue/worker → Chromium discovery with synthetic WhatsApp collections → PostgreSQL → API sync result → dashboard. Repeated imports, private IDs, selected members, surfaced sync failures and successful retry were checked. Contact opt-out, posting permission and existing members survived the relevant syncs/failures.
- Production browser login, session cards and QR dialog pass without browser errors. Database, Redis and both worker queues are healthy. Lockfile dry-run and patch application pass.

The user's account was logged out before these fixes and currently awaits a QR scan. Importing that account's actual contacts/groups remains unverified until pairing. The directory integration uses synthetic browser data; real message transport remains untested. No real WhatsApp messages were sent.

## Save group members into Contacts — 26 October 2026

Groups now has **Save all to contacts**, progress per group, a saved-contact count and **View saved contacts**. The member preview offers the same save action. Saving reads all available participants and commits their contacts, membership and audit entry together; existing contacts are reused. The Contacts column describing the linked phone's address book is labeled explicitly.

TypeScript, ESLint, all 30 regression tests and the integration check pass. In Chromium, saving a synthetic group imported all **602 members**, while the member preview remained limited to 500. View saved contacts cleared unrelated search/consent/account filters and opened all 602 saved contacts in the correct group. Repeated saving produced no duplicates, retained an existing opt-out and posting permission, and handled unavailable metadata without replacing existing members. Disconnected accounts are rejected with a clear error. This verification used synthetic WhatsApp collections and an isolated database schema; it did not save the user's live group data or send messages.
