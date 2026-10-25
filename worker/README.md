# Persistent WhatsApp worker

Run this separately from the Next.js web/API server using `npm run worker` or `npm run dev:all`.
It owns Puppeteer/Chromium sessions and the BullMQ execution loop.

Session credentials reside in SESSION_DIR and must never be checked into Git.
Requires PostgreSQL, Redis, and a Chromium/Puppeteer-compatible environment.
Connection, authentication, QR generation, sync and delivery events are asynchronous; use the dashboard to monitor them.

Messages go only to explicitly opted-in individual contacts or groups granted posting permission. The platform does not turn discovered group membership into direct-marketing consent.
