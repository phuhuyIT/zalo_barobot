# TASK LIST: Implementing the Zalo Squad Duty Schedule Sending System

> This file was split out from `SPEC_zalo_schedule_bot.md` (former section 9).
> Read the SPEC first to understand the context/architecture/rules, then use
> this file to implement it phase by phase.

## 9. Implementation task list (recommended order)

The order below prioritizes "can be tested independently as early as
possible" — once each phase is done, it can be run/tested right away,
without waiting for everything else to be finished.

**Phase 0 — Project initialization**
- [ ] Scaffold Node.js + TypeScript (tsconfig, eslint/prettier optional),
      folder structure following coding rule #6 (`config/`, `sheets/`,
      `formatters/`, `core/`, `channels/`, `store/`).
- [ ] `Dockerfile` that builds and runs a single Node process.
- [ ] `.env.example` (with no real values) listing the variables from
      section 7.

**Phase 1 — Reading & parsing the Google Sheet (no dependency on Zalo)**
- [ ] Google Sheets API client (reads a dynamic range, Viewer permission
      only).
- [ ] Parser for `header_style: two_row_merged` (main squad) — anchor on
      `"Ngày"` ("Date"), merge the 2-row header, forward-fill horizontal
      merges (section 2.1a).
- [ ] Parser for `header_style: single_row` (culi squad) — anchor on
      `"Ngày"`, no 2-row merging (section 2.1b).
- [ ] Parser for the "leave" (tranh thủ) schedule (section 2.2).
- [ ] Read the location/unit line (prefix `"Đơn vị:"` = "Unit:", section
      2.1).
- [ ] Unit test the parser with at least 2 different layouts/squads (rule
      #7).

**Phase 2 — Formatter (pure function, no dependency on Sheet/Zalo)**
- [ ] `gate_duty` formatter (daytime template, section 5.11).
- [ ] `gate_duty` formatter for night/overnight shifts (culi template,
      section 5.11).
- [ ] `gate_duty_patrol_only` formatter (shortened version for F7).
- [ ] `leave_roster` formatter (section 5.4).
- [ ] Snapshot unit test for each formatter.

**Phase 3 — Store (SQLite)**
- [ ] `last_message` table (most recent message_id by schedule_key + chat_id).
- [ ] `runtime_config` table (overrides for `sheet_tab_gate_duty`,
      `auto_send_time`, `enabled` — F9).
- [ ] `send_history` table (append log — F11).
- [ ] Shared `hasSentToday` / `markAsSent` functions for idempotency
      (F1, F6).

**Phase 4 — Zalo client (raw API, no business logic)**
- [ ] `sendMessage`, `deleteMessage` (best-effort, does not throw),
      `setWebhook`, `getMe`.
- [ ] Real test once with a real token: confirm whether `deleteMessage`
      actually works on the bot that was created (section 6.2) — record
      the result in the README.

**Phase 5 — Core: `send_schedule()`**
- [ ] Combine reader + formatter + store + zalo-client in the exact order
      given in section 4 (read config → build text → delete old message
      best-effort → send new message → save message_id → write to
      send_history).
- [ ] `resolve_lookup_date()` for squads with `overnight` (section 5.1).
- [ ] Idempotency check before sending automatically.
- [ ] Unit test the core with a fake/mock reader/formatter/zalo-client.

**Phase 6 — Channel: Web UI**
- [ ] Auth (basic auth or a simple password) for all of `/api` and the
      pages.
- [ ] Dashboard: status of the most recent send for each schedule + a
      button to resend each schedule individually (F2) — no combined
      "send all" button (rule #13); if there is a "send both" button,
      implement it as 2 sequential calls.
- [ ] Message preview page (F10, reusing the exact same text-building
      function as core).
- [ ] Configuration page: change the sheet tab / send time / enable-disable
      per squad/schedule (F9).
- [ ] Send history page (F11).
- [ ] A separate button to send the "leave" (tranh thủ) schedule (F5).

**Phase 7 — Channel: Zalo webhook**
- [ ] `/webhook/zalo` endpoint, authenticate the secret token via a header.
- [ ] Handle the `/gui` command: find every schedule whose recipient list
      includes the chat_id that sent the command, and call
      `send_schedule()` for each one (F3).

**Phase 8 — Channel: Scheduler**
- [ ] `node-cron` registers a job based on the current `auto_send_time` of
      each schedule (read from the store, with overrides from F9).
- [ ] `refreshSchedules()` — cancel and re-create jobs when the
      configuration is changed via the Web UI, without needing a restart
      (F9).
- [ ] Heads-up reminder job (before send time) + failure-alert reminder
      job (after the deadline) — section 5.5, sharing the same idempotency
      function as F1.
- [ ] `/internal/run-due-jobs` endpoint (second layer of protection for the
      Railway Cron Job, section 6.3), calling the same idempotent logic as
      the internal job.

**Phase 9 — Finishing touches & deployment**
- [ ] README: how to set up the Google service account, get the chat_id,
      configure the webhook, and how to add a new schedule/squad (with a
      concrete example).
- [ ] Deploy to Railway: attach a Volume, declare all env vars, create a
      Railway Cron Job that calls `/internal/run-due-jobs`.
- [ ] Register the real webhook on bot.zapps.me pointing to the Railway
      domain.
- [ ] End-to-end manual testing: F1 (wait until the send time, or set the
      send time close to now to test quickly), F2, F3, F5, F9, F10, F11,
      both types of F6.
