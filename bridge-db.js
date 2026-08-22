// bridge-db.js
//
// Unified CLI for fetching, storing, and reconciling Palm <-> Ethereum ChainBridge events.
//
// Commands:
//   node bridge-db.js fetch <palm|ethereum>          Sync from last saved position up to chain tip
//   node bridge-db.js fetch <palm|ethereum> --from-block <N>   Override start block (backfill)
//   node bridge-db.js reconcile [--json] [--summary]  Find stuck/mismatched bridge transfers
//   node bridge-db.js export                          Write deterministic JSONL for both chains
//   node bridge-db.js gaps <palm|ethereum>            Show deposit nonce gaps with inferred block ranges
//   node bridge-db.js status                          Show DB stats and fetch progress
//   node bridge-db.js import <palm|ethereum>          Import committed .jsonl into DB (rebuild state)
//
// DB file: ./bridge.db  (SQLite, ephemeral — git-ignored, rebuilt from committed JSONL)
// Data:    ./web/public/data/{palm,ethereum}-logs.jsonl  (committed source of truth)
//          ./web/public/data/reconcile.json              (dashboard input)
//
// Bridge flow:
//   Palm→Eth:  Palm.Deposit(nonce N, destChain=1)  must match  Ethereum.ProposalEvent(originChain=2, nonce N, status=3)
//   Eth→Palm:  Ethereum.Deposit(nonce N, destChain=2)  must match  Palm.ProposalEvent(originChain=1, nonce N, status=3)
//
// ProposalEvent statuses: 1=Created, 2=Passed, 3=Executed, 4=Cancelled

const Database = require('better-sqlite3');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ─── .env loader (dependency-free; CI supplies env directly) ───────────────────

function loadDotenv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}
loadDotenv();

// ─── Config ──────────────────────────────────────────────────────────────────

const INFURA_KEY   = process.env.INFURA_KEY;
const PALM_RPC     = process.env.PALM_RPC     || (INFURA_KEY ? `https://palm-mainnet.infura.io/v3/${INFURA_KEY}` : null);
const ETHEREUM_RPC = process.env.ETHEREUM_RPC || (INFURA_KEY ? `https://mainnet.infura.io/v3/${INFURA_KEY}` : null);

const PALM_BRIDGE_CONTRACT     = '0xB3C62Aed3be8e0577D4724C40a01379dbf895C01';
const ETHEREUM_BRIDGE_CONTRACT = '0x7D0e63736aEb136aCd44C70D6e1A0f27fb897679';

const PALM_START_BLOCK     = 423355;
const ETHEREUM_START_BLOCK = 12766517;

const PALM_CHAIN_ID     = 2;
const ETHEREUM_CHAIN_ID = 1;

const BATCH_SIZE = 1000;

const BRIDGE_ABI = [
  'event Deposit(uint8 indexed destinationChainID, bytes32 indexed resourceID, uint64 indexed depositNonce)',
  'event ProposalEvent(uint8 indexed originChainID, uint64 indexed depositNonce, uint8 indexed status, bytes32 resourceID, bytes32 dataHash)',
  'event ProposalVote(uint8 indexed originChainID, uint64 indexed depositNonce, uint8 indexed status, bytes32 resourceID)',
];

const PROPOSAL_STATUS = { 1: 'Created', 2: 'Passed', 3: 'Executed', 4: 'Cancelled' };

// ─── Reconcile whitelist ──────────────────────────────────────────────────────
// Entries here are silently excluded from reconcile output.
// Format: { direction: 'palm>ethereum' | 'ethereum>palm', nonce: string }

const RECONCILE_WHITELIST = [
  { direction: 'ethereum>palm', nonce: '8019' },
];

// ─── Paths ───────────────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, 'bridge.db');

// Bulk event logs: committed source of truth, used to rebuild the DB. NOT served by the
// frontend, so it lives outside web/public/ (CF Pages has a 25 MiB per-file limit and the
// dashboard never downloads these — it only reads reconcile.json).
const DATA_DIR = path.join(__dirname, 'data');

