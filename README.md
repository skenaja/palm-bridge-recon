# bridge-recon

Automated reconciliation of the Palm ⇄ Ethereum ChainBridge, with a static dashboard.
**No backend** — the git repo *is* the database, and a daily GitHub Action keeps it current.

- **Source of truth:** committed event logs in [`data/`](data/) (`{palm,ethereum}-logs.jsonl`).
  These rebuild the DB but are *not* served to browsers.
- **Working state:** `bridge.db` (SQLite) is ephemeral and git-ignored — rebuilt from the
  JSONL on every run.
- **Dashboard input:** [`web/public/data/reconcile.json`](web/public/data/) — small, served
  as a static asset. The dashboard reads only this file, never the bulk logs.
- **Dashboard:** a Vite + React app in [`web/`](web/) that shows unreconciled transfers.
  Deployed on Cloudflare Pages.

## Daily cycle (GitHub Action)

```
import (JSONL → rebuild bridge.db)
  → fetch (scan only new blocks since the last commit)
  → export (bridge.db → deterministic JSONL)
  → reconcile --json (write reconcile.json)
  → git commit the diff → push → Cloudflare Pages auto-deploys
```

See [.github/workflows/reconcile.yml](.github/workflows/reconcile.yml). It commits only when
data actually changed, so quiet days produce no commit and no deploy.

## CLI

```
npm install                                  # better-sqlite3, ethers

node bridge-db.js import palm|ethereum       # rebuild DB from committed JSONL (+ seed cursor)
node bridge-db.js fetch  palm|ethereum       # sync new events up to chain tip
node bridge-db.js export                     # DB → deterministic JSONL (both chains)
node bridge-db.js reconcile [--json] [--summary]
node bridge-db.js gaps   palm|ethereum       # deposit-nonce gaps + re-fetch ranges
node bridge-db.js status                     # row counts + fetch progress

npm run sync   # import → fetch → export → reconcile --json  (what the Action runs)
```

Your old daily habit `fetch palm && fetch ethereum && reconcile` still works; `npm run sync`
is the full committed-state version.

## Configuration (RPC / secrets)

RPC URLs come from the environment — no keys are committed.

- Local: `cp .env.example .env` and set `INFURA_KEY` (or full `PALM_RPC` / `ETHEREUM_RPC`).
- CI: add repo secret **`INFURA_KEY`** (Settings → Secrets and variables → Actions).

## Deploy (Cloudflare Pages, Git integration)

One-time, in the Cloudflare dashboard:

1. **Workers & Pages → Create → Pages → Connect to Git**, pick this repo.
2. Build settings:
   - **Root directory:** `web`
   - **Build command:** `npm run build`
   - **Output directory:** `dist`
3. Deploy. Every push — including the bot's daily data commits — auto-builds and redeploys
   with fresh data served at `/data/*`.

## Bridge semantics

```
Palm → Eth:  Palm.Deposit(nonce N, destChain=1)     matches  Ethereum.ProposalEvent(originChain=2, nonce N, status=3)
Eth → Palm:  Ethereum.Deposit(nonce N, destChain=2) matches  Palm.ProposalEvent(originChain=1, nonce N, status=3)
```

ProposalEvent status: 1=Created, 2=Passed, 3=Executed, 4=Cancelled. An unreconciled item is
a `Deposit` with no matching `status=3` proposal on the destination chain. The dashboard
flags `NO_PROPOSAL` (nothing started) vs `IN_PROGRESS(...)` vs `CANCELLED`.
