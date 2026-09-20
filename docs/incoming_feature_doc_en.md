# SPEC: Zalo Task Proof Bot

> This revision folds in every locked review decision (two group-ID
> namespaces, `/lienket`, local proof files, async QR login, `/dong` /
> `/huy`, `@all` reminders, Web UI settings). If it conflicts with an
> earlier draft, this document wins.

## 1. Purpose

This module tracks content-sharing tasks inside Zalo groups. A manager
assigns a task (a post to share, a required caption/keyword, a quota of
participants, and a deadline). Members share the post and send a
screenshot into the group as proof. The system verifies each screenshot
with OCR + fuzzy text matching, reminds members who have not submitted,
and once the quota is reached sends a completion report with every proof
image to a designated report group.

This module supersedes any previous screenshot-collection design based on
tagging or replying to the bot. It is not compatible with that design
and replaces it entirely.

## 2. System Architecture

The system is split into two independent roles:

| | Official bot (Zalo Bot Platform) | Background worker (zca-js) |
|---|---|---|
| Role | Single entry point for every command (`/task`, `/tasks`, `/nhac`, `/lienket`, `/dong`, `/huy`, plus commands from other modules); sends the completion report | Runs on demand: collects and verifies screenshots (OCR + matching), sends reminders with native @mentions, finishes `/lienket` by reading `threadId` |
| Availability | Always online (same service already used by other modules) | Logs in and listens only while at least one **linked** task is `collecting`/`overdue`, or a `/lienket` window / QR login is in flight; logs out when no work remains |
| Rationale | Official API, stable, no account-ban risk, the UI managers already use | Covers the two things the Official Bot Platform cannot do: read images without a mention, and real @mentions against a real member list. Staying offline when idle limits account exposure |

Both processes share one SQLite file (separate tables) on the **same
volume**. They do **not** share a Zalo transport — the two Zalo identities
are fully separate and never call each other's Zalo client. They
coordinate only through a small **bidirectional** internal HTTP API
(Section 10).

**v1 deploy (mandatory):** one container, two Node processes, one Railway
service, one volume mounted at `/data`. Do **not** split into two Railway
services while the store is a SQLite file — the second service cannot see
the first service's volume.

- Process 1 — official bot: Express + webhook + the existing scheduler.
  Always on. Owns schema migrations.
- Process 2 — `task-proof-bot` worker (zca-js). May sit idle / logged
  out. Reads `/data/app.db` (WAL), `/data/zca-session.json`,
  `/data/proofs/`.

Both identities must be members of the task group: the official bot to
receive commands, the secondary account to read images. The official bot
must also be a member of the report group or it cannot deliver the
report. The secondary account does not need to join the report group.

Using zca-js means driving a personal Zalo account through an unofficial
library. The account may be suspended. That risk is accepted for this
module.

### 2.1 Two group-ID namespaces (measured — they differ)

The Official Bot Platform `chat_id` is **not** the same value as zca-js
`groupId` / `threadId`. Every function must take the correct kind of ID.
One variable must never be reused for both clients.

| Name in this spec | Source | Used for |
|---|---|---|
| `official_chat_id` | Official-bot webhook when a command is typed in the group (same convention as `/gui`) | Receive commands, reply in-group, report fallback |
| `zca_group_id` | `message.threadId` / `GroupInfo.groupId` on the secondary account | Listen for images, OCR scope, mentions, member cache |
| `report_group_id` | `BaoCao:` parameter or the default setting | Send the report — this is an **official** chat_id |

The mapping lives in `group_id_map`, created by `/lienket` (Section 8.10)
or the Web UI. A task created before the map exists keeps
`zca_group_id` NULL; the worker must not OCR or remind that task until
it is linked.

T6 always `sendPhoto` / `sendMessage` with an official chat_id. The
worker always listens / mentions with `zca_group_id`.

### 2.2 End-to-end flow