// Dashboard input: small, served as a static asset by the Vite build at /data/reconcile.json.
const WEB_DATA_DIR = path.join(__dirname, 'web', 'public', 'data');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureWebDataDir() {
  fs.mkdirSync(WEB_DATA_DIR, { recursive: true });
}

function rpcFor(network) {
  const url = network === 'palm' ? PALM_RPC : ETHEREUM_RPC;
  if (!url) {
    console.error(
      `No RPC URL for ${network}. Set INFURA_KEY (or ${network === 'palm' ? 'PALM_RPC' : 'ETHEREUM_RPC'}) ` +
      `in the environment or a local .env file.`,
    );
    process.exit(1);
  }
  return url;
}

// ─── DB setup ────────────────────────────────────────────────────────────────

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      chain            TEXT    NOT NULL,
      event_name       TEXT    NOT NULL,
      block_number     INTEGER NOT NULL,
      tx_hash          TEXT    NOT NULL,
      deposit_nonce    TEXT    NOT NULL DEFAULT '',
      resource_id      TEXT    NOT NULL DEFAULT '',
      destination_chain_id TEXT NOT NULL DEFAULT '',
      origin_chain_id  TEXT    NOT NULL DEFAULT '',
      status           TEXT    NOT NULL DEFAULT '',
      data_hash        TEXT    NOT NULL DEFAULT '',
      UNIQUE(chain, event_name, tx_hash, deposit_nonce, status)
    );

    CREATE INDEX IF NOT EXISTS idx_logs_chain_event   ON logs(chain, event_name);
    CREATE INDEX IF NOT EXISTS idx_logs_deposit_nonce ON logs(deposit_nonce);
    CREATE INDEX IF NOT EXISTS idx_logs_block         ON logs(chain, block_number);
    CREATE INDEX IF NOT EXISTS idx_logs_join          ON logs(chain, event_name, deposit_nonce);

    CREATE TABLE IF NOT EXISTS fetch_progress (
      chain          TEXT PRIMARY KEY,
      next_from_block INTEGER NOT NULL,
      updated_at     TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scanned_blocks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chain      TEXT    NOT NULL,
      batch_from INTEGER NOT NULL,
      batch_to   INTEGER NOT NULL,
      UNIQUE(chain, batch_from, batch_to)
    );

    CREATE INDEX IF NOT EXISTS idx_scanned_chain ON scanned_blocks(chain, batch_from, batch_to);
  `);
  return db;
}

// ─── ABI / parsing ───────────────────────────────────────────────────────────

const iface = new ethers.Interface(BRIDGE_ABI);
const EVENT_TOPICS = BRIDGE_ABI.map(e => iface.getEvent(e.match(/event (\w+)/)[1]).topicHash);

function parseLog(raw) {
  const parsed = iface.parseLog(raw);
  if (!parsed) return null;
  const base = {
    event_name:   parsed.name,
    block_number: raw.blockNumber,
    tx_hash:      raw.transactionHash,
    deposit_nonce:        '',
    resource_id:          '',
    destination_chain_id: '',
    origin_chain_id:      '',
    status:               '',
    data_hash:            '',
  };
  const a = parsed.args;
  if (parsed.name === 'Deposit') {
    return { ...base, destination_chain_id: a.destinationChainID.toString(), resource_id: a.resourceID, deposit_nonce: a.depositNonce.toString() };
  }
  if (parsed.name === 'ProposalEvent') {
    return { ...base, origin_chain_id: a.originChainID.toString(), deposit_nonce: a.depositNonce.toString(), status: a.status.toString(), resource_id: a.resourceID, data_hash: a.dataHash };
  }
  if (parsed.name === 'ProposalVote') {
    return { ...base, origin_chain_id: a.originChainID.toString(), deposit_nonce: a.depositNonce.toString(), status: a.status.toString(), resource_id: a.resourceID };
  }
  return null;
}

// ─── Fetch command ────────────────────────────────────────────────────────────

async function cmdFetch(network, overrideFromBlock) {
  const db = openDb();
  const provider = new ethers.JsonRpcProvider(rpcFor(network));
  const defaultStart = network === 'palm' ? PALM_START_BLOCK : ETHEREUM_START_BLOCK;
  const contractAddress = network === 'palm' ? PALM_BRIDGE_CONTRACT : ETHEREUM_BRIDGE_CONTRACT;

  const progress = db.prepare('SELECT next_from_block FROM fetch_progress WHERE chain = ?').get(network);
  const chainTip = await provider.getBlockNumber();

  let fromBlock = overrideFromBlock ?? progress?.next_from_block ?? defaultStart;
  console.log(`Chain: ${network} | from block: ${fromBlock} | chain tip: ${chainTip}`);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO logs
      (chain, event_name, block_number, tx_hash, deposit_nonce, resource_id, destination_chain_id, origin_chain_id, status, data_hash)
    VALUES
      (@chain, @event_name, @block_number, @tx_hash, @deposit_nonce, @resource_id, @destination_chain_id, @origin_chain_id, @status, @data_hash)
  `);

  const saveProgress = db.prepare(`
    INSERT INTO fetch_progress(chain, next_from_block, updated_at) VALUES(?,?,?)
    ON CONFLICT(chain) DO UPDATE SET next_from_block=excluded.next_from_block, updated_at=excluded.updated_at
  `);

  const alreadyScanned = db.prepare(`
    SELECT 1 FROM scanned_blocks
    WHERE chain = ? AND batch_from <= ? AND batch_to >= ?
  `);

  const recordScanned = db.prepare(`
    INSERT OR IGNORE INTO scanned_blocks(chain, batch_from, batch_to) VALUES(?,?,?)
  `);

  const insertBatch = db.transaction((rows, chain, batchFrom, batchTo) => {
    for (const row of rows) insert.run({ chain, ...row });
    recordScanned.run(chain, batchFrom, batchTo);
  });

  let inserted = 0;
  let skipped = 0;
  while (fromBlock <= chainTip) {
    const toBlock = Math.min(chainTip, fromBlock + BATCH_SIZE - 1);

    if (alreadyScanned.get(network, fromBlock, toBlock)) {
      process.stdout.write(`  blocks ${fromBlock}–${toBlock}... skipped (already scanned)\n`);
      skipped++;
      fromBlock = toBlock + 1;
      continue;
    }

    process.stdout.write(`  blocks ${fromBlock}–${toBlock}...`);

    let retryDelay = 5000;
    let rawLogs;
    while (true) {
      try {
        rawLogs = await provider.getLogs({
          address: contractAddress,
          topics: [EVENT_TOPICS],
          fromBlock,
          toBlock,
        });
        break;
      } catch (err) {
        const is429 = /429|rate.?limit|too many requests/i.test(err?.message ?? '');
        if (is429) {
          process.stdout.write(` rate limited, retry in ${retryDelay}ms...\n`);
          await new Promise(r => setTimeout(r, retryDelay));
          retryDelay = Math.min(retryDelay * 2, 60000);
        } else {
          console.error(`\nError: ${err.message}`);
          rawLogs = [];
          break;
        }
      }
    }

    const rows = rawLogs.map(parseLog).filter(Boolean);
    insertBatch(rows, network, fromBlock, toBlock);
    inserted += rows.length;
    process.stdout.write(` ${rawLogs.length} logs (${rows.length} parsed)\n`);

    saveProgress.run(network, toBlock + 1, new Date().toISOString());
    fromBlock = toBlock + 1;
  }

  if (skipped) console.log(`Skipped ${skipped} already-scanned batches.`);
  console.log(`Done. Inserted ${inserted} new rows into bridge.db`);
  db.close();
}

