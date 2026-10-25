# Local acceptance checklist

## One-time startup
- [ ] Docker Compose starts PostgreSQL and Redis; `npm run db:push` succeeds.
- [ ] `npm run db:seed` provisions admin; incorrect password is rejected.
- [ ] Dashboard navigation works at desktop and mobile widths; signed-out API endpoints return 401.
- [ ] Browser auth persists a refresh, and logout invalidates the cookie.

## Session lifecycle
- [ ] Add a session, connect it; QR appears and updates if expired.
- [ ] Scan QR on WhatsApp phone; status becomes CONNECTED and phone number appears.
- [ ] Sync brings contacts and groups into the database.
- [ ] Disconnect / reconnect does not lose persisted authentication.
- [ ] Restart worker: previously connected sessions restore.

## Audience
- [ ] Imported numbers start as UNKNOWN, even if present in groups.
- [ ] Toggle group posting permission; only enabled groups appear in the campaign composer.
- [ ] Review actual group participants; anonymous LIDs do not become phone numbers.
- [ ] Save manually recorded opt-in; send a STOP reply from the contact and verify OPTED_OUT.
- [ ] Create a list from selected contacts; it can be targeted in a campaign.

## Campaigns
- [ ] Create/save draft for opted-in contacts, preview recipients, launch once.
- [ ] Create a group announcement draft and verify it addresses groups, not member DMs.
- [ ] Create a future one-time schedule and a recurring cron schedule.
- [ ] Pause or cancel a recurring schedule and verify no further sends.
- [ ] Disconnect session, launch and verify error handling; no silent duplicate sends.
- [ ] Inspect run history; sent and acknowledged messages have statuses.
- [ ] Repeat recipients in multiple lists; deduplication should send only one message per execution.

## Privacy and resilience
- [ ] Cross-origin mutation requests are rejected.
- [ ] Contacts without explicit consent are never sent marketing DMs.
- [ ] Opted-out contacts are not sent even if a campaign was already queued.
- [ ] A crashed or uncertain send is marked for manual review, not automatically repeated.
- [ ] Session credentials, .env and uploads are never committed.