```
[First time on each group]
Manager types /lienket inside the task group
        │
        ▼
Official bot records official_chat_id, calls
POST /internal/taskproof/link-group
        │
        ▼
Worker opens a 120s pending window; official bot asks the group
to send a plain "ok"
        │
        ▼
Worker sees the next group message → threadId = zca_group_id
        │
        ├─ UPSERT group_id_map
        ├─ UPDATE tasks.zca_group_id for that official_chat_id
        └─ POST /internal/taskproof/link-result → bot confirms in-group
   (alternative: /lienket <zca_group_id> writes the map immediately)


Manager types /task ... inside the task group
        │
        ▼
Official bot webhook receives the command
        │
        ├─ Inserts a new task (status=collecting, short_code, official_chat_id)
        │    zca_group_id = lookup group_id_map (may be NULL)
        └─ Calls POST /internal/taskproof/ensure-listening
           (returns immediately: listening | reusing_session | qr_required)
                │
                ▼
        worker (zca-js):
          - If not logged in: reuse the saved session, otherwise QR →
            official bot delivers QR to admin_official_chat_id
            (async, does not block the webhook)
          - Listen on every zca_group_id that has a linked open task

... while the task is collecting ...
        │
        ├─ A member posts an image → worker queues OCR + fuzzy match
        │  → on pass: write /data/proofs/{task_id}/ + a DB row
        │
        ├─ Manager types /nhac <short_code>
        │  → official bot resolves the exact short_code, calls remind
        │  → worker @mentions missing members (or @all if they do not
        │    fit in one message)
        │
        ├─ /dong <short_code> → status=completed, T6 still sends a
        │  report with whatever was submitted
        │
        ├─ /huy <short_code> → status=cancelled, no report, delete files
        │
        └─ /tasks → official bot reads the DB only, no worker call

... once required_count is reached (or /dong) ...
        │
        ├─ status=completed; the worker does not send the report
        ├─ if no linked collecting/overdue task remains, worker logs out
        ▼
Official-bot scheduler (same run-due-jobs pattern as the schedule
module) selects completed AND reported_at IS NULL. Sends images from
local files (URL only as fallback) + a summary to report_group_id,
falls back to the task group's official_chat_id, sets reported_at,
deletes /data/proofs/{task_id}/ immediately.
```

## 3. Dependencies

```json
{
  "dependencies": {
    "zca-js": "^2.1.2",
    "better-sqlite3": "^11.3.0",
    "tesseract.js": "^5.1.1",
    "string-similarity": "^4.0.4"
  }
}
```

`vie.traineddata` and `eng.traineddata` (Tesseract language data) must
live in the **worker process** working directory at runtime — bake them
into the Docker image/volume, not only the local dev tree.

Suggested layout (keep the schedule module's layering; do not dump this
into `channels/`):

```
taskproof/
  store.ts
  commands/          # parsers + handlers — run inside the official-bot process
  report.ts          # T6 — format text, call the existing Zalo client
  worker/
    index.ts
    session.ts
    listener.ts
    link.ts
    ocr.ts
    match.ts
    reminders.ts
    http.ts
```

