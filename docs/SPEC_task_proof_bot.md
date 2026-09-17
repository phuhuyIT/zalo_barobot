# SPEC: Zalo Task Proof Bot

## 1. Purpose

This module tracks content-sharing tasks inside Zalo groups. A manager
assigns a task (a post to share, a required caption/keyword, a quota of
participants, and a deadline). Members share the post and post a
screenshot into the group as proof. The system verifies each screenshot
with OCR + fuzzy text matching, reminds members who haven't submitted,
and once the quota is reached, sends a completion report with all proof
images to a designated report group.

This module supersedes any previous screenshot-collection design based on
tagging/replying to the bot. It is not compatible with that design and
replaces it entirely.

## 2. System Architecture

The system is split into two independent roles:

| | Official Bot (Zalo Bot Platform) | Background Worker (zca-js) |
|---|---|---|
| Role | Single entry point for all commands (`/task`, `/tasks`, `/nhac`, plus commands from other modules); sends the final completion report | Runs on demand: collects and verifies screenshots (OCR + matching), sends reminders with native @mentions |
| Availability | Always online (same service already used by other modules) | Logs in and listens only while at least one task is `collecting`/`overdue`; logs out automatically once no tasks remain open |
| Rationale | Stable, official API, no account-suspension risk, the interface managers already use | Provides the two capabilities the Official Bot Platform does not support: reading images without requiring a mention, and real @mention tags with a real member list. Staying offline when idle limits the account's exposure |

Both processes share a single SQLite database (separate tables). They do
**not** share a Zalo transport layer — the two Zalo identities are
completely separate and never call each other's Zalo client directly.
Coordination between the two processes happens only through a small
internal HTTP API (Section 10).

Both identities must be members of the task group: the official bot to
receive commands, the secondary account to read images. The official bot
must additionally be a member of the report group to deliver the
completion report. The secondary account does not need to be a member of
the report group.

Using zca-js means automating a personal Zalo account through an
unofficial library. This carries a risk of the account being suspended
by the platform. This risk is accepted for this module.

### 2.1 End-to-end flow

