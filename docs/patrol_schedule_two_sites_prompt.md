# Addition: Combined Patrol Schedule for 2 Sites (Tan Phuoc Khanh + Thanh Hoi)

Extends the already-implemented "tuantra" feature (squad 1's leader
reports the names of people going on patrol; the system merges that with
the sheet data and sends it to the platoon leader). This is an addition,
not a rewrite — read the existing "tuantra" code carefully before making
changes.

## 1. Overview of the change

There are now 2 report sources instead of 1:
- **Site 1 (Tan Phuoc Khanh)** = squad 1's leader reports (as before),
  **merged with** the "Patrol" column data from the main squad's gate-duty
  sheet (a source already present in the system — use the exact same
  "what counts as today" logic the gate-duty module already uses; do not
  write a new date-resolution rule).
- **Site 2 (Thanh Hoi)** = Site 2's platoon leader reports their own
  patrol list in **full**, using the same syntax as Site 1, but this one
  is **not** merged with anything from the system — they are responsible
  for reporting the complete pair/group for each shift themselves.

The system waits until **both sites have reported** for the same day
before composing a single combined message, sent to the system's current
recipient for the consolidated patrol report (Site 1's platoon leader).

## 2. Message syntax (same syntax for both sources)

**1 shift/day** (unchanged from the existing implementation):
```
tuantra Nguyen Van A, Nguyen Van B
```

**Multiple shifts/day** (new):
```
tuantra
Shift1: Pham Hoang Phuc, Tu Dai Vy
Shift2: Pham Huu Luan, Nguyen Minh Thuan
```

Parsing should be lenient (so quick mobile typing doesn't break it):
- Case-insensitive, and the space between the shift keyword and the
  number is optional (`shift1` = `Shift 1` = `SHIFT1`).
- Names may be separated by a comma `,` or by the word "and".
- How to tell single-shift vs multi-shift apart: if the content after
  "tuantra" contains at least one line matching the pattern "shift word +
  number + colon" → treat it as multi-shift mode; otherwise → single-shift
  mode (one single name list, as before).

## 3. Merge logic for Site 1

- Single-shift mode: the name(s) squad 1's leader reported (1–2 names),
  appended with the name in the (non-split) "Patrol" column of the sheet
  for that day.
- Multi-shift mode: the Nth shift reported by the leader is merged with
  the Nth sub-column (counted left→right) under the "Patrol" column group
  in the sheet — merge **by positional order**, not by matching the exact
  wording "Shift 1"/"Shift 2" in the column header (because the
  sub-column names in the sheet are set by the Admin and may not read
  exactly "Shift N").

## 4. Shift-count validation (mandatory — never guess on mismatch)

Compare the number of shifts squad 1's leader reported against the number
of sub-columns with data under the "Patrol" column group in the sheet for
that same day:
- Match → merge and send normally (still subject to the condition in
  section 5).
- Mismatch → do **not** auto-merge or auto-send. Send a separate warning
  to the Admin (via the existing reminder channel) stating the date, how
  many shifts the sheet has, and how many shifts the leader reported —
  so the Admin can review it manually. Do not silently leave gaps or
  silently truncate the extra shifts.

## 5. Conditions for compiling & sending

Only compose and send the combined message when **both** conditions hold
for the same day:
1. Site 1 has a valid report (passed the validation in section 4).
2. Site 2's platoon leader has submitted their report.

If either is missing, do not send yet — keep waiting.

**Reminders**: apply the same existing reminder mechanism to **both**
reporters (squad 1's leader and Site 2's platoon leader) **independently**
— each has their own deadline/max-reminder-count, and whichever one
hasn't reported gets reminded, regardless of the other's status.

**If one site has no patrol shift that day**: still show that site's full
header block in the combined message, with a line reading "(No patrol
shift today)" instead of omitting the block entirely — so the recipient
always sees the same two-site structure every day.

## 6. Output message template

**When both sites have a single shift per day** (each name-list line ends
with a period):
```
PATROL SCHEDULE (16/9/2026)

Site 1 (Tan Phuoc Khanh)
- Nguyen Minh Thuan, Pham Hoang Phuc, Luong Van Tai.

Site 2 (Thanh Hoi)
- Le Huynh Phuc, Nguyen Trung Nghia, Le Thai Dien.
```

**When there are multiple shifts** (each "Shift..." line also ends with a
period):
```
PATROL SCHEDULE (07/9/2026)

Site 1 (Tan Phuoc Khanh)
Shift1: Pham Hoang Phuc, Tu Dai Vy.
Shift2: Pham Huu Luan, Nguyen Minh Thuan.

Site 2 (Thanh Hoi)
Shift1: Nguyen Anh Pha, Nguyen Trung Hau.
Shift2: Pham Trung Nghia, Nguyen Chi Khang.
```

General rule: a title line "PATROL SCHEDULE (dd/M/yyyy)", one blank line,
then each site's block under its fixed display name "Site 1 (Tan Phuoc
Khanh)" / "Site 2 (Thanh Hoi)", with every name-list line ending in a
period. Site names should live in one easy-to-edit place (configuration),
not be hardcoded in multiple places in the code, in case a site's name
changes later.

## 7. Configuration requirements (describing behavior — NOT prescribing
   specific field names/schema)

The system needs to allow configuring/adjusting (name the fields however
you like):
- The display name of each site (currently 2 sites, names as in
  section 6).
- Per site: who is authorized to send a "tuantra" report for that site,
  and whether that site's report gets merged with the "Patrol" sheet data
  or is self-contained (per the distinction in section 1).
- The final recipient of the combined message (currently: Site 1's
  platoon leader — the same recipient the patrol report already uses in
  the system today).
- The deadline and maximum reminder count for each individual reporter
  (this already exists for squad 1's leader; now add an equivalent,
  independent set of settings for Site 2's platoon leader).