The official-bot process must not import `zca-js`. The worker must not
call the Official Bot Platform API. The official bot sends already-formatted
text/photos through the existing Zalo client (same rule as schedule-module
coding rule #12). Do not route task-proof sends through `send_schedule()`.

## 4. Feature list

| # | Feature | Trigger | Owner |
|---|---|---|---|
| T1 | Create a new task | `/task` | Official bot inserts the row + `ensure-listening` |
| T2 | Verify a proof screenshot (OCR + fuzzy match) and store file + URL | Image in a **linked** group with an open task | Worker |
| T3 | List tasks and progress | `/tasks` | Official bot (DB only) |
| T4 | Remind members who have not submitted | Auto timer; `/nhac` | Worker (native mentions) |
| T5 | Close a task at quota; shut the worker down if idle | Automatic at `requiredCount` | Worker |
| T6 | Completion report with images + fallback group | Periodic scan `completed AND reported_at IS NULL` | Official bot |
| T7 | Internal coordination API | Official bot ↔ worker | Both (Section 10) |
| T8 | Persist the zca-js session; deliver a login QR to admin | When listening must start | Worker + official bot |
| T9 | Fetch and cache group members | Listener start / `/nhac` refresh | Worker |
| T10 | Map `official_chat_id` ↔ `zca_group_id` | `/lienket` | Official bot + worker |
| T11 | Close a task and still send a report | `/dong <short_code>` | Official bot (+ T6) |
| T12 | Cancel a task, no report, delete files | `/huy <short_code>` + stale job | Official bot + worker |
| T13 | Edit runtime settings without a redeploy | Web UI (same admin page as the schedule module, same auth) | Official bot writes DB; worker reads DB on each use |
| T14 | Scan recent group history for proofs posted before `/task` | `/quet <short_code> [count]` | Official bot + worker |

## 5. Configuration

Two layers — do not dump everything into a file or into env.

### 5.1 Secrets — environment variables only

Never shown on the Web UI, never written to the DB, never committed.

```
ZALO_BOT_TOKEN
INTERNAL_CRON_TOKEN          # protects internal endpoints + temp QR URLs
WEB_UI_USER / WEB_UI_PASSWORD
ZCA_SESSION_FILE_PATH=/data/zca-session.json   # path to the session file, not a uid
PROOF_DIR=/data/proofs
TZ=Asia/Ho_Chi_Minh
```

### 5.2 Operational settings — Web UI + DB table (T13)

Anything that can change between runs: group IDs, member IDs, report
group, exclude lists, OCR threshold, max mentions, and so on. **Do not**
put these in a YAML/JSON file on disk (editing a file on PaaS and
redeploying is painful, and secrets leak into artifacts).

Read order on every use (do not cache across requests for long):

```
DB value  >  in-code default
```

A YAML file, if present, only **seeds** empty keys once — same idea as
schedule-module F9. After the first Web UI save, the DB is the source of
truth.

Defaults when the DB is empty:

```ts
OCR_MATCH_THRESHOLD = 0.5;
DEFAULT_REQUIRED_COUNT = 1;
DEADLINE_CHECK_INTERVAL_MS = 60_000;
REMINDER_INTERVAL_MS = 3_600_000;
MAX_AUTO_REMINDERS = 3;
REPORT_POLL_INTERVAL_MS = 60_000;
QR_LOGIN_TIMEOUT_MS = 90_000;
MEMBER_CACHE_MAX_AGE_MS = 86_400_000;
MAX_MENTIONS_PER_MESSAGE = 8;
MAX_REMINDER_TEXT_LEN = 1500;
TASK_STALE_AFTER_MS = 604_800_000;   // 7 days
LINK_PENDING_MS = 120_000;
```

IDs stay empty on the UI until an admin fills them or runs `/lienket`:

- `admin_official_chat_id` — default-copy from the schedule module's
  `recipients.admin` if present; overridable
- `default_report_group_id` — official chat_id of the report group
- `official_bot_uid`
- `zca_own_uid` — may be auto-filled after `getOwnId()`, still editable
- `remind_exclude_uids` — csv / list
- group map: see `group_id_map` (edit on the UI or via `/lienket`)

`/task BaoCao:` still overrides `report_group_id` **for that one task**.
The default comes from `default_report_group_id`.

The worker and the official bot **read settings from the DB at handling
time**, not once at process start — a UI change takes effect on the next
run, with no restart.

## 6. Data schema

SQLite, WAL enabled. Same DB file as the rest of the project
(`/data/app.db`). **Only the official-bot process runs migrations** at
startup. The worker checks `PRAGMA user_version` and refuses to start if
tables are missing — it must not race `CREATE TABLE`.

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  short_code TEXT NOT NULL UNIQUE,          -- 6 chars [A-Z0-9], shown to managers
  official_chat_id TEXT NOT NULL,           -- group where /task was typed
  zca_group_id TEXT,                        -- NULL until /lienket succeeds
  report_group_id TEXT NOT NULL,            -- official chat_id of the report group
  link TEXT NOT NULL,
  reference_text TEXT NOT NULL,
  required_count INTEGER NOT NULL,
  deadline INTEGER NOT NULL,                -- epoch ms UTC; parse input in Asia/Ho_Chi_Minh
  status TEXT NOT NULL,                     -- collecting | overdue | completed | cancelled
  created_at INTEGER NOT NULL,
  reminded_at INTEGER,
  remind_count INTEGER NOT NULL DEFAULT 0,
  reported_at INTEGER                       -- NULL = completed but report not sent
);

CREATE INDEX idx_tasks_short_code ON tasks(short_code);
CREATE INDEX idx_tasks_open ON tasks(status);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  uid_from TEXT NOT NULL,
  display_name TEXT NOT NULL,
  image_url TEXT NOT NULL,                  -- original Zalo URL, fallback only
  stored_path TEXT,                         -- /data/proofs/{task_id}/{id}.jpg
  match_score REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, uid_from)
);

CREATE TABLE group_members_cache (
  zca_group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (zca_group_id, user_id)
);

CREATE TABLE group_id_map (
  official_chat_id TEXT PRIMARY KEY,
  zca_group_id     TEXT NOT NULL UNIQUE,
  display_name     TEXT,
  linked_at        INTEGER NOT NULL,
  linked_by_uid    TEXT
);

CREATE TABLE processed_messages (
  zca_group_id TEXT NOT NULL,
  msg_id       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (zca_group_id, msg_id)
);