// ─── Reconcile command ────────────────────────────────────────────────────────

function cmdReconcile({ summary = false, json = false } = {}) {
  const db = openDb();

  // Palm→Eth: Palm Deposit (dest=1) should have a matching Ethereum ProposalEvent (origin=2, status=3)
  const palmStuck = db.prepare(`
    SELECT d.deposit_nonce, d.resource_id, d.block_number AS deposit_block, d.tx_hash AS deposit_tx,
           MAX(CASE WHEN p.status = '3' THEN 1 ELSE 0 END) AS executed,
           MAX(CASE WHEN p.status = '4' THEN 1 ELSE 0 END) AS cancelled,
           MAX(p.status) AS highest_status
    FROM logs d
    LEFT JOIN logs p
      ON p.chain = 'ethereum'
     AND p.event_name = 'ProposalEvent'
     AND p.origin_chain_id = '2'
     AND p.deposit_nonce = d.deposit_nonce
    WHERE d.chain = 'palm'
      AND d.event_name = 'Deposit'
      AND d.destination_chain_id = '1'
    GROUP BY d.deposit_nonce, d.resource_id, d.block_number, d.tx_hash
    HAVING executed = 0
    ORDER BY CAST(d.deposit_nonce AS INTEGER)
  `).all();

  // Eth→Palm: Ethereum Deposit (dest=2) should have a matching Palm ProposalEvent (origin=1, status=3)
  const ethStuck = db.prepare(`
    SELECT d.deposit_nonce, d.resource_id, d.block_number AS deposit_block, d.tx_hash AS deposit_tx,
           MAX(CASE WHEN p.status = '3' THEN 1 ELSE 0 END) AS executed,
           MAX(CASE WHEN p.status = '4' THEN 1 ELSE 0 END) AS cancelled,
           MAX(p.status) AS highest_status
    FROM logs d
    LEFT JOIN logs p
      ON p.chain = 'palm'
     AND p.event_name = 'ProposalEvent'
     AND p.origin_chain_id = '1'
     AND p.deposit_nonce = d.deposit_nonce
    WHERE d.chain = 'ethereum'
      AND d.event_name = 'Deposit'
      AND d.destination_chain_id = '2'
    GROUP BY d.deposit_nonce, d.resource_id, d.block_number, d.tx_hash
    HAVING executed = 0
    ORDER BY CAST(d.deposit_nonce AS INTEGER)
  `).all();

  const isWhitelisted = (direction, nonce) =>
    RECONCILE_WHITELIST.some(e => e.direction === direction && e.nonce === String(nonce));

  const palmFiltered = palmStuck.filter(r => !isWhitelisted('palm>ethereum', r.deposit_nonce));
  const ethFiltered  = ethStuck.filter(r => !isWhitelisted('ethereum>palm', r.deposit_nonce));
  const palmSkipped  = palmStuck.length - palmFiltered.length;
  const ethSkipped   = ethStuck.length - ethFiltered.length;

  function statusLabel(row) {
    if (!row.highest_status) return 'NO_PROPOSAL';
    if (row.cancelled)       return 'CANCELLED';
    return `IN_PROGRESS(${PROPOSAL_STATUS[row.highest_status] ?? row.highest_status})`;
  }

  function groupByStatus(rows) {
    const groups = {};
    for (const r of rows) {
      const label = statusLabel(r);
      (groups[label] ??= []).push(r);
    }
    return groups;
  }

  // ── JSON output for the dashboard ──
  if (json) {
    ensureWebDataDir();
    const toRows = rows => rows.map(r => ({
      nonce:      r.deposit_nonce,
      block:      r.deposit_block,
      tx:         r.deposit_tx,
      resourceID: r.resource_id,
      status:     statusLabel(r),
    }));
    const countByStatus = rows => {
      const g = groupByStatus(rows);
      return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.length]));
    };
    const out = {
      generatedAt: new Date().toISOString(),
      totalUnexecuted: palmFiltered.length + ethFiltered.length,
      directions: {
        'palm>ethereum': {
          label: 'Palm → Ethereum',
          unexecuted: palmFiltered.length,
          whitelisted: palmSkipped,
          byStatus: countByStatus(palmFiltered),
          items: toRows(palmFiltered),
        },
        'ethereum>palm': {
          label: 'Ethereum → Palm',
          unexecuted: ethFiltered.length,
          whitelisted: ethSkipped,
          byStatus: countByStatus(ethFiltered),
          items: toRows(ethFiltered),
        },
      },
    };
    const outPath = path.join(WEB_DATA_DIR, 'reconcile.json');
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
    console.log(`Wrote ${path.relative(__dirname, outPath)} (${out.totalUnexecuted} unexecuted)`);
    db.close();
    return;
  }

  // ── Console output ──
  if (summary) {
    const palmGroups = groupByStatus(palmFiltered);
    const ethGroups  = groupByStatus(ethFiltered);
    console.log('\n=== Reconcile summary ===');
    console.log(`  Palm → Ethereum  ${palmFiltered.length} unexecuted${palmSkipped ? ` (${palmSkipped} whitelisted)` : ''}`);
    for (const [label, rows] of Object.entries(palmGroups)) {
      console.log(`    ${label}: ${rows.length}`);
    }
    console.log(`  Ethereum → Palm  ${ethFiltered.length} unexecuted${ethSkipped ? ` (${ethSkipped} whitelisted)` : ''}`);
    for (const [label, rows] of Object.entries(ethGroups)) {
      console.log(`    ${label}: ${rows.length}`);
    }
  } else {
    console.log('\n=== Palm → Ethereum (unexecuted) ===');
    if (palmFiltered.length === 0) {
      console.log(`  All Palm deposits have been executed on Ethereum.${palmSkipped ? ` (${palmSkipped} whitelisted)` : ''}`);
    } else {
      for (const r of palmFiltered) {
        console.log(`  nonce=${r.deposit_nonce}  block=${r.deposit_block}  status=${statusLabel(r)}`);
        console.log(`    tx=${r.deposit_tx}`);
        console.log(`    resourceID=${r.resource_id}`);
      }
      if (palmSkipped) console.log(`  (${palmSkipped} whitelisted)`);
    }

    console.log('\n=== Ethereum → Palm (unexecuted) ===');
    if (ethFiltered.length === 0) {
      console.log(`  All Ethereum deposits have been executed on Palm.${ethSkipped ? ` (${ethSkipped} whitelisted)` : ''}`);
    } else {
      for (const r of ethFiltered) {
        console.log(`  nonce=${r.deposit_nonce}  block=${r.deposit_block}  status=${statusLabel(r)}`);
        console.log(`    tx=${r.deposit_tx}`);
        console.log(`    resourceID=${r.resource_id}`);
      }
      if (ethSkipped) console.log(`  (${ethSkipped} whitelisted)`);
    }
  }

  console.log('');
  db.close();
}