```
Manager types /task ... inside the task group (official bot is a member)
        │
        ▼
Official bot's webhook receives the command
        │
        ├─ Inserts a new task row into the shared DB (status=collecting)
        └─ Calls the internal "ensure-listening" endpoint on the
           task-proof-bot service
                │
                ▼
        task-proof-bot service (separate process, running zca-js):
          - If not currently logged in / listening: log in (reusing a
            saved session where possible), start listening on the group
            of the new task plus every other group with an open task
          - If already listening: just add the new task/group to the
            watch list, no re-login

... while the task is collecting ...
        │
        ├─ A member posts a screenshot → the worker runs OCR + fuzzy
        │  matching → if the score passes the threshold, the image URL
        │  is stored as-is (see 8.2 for why no file is downloaded)
        │
        ├─ Manager types /nhac in the group (received by the official
        │  bot) → its webhook calls the internal "remind" endpoint →
        │  the worker sends an immediate reminder with native @mentions
        │
        └─ Manager types /tasks (received by the official bot) → the
           official bot answers directly from the shared DB; it does
           not need to call the worker, since this is a pure read

... once the task reaches its required count ...
        │
        ├─ The worker marks the task status=completed (it does not send
        │  a report itself)
        ├─ The worker checks whether any other task is still
        │  collecting/overdue; if none remain, it logs out and stops
        │  listening
        │
        ▼
A periodic job on the official bot's side (reusing the scheduler already
used by other modules) scans for tasks with status=completed AND
reported_at IS NULL. For each one, the official bot calls sendPhoto for
every stored image URL, then sendMessage with the summary report, into
the report group (falling back to the task group on failure), then sets
reported_at = now.
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

`vie.traineddata` and `eng.traineddata` (Tesseract language data) must be
placed in the working directory of the **worker process** at runtime —
include them in the Docker image/volume, not just the local dev setup.

## 4. Feature List

| # | Feature | Trigger | Owner |
|---|---|---|---|
| T1 | Create a new task | `/task` command (sent to the official bot) | Official bot creates the DB row + calls the internal wake-up endpoint |
| T2 | Verify a proof screenshot (OCR + fuzzy match) and record its URL | Image posted in a group with an open task | Worker (zca-js) |
| T3 | List open tasks and progress | `/tasks` command | Official bot (reads the DB directly, no worker call) |
| T4 | Remind members who haven't submitted (automatic + manual) | Automatic (worker's own timer); `/nhac` (relayed by the official bot) | Worker (needs real @mentions) |
| T5 | Close a task once its quota is reached; shut the worker down if no task remains open | Automatic, once `requiredCount` is reached | Worker |
| T6 | Compile and send the completion report with images, with a fallback group | Periodic scan for tasks that are `completed` with `reported_at IS NULL` | Official bot |
| T7 | Internal coordination API (ensure-listening, remind) | Called internally by the official bot | Worker (exposes two small endpoints) |
| T8 | Persist and reuse the zca-js login session; send a login QR code to the manager when a fresh login is required | Whenever the worker needs to start listening | Worker (logs in) + official bot (delivers the QR code) |
| T9 | Fetch and cache a group's member list (IDs + display names) | When the worker starts listening on a group (first time, or after having been shut down) | Worker |

## 5. Configuration

```ts
OCR_MATCH_THRESHOLD = 0.5;
DEFAULT_REQUIRED_COUNT = 1;
DEADLINE_CHECK_INTERVAL_MS = 60_000;      // worker's own deadline poll while listening
REMINDER_INTERVAL_MS = 3_600_000;         // throttle between automatic reminders
MAX_AUTO_REMINDERS = 3;                   // cap before manual /nhac is required
REPORT_GROUP_ID = <default>;              // overridable via a /task parameter
REPORT_POLL_INTERVAL_MS = 60_000;         // official bot's scan for tasks awaiting a report
ZCA_SESSION_FILE_PATH = "data/zca-session.json";  // on the worker's own volume
QR_LOGIN_TIMEOUT_MS = 90_000;             // time allowed for the manager to scan the QR code
MEMBER_CACHE_MAX_AGE_MS = 86_400_000;     // a member cache is considered stale after 24h
```

The channel used to deliver the login QR code is the same `recipients.admin`
chat ID already configured for the project (see the schedule module's
configuration) — no separate admin identifier is introduced for this
module.

All values above are read from configuration/environment variables, never
hardcoded.

## 6. Data Schema

SQLite, WAL mode enabled. These tables live in the same database file
already used by the rest of the project, under their own names.

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  report_group_id TEXT NOT NULL,
  link TEXT NOT NULL,
  reference_text TEXT NOT NULL,
  required_count INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  status TEXT NOT NULL,             -- collecting | overdue | completed
  created_at INTEGER NOT NULL,
  reminded_at INTEGER,
  remind_count INTEGER NOT NULL DEFAULT 0,
  reported_at INTEGER               -- NULL = the worker has closed the task
                                     -- but the official bot has not yet
                                     -- sent the report (Section 8.6)
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  uid_from TEXT NOT NULL,
  display_name TEXT NOT NULL,       -- stored here so the official bot can
                                     -- build the report without querying
                                     -- the worker/zca-js again
  image_url TEXT NOT NULL,          -- the raw URL Zalo returned for the
                                     -- image; no file is downloaded or
                                     -- stored (see the risk note in 8.2)
  match_score REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, uid_from)
);

CREATE TABLE group_members_cache (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
```

## 7. Storage

No volume is required for proof images — the module never downloads or
stores them; it only forwards the URL Zalo already returned.

A small dedicated volume **is** required for the worker process, holding:
- the persisted zca-js login session (must survive restarts/redeploys —
  Section 8.7), and
- the temporary QR code image generated during a fresh login (deleted
  immediately after use — Section 8.7).

## 8. Detailed Specification

### 8.1 T1 — The `/task` command (handled by the official bot)