-- Operational settings (T13). value_json so one key can hold a list.
CREATE TABLE taskproof_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Initial keys (seed defaults when the row is missing):

| key | example value_json |
|---|---|
| `ocr_match_threshold` | `0.5` |
| `default_required_count` | `1` |
| `deadline_check_interval_ms` | `60000` |
| `reminder_interval_ms` | `3600000` |
| `max_auto_reminders` | `3` |
| `report_poll_interval_ms` | `60000` |
| `qr_login_timeout_ms` | `90000` |
| `member_cache_max_age_ms` | `86400000` |
| `max_mentions_per_message` | `8` |
| `max_reminder_text_len` | `1500` |
| `task_stale_after_ms` | `604800000` |
| `link_pending_ms` | `120000` |
| `default_report_group_id` | `""` |
| `admin_official_chat_id` | `""` |
| `official_bot_uid` | `""` |
| `zca_own_uid` | `""` |
| `remind_exclude_uids` | `[]` |

Group mappings do not belong in this table — use `group_id_map` (one row
per group).

`overdue` is informational only: it is shown on `/tasks` and it starts
the automatic reminder cycle. The status itself never closes a task.

## 7. Storage

v1 uses the **same `/data` volume** already attached for the schedule
module's SQLite file. No second volume.

```
/data/app.db
/data/zca-session.json
/data/proofs/{task_id}/{submission_id}.jpg
/data/qr-tmp/          -- login QR, deleted after success or timeout
```

Proof images **are downloaded** at OCR time and written to disk when the
score passes. The official bot reads `stored_path` when compiling the
report. After `reported_at` is set, or on `/huy`, delete
`/data/proofs/{task_id}/` immediately. A daily sweep may remove orphan
files whose task is `cancelled` or already reported.

Zalo CDN URLs are stored only as fallback. They may expire; one failed
image must not abort the rest of the report (Section 8.6).

## 8. Detailed specification

### 8.1 T1 — `/task` (official bot)

- The official-bot webhook accepts `/task ...` through the same
  dispatcher already used for `/gui`. Schedule-module commands must keep
  working; task-proof is its own command module.
- The parser accepts several bullet styles and any parameter order:
  `Link:`, `Caption:`, `SoLuong:`, `HanChot:`, `BaoCao:`.
- Deadline parser: `DD/MM/YYYY HH:mm`, `HH:mm DD/MM/YYYY`,
  `YYYY-MM-DD HH:mm`. Interpret wall time in `Asia/Ho_Chi_Minh`, store
  UTC epoch ms.
- Messages that contain a link are turned into a preview card by Zalo;
  the parser must take the command text and the fallback link from that
  card's metadata.
- `official_chat_id` is the webhook chat ID of the group where `/task`
  was typed — same convention as `/gui`. The manager must type `/task`
  inside the task group, not in a private chat with the bot.
- On insert:
  - `id` = UUID.
  - `short_code` = 6 characters `[A-Z0-9]`, UNIQUE, retry on collision.
    **Do not** slice the UUID.
  - `zca_group_id` = lookup `group_id_map` by `official_chat_id`, or NULL.
  - `report_group_id` = `BaoCao:` or setting `default_report_group_id`.
- After insert, call `POST /internal/taskproof/ensure-listening` and
  **do not wait for QR / login**. Reply in the group with `short_code`.
  If `zca_group_id` is NULL, add one line: the group is not linked yet,
  type `/lienket`. `/tasks` also shows `chưa liên kết nhóm`.
- A group may have several tasks open at once (Section 8.2).
- If `ensure-listening` returns `login_failed` / `qr_required`, tell the
  manager clearly (the QR is delivered to admin separately). The task
  row stays in the DB.

### 8.2 T2 — Verifying a screenshot (worker, `ocr.ts` + `match.ts`)

Matching logic comes from the tested prototype. Two adaptations:
(a) candidates are the linked group's open tasks in the shared DB, not
an in-memory list; (b) the official bot, not the worker, sends the
report.

**Content-based, not thread-based.** An image does not need to reply or
quote anything. Several tasks may be open in one group — the image is
scored against all of them and assigned to the best match.

**Pre-filters**

1. Ignore the message unless `threadId` is a `zca_group_id` with a task
   in `collecting|overdue`.
2. Ignore if `(zca_group_id, msg_id)` already exists in
   `processed_messages`. Write that key before OCR so a crash retry is
   safe (default is at-most-once).
3. Images only: `content` is an object with `href` or `thumb`. Skip
   text, stickers, GIFs.
