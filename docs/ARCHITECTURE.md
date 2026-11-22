# Architecture — AWS Secret Scanner

## In one paragraph

You give the service a GitHub repo. It downloads the repo's history, looks at every commit on every branch, tag and
pull request, newest first, and saves every AWS key it finds, with the commit and the person who committed it. Scanning
happens in the background. If anything breaks halfway (a crash, a restart, a stop), the scan continues later from where
it stopped, and you never get the same finding twice.

The assignment itself is in [`ASSIGNMENT.md`](ASSIGNMENT.md). Why each choice was made: [`DESIGN_DECISIONS.md`](DESIGN_DECISIONS.md).
The tables in detail: [`ERD.md`](ERD.md).

## The big picture

```
         you (curl / browser)
                 │
                 ▼
        ┌─────────────────┐
        │   API container │   takes requests, writes "please scan this" into the DB,
        │   (apiMain.ts)  │   reads results back out of the DB
        └────────┬────────┘
                 │
                 ▼
        ┌─────────────────┐
        │  SQLite file    │   the only thing the containers share.
        │  scans          │   it is the queue (scans waiting), the progress
        │  findings       │   (how far each scan got) and the results
        └────────┬────────┘
                 ▲
        ┌────────┴────────┐
        │ Worker container│ ×2   each runs 3 "slots"; a slot takes one scan
        │ (workerMain.ts) │      and does the actual work: clone, read diffs,
        └────────┬────────┘      find keys, save findings
                 │
                 ▼
              GitHub
```

The API never talks to GitHub, and the workers never take HTTP requests. They only meet in the database.

## The life of one scan

1. **You ask for a scan.** `POST /scans {"repoUrl": "owner/repo"}`. The API cleans up the URL and adds a row to
   `scans` with status `queued`. If this repo already has a scan in progress, you get that one back instead of a new one.
2. **A worker picks it up.** Each free slot asks the database about once a second: "give me the oldest scan that's
   waiting". Taking it and marking it as ours happens in one step, so two slots can never take the same scan. The
   status becomes `cloning`.