- The official bot's webhook recognizes `/task ...` (the same dispatcher
  already extended for `/gui` and other module commands).
- The command parser accepts several bullet styles and any parameter
  order: `Link:`, `Caption:`, `SoLuong:`, `HanChot:`, `BaoCao:`. The
  deadline parser supports `DD/MM/YYYY HH:mm`, `HH:mm DD/MM/YYYY`, and
  `YYYY-MM-DD HH:mm`.
- Messages containing a link are auto-converted by Zalo into a preview
  card; the parser must extract the command text and the fallback link
  from that card's metadata.
- `group_id` is the chat ID of the group where `/task` was typed (the
  same convention used by `/gui` in the schedule module) — the manager
  must issue `/task` inside the task group itself, not in a private
  message to the bot.
- After the row is inserted, the official bot calls
  `POST /internal/taskproof/ensure-listening` (Section 10) with the new
  `task_id`.

### 8.2 T2 — Verifying a screenshot (worker, `ocr.ts` + `match.ts`)

- OCR runs directly against the image URL (no file is downloaded first),
  to avoid wasted downloads on unrelated images. `ocrImage(imageSource)`
  accepts a URL or a Buffer.
- Matching algorithm (keep as benchmarked, do not alter):
  1. Normalization: NFD decomposition, lowercase, replace any character
     outside `[\p{L}\p{N}\s]` with a space.
  2. Exact substring match → score 1.0 immediately.
  3. Dice's coefficient across the full string and per line.
  4. Sliding window sized to the token length of `reference_text`.
  5. Prefix matching for captions of 6+ words (weight 0.95), to handle
     mobile clients truncating captions with "... See more".
- Only when `matchScore ≥ OCR_MATCH_THRESHOLD`: store the `image_url`
  Zalo returned in the submission row. No file is downloaded or stored.
  Images below the threshold are discarded, nothing is stored for them.
- **Known risk**: Zalo's image URLs may be time-limited (signed links
  that expire after some hours). If so, a URL stored at submission time
  could be unusable by the time the official bot compiles the report
  (Section 8.6), particularly for tasks that stay open for a long time
  before reaching quota. This module deliberately does not add a
  fallback download step for this. Instead, the report-sending step
  degrades gracefully (Section 8.6: a failed image is skipped, the rest
  of the report is still sent). It is recommended to verify empirically
  how long these URLs remain valid before relying on this design for
  long-running tasks.
- `UNIQUE(task_id, uid_from)`: a repeat submission from the same member
  overwrites the previous one.
- After a submission is recorded, if the required count is reached, the
  task status moves to `completed`. The worker does not send a report at
  this point — it only finishes collecting; Section 8.6 covers reporting.

### 8.3 T3 — The `/tasks` command (handled by the official bot, no worker call)

- The official bot reads the `tasks`/`submissions` tables directly and
  replies immediately: task code, progress (`X/requiredCount`), reminder
  count. The worker does not need to be running for this — this is the
  key difference from `/task`/`/nhac`, and it avoids waking the worker
  unnecessarily.

### 8.4 T4 — Reminders

- **Automatic**: while the worker is listening (task `collecting`/
  `overdue`), it checks on `DEADLINE_CHECK_INTERVAL_MS`. Once past the
  deadline, under `MAX_AUTO_REMINDERS`, and `REMINDER_INTERVAL_MS` since
  the last reminder, it computes the missing members by comparing
  `group_members_cache` (Section 8.9) against the task's `submissions`,
  and sends a native @mention reminder to each of them. It only calls
  `api.getGroupInfo(groupId)` directly if the cache is completely empty
  for that group; otherwise it relies on the cache.
- **Manual**: the manager types `/nhac <task_code>` to the official bot,
  whose webhook calls `POST /internal/taskproof/remind` (Section 10) with
  the `task_id`. The worker sends an immediate reminder without waiting
  for the throttle interval.
  - If the worker is not currently running (an inconsistent state, since
    an open task should normally keep it running), `ensure-listening` is
    called first so the reminder is not silently lost.
