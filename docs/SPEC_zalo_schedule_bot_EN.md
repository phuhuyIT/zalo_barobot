# SPEC: Automated System for Sending Squad Duty Schedules via Zalo

> This document is for a coding agent to read and implement. The stack has
> already been decided in section 1.1 — do NOT switch to a different stack
> unless section 1.1 says the agent is free to decide.
>
> **The phase-by-phase implementation task list lives in a separate file:
> `TASKLIST_zalo_schedule_bot.md`** — after finishing this SPEC (context,
> architecture, feature specs, coding rules), move to that file to see the
> order of work.

## 1. Overview & goals

The user (referred to as **Admin**) manages 2 military squads, each of
which has a daily gate-duty schedule stored on 1 shared Google Sheet. The
Admin needs an automated system that:

1. Every day, reads each squad's gate-duty schedule from the Google Sheet
   and sends it to that squad's correct Zalo group chat.
2. Lets the Admin resend the schedule at any time (when the schedule is
   edited on short notice) via 3 methods: a web button, a chat command in
   Zalo, or automatically at a scheduled time.
3. When resending, cleans up the old message (if the API allows it) so the
   group chat doesn't get cluttered.
4. Sends the "leave" (tranh thủ — who has returned, who hasn't) schedule
   whenever the Admin needs to, not on a fixed schedule.
5. Reminds the Admin via Zalo if the send time has passed and the schedule
   still hasn't been sent automatically (e.g. due to an error).
6. Is easy to extend: adding a new squad, a new type of schedule, or
   sending an existing schedule to a new recipient (e.g. sending the main
   squad's patrol shift to the platoon leader) — by editing **configuration**
   only, without touching the core code.

The Admin does **not** edit data through the bot — all schedule changes are
made directly on the Google Sheet, after which the Admin presses "resend."

### 1.1 Technical decisions (tech stack & deployment) — FINALIZED

Finalized so the agent can implement directly without re-deciding:

| Component | Choice | Why |
|---|---|---|
| Language | **TypeScript** (Node.js LTS, e.g. 20.x) | Matches the interfaces/data types the Admin already sketched out (DailyDuty, DutyTask, ScheduleConfig...) — use them directly, no need to translate into another language. |
| Backend framework | **Express** | Lightweight, enough for a few dozen internal endpoints, plenty of docs/examples. Fastify is also acceptable if the agent finds it more convenient, but Express is the default choice. |
| Scheduler | **node-cron** | Registers/cancels jobs dynamically at runtime (supports F9 — changing the send time without a restart), exactly as the Admin sketched out. |
| Storage | **SQLite** via `better-sqlite3` | A single file, no separate DB server needed, enough for a scale of a few dozen records per day. |
| Google Sheets API | npm package `googleapis` | Google's official client. |
| Calling the Zalo Bot API | `axios` or `fetch` (Node 20 has fetch built in) | Simple REST, no need for a dedicated SDK. |
| Frontend Web UI | Static HTML + Tailwind CSS (via CDN or a light build) + Alpine.js | Matches the direction the Admin already chose — no need for a heavy SPA framework for 1 internal admin page. |
| Testing | **Vitest** (or Jest if the agent is more familiar with it) | For the required unit tests in section 8, rule #7. |
| Packaging | **Docker** (a single Dockerfile running both the web server and the scheduler in 1 Node process) | Consistent deployment on any PaaS. |
| Hosting | **Railway** (top priority) | Has a Volume to persist the SQLite file across deploys, has its own Cron Jobs feature, and **does not auto-sleep** on the small paid tier (unlike Render's free tier, which sleeps — this matters because the `/gui` webhook must always be able to respond, it can't wait to "wake up"). |
| Hosting (backup option) | **Fly.io** | Use if Railway doesn't work out; also supports volumes + always-on. Don't use Render's free tier as the main option because of the risk that sleeping affects the webhook & internal cron (see section 6.3). |

## 2. Data source: Google Sheet structure

There is 1 shared Google Sheet with multiple tabs (each tab is 1 type of
schedule / 1 squad).

### 2.1 Gate-duty schedule tab (1 tab per squad)

> **Important — row/column numbers must NOT be hardcoded.** The main
> squad's gate-duty schedule changes fairly often: the shift structure
> (number of shifts, shift names, whether there's an "off" slot or not,
> etc.) can differ between periods. The actual convention:
> - When the **headquarters changes** (e.g. this month at HQ A, next month
>   at HQ B) → the Admin creates **a brand-new tab** (column structure,
>   number of header rows may differ from the old tab). The system must
>   detect the header position **dynamically** for each tab, and must not
>   assume a fixed "rows 4-5".
> - When there's only a small change within the same HQ (e.g. 1 "off" slot
>   changes to having someone on duty) → the Admin **edits the cell value
>   directly** on the tab currently in use, and the column structure
>   doesn't change. In this case **nothing extra needs to be handled**, as
>   long as the system re-reads the latest data every time it sends (it
>   does not cache sheet data between sends) — since this is essentially
>   just a change to the content of 1 cell.

**There are 2 different header layout styles depending on the squad** —
each squad declares which style it uses via the `header_style` field in
the config (section 5.7), so the parser can choose the right reading
strategy. Do NOT use a single hardcoded parser for every squad.

#### a) `header_style: two_row_merged` (main squad)

- There are 2 consecutive header rows that have been **merged**:
  - Most columns: merged vertically across the 2 rows (a single header,
    e.g. "Trực ban" — "Duty officer").
  - Some columns may be merged **horizontally** in header row 1 (spanning
    multiple columns), and then header row 2 has separate sub-headers for
    each sub-column (e.g. "Đi tuần" — "Patrol" — spans 2 columns, and the
    row below reads "Ca 1"/"Ca 2" — "Shift 1"/"Shift 2" — → combined into
    "Đi tuần - Ca 1", "Đi tuần - Ca 2").
  - Merging rule: if a header row 1 cell is empty (because it was
    horizontally merged from the column to its left), then "forward-fill"
    the nearest header row 1 value to the left so it combines correctly
    with the sub-header in header row 2 of that column. If a column that
    used to be horizontally merged (like "Đi tuần") is no longer split
    into Shift 1/Shift 2 for this period (header row 2 is empty) → keep
    the main header ("Đi tuần") as is, this is not treated as an error.
- **How to locate these 2 header rows (must be done dynamically, no fixed
  row numbers)**: scan from top to bottom, find the row that has 1 cell
  whose value exactly equals `"Ngày"` ("Date") (case-insensitive,
  whitespace-trimmed) — that is **header row 1**, and the column
  containing that cell is the **date column**. The row right below it is
  **header row 2**. Data starts on the row right after that. This is the
  only anchor point the parser is allowed to rely on — the Admin commits
  to keeping the `"Ngày"` label fixed on every new tab, even when the HQ
  changes.

#### b) `header_style: single_row` (culi squad)

- There is only **1 single header row** (no 2-row merging, no
  sub-headers like "Shift 1"/"Shift 2").
- Locating the header row: scan from top to bottom, find the row that has
  1 cell whose value exactly equals `"Ngày"` — that is the header row, and
  the column containing that cell is the date column. Data starts on the
  row right after that.
- The remaining columns in the header row = the names of the night
  shifts, read directly from the header (no need to merge 2 rows like in
  style a).
- A **separate parser** needs to be written for this style (do not reuse
  style a's 2-row-merging function), but still use the same `"Ngày"`
  anchor rule to locate the row/column — 2 different parsers, but the
  same anchoring principle.

#### Applies to both styles

- **Date column**: date format `dd/mm/yyyy`.
- From the first data row onward: each row = 1 day, each column (except
  the date column) = the name of the person assigned to the corresponding
  shift/task. The number of columns/shift names can genuinely differ
  between tabs — the parser must read the column list from that tab's own
  header row, and must not hardcode a list of shift names.
- **Location/unit line** (to display in the message, see section 5.11):
  look for a row ABOVE the header row that has 1 cell starting with the
  prefix `"Đơn vị:"` ("Unit:") (case-insensitive) — if found, take that
  cell's exact text as the location/unit label. If not found, skip it (it
  is not required).
- **Overnight shift**: the "culi" squad has a duty shift from 11 PM today
  to 5:30 AM the next day. The date recorded in the date column is the
  **start** date of the shift (today). When the system automatically
  sends at 5:30 AM, it must send the shift for **tonight, coming up**
  (the data in the row whose date = today), not the shift that just
  ended. See the date-resolving rule in section 5.1.

### 2.2 "Leave" (tranh thủ) schedule tab

- No fixed number of rows (the Admin arranges it manually according to the
  work situation, the system does not need to compute any rotation
  logic).
- Has 1 header row identified by: the first column = "Ngày" ("Date")
  (case-insensitive).
- Data rows below it, until a row that is completely empty is reached.
- The system only needs to read & display this table as-is, as an
  easy-to-read message — it does **not** need to compute who missed their
  turn — the Admin decides that themselves on the sheet.

> The agent needs to actually read 2-3 sample tabs (the Admin will provide
> them) before coding the parsing part, since the actual tab names & exact
> number of columns may differ from the examples above.

## 3. Feature list

| # | Feature | Triggered by |
|---|---|---|
| F1 | Automatically send each squad's gate-duty schedule to its own group | Daily cron (configurable time) |
| F2 | Resend today's schedule for a specific squad | Web button |
| F3 | Resend today's schedule for a specific squad | Chat command in the Zalo group (e.g. `/gui`) |
| F4 | Delete the old schedule message before sending a new one (best-effort) | Automatic, every time F1/F2/F3 runs |
| F5 | Send the "leave" (tranh thủ) schedule when needed (not on a fixed schedule) | Web button or chat command |
| F6 | Remind the Admin via Zalo — **2 types**: (a) 1 hour before the automatic send time ("1 hour left until it auto-sends"), (b) after the deadline has passed and it still hasn't been sent (error report) | Internal cron, checks periodically |
| F7 | Send an existing schedule to a different recipient, in a different format (e.g. a summary of the patrol shift for the platoon leader) | Configuration, shares the same engine as F1-F3 |
| F8 | Add a new squad / schedule type / recipient just by editing config | N/A (architectural requirement) |
| F9 | Change the Google Sheet tab / auto-send time / enable-disable for a squad WITHOUT redeploying code | Web UI (same page that has the send-schedule button) |
| F10 | Preview the content of the message that will be sent (without actually sending it) | Web UI |
| F11 | View the history of recent sends (time, schedule type, group, result) | Web UI |

**Hard constraint for every send feature:** each send only goes to **1
group/recipient at a time** — sends must not be batched to multiple groups
in a single call (even when triggering 2 squads at the same time, it must
be 2 independent send calls one after another, not 1 broadcast).

## 4. System architecture

```
                +-------------+
                | Google Sheet |  (data source, read-only)
                +------+------+
                       | read via Sheets API
                       v
   +---------------------------------------+
   |           SHEET READER LAYER          |  1 module per tab type
   |  (gate_duty_reader, leave_reader, ..) |
   +-----------------+---------------------+
                      v
   +---------------------------------------+
   |            FORMATTER LAYER            |  1 formatter per type,
   |   (formats the Zalo message text)     |  registered by "type"
   +-----------------+---------------------+
                      v
   +---------------------------------------+
   |         CORE: send_schedule()         |<---- THE ONLY PLACE that
   |  - gets config by schedule_key        |      handles sending +
   |  - calls reader + formatter            |      deleting old messages.
   |  - deletes old message (best-effort)   |      EVERY trigger channel
   |  - sends new message, saves message_id |      calls into here, no
   +-----------------+---------------------+      duplicate send logic
                      v                            written elsewhere.
   +---------------------------------------+
   |            ZALO BOT CLIENT            |  sendMessage / deleteMessage
   +---------------------------------------+

"Trigger channels" (all of them only call send_schedule(schedule_key, recipient)):
  - Cron job (F1, F6)
  - Web endpoint with a button, with auth (F2, F5)
  - Webhook receiving chat commands from Zalo (F3, F5)
```

**Small data store (key-value or SQLite, no need for a heavy DB)** stores:
- The most recent `message_id` sent, by `(schedule_key, chat_id)` → to
  delete the old message (this table is OVERWRITTEN each time a message
  is sent, it only keeps the latest value).
- The time of the most recent successful send, by `(schedule_key,
  chat_id)` → so F6 (reminders) knows whether it has already sent today,
  to avoid duplicate sends when the cron runs multiple times.
- Runtime overrides for `sheet_tab_gate_duty` / `auto_send_time` /
  `enabled` per squad or schedule (F9, section 5.8).
- **A separate append-only log table** for send history (F11, section
  5.10) — very different from the 2 "latest value" tables above; this
  table ACCUMULATES over time.

## 5. Detailed spec for each feature / use case

### 5.1 F1 — Automatically sending the gate-duty schedule

- Input: `schedule_key` (identifies the squad + sheet tab + recipient),
  scheduled time (e.g. "05:30").
- Logic for determining which date's data to fetch
  (`resolve_lookup_date`):
  - Regular squad: `lookup_date = today`.
  - Squad with an overnight shift (`overnight = true`, with its own
    `cutover_time`, e.g. "05:30"): if the current time < cutover_time →
    `lookup_date = yesterday`; otherwise → `lookup_date = today`.
- Concrete use case: 5:30 AM on Tuesday, culi squad → current time
  (05:30) is NOT less than the cutover (05:30) → `lookup_date = Tuesday`
  → the correct shift is Tuesday night (11 PM) - Wednesday morning
  (5:30 AM), which is coming up. This is the intended, correct behavior.
- If no data row is found matching `lookup_date` → do not send an empty
  message, log a clear error (e.g. report to the Admin via the
  log/reminder channel), and must not crash the entire job (other squads'
  jobs must still run).
- Idempotency is mandatory: if the cron runs multiple times within the
  same time window (e.g. due to a restart), it must **not send
  duplicates** on the same day for the same `schedule_key` + `chat_id` —
  check the store before sending.

### 5.2 F2/F3 — Resending the schedule on request (web / chat command)

- Both call the same `send_schedule()`, they only differ in where they're
  triggered from.
- F2 (web): has a separate button for **each** schedule/squad (not 1
  "send all" button). The web page must have authentication (basic auth
  or equivalent) since this is an action that can send a real message to
  a group.
- F3 (chat command, e.g. `/gui`): determine the `chat_id` of the group
  that sent the command, find every `schedule_key` that has that group in
  its recipient list, and resend exactly the schedules related to that
  group (do not send another group's schedule).
- No need for complex permission logic for the chat command (whichever
  group types the command receives that group's schedule back — that is
  enough, per the Admin's requirement).

### 5.3 F4 — Deleting old messages

- **Known risk**: it has not been confirmed for certain whether the Zalo
  Bot API supports `deleteMessage` (the documentation is not as clear as
  the Telegram Bot API's).
- The code must: attempt to call `deleteMessage`, and if it errors/is not
  supported → log a warning and **continue sending the new message
  normally** (do not raise an exception that interrupts the send flow).
  This is not a "must work" feature, it's a "try if possible" feature.
- Save the new `message_id` to the store AFTER the new message is
  successfully sent, even if deleting the old message failed.

### 5.4 F5 — "Leave" (tranh thủ) schedule

- No automatic cron, no `auto_send_time`.
- Only triggered via web or chat command, using the same
  `send_schedule()` engine with `type = leave_roster`.
- The formatter only needs to display the data table read from the sheet
  (section 2.2) as easy-to-read text, with no extra business logic
  (computing turns, rotation) — the data on the sheet is already a
  "finished product" arranged by the Admin.

### 5.5 F6 — Reminding the Admin (2 types, sharing 1 duplicate-prevention mechanism)

There are 2 types of reminders, with **different purposes**, both sent to
the Admin's `chat_id` (different from the squad's group), and both only
remind **once per day per schedule_key** (to prevent spam if the checking
job runs every minute):

**a) Reminder BEFORE the send time ("heads-up")** — purpose: remind the
Admin there's still time to fix the sheet before the system auto-sends.
- Configuration: each schedule has an `auto_send_time`, remind 1 hour
  before it (default — the number of minutes can be configured
  differently if needed).
- Sample content: `"⏰ 1 hour left until the system automatically sends
  the [label] schedule. Expected send time: HH:MM"`.
- If the reminder time coincides with or falls after the auto-send time
  (e.g. auto_send_time is too early, less than 1 hour after the job
  starts) → automatically skip it, don't remind.

**b) Reminder AFTER the deadline has passed without a successful send
("failure alert")** — purpose: detect a problem (the automatic job
failed, an error reading the sheet, etc.).
- Separate configuration: `(schedule_key, remind_if_not_sent_by:
  "HH:MM")`.
- A job runs periodically (e.g. every 1-5 minutes), and checks: if the
  scheduled time has passed and `schedule_key` has no "sent today" record
  in the store → send a warning message to the Admin.
- Only remind within a short window after the deadline (e.g. 10 minutes)
  and then stop, do not repeat all day.

Both types share the same "has it been sent today" checking function
(already built for F1's idempotency) — do not write a separate
duplicate-checking logic.

### 5.6 F7 — Sending an existing schedule to a different recipient, in a different format

- Sample use case: send the main squad's "patrol" section (extracted from
  the same gate-duty schedule tab) to the Platoon Leader, as a shortened
  message (only 2 lines, "Patrol - Shift 1/2", without printing the other
  shifts).
- Architectural requirement: this must be handled by **adding 1 new
  configuration entry** (same squad, a different formatter type, a
  different recipient), *not* by writing a separate new processing flow.
  A new formatter (if a different format is needed) is written as 1
  standalone function, registered into the registry by `type`.

### 5.7 F8 — Extending via configuration

The configuration (a YAML/JSON file, not hardcoded in the code) must be
able to describe:

```yaml
squads:
  <squad_key>:
    display_name: "..."
    sheet_tab_gate_duty: "..."  # INITIAL DEFAULT value; may be overridden
                                 # by the Admin at runtime via the Web UI
                                 # (see F9, section 5.8) when the HQ
                                 # changes — the value actually in effect
                                 # lives in the store, not in this file,
                                 # after the first override.
    header_style: two_row_merged | single_row   # see section 2.1 — selects the parser
    overnight: true|false
    cutover_time: "HH:MM"      # only needed if overnight = true

recipients:
  <recipient_key>: "<chat_id, taken from an environment variable>"

schedules:
  - key: <schedule_key>      # A FREE-FORM STRING, not a fixed union —
                              # see coding rule #10 (no hardcoded unions)
    label: "..."
    squad: <squad_key>          # optional, depending on type
    type: <formatter_type>       # e.g. gate_duty, gate_duty_patrol_only, leave_roster
    recipients: [<recipient_key>, ...]
    auto_send_time: "HH:MM" | null   # DEFAULT value; may be changed by
                                       # the Admin at runtime via the Web UI
                                       # (F9, section 5.8)
    enabled: true|false               # turns automatic sending on/off, changeable at runtime

reminders:
  - schedule_key: <schedule_key>
    remind_before_send_minutes: 60       # type (a) — heads-up, see 5.5
    remind_if_not_sent_by: "HH:MM"       # type (b) — failure alert, see 5.5
```

Adding a new squad / schedule type / recipient must NOT require changing
the core code (`core`/`send_schedule`), only adding a configuration entry
+ (if needed) 1 new formatter or 1 new sheet-reader for an entirely new
type of data.

### 5.8 F9 — Editing operational configuration via the Web UI, without redeploying

- Context: there are 2 kinds of changes the Admin needs to make
  **frequently**, which shouldn't require editing a static config file +
  redeploying every time (both slow and requires technical knowledge):
  1. Changing which Google Sheet tab is used for a squad (when the HQ
     changes).
  2. Changing the auto-send time (`auto_send_time`) or turning automatic
     sending on/off (`enabled`) for a schedule (the "Configuration"
     section in the Web UI).
- Requirement: both of the above types of values must be **runtime
  configuration, editable via the web interface** (the same page that has
  the "resend schedule" button), not hardcoded constants baked into the
  deployed code.
  - Stored in the store (SQLite or equivalent) instead of only being read
    once from the YAML file at startup. The YAML file is still used as
    the **initial default value**; the value in the store (if present)
    will **override** the default value.
  - Web UI — "Configuration" section: 1 input field "Google Sheet tab
    name currently used for [squad]", and for each schedule: an
    hour:minute auto-send time + an on/off toggle. Submitting saves
    immediately, with the same authentication as F2 (not public).
  - If the system uses an internal scheduler that "registers jobs by
    time" (see section 6.3), changing the send time must take effect
    **immediately** (cancel the old job, create a new job at the new
    time) — without needing a process restart. If it uses the "external
    cron calling an endpoint every few minutes" approach (also in section
    6.3), this is naturally already correct, since every call reads the
    latest `auto_send_time` value from the store — no extra "refresh"
    mechanism needed.
