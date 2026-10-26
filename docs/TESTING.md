# Verification

Run `npm ci`, `npm run setup`, then:

```bash
npm run doctor
npm run typecheck
npm run lint
npm test
npm run build
npm run test:integration
npm run test:whatsapp
```

The integration check uses an isolated PostgreSQL schema and queue names and removes them on completion. It covers real authenticated HTTP requests, Prisma/PostgreSQL data, BullMQ/Redis scheduling and browser navigation at desktop/mobile widths. WhatsApp sends and session commands use a test transport; screenshots/logs are in `.local/verification/`. No real messages are sent. A linked phone is required for the live checks below.

Directory tests execute discovery in real Chromium with synthetic WhatsApp collections, through the API and Redis worker into PostgreSQL. They cover repeated sync, private LIDs, selected membership, sync status and preservation of consent/posting permission. `test:whatsapp` separately opens the real WhatsApp website with an isolated temporary profile, generates QR codes and forces two reloads; it also checks that iframe navigation does not reinject the session. The test never uses your existing authentication profile.

# Live acceptance checklist

## One-time startup
- [ ] `npm run setup` starts PostgreSQL and Redis through Docker or the native backend; `npm run doctor` succeeds.
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
- [ ] Choose one group, sync its members, verify no other group members were imported; anonymous LIDs do not become phone numbers.
- [ ] Groups → Save all to contacts saves all available participants, including groups larger than the member preview; View saved contacts opens the correct filtered directory. Saving again does not create duplicates or change consent.
- [ ] Save manually recorded opt-in; send a STOP reply from the contact and verify OPTED_OUT.
- [ ] Create a list from selected contacts; it can be targeted in a campaign.

## Campaigns
- [ ] Create/save draft for opted-in contacts, attach a small image/PDF, preview recipients, edit the draft and launch once.
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