- If member metadata cannot be retrieved at all, fall back to a generic
  reminder addressed to the whole group rather than blocking.

### 8.5 T5 — Closing a task and shutting the worker down

- When a task's status moves to `completed` (Section 8.2), or is closed
  in any other way in the future, the worker checks the DB: is any other
  task, in any group, still `collecting` or `overdue`? If yes, it keeps
  listening. If none remain, it logs out of zca-js and stops the
  listener entirely, releasing resources — the account should only stay
  online while there is active work.

### 8.6 T6 — Compiling and sending the completion report (official bot, not the worker)

- Runs as a job in the official bot's existing scheduler, on
  `REPORT_POLL_INTERVAL_MS`: `SELECT * FROM tasks WHERE status='completed'
  AND reported_at IS NULL`.
- For each task found:
  1. Compile the summary: task code, caption, URL, and the list of
     submitters with their timestamps and match scores (read directly
     from `submissions`, including the already-stored `display_name`).
  2. For each `image_url`, call `sendPhoto` (official Bot Platform) with
     that URL directly into `report_group_id` — no download, no
     re-upload. If a specific URL fails or has expired (see the risk
     noted in 8.2), log a warning, skip that image, and continue sending
     the rest of the images and the text summary — a single failed image
     must not abort the whole report.
  3. Call `sendMessage` with the compiled summary text.
  4. **Fallback**: if sending to `report_group_id` fails (e.g. the bot is
     not a member), resend the entire report (images + text) to
     `group_id` (the task group) instead.
  5. Set `reported_at = now`.

### 8.7 T8 — Login and session persistence for zca-js

- **After any successful login** (whether by scanning a fresh QR code or
  by reusing a saved session), persist the session data (cookie/imei/
  user-agent, as required by zca-js) to `ZCA_SESSION_FILE_PATH`, on the
  worker's dedicated volume (Section 7).
- **Whenever listening needs to start** and the worker isn't already
  logged in, it first attempts to load the saved session file and log in
  with it, without showing a QR code. Only if that attempt fails (the
  session is expired or invalid) does it fall back to the QR flow below.
- **Fresh-login QR flow**:
  1. zca-js generates a QR code (image/data). Save it as a temporary
     image file, served through the same static-file route pattern used
     elsewhere in the project, to obtain a public URL.
  2. The **official bot** sends that QR image (`sendPhoto`) to the
     **manager** (`recipients.admin`, never to a regular group), with a
     note to scan it within `QR_LOGIN_TIMEOUT_MS`.
  3. Wait for the login-success event from zca-js, within
     `QR_LOGIN_TIMEOUT_MS`. On success, persist the new session (as
     above) and delete the temporary QR image immediately. If the
     timeout elapses without a scan, log the failure and notify the
     manager through the official bot; the task itself remains in the
     DB, simply uncollected until a subsequent login succeeds (triggered
     by a new `/task` or `/nhac` call).
- Do not retry the login loop automatically after a failed QR scan (to
  avoid spamming the manager) — only retry when a new command triggers
  `ensure-listening` again.

### 8.8 T7 — Internal coordination API

See Section 10 for the full specification.

### 8.9 T9 — Fetching and caching a group's member list

- When the worker starts listening on a group (the first time in the
  current process, or after having previously shut down), call
  `api.getGroupInfo(groupId)` and upsert `{group_id, user_id,
  display_name}` into `group_members_cache` for every member returned.
- If a cache entry for that group already exists but is older than
  `MEMBER_CACHE_MAX_AGE_MS` (default 24h), refresh it once at the moment
  listening starts — not continuously while already running.
- `group_members_cache` is the primary data source for T4 (Section 8.4).
  If `getGroupInfo` fails while a refresh is needed but a cache already
  exists, keep using the stale cache, log a warning, and do not block
  listening or collection.

## 9. Event Routing

