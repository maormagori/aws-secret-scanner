# AWS Secret Scanner

A web service that clones a GitHub repo and scans every commit on every ref (branches, tags, pull requests), newest
commit first, for leaked AWS access key ids and secret access keys. Each finding has the commit, the committer and the
leaked value. Scans are jobs in a database queue, so a scan that is interrupted resumes from its last checkpoint.

## Run

```bash
docker compose up --build          # 1 api (port 3000) + 2 workers, sharing a SQLite volume
API_PORT=3100 docker compose up --build   # if port 3000 is taken on your machine (then use localhost:3100 below)
```

Or locally (Node 24+, `git` on the PATH), in two terminals:

```bash
npm ci && npm run dev:api     # terminal 1
npm run dev:worker            # terminal 2
```

Demo dashboard (live scans, findings and container logs): see [`demo-ui/README.md`](demo-ui/README.md).

Every log line starts with its role, `[api]` or `[worker]`, and also carries a `role` field.

Public repos need no token. For private repos set `GITHUB_TOKEN` (e.g. `GITHUB_TOKEN=ghp_… docker compose up`).

## API

```bash
# Create a scan: 202 {scan} for a new one, 200 with the active scan if this repo is already being scanned
curl -s -X POST localhost:3000/scans -H 'content-type: application/json' \
  -d '{"repoUrl":"https://github.com/maormagori/aws-leak-fixture"}'

# Status and progress
curl -s localhost:3000/scans/<scanId>
# {"scan":{"scanId":"…","status":"scanning","progress":{"scannedCommits":6,"totalCommits":14},"deliveryCount":1,…}}

# All scans, newest first
curl -s localhost:3000/scans

# Findings, a page at a time: pass the nextCursor you got back until it is null
curl -s 'localhost:3000/scans/<scanId>/findings?limit=100'
curl -s 'localhost:3000/scans/<scanId>/findings?limit=100&cursor=<nextCursor>'

# Stop a scan (it finishes the current batch first), then resume it from its checkpoint
curl -s -X POST localhost:3000/scans/<scanId>/stop
curl -s -X POST localhost:3000/scans/<scanId>/resume

curl -s localhost:3000/health
```

A finding:

```json
{
  "id": 13,
  "scanId": "883d07f5-dde4-4110-bac5-6fcc93ba4565",
  "commitSha": "f3964de6390aa1a5140e4b875c3f9f27acd5b1d7",
  "commitMessage": "Add release notes",
  "committedAt": "2025-01-09T10:00:00.000Z",
  "committerName": "Carol QA",
  "committerEmail": "carol@example.com",
  "authorName": "Carol QA",
  "authorEmail": "carol@example.com",
  "filePath": "release/notes.txt",
  "lineNumber": 4,
  "leakType": "aws_secret_access_key",
  "leakValue": "UNEhEkk/iqq8vH2BzNZV45pFCiRcDCajhDieQjEJ"
}
```

Errors: 400 for an invalid repo URL or query, 404 for an unknown scan, 409 for stopping a finished scan or resuming one
that is not `stopped`/`failed`.

## Config

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | API port |
| `DATA_DIR` | `./data` | Directory created at start for local data |
| `DATABASE_FILE` | `./data/scanner.db` | SQLite file, shared by the api and workers |
| `CLONES_DIR` | `./data/clones` | Where workers clone repos; wiped when a worker starts |
| `GITHUB_TOKEN` | — | Optional, for private repos; sent as a header, never in the URL |
| `WORKER_CONCURRENCY` | `3` | Scans one worker process runs at once |
| `LEASE_MS` | `30000` | How long a claim lasts without a heartbeat |
| `POLL_MS` | `1000` | How often an idle slot looks for a queued scan |
| `BATCH_SIZE` | `200` | Commits per page; each page commits its findings and the checkpoint together |
| `MAX_DELIVERIES` | `3` | Deliveries in a row without progress before the scan goes to `failed` (our DLQ) |
| `RETRY_BASE_MS` | `5000` | Retry backoff base: `RETRY_BASE_MS × 2^(deliveryCount - 1)` |
| `CLONE_TIMEOUT_MS` | `600000` | Clone timeout |
| `BIG_FILE_THRESHOLD` | `50m` | Blobs bigger than this are treated as binary by git and skipped |
| `LOG_LEVEL` | `info` | pino log level |

## How it works

- **Blobless mirror clone:** `git clone --mirror --filter=blob:none` gets every branch, tag and PR ref, but only
  commits and trees. Before each page is diffed, the file contents it needs are fetched in one request.
- **Strict sort:** the ref tips are frozen on the first clone; every commit reachable from them is listed once and
  sorted by committer time (newest first), then SHA. Git's own order isn't strict under clock skew.
- **Pages + checkpoint in one transaction:** each page of `BATCH_SIZE` commits is diffed with `git log -p`, added lines
  go through the detector, and the findings and the new checkpoint are written in one transaction. A unique key on
  findings means a replayed page never duplicates them.
- **Leases + fencing:** a worker claims a scan with a lease and a fencing token, renews it with a heartbeat, and every
  write it makes checks the token. A worker that lost its lease can't write anything.
- **State machine:** `queued → cloning → scanning → completed`, plus `failed` and `stopped`. Every change is a
  compare-and-set on the current status.
- **Retries / DLQ:** retryable errors (network, timeout) go back to `queued` with exponential backoff. `deliveryCount`
  counts deliveries in a row without progress; after `MAX_DELIVERIES` the scan goes to `failed`. Bad repo or token
  fails at once. A crashed worker's scan is picked up when its lease expires and resumes at the checkpoint.
- **Roles:** one image, two entry points: `apiMain` serves HTTP, `workerMain` runs scans. They only share the database.

Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/DESIGN_DECISIONS.md`](docs/DESIGN_DECISIONS.md),
[`docs/ERD.md`](docs/ERD.md).

## Scaling and limits

See [Big repos](docs/ARCHITECTURE.md#big-repos). Add worker containers to scan more repos at once; one scan runs
in order on one worker. SQLite works for several processes on one host; several hosts need Postgres (new SQL in the
repositories, and repository calls become async).

Not built: sharding one huge repo across workers, scanning merge diffs (`--cc`), verifying keys against AWS, other
secret types, Git LFS content, incremental rescans, and auth on this API.