4. Single-flight queue: one Tesseract job at a time (singleton).

**Step 1 — Fetch + OCR.** Download bytes from `content.href`, fall back
to `content.thumb`. Use the zca-js session if the URL needs that cookie.
Run Tesseract `vie+eng` on the buffer. Do not OCR a live URL and assume
it stays valid.

**Step 2 — Normalize.** OCR text and every candidate `reference_text`:
Unicode NFD, strip Vietnamese diacritics, lowercase, collapse everything
outside `[\p{L}\p{N}\s]` to a space. Punctuation in the caption must not
penalize the score.

**Step 3 — Score every open task on that `zca_group_id`**
(`status IN ('collecting','overdue')`). Four-tier strategy — do not
simplify:

1. Exact substring (`ocrText.includes(referenceText)`) → 1.0, stop.
2. Dice coefficient (`string-similarity`) on the full text and per line.
3. Sliding window of `reference_text` token length across the OCR text
   (isolates the caption from surrounding social-UI chrome).
4. Prefix match only when `reference_text` is 6+ words: leading ~50–70%,
   weighted 0.95 (mobile "... See more" truncation).

**Step 4 — Winner.** Highest score. If `≥ OCR_MATCH_THRESHOLD` (default
0.5), record a submission. If every score is below the threshold,
discard the image — no row, no task change. Exact tie → earlier
`created_at`.

**Step 5 — Record.** Write the buffer to
`PROOF_DIR/{task_id}/{submission_id}.jpg`. Insert / replace
`{task_id, uid_from, display_name, image_url, stored_path, match_score}`.
`UNIQUE(task_id, uid_from)` overwrites an earlier attempt; no history.

**Step 6 — Close if quota reached.** Distinct `uid_from` ≥
`required_count` → `status=completed` (Section 8.5). Passing the
deadline never closes a task; it only flips `overdue` and starts
reminders. Submissions continue until quota, `/dong`, `/huy`, or the
stale-cancel job.

### 8.3 T3 — `/tasks` (official bot, no worker call)

Read `tasks` / `submissions` and reply immediately:

- `short_code`
- progress `X/requiredCount`
- `status` (`collecting` | `overdue` | `completed` | `cancelled`)
- `chưa liên kết nhóm` when `zca_group_id IS NULL`
- `remind_count`

Do not wake the worker.

### 8.4 T4 — Reminders

Exclude list (never mention) — read from `taskproof_settings` on every
reminder:

```
{ official_bot_uid, api.getOwnId() or zca_own_uid, remind_exclude_uids[] }
```

`missing = group_members_cache.user_id − submissions.uid_from − exclude`.

Send **exactly one** reminder message:

- `missing.length === 0` → send nothing.
- `missing.length ≤ MAX_MENTIONS_PER_MESSAGE` **and** rendered text ≤
  `MAX_REMINDER_TEXT_LEN` → mention each uid (`mentions: [{ pos, len,
  uid }]`, `ThreadType.Group`).
- Otherwise → one `@all` (`uid: "-1"`) plus the count still missing. Do
  not split across multiple mention messages.

**Automatic:** while listening, on `DEADLINE_CHECK_INTERVAL_MS`. Fire
only if `now > deadline`, `remind_count < MAX_AUTO_REMINDERS`, and
`REMINDER_INTERVAL_MS` has passed since `reminded_at`. Uses the member
cache. Call `getGroupInfo` + `getGroupMembersInfo` only when that
`zca_group_id` cache is empty.

**Manual `/nhac <short_code>`:** official bot resolves by **exact**
`short_code` (not a UUID prefix). Calls `ensure-listening` then
`POST /internal/taskproof/remind`. Worker refreshes the member cache
once, then reminds immediately (no throttle).

### 8.13 T14 — `/quet` (scan recent history)

Members may screenshot a post from another group and send the proof
**before** the manager types `/task`. Live ingest never sees those
photos. `/quet` is a manual lookback, not an automatic scan on create.

- Typed in the task group. Exact 6-char `short_code`.
- Default window: **last 5 messages**. Optional count:
  `/quet ABC123`, `/quet ABC123 20` (1–50, Zalo `getrecentv2` cap).
- Official bot: `ensure-listening` then
  `POST /internal/taskproof/scan-history`
  `{ task_id, count, reply_chat_id }`. Replies immediately
  (OCR can take longer than a webhook). Worker down must not be silent.
