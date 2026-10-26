# Persistent WhatsApp worker

Run this separately from the Next.js web/API server using `npm run worker` or `npm run dev:all`.
It owns Puppeteer/Chromium sessions and two BullMQ execution loops: session/sync commands and serialized campaign delivery. Session controls remain available while campaigns send.

Session credentials reside in SESSION_DIR and must never be checked into Git.
Requires PostgreSQL, Redis, and a Chromium/Puppeteer-compatible environment.
Run `npm run setup` once and `npm run doctor` to diagnose missing configuration or services. Redis 6.2+ is required; setup provisions Redis 7.4.6 when the system version is too old.
Connection, authentication, QR generation, sync and delivery events are asynchronous; use the dashboard to monitor them.

WhatsApp navigation is guarded by the versioned SDK patch in `patches/`. Installation and worker startup apply it with `patch-package`; keep the SDK pinned until an upstream fix is verified. Main-frame reloads serialize injection and retry destroyed contexts. Iframe navigation is ignored. Browser failures reconnect up to three times without terminating the worker; genuine logout requires pairing again. Recovery closes Chromium without deleting its live authentication profile.

Directory sync reads the required fields directly from WhatsApp collections, avoiding full business-profile/message serialization. It waits for a connected store and retries navigation failures for reads only. Private `@lid` contacts remain discoverable without inventing phone numbers. Member sync refreshes only the selected group; a failed metadata fetch keeps existing members. Sync preserves consent and posting permission. Sessions display queued/running/completed/failed results for 24 hours; completed and failed operations are also audited.

Groups → **Save all to contacts** queues the existing member-discovery operation through `/api/v1/groups/:id/save-contacts` (`sync-members` remains supported). The action saves every available participant into the shared Contacts directory, regardless of the member preview's 500-record limit. Contacts, membership and the audit entry commit together; repeated saves reuse contacts and preserve consent. Each group displays its own progress and saved count, with a link to the filtered Contacts view. The phone address-book flag continues to describe the linked phone's existing contacts.

`npm run test:whatsapp` verifies real QR generation, two reloads and iframe handling in an isolated temporary profile, then runs directory/member discovery with synthetic browser data. It does not pair your account or send messages. `npm run test:integration` also verifies API → queue → Chromium discovery → PostgreSQL → API sync status in an isolated database schema.

Messages go only to explicitly opted-in individual contacts or groups granted posting permission. The platform does not turn discovered group membership into direct-marketing consent.

Pausing stops before the next recipient. Resuming queues a new execution and skips recipients already attempted by a one-off campaign. Interrupted sends become UNKNOWN for manual reconciliation. Failed prerequisites create a failed run instead of leaving the report empty. SIGINT/SIGTERM closes both workers, browser clients, Redis connections and Prisma once.


Segments are shared across source sessions. `save-contacts` accepts multiple `segmentIds`; all discovered contacts and destination memberships commit together. Contacts keep source provenance, while campaign delivery deduplicates by phone destination. Consent edits and inbound STOP suppressions apply across all known records; inbound STOP also creates a suppression record if the receiving session had no contact yet.

Campaign jobs carry the launch/resume revision so old queued jobs cannot send after a lifecycle change. The delivery queue has global concurrency 1. Each campaign uses its chosen message interval (default 5 seconds) with `SEND_INTERVAL_MS` as a minimum. Recurring cadence is checked against estimated audience duration at launch/resume and again during execution. A recurrence overlapped by a previous run is skipped. Prerequisite errors persist on the run and pause the campaign for review. Updating the schema and restarting the worker is required after upgrading.


Session restoration uses the same project-relative storage in development, production and direct worker launches, even when launched from another working directory. On Linux, a kernel ownership lock permits one worker per auth directory. Startup restores connected/in-progress sessions and previously paired error sessions with saved profiles; explicit disconnects and genuine logouts remain off. Transient transport disconnects recover with the existing login.

Chromium may shorten its `/proc` command line, hiding the profile argument. Both launcher shutdown and per-session recovery verify the SingletonLock PID against open profile descriptors. Only a proven orphan is reclaimed; a browser owned by another live worker or an unverified/foreign lock is preserved and reported. Recovery removes only stale Singleton links, never LocalAuth credentials, IndexedDB, contacts or segments. Browser handles are retained before page initialization so a failed setup can close the browser. SIGINT, SIGTERM and terminal SIGHUP all run cleanup.

`tests/session-profile.test.ts` checks stale/foreign/unrelated locks, exclusive ownership, startup decisions and a real Chromium orphan/reopen cycle with preserved IndexedDB. It never loads WhatsApp or sends messages.
