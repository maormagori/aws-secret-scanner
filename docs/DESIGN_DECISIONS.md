# Design decisions, explained

Each decision has the same shape: **what** we chose, **why**, **what we gave up**, and **the question you'll likely get
and a short answer**. The one-line version of each lives in the decision log in [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. Git clone instead of the GitHub API

**What.** Each scan clones the repo with `git clone --mirror --filter=blob:none` and reads history with local `git`
commands.

**Why.**
- The API needs one request per commit to get its diff (`GET /repos/{o}/{r}/commits/{sha}`). The rate limit is 5,000
  requests/hour with a token, so a repo with 1M commits takes about 200 hours.
- The API **loses data** on big commits: it returns at most 3,000 files per commit, and drops the `patch` text for
  large diffs. A secret scanner that silently skips big diffs is wrong, not just slow.
- Covering all branches through the API means listing every branch, paging each one, and merging them by date while
  removing shared commits. With a clone, `git` already knows the whole commit graph.

**What we gave up.** We depend on the `git` binary (it's in the Docker image) and need local disk for the clone.

**Likely question:** *"The assignment says handle rate limits and pagination. Why didn't you?"*
Those requirements belong to the API option. We chose the clone option, which the assignment allows, and its
requirement is "clear the files at the end", which we do. If we had used the API: 100 commits per page, follow the
`Link` header, read `X-RateLimit-Remaining`/`X-RateLimit-Reset` and sleep until the reset, honor `Retry-After` for
secondary limits, and keep a page cursor per branch as the checkpoint.

---

## 2. Blobless clone (paging the download)

**What.** `--filter=blob:none` downloads all commits and directory trees, but not file contents. Before each page of
commits is diffed, we list the file versions the page needs (`git diff-tree`, local), skip the ones we already have,
and download the rest in **one** `git fetch` (blob SHAs on stdin). Git's own on-demand fetch stays on as a fallback.

**Why.** It turns one huge download into one small download per page, in the same order as the scan:
- The first findings come fast, instead of after a 10 GB clone.
- Disk use grows with progress instead of all up front.
- The commit list (needed for sorting) arrives in seconds, because commits and trees are small.

**Why the prefetch step.** Left alone, `git log -p` in a blobless clone fetches missing contents about once per commit
(measured on the fixture: 12 fetches for 13 commits). For a million commits that's a million small requests, the
pattern GitHub is most likely to throttle. With the prefetch it's one request per page of 200 commits (fixture: 12 → 1).
Git traffic isn't counted in the REST API's 5,000/hour, but GitHub does throttle heavy git traffic, especially without a
token; a throttled fetch fails the page, and the scan retries with backoff from its placeholder.

**What we gave up.** The scan needs the network the whole time, not only at the start. A network error mid-scan is a
retryable failure: back to the queue, resume from the checkpoint. For a repo GitHub would throttle even at one fetch
per page, a full clone (one download, zero calls during the scan) is the better trade.

**Likely question:** *"How do you handle paging for a huge repo?"* Paging happens at three layers:
1. **Download:** blobless clone; contents fetched in one request per page of commits.
2. **Processing:** pages of 200 commits (`BATCH_SIZE`); each page writes its findings and the checkpoint in one
   transaction.
3. **Results:** the findings API uses a keyset cursor.

---

## 3. Mirror clone: every ref, each commit once

**What.** `--mirror` fetches `refs/heads/*` (branches), `refs/tags/*`, `refs/pull/*` (every PR, including ones from
forks and closed ones) and notes. We list every commit reachable from any of them.

**Why.** The assignment asks for non-main branches; we went as inclusive as possible. A secret pushed to a PR branch
that was later deleted is still on GitHub under `refs/pull/N/head`, and still a leak.

**Each commit once.** Branches share most of their history. We scan **commits**, not branches, so a commit reachable
from 500 branches is scanned one time.

**Likely question:** *"What about commits that no ref reaches?"* They can't be fetched with git at all (GitHub only
serves reachable objects over git). We note it as a limit.

---

## 4. Strict order by committer time, sorted by us

**What.** We list every commit with its committer timestamp, sort it ourselves (newest first, ties broken by SHA), and
then ask git for diffs in exactly that order (`git log -p --no-walk=unsorted --stdin`).

**Why.** "Descending by commit time" is a requirement. Git's own `log` order follows the commit graph and can be wrong
when clocks are skewed (a child commit dated before its parent happens with rebases and bad clocks). The fixture repo
has a commit like that on purpose.

**Why committer time, not author time.** Committer time is when the commit was created in this history (a rebase
updates it); author time is when the change was first written. The assignment says "commit time".

**What we gave up.** The whole list (SHA + timestamp) sits in memory: about 100 MB per 1M commits. Fine up to millions.
Beyond ~10M commits: sort on disk, or work in time windows (see 13).

---

## 5. Only added lines, no merge diffs

**What.** We scan lines that start with `+` in the diffs of non-merge commits. Binary files are skipped.

**Why.**
- A leak enters history when it's **added**. A removed line was added by an earlier commit, which we also scan, so
  scanning removals would only report the same leak twice.
- A normal merge commit brings in nothing new: every line already came from a commit on one of its parents.

**What we gave up — evil merges.** If someone types something new while resolving a merge conflict, that line exists
only in the merge commit and we miss it. The fix is `git log -p --cc`, which shows only lines that differ from all
parents. It uses a different diff format (two marker columns), so it needs its own parser. Documented, not built.

---

## 6. Resume: frozen ref tips + a checkpoint in the same transaction

**What.**
- When a scan first clones, it saves `refTips`: every ref name and the commit it points to.
- The commit list is always built from those frozen tips, so on every resume it's the **same list in the same order**.
- The checkpoint is `scannedCommits` (how many from the top are done) plus `lastScannedSha` (to confirm the list still
  matches).
- Each page of commits writes its findings **and** advances the checkpoint in **one database transaction**.

**Why.**
- If we re-read the refs on resume, new pushes would add commits at the top of the list, and "commit #5,000" would
  point at a different commit. Freezing makes the position a valid placeholder.
- Same transaction = no gap and no double count. Either both the findings and the new checkpoint are saved, or neither.
- The unique key on findings `(scanId, commitSha, filePath, lineNumber, leakValue)` with `INSERT OR IGNORE` is a second
  safety net: replaying a page can never create duplicates.

**What we gave up.** Commits pushed after the scan started aren't in that scan. A new scan picks them up. Incremental
rescans would reuse the frozen tips as the starting point (documented as an extension).

**Failure case:** if history was force-pushed and a frozen tip commit no longer exists on GitHub, the scan fails with a
clear message instead of silently scanning a different list.

**Likely question:** *"What exactly is your placeholder?"* An index into a deterministic, frozen, sorted commit list,
saved atomically with that page's findings.

---

## 7. The scan state machine

**What.** Six states: `queued → cloning → scanning → completed`, plus `failed` and `stopped`.

| From | To | When |
|---|---|---|
| queued | cloning | a worker claims it |
| cloning | scanning | clone ready, ref tips frozen |
| scanning | completed | last page written |
| cloning / scanning | queued | retryable error (with backoff), or graceful shutdown |
| cloning / scanning | failed | non-retryable error, deliveries used up, or abandoned `maxDeliveries` times (checked at claim) |
| queued / cloning / scanning | stopped | stop requested |
| stopped / failed | queued | resume requested |
| cloning / scanning | cloning | another worker reclaims it after the lease expired |

**Why a state machine.**
- Every allowed move is listed in one table (`SCAN_TRANSITIONS`). Anything else is a bug and throws.
- Every move is a **compare-and-set** write: `UPDATE … SET status = :to WHERE id = :id AND status = :from AND
  leaseToken = :token`. If someone else changed the scan first, 0 rows change and the caller learns it lost; it never
  overwrites.

**Why `cloning` and `scanning` are separate.** The API can show which phase a scan is in, and progress
(`scannedCommits / totalCommits`) only means something in `scanning`.

---

## 8. Database queue with leases and fencing tokens

**What.** Scans are rows in the database; workers poll for work.
- **Claim:** one transaction picks the oldest claimable scan and marks it as ours.
- **Lease:** the claim is valid until `leaseExpiresAt`. The worker renews it every `leaseMs / 3`. If the worker
  crashes, renewals stop, the lease expires, and any worker can claim the scan again.
- **Fencing token:** `leaseToken` goes up by one on every claim. Every write a worker makes includes the token it
  claimed with.

**Why the fencing token matters.** A worker can be alive but stalled (long GC pause, slow disk). Its lease expires,
worker B claims the scan (token 7 → 8), and then worker A wakes up and tries to write with token 7. The write matches
0 rows, so A learns it lost the scan and stops. Without the token, A and B would both write findings and checkpoints
for the same scan.

**Why not an in-memory queue.** It's lost on crash. The database queue makes "the process died" a normal case:
the lease expires and work continues elsewhere.

**Likely question:** *"Can two workers ever scan the same repo at the same time?"* No:
- Claiming happens in a `BEGIN IMMEDIATE` transaction, so two claims can't pick the same row.
- A stalled worker that lost its lease is stopped by the fencing token on its next write.
- A unique index allows only one active scan per repo.

---

## 9. Retries, backoff, delivery count and the dead-letter state

**What.**
- **Non-retryable** (fail at once): repo not found, authentication failed, history rewritten.
- **Retryable**: network errors, timeouts, unknown errors. The scan goes back to `queued` with
  `runAfter = now + retryBaseMs × 2^(deliveryCount - 1)` (5 s, 10 s, 20 s, …).
- **`deliveryCount`** works like an SQS receive count: it goes up by one on every claim, not when a run fails. A crashed
  worker can't report anything, so counting at the claim is the only way a crash is counted.
- **`failed` is the dead-letter queue.** The limit (`maxDeliveries`, default 3) is checked in two places:
  - **At claim:** inside the claim transaction, every running scan with an expired lease and
    `deliveryCount >= maxDeliveries` is moved to `failed` ("Scan was abandoned by workers 3 times without progress")
    instead of being claimed again. Without this, a repo that crashes the worker every time would loop forever.
  - **On a reported failure:** the worker re-reads the scan and retries only while `deliveryCount < maxDeliveries`.
- **Progress resets the count.** Every saved page sets `deliveryCount = 1` (the current delivery), so it means
  "deliveries in a row without progress". A huge repo that crashes now and then but keeps moving is never failed.
- **`POST /resume` (the redrive)** sets `deliveryCount = 0`.
- **A graceful shutdown refunds** the delivery (`deliveryCount - 1`): stopping the worker is not the scan's fault.

**Why.** Retrying a 404 wastes time; giving up on a network blip wastes the scan. Exponential backoff avoids hammering
GitHub while it's having trouble. Counting at claim and resetting on progress is what lets crashes be counted at all
without punishing slow-but-moving scans.

---

## 10. Stop and resume

**What.** `POST /scans/:id/stop` sets `stopRequested`. A queued scan stops at once; a running one notices at its next
heartbeat and stops after the current page, so the checkpoint is always on a page boundary.
`POST /scans/:id/resume` moves a `stopped` or `failed` scan back to `queued` with its `deliveryCount` reset; it continues from
its checkpoint.

**Why a flag instead of killing the worker.** The worker owns the scan and is the only one allowed to write it (fencing
token). The API asks; the worker decides when it's safe to stop.

---

## 11. Concurrency model

**What.**
- Each worker process runs `workerConcurrency` slots (default 3); each slot claims and runs one scan at a time.
- You can run several worker containers. They all claim from the same database.
- One scan is processed in order; many scans run at once.

**Why not parallel inside one scan.** Order is a requirement, and splitting by branch would rescan shared commits.
The right unit for splitting one huge repo is a **range of the sorted commit list** (see 13).

**Where races are handled.**
| Race | Guard |
|---|---|
| Two workers claim the same scan | Claim is one `BEGIN IMMEDIATE` transaction |
| A stalled worker writes after losing its lease | Fencing token on every write |
| Two API requests create a scan for the same repo | Unique partial index on active `repoUrl`; the loser gets the existing scan |
| A page is replayed after a crash | Findings unique key + checkpoint in the same transaction |
| Stop arrives while a page is mid-write | Checked between pages; transitions are compare-and-set |
| Two scans' git files collide, or a stalled worker deletes the new owner's clone | One clone directory per claim (`<scanId>-<leaseToken>`); each worker only deletes its own |

---

## 12. SQLite now, Postgres for multi-host

**What.** SQLite through Node's built-in `node:sqlite`, in WAL mode, on a shared Docker volume.

**Why.** No extra service or package, real transactions, and WAL lets several processes on **one host** read and write
safely (with `busy_timeout` for short waits).

**What we gave up.** SQLite can't be shared across hosts. For that, swap the two repositories for Postgres versions;
the claim becomes `SELECT … FOR UPDATE SKIP LOCKED`. All SQL lives in the repositories, so the queries change only there. One honest catch: `node:sqlite`
is synchronous, so repository methods return plain values today. A Postgres driver is async, so the repository
methods would return Promises and the runner, pool and service would `await` them: a mechanical change, but not a
repository-only one.

**Why SQLite is enough on one host.** File locks let several processes share the file; `BEGIN IMMEDIATE` takes the
write lock before reading, so two workers can't claim the same scan; WAL lets the API read while a worker writes. The
limits are real but elsewhere: one host only (locks aren't reliable over network filesystems) and one writer at a time
(fine for our small, infrequent writes; not for hundreds of workers).

---

## 13. Large tenants, branches, files

| Dimension | What we do | If it gets bigger |
|---|---|---|
| Many commits | Stream diffs line by line; checkpoint per page; list in memory (~100 MB/1M) | Sort on disk, or page by time windows (checkpoint = window + index) |
| Many branches/PRs | One mirror fetch; scan commits, not branches | — |
| Large files | Streamed; `core.bigFileThreshold` (50 MB) makes git treat bigger blobs as binary and skip them; `--no-renames` avoids slow rename detection | Raise the threshold, or scan big blobs in a separate pass |
| Huge clone | Blobless clone; deleted as soon as the worker lets go | — |
| Many repos | Each is a queued scan; add worker containers | Postgres for many hosts |
| One giant repo | — | **Sharding:** split the frozen sorted list into ranges, each its own job and checkpoint; a parent scan completes when all its ranges do; the API sorts findings by `committedAt` |
| Many findings | Keyset cursor | — |

**Why sharding is design-only.** It needs parent/child jobs and a clone per shard. It's about an hour of work; the
frozen sorted list is what makes it possible, and that part is built.

**Trade-off on big files:** skipping blobs over 50 MB could miss a key inside one. It's a config value; we chose
predictable memory and time over scanning generated or vendored blobs.

---

## 14. Containers: one image, two entry points

**What.** One Docker image. `src/apiMain.ts` starts the API, `src/workerMain.ts` starts the worker pool; both call
`src/bootstrap.ts` for what they share (config, logger, DB, repositories, shutdown handling). Compose runs one `api`
container and two `worker` containers, each with its own `command`, sharing a volume for the SQLite file. Each worker's
clones stay inside its own container. Every log line carries its role as a prefix (`[api] …`, `[worker] …`) and as a
structured field.

**Why.** The API is light and must answer fast; workers are heavy (git, disk, CPU). Separate entry points let them
scale separately, let a worker crash without taking the API down, and make each start-up file read top to bottom with no
role branching. One image keeps the build simple.

**What we gave up.** Running locally takes two processes (`npm run dev:api`, `npm run dev:worker`). The earlier version
used one entry point with `ROLE=api|worker|all`: fewer files and one command for dev, but every process loaded all the
code and the start-up had role `if`s.

---

## 15. Detection rules

- **Access key ID:** `\b(AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b`. These prefixes are AWS's documented ID formats (`AKIA`
  long-term user keys, `ASIA` temporary STS keys).
- **Secret access key:** 40 characters of `[A-Za-z0-9/+=]` on a line that also has an AWS-secret keyword. A bare
  40-character string is too common (hashes, tokens) to report without context.
- No call to AWS to check if a key is live, and no entropy scoring (out of scope).
- The full value is stored and returned, because the assignment asks for the leak value. In production you'd mask it
  in the API.

---

## 16. Code structure

**What.** Layers: API routes → services → repositories; workers → scan runner → git client + detector. Factory
functions (`createScanRepository(db)`) with dependencies passed in; Zod schemas as the single source of truth for
types.

**Why.** Each file has one job and can be tested with real dependencies (in-memory SQLite) instead of mocks. The
`GitClient` interface exists so the scan runner could be built and tested in parallel with the real git code.

---

## 17. Things we chose not to build (and would say so)

- Sharding one repo across workers (13).
- Merge-commit diffs / evil merges (5).
- Incremental rescans (6).
- Live-key verification, entropy, other secret types (15).
- Git LFS contents (only pointer files are scanned).
- Auth on our own API.
- Concurrency tests (the design covers it; the assignment doesn't ask for tests).

---

## 18. How workers fetch work: polling the database

**What.** Each worker slot loops: `claimNextScan` → if nothing, wait `pollMs` (1 s) → try again. The claim takes the
oldest scan that is `queued` (and past its `runAfter`, not stop-requested) **or** running with an expired lease, in one
`BEGIN IMMEDIATE` transaction, and marks it ours: status `cloning`, new lease, `leaseToken + 1`, `deliveryCount + 1`. Before picking, the same transaction
moves scans that ran out of deliveries to `failed` (see 9).

**Why polling.**
- The database is the queue: nothing is lost if a process dies, and picking up orphans is the same query as picking up
  new work (no separate reaper).
- No extra infrastructure (Redis, SQS, RabbitMQ).
- Cost: one indexed query per idle slot per second, and up to 1 s before a new scan starts. Negligible for scans that
  take minutes.

**At scale.** Postgres: `SELECT … FOR UPDATE SKIP LOCKED` so many workers claim in parallel without waiting on each
other; `LISTEN/NOTIFY` to wake workers on insert, with polling kept as the fallback for leases and backoffs. A broker
only for very high volume, and even then the database stays the source of truth for state and checkpoints.

**Known gap: fairness.** Oldest-first is FIFO across everyone, so one tenant queuing 1,000 repos delays the rest. Fix: a
per-tenant cap in the claim query, which needs a tenant on the scan (see 19).

---

## 19. No `repos` table (yet)

**What.** A repo is its normalized URL, stored on each scan. No separate `repos` table.

**Why.** A repo has one attribute today, its URL, and nothing in the assignment is per repo. Everything we need works
without it: one active scan per repo (unique partial index), a repo's history (`WHERE repoUrl = ?`), one spelling per
repo (`parseRepoUrl` normalizes).

**When it would come in.** The day a repo has real columns:
- incremental rescans: `lastCompletedScanId`, `lastRefTips` (scan only what's new since then);
- tenants/orgs: `tenantId`, scan a whole org, fairness between tenants (18);
- per-repo settings: token reference, schedule, ignored paths;
- identity across renames: GitHub's numeric repo id.

**Likely question:** *"Why isn't the repo its own entity?"* "I didn't add a table that only holds a URL. Incremental
rescans or tenants would give it real columns, and that's when it comes in."

---

## 20. Streaming unit: one commit, not one line

**What.** `git log -p` output is read line by line from the pipe (`readline`), and git pauses when we read slower, so
the pipe never holds more than a small buffer. The diff parser, though, collects every **added** line of the current
commit in an array (`CommitDiff.addedLines`) and hands the whole commit to the runner when the next commit starts. The
runner runs the detector on those lines and keeps only the findings. Removed lines, context lines and binary files are
never kept.

**Why.** A commit is a natural unit: the parser's output is a plain value that is easy to test, and the runner sees one
complete commit with its metadata. For normal commits the array is tiny.

**What we gave up.** Memory per commit grows with its added lines. A commit that adds a 40 MB text file holds those
lines until the commit ends. Separately, `readline` needs a whole line, so a single 30 MB line (minified JS) is one 30 MB
string. `core.bigFileThreshold` (50 MB) caps the worst case by making git skip bigger files as binary.

**The fix if it matters.** Run the detector inside the stream: the parser takes an `onAddedLine` callback (or yields
lines instead of commits), the detector checks each added line right away, and only findings are kept. Memory per
commit then becomes its findings, not its lines. For giant single lines: lower the threshold or cut lines above a set
length (risk: a key past the cut is missed).