- Worker: `getGroupChatHistory`, images only (skip link cards), OCR
  against **that task only**, skip uids who already submitted, ignore
  `processed_messages` so a photo discarded against another caption can
  rematch. Quota close still HTTP-kicks `report-now`. Worker never
  `sendPhoto`.
- Result: `POST /internal/taskproof/scan-result` → group text.

If member metadata cannot be retrieved at all, send a generic group
message with no mentions rather than blocking.

### 8.5 T5 — Closing a task and shutting the worker down

A task **keeps the worker alive** only when:

```
status IN ('collecting', 'overdue') AND zca_group_id IS NOT NULL
```

Exceptions: a live `pending_link` window or an in-flight QR login —
stay up until that timeout, then re-evaluate.

When a task becomes `completed` or `cancelled`, the worker checks the
rule above. If nothing remains, it logs out of zca-js and stops the
listener. Unlinked tasks (`zca_group_id IS NULL`) do not keep the
account online by themselves; `ensure-listening` may still start the
worker to serve `/lienket`.

Stale job (official-bot scheduler): `collecting|overdue` older than
`TASK_STALE_AFTER_MS` (default 7 days) is treated as `/huy`.

### 8.6 T6 — Completion report (official bot only)

Same scheduler family as the schedule module
(`REPORT_POLL_INTERVAL_MS`, also reachable from
`/internal/run-due-jobs`):

```
SELECT * FROM tasks WHERE status='completed' AND reported_at IS NULL
```

For each row:

1. Build the summary from `submissions` (short_code, caption, link,
   display_name, timestamps, scores).
2. For each submission, `sendPhoto` into `report_group_id` using the
   **local file** at `stored_path`. `image_url` is fallback only. One
   failed image → log + skip; do not abort the report.
3. `sendMessage` with the summary (existing Zalo client, preformatted
   text).
4. If the report-group send fails (bot not a member, etc.), resend
   images + text to the task group's `official_chat_id`. Sequential, one
   recipient at a time — not a broadcast.
5. `reported_at = now`.
6. Delete `/data/proofs/{task_id}/` immediately.

`/huy` never enters this queue. Skip `cancelled` tasks.

### 8.7 T8 — Login and session persistence

- After any successful login (QR or saved session), persist cookie /
  imei / user-agent to `ZCA_SESSION_FILE_PATH`.
- When listening must start and the worker is not logged in: try the
  saved session first. Only on failure start the QR flow.
- **QR flow (async — the webhook already returned):**
  1. Write a temp image under `/data/qr-tmp/`, serve via an internal
     URL that requires the internal token. Expiry = `QR_LOGIN_TIMEOUT_MS`.
  2. Worker calls `POST /internal/taskproof/deliver-qr`. Official bot
     `sendPhoto`s it to `admin_official_chat_id` only.
  3. Wait for login-success ≤ `QR_LOGIN_TIMEOUT_MS`. On success: persist
     the session, delete the QR file, `login-result { ok: true }`. On
     timeout: delete the QR file, `login-result { ok: false }`, official
     bot notifies admin. The task row stays.
- Do not auto-retry QR after a failed scan. Retry only on a later
  `ensure-listening` (`/task`, `/nhac`, `/lienket`).

### 8.8 T7 — Internal coordination API

See Section 10.

### 8.9 T9 — Member-list cache

On first listen for a `zca_group_id` in this process, and when the cache
is older than `MEMBER_CACHE_MAX_AGE_MS`, refresh once (not continuously):

1. `getGroupInfo(zca_group_id)` → `memberIds`, `currentMems`,
   `totalMember`, `hasMoreMember`, `name`.
2. `ids = memberIds` if non-empty, else `currentMems[].id`.
3. If `hasMoreMember` or `ids.length < totalMember`, log a warning and
   continue with the list on hand.
4. `getGroupMembersInfo(ids)` in batches of 20–50 → upsert
   `group_members_cache` (`displayName` / `dName`).

If refresh fails but a cache exists, keep the stale cache, log, do not
block listen or collection. `/nhac` always attempts one refresh first.

### 8.10 T10 — `/lienket` (map the two IDs)

Must be typed **inside the task group**.

**Method A (default):**

1. Official bot reads `official_chat_id` from the webhook.
2. `POST /internal/taskproof/link-group` `{ official_chat_id }`.
3. Worker writes a pending row (`expires_at = now + LINK_PENDING_MS`).
4. Official bot replies: linking is open for 2 minutes — send `ok` in
   this group.