// ─── Export command ────────────────────────────────────────────────────────────
//
// Dump the logs table to deterministic JSONL (stable sort), one file per chain.
// Deterministic ordering is what keeps git diffs clean and reviewable — without it
// every run rewrites the whole file. Emits the same camelCase schema `import` reads,
// so export/import stay symmetric.

function cmdExport() {
  const db = openDb();
  ensureDataDir();

  const selectChain = db.prepare(`
    SELECT event_name, block_number, tx_hash, deposit_nonce, resource_id,
           destination_chain_id, origin_chain_id, status, data_hash
    FROM logs
    WHERE chain = ?
    ORDER BY block_number,
             CAST(deposit_nonce AS INTEGER),
             event_name,
             status,
             tx_hash
  `);

  for (const network of ['palm', 'ethereum']) {
    const rows = selectChain.all(network);
    const lines = rows.map(r => {
      const o = { eventName: r.event_name, blockNumber: r.block_number, hash: r.tx_hash };
      if (r.deposit_nonce)        o.depositNonce       = r.deposit_nonce;
      if (r.resource_id)          o.resourceID         = r.resource_id;
      if (r.destination_chain_id) o.destinationChainID = r.destination_chain_id;
      if (r.origin_chain_id)      o.originChainID      = r.origin_chain_id;
      if (r.status)               o.status             = r.status;
      if (r.data_hash)            o.dataHash           = r.data_hash;
      return JSON.stringify(o);
    });
    const outPath = path.join(DATA_DIR, `${network}-logs.jsonl`);
    fs.writeFileSync(outPath, lines.length ? lines.join('\n') + '\n' : '');
    console.log(`Wrote ${path.relative(__dirname, outPath)} (${rows.length} rows)`);
  }
  db.close();
}