**Official bot side** (existing webhook, extended with new branches):
```
/task   → 8.1 (create the task, call ensure-listening)
/tasks  → 8.3 (read the DB, reply immediately)
/nhac   → 8.4 (call ensure-listening, then remind)
```

**Worker side** (only runs while at least one task is open):
```
message event from zca-js (only received because the worker is logged in
and listening on the group of an open task)
  ├─ isImage === true → 8.2 (OCR + match; store if it passes; check quota → 8.5)
  └─ anything else → ignored (the worker no longer handles chat commands;
     all commands go through the official bot)

internal timer (DEADLINE_CHECK_INTERVAL_MS) → 8.4 (automatic reminders)
```

## 10. Internal Coordination API

Exposed by the task-proof-bot (worker) service, protected by a shared
token in the same style as the `INTERNAL_CRON_TOKEN` already used by the
schedule module:

```
POST /internal/taskproof/ensure-listening
  body: { task_id }
  - If the worker is not currently logged in/listening: log in and start
    listening on every group that has a task with status
    collecting/overdue in the DB — not just the task passed in, so no
    open task is missed when several exist at once.
  - If already listening: no-op, return 200 immediately (idempotent).

POST /internal/taskproof/remind
  body: { task_id }
  - Calls ensure-listening first (idempotent), then triggers an
    immediate reminder for that specific task, bypassing the throttle.
```

Both endpoints must return a clear error (not a generic 500) when the
zca-js login fails (e.g. the session is invalid and a new QR scan is
required). The official bot surfaces this error to the manager through
an existing channel rather than letting `/task`/`/nhac` fail silently.

## 11. Implementation Task List

- [ ] **Step 1**: Set up the two processes as clearly separate components
      in the repository — the official bot service (existing, extended)
      and the new `task-proof-bot` service (zca-js). They may run as two
      Node processes in the same deployment or as two separate Railway
      services, as long as they run independently.
- [ ] **Step 2**: Create the `tasks`, `submissions`, and
      `group_members_cache` tables (Section 6) in the shared SQLite
      database.
- [ ] **Step 3**: Port the already-tested core files: `match.ts`,
      `ocr.ts`, `tasks.ts` (splitting out command parsing, which now
      belongs to the official bot, from submission handling, which stays
      in the worker), and `reminders.ts`.
- [ ] **Step 4**: Install dependencies and place the Tesseract language
      files for the worker process. No volume is needed for proof images.
- [ ] **Step 5**: Implement session persistence and reuse, plus the QR
      login flow that delivers the code to the manager through the
      official bot (Section 8.7). Do this early — every later step
      depends on the worker being able to log in.
- [ ] **Step 6**: Implement group member fetching and caching on listener
      startup (Section 8.9), and wire T4's reminder logic to read from
      that cache.
- [ ] **Step 7**: Implement the two internal coordination endpoints
      (Section 10) on the worker.
- [ ] **Step 8**: Extend the official bot's webhook with the `/task`,
      `/tasks`, and `/nhac` branches (Sections 8.1, 8.3, 8.4), calling
      the worker's internal API where needed.
- [ ] **Step 9**: Implement the worker's listen/stop lifecycle (Section
      8.5) and its automatic-reminder timer (Section 8.4).
- [ ] **Step 10**: Implement the OCR + matching + submission-recording
      flow (Section 8.2), storing only the image URL.
- [ ] **Step 11**: Implement the official bot's scheduler job that scans
      for completed-but-unreported tasks and sends the report, including
      the per-image failure handling and the group fallback (Section
      8.6).
- [ ] **Step 12**: Provision the worker's dedicated volume for the
      session file and temporary QR images (Section 7).
- [ ] **Step 13**: Re-run `test-logic.ts` and `eval-dataset.ts` to confirm
      the matching accuracy is unchanged after this integration.
- [ ] **Step 14**: End-to-end manual test: `/task` → submit screenshots
      (some passing, some failing the threshold) → `/tasks` → `/nhac` →
      reach quota → confirm the report is delivered to the report group,
      and confirm the fallback works when the official bot is removed
      from that group.