5. Worker, on the next non-command group message in that window:
   `threadId` → `zca_group_id`. UPSERT `group_id_map`.
   `UPDATE tasks SET zca_group_id=? WHERE official_chat_id=? AND zca_group_id IS NULL`.
   Clear pending. `POST /internal/taskproof/link-result` so the official
   bot confirms in-group: `Đã liên kết: {display_name}`.
6. Timeout with no message → `link-result` failure, ask to retry.

**Method B:** `/lienket <zca_group_id>` (admin already copied the id from
the measurement script). Official bot sends both ids in `link-group`;
worker writes the map immediately. Idempotent if the pair already
exists.

Conflicts (official id already mapped to a different zca id, or the
reverse) → clear error, do not overwrite silently.

### 8.11 T11 / T12 — `/dong` and `/huy`

Resolve by exact `short_code`.

- `/dong <short_code>` → `status=completed`, leave `reported_at` NULL.
  T6 sends a report with submissions so far. Then delete proof files
  (T6 step 6).
- `/huy <short_code>` → `status=cancelled`. No report. Delete
  `/data/proofs/{task_id}/` immediately. Worker re-evaluates shutdown
  (Section 8.5).

The stale job past `TASK_STALE_AFTER_MS` follows the `/huy` path.

### 8.12 T13 — Runtime settings on the Web UI

Same admin page as the schedule module, same basic auth (F2/F9). Not
public. No separate site is required if the agent adds a **Task proof**
section to that page.

**Section A — Parameters**

One form; submit writes `taskproof_settings` immediately:

- Official-bot UID, secondary-account UID
- UIDs excluded from reminders (multiline or csv)
- Default report group (`default_report_group_id`, official chat_id)
- Admin chat that receives QR / alerts (`admin_official_chat_id`)
- `max_mentions_per_message`, `max_reminder_text_len`
- `ocr_match_threshold`, `default_required_count`
- `max_auto_reminders`, `reminder_interval_ms`
- `task_stale_after_ms`, `link_pending_ms`, `qr_login_timeout_ms`

Do not validate that an ID really exists on submit (same as F9 sheet-tab
names). The next send / reminder surfaces a clear error on the UI / in
logs.

**Section B — Group map**

Table over `group_id_map`: official chat_id, zca group id, name. Add /
edit / delete. Deleting a map sets `zca_group_id` to NULL on that
group's open tasks (does not cancel the tasks). `/lienket` and this form
write the same table — idempotent.

**Section C — Open tasks (minimum)**

Recent-task list + buttons equivalent to `/dong` / `/huy` that call the
same functions as the chat commands (no duplicated logic). OCR preview
is optional.

A setting change takes effect on the **next handling** (read the DB each
time). No process restart. A worker that is already listening does not
need to reconnect just because `max_mentions_per_message` changed; a
newly mapped group is picked up on the next `ensure-listening` — the UI
should expose a “Wake worker” button that calls that endpoint.

Do not put the Zalo token, Web UI password, or zca-js session contents
on this form.

## 9. Event routing

**Official bot** (existing webhook, extra branches; `/gui` unchanged):

```
/task              → 8.1
/tasks             → 8.3
/nhac <short_code> → 8.4
/quet <short_code> [count]   → 8.13
/lienket           → 8.10
/dong <short_code> → 8.11
/huy  <short_code> → 8.11
/gui ...           → schedule module (untouched)
```

**Worker** (logged in only while there is work — Section 8.5):

```
message event
  ├─ pending_link window + group message → 8.10 (capture threadId)
  ├─ image in a linked group with an open task → 8.2
  └─ anything else → ignore
     (worker does not parse chat commands)

internal timer (DEADLINE_CHECK_INTERVAL_MS) → 8.4 automatic reminders
```

## 10. Internal coordination API

Protected with the same shared-token style as `INTERNAL_CRON_TOKEN`.
Login failure must return an explicit state, not a generic 500.

### Official bot → worker

```
POST /internal/taskproof/ensure-listening
  body: { task_id? }
  - Log in if needed and listen on every zca_group_id that has a
    linked collecting/overdue task — not only the task passed in.
  - Already listening → 200 immediately (idempotent).
  - 200 { state: "listening" | "reusing_session" | "qr_required" | "pending_link" }
  - 409 { state: "login_failed" | "qr_timeout", error }

POST /internal/taskproof/remind
  body: { task_id }
  - ensure-listening first, then remind that task, no throttle.

POST /internal/taskproof/scan-history
  body: { task_id, count?, reply_chat_id? }
  - Default last 5 messages (1–50). Returns 202 { state: "scanning" }
    then OCR in the background. 409 already_scanning / unlinked / closed.

POST /internal/taskproof/link-group
  body: { official_chat_id, zca_group_id? }
  - zca_group_id present (method B) → write the map now.
  - otherwise (method A) → open a LINK_PENDING_MS window.

GET  /internal/taskproof/status
  → { logged_in, listening, open_task_count, pending_link }
```