// ─── Gaps command ────────────────────────────────────────────────────────────
//
// Finds gaps in deposit nonces for a given chain.
// For each gap, infers the block range to re-fetch from the surrounding nonces,
// and reports whether that range has already been scanned.

function cmdGaps(network) {
  const db = openDb();

  const deposits = db.prepare(`
    SELECT CAST(deposit_nonce AS INTEGER) AS nonce, block_number
    FROM logs
    WHERE chain = ? AND event_name = 'Deposit'
    ORDER BY CAST(deposit_nonce AS INTEGER)
  `).all(network);

  if (deposits.length === 0) {
    console.log(`No deposits found for ${network}. Run fetch first.`);
    db.close();
    return;
  }

  const alreadyScanned = db.prepare(`
    SELECT 1 FROM scanned_blocks
    WHERE chain = ? AND batch_from <= ? AND batch_to >= ?
  `);

  const gaps = [];
  for (let i = 0; i < deposits.length - 1; i++) {
    const cur  = deposits[i];
    const next = deposits[i + 1];
    if (next.nonce - cur.nonce > 1) {
      gaps.push({
        from_nonce:       cur.nonce + 1,
        to_nonce:         next.nonce - 1,
        infer_from_block: cur.block_number,
        infer_to_block:   next.block_number,
      });
    }
  }

  const minNonce = deposits[0].nonce;
  console.log(`\n=== Deposit nonce gaps: ${network} ===`);
  if (minNonce > 1) {
    console.log(`  Note: lowest nonce in DB is ${minNonce} — nonces 1–${minNonce - 1} predate the fetch window`);
  }

  if (gaps.length === 0) {
    console.log('  No gaps found in fetched deposit nonces.');
  } else {
    for (const g of gaps) {
      const count = g.to_nonce - g.from_nonce + 1;
      const scanned = alreadyScanned.get(network, g.infer_from_block, g.infer_to_block);
      const scanNote = scanned
        ? '(range already scanned — data may be genuinely absent)'
        : '(range NOT fully scanned — re-fetch recommended)';
      console.log(`  nonces ${g.from_nonce}–${g.to_nonce}  [${count} missing]  blocks ${g.infer_from_block}–${g.infer_to_block}  ${scanNote}`);
      if (!scanned) {
        console.log(`    → node bridge-db.js fetch ${network} --from-block ${g.infer_from_block}`);
      }
    }
  }
  console.log('');
  db.close();
}