- No need to validate that the tab name actually exists at submit time
  (to keep things simple) — if the Admin types the wrong tab name, the
  next schedule send will report a clear error, "tab not found" (per the
  error-handling rule in section 5.1), and the Admin can just fix it.

### 5.9 F10 — Message preview

- Web UI: the Admin selects 1 schedule → the system reads the sheet +
  formats it (the exact same message-building flow as when actually
  sending) → displays the resulting text on the page, **without calling
  the Zalo API, without deleting/saving any message_id** (this action is
  read-only, safe, no side effects).
- There is a "Copy" button for the content, and a "Send now" button right
  next to the preview (pressing "Send now" actually triggers F2 for that
  exact schedule).
- Reuse the exact same message-text-building function that
  `send_schedule()` uses internally (do not write separate formatting
  logic for the preview) to guarantee the preview is 100% identical to
  what will actually be sent.

### 5.10 F11 — Send history

- Purpose: lets the Admin quickly review recent sends (to debug when
  someone reports "I didn't see today's schedule").
- Requires an additional **append-only log table** in the store
  (different from the "most recent message_id" table in section 4 — that
  table is overwritten every send, it doesn't keep history). Each send
  (successful or failed) adds 1 row:
  `(timestamp, schedule_key, chat_id, result: success/failure, error if any, whether the old message was deleted)`.
- The Web UI displays this as a table, most recent first, limited to
  showing e.g. the most recent 50 rows (no need for complex pagination).
- There's no requirement to keep the log forever — the number of rows
  kept in the store can be capped (e.g. keep only the most recent
  200-500 rows) to avoid the data growing too large.

### 5.11 Message format standard (Message Formatter)

Applies to every `gate_duty`/`gate_duty_patrol_only` formatter (not
required for `leave_roster`, which only needs to display the raw table
as-is — section 5.4).

**Template for a squad with a same-day shift (not overnight):**
```
📢 Gate duty schedule for 05/09/2026
Squad 2 - Platoon 1              <- location/unit line if present (section 2.1)

🔹 Shift 1 (05:30 - 06:00) + dormitory sweep: Nguyễn Văn A
🔹 Shift 2 (06:00 - 07:00): Trần Văn B
🔹 Patrol - Shift 1: ...
🔹 Patrol - Shift 2: ...
🔹 Duty officer: ...
```

**Template for a squad with an overnight shift (culi) — adds a time-range note line:**
```
📢 Night gate duty schedule for 05/09/2026
Culi squad - Platoon 1
(Time: 11:00 PM on 05/09 → 5:30 AM on 06/09)

🔹 Shift 1 (11 PM - 1 AM): ...
🔹 Shift 2 (1 AM - 2:15 AM): ...
```

**Rules:**
- Each task is on its own line, starting with `🔹`, in the same column
  order as in the sheet.
- Skip (do not print) any task whose value is empty/contains only
  whitespace.
- If there are NO tasks left with a value (all of them are empty) →
  return the text `"No gate-duty schedule data for dd/mm/yyyy"` instead
  of an empty message.
- The formatter is a **pure function**: it receives already-parsed data
  (date, unit, task list) and returns a `string`; it does not call the
  Zalo API or the Google Sheets API itself — to make it easy to test and
  to let F10 (Preview) reuse it.

## 6. External integrations

### 6.1 Google Sheets

- Only read access is needed (read-only). Use a Service Account, share
  the sheet with the service account's email with Viewer permission.
- Read by tab name + dynamic range (no hard limit on the number of rows,
  since the data keeps growing over time).

### 6.2 Zalo Bot Platform

- The bot has already been created on bot.zapps.me, **and it has been
  confirmed that it can be added to a group and has a `chat_id`** — no
  need to worry about this platform's limits anymore.
- APIs needed: `sendMessage`, `deleteMessage` (best-effort, see 5.3),
  `setWebhook` (to receive chat commands for F3).
- The webhook endpoint must authenticate using its own secret token (a
  header sent by Zalo with each request).

### 6.3 Hosting & Cron

- Hosted on **Railway** (see 1.1). Attach 1 **Volume** to mount to the
  folder containing the SQLite file (e.g. `/data/app.db`) — do not leave
  the DB in the container's temporary filesystem, or data will be lost on
  every redeploy.
- **Important constraint**: even though Railway's paid tier doesn't
  auto-sleep, F1/F6 must still be designed so they don't depend 100% on 1
  continuously-running background process — also use a **Railway Cron
  Job** (the platform's own feature) to call a protected internal
  endpoint (e.g. `POST /internal/run-due-jobs`) every 5 minutes as a
  second layer of protection, in parallel with `node-cron` running inside
  the main process. Both call paths go into **the same function** that
  checks "which jobs are due and haven't run yet, run them" (idempotent
  based on the store — coding rule #4), so that duplicate sends never
  happen even with 2 trigger sources.
- If later switched to Fly.io (backup option): use Fly Machines in a mode
  that always keeps at least 1 instance running
  (`min_machines_running >= 1`) + an equivalent volume, and Fly Scheduled
  Machines instead of the Railway Cron Job.

## 7. Non-functional requirements

- **Security**: the web UI's send buttons must be authenticated; the
  webhook must authenticate via a secret token; do not hardcode
  tokens/chat_ids/credentials in the code — all of it through environment
  variables; do not commit a file containing real secrets to git (provide
  a `.env.example` template file with no real values).
- **Logging**: every send/delete of a message (whether successful or
  failed) must clearly log the `schedule_key`, `chat_id`, and the result —
  enough to debug when the Admin reports "I didn't see the schedule
  today."
- **Error handling**: an error in 1 schedule/1 recipient must not crash
  or block the processing of other schedules/recipients in the same
  batch.
- **UX**: the result of a send (success/error) must be displayed back to
  the Admin right away, on the channel they just triggered it from (web:
  show a notification on the page; chat command: a text reply is not
  required if the schedule message itself being sent out already serves
  as confirmation).

## 8. Coding rules

1. **Clear separation of layers**, per section 4: sheet-reader /
   formatter / core-send / trigger channel (web, webhook, cron) — do not
   let 1 file do multiple jobs.
2. **Do not hardcode** the squad, tab name, chat_id, or send time in the
   code — all of it through the configuration file (section 5.7) + environment
   variables for sensitive parts.
3. **A single point of sending**: every trigger channel must call into the
   same central function (something like
   `send_schedule(schedule_key, recipient_key=None)`). Do not copy-paste
   the send+delete logic in multiple places.
4. **Idempotent per day**: every automatic send operation must check
   "has it already been sent today" before sending, based on the store,
   not based on an assumption that the job only ever runs exactly once.
5. **A partial failure must not break the whole thing**: use try/except
   around the smallest independent unit of work possible (each schedule,
   each recipient), log the error, and continue with the rest.
6. **Do not hardcode the row/column position of the gate-duty schedule
   sheet.** The position of the 2 header rows and the date column must be
   determined dynamically by finding the cell with the value `"Ngày"`
   (section 2.1) — applied the same way the "leave" schedule parser
   already does (finding the row whose first column = "Ngày"). This is
   mandatory because the main squad's sheet structure changes with every
   period/HQ.
7. **Testing is mandatory** for every part that does **data parsing** and
   **message formatting** (this is pure logic, easy to test, easy to get
   wrong, and hard to catch if not tested):
   - Test merging the 2-row header (including the "Đi tuần"
     ("Patrol") horizontal-merge case).
   - Test dynamically detecting the header/date-column position with at
     least 2 different tab layouts (different number of columns,
     different header row position) to prove nothing is hardcoded.
   - Test date resolution for a squad with an overnight shift
     (before/after the cutover).
   - Test the "leave" schedule parser with a table whose number of
     rows/columns changes.
   - Test that the formatter produces the exact expected text (string
     match or snapshot).
   - Testing the actual API calls (Google Sheets, Zalo) is not required —
     use mocks/stubs for these tests.
8. **Comments/docstrings in Vietnamese** at places containing important
   business assumptions (sheet structure, the overnight-shift rule,
   fallback behavior when deleting a message fails) — since these are
   business decisions, not something obvious from the code.
9. **Suggested folder structure** (the agent may rename things as long as
   the layer separation is kept): `config/`, `sheets/` (reader),
   `formatters/`, `core` (send_schedule), `channels/` (web, webhook, cron),
   `store` (stores message_id + send history, + runtime overrides for
   `sheet_tab_gate_duty` per F9).
10. **A README is mandatory** with the code: instructions for setting up
    the Google service account, getting the chat_id, configuring the
    webhook, deploying, and how to add a new schedule/squad (with a
    concrete example).
11. **Do not use a fixed union/enum for the schedule/schedule-type
    identifier** (e.g. a type like `"main" | "culi" | "tranh-thu"`). This
    identifier (`schedule_key`) must be a free-form string read from the
    config — using a fixed union would mean that adding a new
    squad/schedule requires changing the code again, which directly
    violates rule #2 and F8. Similarly, the auto-send-time configuration
    must not be a fixed object with fields
    `{ main: {...}, culi: {...} }`, but must be a dynamic map/list keyed
    by `schedule_key`.
12. **The message-sending layer (Zalo client / "ZaloService") must not
    call the Formatter itself.** The business-level send function
    (equivalent to `sendDutyMessage`) should only receive **already
    formatted text**, not receive raw data and format it internally —
    calling the Formatter is the responsibility of the `core`/
    `send_schedule()` layer (section 4), keeping the boundary between
    "calling the API" and "business logic" as defined.
13. **The "send to multiple groups at once" action on the UI** (e.g. a
    "Send both squads" button) is only a display convenience — internally
    it MUST be carried out as multiple independent, sequential
    `send_schedule()` calls, not combined into 1 broadcast call
    (maintaining the hard constraint from section 3).

## 9. Things that need Admin confirmation/input before or during coding

- The real tab names currently in use on the Google Sheet at the time
  coding is finished (only needed to set the initial default value —
  after that, the Admin will change it themselves via the Web UI per F9
  when needed, no need to ask the agent again).
- Confirmation of whether `deleteMessage` actually works on the bot that
  was created (quick test by calling it once — see Phase 4 in
  `TASKLIST_zalo_schedule_bot.md`).