3. **The worker downloads the repo.** One `git clone`, which gets every branch, tag and PR, but only the commits and
   folder structure, not the file contents (that's what "blobless" means). It's fast even for big repos.
4. **The worker makes the to-do list.** It writes down where every branch, tag and PR points right now (the "ref
   tips") and saves that on the scan. Then it lists every commit reachable from them, each one once, and sorts them by
   commit time, newest first. The status becomes `scanning`.
5. **The worker goes through the list in pages of 200 commits.** For each page:
   - download the file contents this page needs, in one request;
   - get the diffs with `git log -p`, read them line by line, and check every **added** line for AWS keys;
   - save the page's findings **and** "200 more commits done" in one database transaction. Both are saved, or
     neither is.
6. **Done.** The status becomes `completed` and the downloaded repo is deleted.

While this runs, the worker sends a "still alive" signal every 10 seconds (the heartbeat). You can watch progress with
`GET /scans/:id` and read the results with `GET /scans/:id/findings`.

## Words used in this project

| Word | Meaning |
|---|---|
| **Ref tips** | Where every branch, tag and PR points when the scan starts. Saved once, so the scan's commit list never changes, even if people push new commits during the scan |
| **Page** | 200 commits from the sorted list (`BATCH_SIZE`). The unit of work and of saving |
| **Placeholder / checkpoint** | `scannedCommits`: how many commits from the top of the list are done. Plus `lastScannedSha`, the commit at that spot, to double-check on resume |
| **Slot** | One "lane" inside a worker container. Each slot runs one scan at a time. 3 per container by default |
| **Lease** | "This slot owns this scan until time X." The heartbeat keeps pushing X forward. If the slot dies, X passes and another slot may take the scan |
| **Lease token** | A number that goes up every time someone takes the scan. Every save must carry the current number, so a slot that lost the scan can't save anything |
| **Delivery count** | How many times in a row a slot took the scan without making progress. At 3 the scan is marked `failed`. Our version of a dead-letter queue |

## Scan statuses

| Status | Meaning |
|---|---|
| `queued` | Waiting for a slot (new, retrying after an error, or resumed) |
| `cloning` | A slot owns it and is downloading the repo and building the list |
| `scanning` | Going through the pages. Progress = `scannedCommits / totalCommits` |
| `completed` | Done. Final |
| `failed` | Stopped for good: repo not found, bad token, history rewritten, or too many tries. `POST /resume` puts it back in the queue |
| `stopped` | Someone called `POST /stop`. `POST /resume` puts it back in the queue |

Every status change is checked against a list of allowed moves (`src/domain/scanStateMachine.ts`) and saved with
"change it *only if* it's still in the status I think it's in". If someone else changed it first, nothing is saved.

## When things go wrong

| What happens | What the system does |
|---|---|
| A worker crashes in the middle of a page | That page was never saved. The heartbeat stops, the lease runs out after 30 s, another slot takes the scan, downloads again, and continues from the last saved page |
| A worker freezes, then wakes up after someone else took its scan | Its saves carry an old lease token, so they change nothing. It notices and stops. It also has its own download folder, so it can't delete the new owner's files |
| Network error or timeout talking to GitHub | The scan goes back to `queued` and waits 5 s, then 10 s, then 20 s before it can be taken again |
| A repo makes every worker crash | Each takeover counts as a delivery. After 3 in a row with no progress, the scan is marked `failed` instead of crashing more workers |
| Repo not found or bad token | `failed` at once. No retries, since retrying won't help |
| Someone force-pushed and the saved commits are gone | `failed` with "history changed, start a new scan". We never continue a placeholder on a different list |
| You call stop | A waiting scan stops at once. A running one stops after the current page |
| The containers are shut down (deploy, `docker compose down`) | Running scans are put back in the queue without counting a delivery, and continue on the next start |
| The same page is scanned twice | Findings have a unique key, so duplicates are ignored |
| Invalid input / unknown scan / wrong state | 400 / 404 / 409 |

## Many scans at once

- 2 worker containers × 3 slots = 6 scans at the same time. A new repo doesn't wait for a big one to finish; it waits
  only if all 6 slots are busy. To go faster, add worker containers.
- One scan is always done by one slot, in order, because "newest first" and the placeholder need one ordered list.
- What keeps it safe:
  - **taking a scan** is one locked database step (`BEGIN IMMEDIATE`);
  - **the lease token** stops a slot that lost its scan from saving;
  - **one active scan per repo** is a database rule (a unique index), not a check in our code;
  - **findings and placeholder in one transaction**, plus the unique key on findings, means no gaps and no duplicates;
  - **one download folder per claim**, so slots never share files.

## Big repos

| Problem | What we do |
|---|---|
| Huge download | Blobless clone: start with commits and folders only; file contents come one page at a time, in one request per page |
| Huge diffs | Read line by line from git, never the whole output at once. Files over 50 MB are skipped as binary |
| Many branches | One download gets them all; a commit on 500 branches is scanned once |
| Long scans and crashes | A save every page, so a crash loses at most one page |
| Many commits | The sorted list is just SHA + time, about 100 MB per million commits |
| Many findings | The findings API pages with a cursor (`id > last seen`), so it stays fast |

Not built yet, but designed: splitting one giant repo across several workers, sorting on disk for 10M+ commits, and
checking each line while streaming instead of per commit. See `DESIGN_DECISIONS.md` sections 13 and 20.

## Where things are in the code

```
src/
  apiMain.ts         start the API container
  workerMain.ts      start a worker container
  bootstrap.ts       what both need: config, logger ([api]/[worker] prefix), DB, shutdown
  config.ts          env vars, checked with Zod
  api/               HTTP routes, input checks, error codes
  services/          what the API does (create, stop, resume...), no HTTP in here
  worker/            the slots: take a scan, heartbeat, retry or fail, shut down cleanly
  scanner/           scanRunner: clone → list → pages; detector: the AWS key patterns
  git/               runs git: clone, list and sort commits, prefetch file contents, read diffs
  db/                all SQL: tables, taking a scan, leases, placeholder, findings
  domain/            the shapes (Zod) and the allowed status moves
```

Layers: routes → services → database. Workers → scan runner → git + detector → database.

## API

| Request | Answer |
|---|---|
| `POST /scans` `{repoUrl}` | 202 new scan · 200 the scan already running for that repo · 400 bad URL |
| `GET /scans` | All scans, newest first |
| `GET /scans/:scanId` | Status, progress, error · 404 |
| `GET /scans/:scanId/findings?limit=&cursor=` | `{findings, nextCursor}`; pass `nextCursor` back for the next page |
| `POST /scans/:scanId/stop` | 202 · 409 if already finished |
| `POST /scans/:scanId/resume` | 202 · 409 if not `stopped`/`failed` |
| `GET /health` | 200 |

## What counts as a leak

- **Access key ID:** `AKIA`, `ASIA`, `ABIA` or `ACCA` followed by 16 capital letters or digits.
- **Secret access key:** 40 characters of letters, digits, `/` and `+`, on a line that also has a name like
  `aws_secret_access_key`, `AWS_SECRET` or `secretAccessKey`. Pure lowercase hex is skipped (those are git SHAs).
- Only **added** lines in normal commits. A removed line was added by an earlier commit, which we also scan. Merge
  commits are skipped because they only combine lines that were added elsewhere.

## Deployment

- One Docker image with Node 24 and git. The `api` service runs `apiMain.js`; the `worker` service runs `workerMain.js`
  with 2 copies.
- They share one Docker volume with the SQLite file. Each worker keeps its downloads inside its own container.
- SQLite is fine for several containers on one machine. Several machines need Postgres.
- `GITHUB_TOKEN` is optional (public repos don't need it) and only the workers get it.

## Not built (on purpose)

- Splitting one giant repo across workers.
- Scanning merge commits ("evil merges").
- Checking keys with AWS, other secret types, Git LFS files.
- Scanning only new commits since the last scan (incremental scans).
- Login on our own API.
- Postgres and a real message queue (next step after this version).

## Decision log

| Decision | Why | What we didn't pick |
|---|---|---|
| Clone with git, not the GitHub API | One download for all history; the API allows ~5,000 requests an hour and cuts big diffs | GitHub REST API |
| Blobless clone + one fetch per page | Fast start, disk grows as we go, few requests to GitHub | Full clone (slow start, all disk up front) |
| Mirror clone with PR refs | Find leaks even on deleted PR branches | Branches only |
| Sort commits ourselves | Git's own order can be wrong when commit dates are out of order | Trust `git log` order |
| Save ref tips once | The list stays the same, so "N commits done" stays true | Read branches again on resume |
| Findings + placeholder in one transaction | No gaps, no duplicates after a crash | Save them separately |
| Queue in the database, with leases and tokens | Nothing lost on a crash; safe with many workers | In-memory queue; Redis/SQS |
| Checked status changes | Every change is allowed and race-safe | Update status freely |
| SQLite | Nothing to install, real transactions | Postgres (for many machines) |
| Separate API and worker entry points | Each scales on its own; simple start-up files | One entry point with a `ROLE` switch |
| One slot per scan, many scans at once | Order and placeholder need one list | Split by branch (scans shared commits again) |
| Only added lines, skip merges | No double reports | Scan removed lines or merges |
| Delivery count reset on progress | Only stuck scans go to `failed`, not long ones | Count every try forever |
| Fastify | Input checks and clean shutdown built in | Express |