// ─── Status command ───────────────────────────────────────────────────────────

async function cmdStatus() {
  const db = openDb();

  const counts = db.prepare(`
    SELECT chain, event_name, COUNT(*) as cnt,
           MIN(block_number) as min_block, MAX(block_number) as max_block
    FROM logs
    GROUP BY chain, event_name
    ORDER BY chain, event_name
  `).all();

  const progress = db.prepare('SELECT * FROM fetch_progress ORDER BY chain').all();

  // Fetch chain tips in parallel (best-effort — skip if no RPC configured)
  const tipFor = (url) => url
    ? new ethers.JsonRpcProvider(url).getBlockNumber().catch(() => null)
    : Promise.resolve(null);
  const [palmTip, ethTip] = await Promise.all([tipFor(PALM_RPC), tipFor(ETHEREUM_RPC)]);
  const tips = { palm: palmTip, ethereum: ethTip };

  console.log('\n=== Log counts ===');
  for (const row of counts) {
    console.log(`  ${row.chain.padEnd(10)} ${row.event_name.padEnd(14)} ${String(row.cnt).padStart(6)} rows  (blocks ${row.min_block}–${row.max_block})`);
  }

  console.log('\n=== Fetch progress ===');
  if (progress.length === 0) {
    console.log('  No progress recorded — run fetch first.');
  }
  for (const row of progress) {
    const tip = tips[row.chain];
    const behind = tip != null ? ` — ${(tip - row.next_from_block + 1).toLocaleString()} blocks behind tip (${tip.toLocaleString()})` : '';
    console.log(`  ${row.chain}: next fetch from block ${row.next_from_block}${behind}`);
  }
  console.log('');
  db.close();
}