### Worker → official bot

```
POST /internal/taskproof/deliver-qr
  body: { image_url, expires_at }
  → sendPhoto QR to admin_official_chat_id

POST /internal/taskproof/login-result
  body: { ok, error? }
  → notify admin

POST /internal/taskproof/link-result
  body: { official_chat_id, ok, zca_group_id?, display_name?, error? }
  → sendMessage into official_chat_id

POST /internal/taskproof/scan-result
  body: { reply_chat_id, short_code, count, scanned, recorded,
          skipped, discarded, closed, truncated, error? }
  → sendMessage into the group where /quet was typed
```

If the worker is down while linked open tasks still exist, the official
bot's periodic job should notify `admin_official_chat_id` (reuse the
schedule module's admin-reminder channel). `/task` / `/nhac` / `/lienket`
/ `/quet` must not fail silently.

## 11. Implementation task list

- [ ] **Step 1**: One container, two processes, shared `/data` volume.
      Official bot always on; worker may log out. Official bot is the
      only migrator.
- [ ] **Step 2**: Create the Section 6 tables (`tasks` with two IDs +
      `short_code` + `cancelled`, `submissions` with `stored_path`,
      `group_members_cache`, `group_id_map`, `processed_messages`,
      `taskproof_settings`). Settings reader: DB overrides in-code
      defaults; do not read secrets from a file.
- [ ] **Step 3**: Command parsers on the official bot: `/task`, `/tasks`,
      `/nhac`, `/lienket`, `/dong`, `/huy`. Tests: field order, preview
      card, VN timezone, exact `short_code`, no UUID-prefix match.
- [ ] **Step 4**: Port `match.ts` / `ocr.ts`. Re-run `test-logic.ts` and
      `eval-dataset.ts` **before** wiring Zalo. Keep the four match
      tiers unchanged.
- [ ] **Step 5**: Bidirectional internal API (Section 10) + session reuse
      + async QR to `admin_official_chat_id`. Webhooks never wait on QR.
- [ ] **Step 6**: `/lienket` method A (pending + next message) and method
      B (explicit zca id). Do not OCR an unmapped group.
- [ ] **Step 7**: Member cache via `getGroupInfo` + `getGroupMembersInfo`
      (Section 8.9). Reminder algorithm in Section 8.4, including `@all`.
- [ ] **Step 8**: Listen / stop lifecycle (Section 8.5) + automatic
      reminder timer + stale-cancel job.
- [ ] **Step 9**: OCR queue + file store + quota close (Section 8.2).
      Tesseract data files in the worker image.
- [ ] **Step 10**: Report job on the existing scheduler (Section 8.6):
      local files first, skip a dead image, fallback group, delete
      proofs after `reported_at`.
- [ ] **Step 11**: Health: if the worker is down while linked open tasks
      exist, notify admin.
- [ ] **Step 12**: Task-proof Web UI section (Section 8.12): edit IDs /
      exclude list / max mentions / report group / group map, persist in
      DB, take effect without a restart. Same auth as the schedule page.
- [ ] **Step 13**: E2E on a real group:
      `/lienket` → `/task` → passing and failing screenshots → `/tasks` →
      `/nhac` (few missing vs `@all`) → quota → report group → fallback
      when the bot is removed from the report group → `/dong` mid-task
      still reports → `/huy` does not → worker restart mid-task still
      collects → `/gui` still works.

## 12. Coding rules carried over from the schedule module

1. An error in one task / one image / one recipient must not block the
   rest of a batch.
2. Secrets (bot token, internal token, Web UI password) live in env
   only. Chat ids / uids / thresholds / exclude lists live in the DB and
   are edited on the Web UI — not in a deploy file. `.env.example` has
   no real values. QR URLs are token-gated and short-lived.
3. Vietnamese comments on business assumptions: two ID namespaces,
   `@all` vs per-person mention, delete files after report, QR must not
   block the webhook, `overdue` does not close a task, an unlinked task
   does not keep the worker online.
4. Required tests: command parser, Vietnamese normalize, four-tier
   match, `short_code` resolve, `/lienket` pending timeout, quota close,
   report skips one bad image, stale → `cancelled`.