// ─── Import command ───────────────────────────────────────────────────────────
//
// Rebuild the ephemeral bridge.db from the committed JSONL, then seed the fetch
// cursor to the last block seen so a subsequent `fetch` only scans the new tail
// (otherwise it would fall back to the START_BLOCK and rescan all of history).

async function cmdImport(network) {
  const db = openDb();
  const jsonlPath = path.join(DATA_DIR, `${network}-logs.jsonl`);
  if (!fs.existsSync(jsonlPath)) {
    console.error(`File not found: ${jsonlPath}`);
    console.error(`(nothing to import yet — run \`node bridge-db.js fetch ${network}\` then \`export\`)`);
    process.exit(1);
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO logs
      (chain, event_name, block_number, tx_hash, deposit_nonce, resource_id, destination_chain_id, origin_chain_id, status, data_hash)
    VALUES
      (@chain, @event_name, @block_number, @tx_hash, @deposit_nonce, @resource_id, @destination_chain_id, @origin_chain_id, @status, @data_hash)
  `);

  const rl = readline.createInterface({ input: fs.createReadStream(jsonlPath), crlfDelay: Infinity });
  let count = 0;
  const insertBatch = db.transaction((rows) => { for (const r of rows) insert.run(r); });
  const buf = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    let raw;
    try { raw = JSON.parse(line); } catch { continue; }
    buf.push({
      chain:                network,
      event_name:           raw.eventName ?? '',
      block_number:         raw.blockNumber ?? 0,
      tx_hash:              raw.hash ?? '',
      deposit_nonce:        raw.depositNonce ?? '',
      resource_id:          raw.resourceID ?? '',
      destination_chain_id: raw.destinationChainID ?? '',
      origin_chain_id:      raw.originChainID ?? '',
      status:               raw.status ?? '',
      data_hash:            raw.dataHash ?? '',
    });
    count++;
    if (buf.length >= 500) { insertBatch(buf.splice(0)); }
  }
  if (buf.length) insertBatch(buf);

  // Seed fetch cursor from the last imported block (MAX, not MAX+1: re-scan the
  // final block, which is harmless because inserts are INSERT OR IGNORE).
  const maxBlock = db.prepare('SELECT MAX(block_number) AS m FROM logs WHERE chain = ?').get(network)?.m;
  if (maxBlock) {
    db.prepare(`
      INSERT INTO fetch_progress(chain, next_from_block, updated_at) VALUES(?,?,?)
      ON CONFLICT(chain) DO UPDATE SET next_from_block=excluded.next_from_block, updated_at=excluded.updated_at
    `).run(network, maxBlock, new Date().toISOString());
  }

  console.log(`Imported ${count} rows from ${path.basename(jsonlPath)}${maxBlock ? ` (fetch cursor → block ${maxBlock})` : ''}`);
  db.close();
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

(async () => {
  const [,, cmd, arg1, ...rest] = process.argv;
  const flags = [arg1, ...rest];

  if (cmd === 'fetch' && (arg1 === 'palm' || arg1 === 'ethereum')) {
    const fromIdx = rest.indexOf('--from-block');
    const overrideFromBlock = fromIdx !== -1 ? parseInt(rest[fromIdx + 1], 10) : undefined;
    await cmdFetch(arg1, overrideFromBlock);

  } else if (cmd === 'reconcile') {
    cmdReconcile({ summary: flags.includes('--summary'), json: flags.includes('--json') });

  } else if (cmd === 'export') {
    cmdExport();

  } else if (cmd === 'gaps' && (arg1 === 'palm' || arg1 === 'ethereum')) {
    cmdGaps(arg1);

  } else if (cmd === 'status') {
    await cmdStatus();

  } else if (cmd === 'import' && (arg1 === 'palm' || arg1 === 'ethereum')) {
    await cmdImport(arg1);

  } else {
    console.log(`Usage:
  node bridge-db.js fetch <palm|ethereum> [--from-block N]
  node bridge-db.js reconcile [--json] [--summary]
  node bridge-db.js export
  node bridge-db.js gaps <palm|ethereum>
  node bridge-db.js status
  node bridge-db.js import <palm|ethereum>   (rebuild DB from committed JSONL)`);
    process.exit(1);
  }
})();
