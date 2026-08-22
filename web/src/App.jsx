import { useEffect, useMemo, useState } from 'react';

// The deposit tx lives on the ORIGIN chain, so link each direction to its origin explorer.
const EXPLORER = {
  'palm>ethereum': (h) => `https://explorer.palm.network/tx/${h}`,
  'ethereum>palm': (h) => `https://etherscan.io/tx/${h}`,
};

// The execution tx lives on the DESTINATION chain — the reverse explorer of the deposit.
const EXEC_EXPLORER = {
  'palm>ethereum': (h) => `https://etherscan.io/tx/${h}`,
  'ethereum>palm': (h) => `https://explorer.palm.network/tx/${h}`,
};

const DIR_SHORT = {
  'palm>ethereum': 'Palm → Eth',
  'ethereum>palm': 'Eth → Palm',
};

const STATUS_CLASS = (status) => {
  if (status === 'EXECUTED') return 'badge badge-ok';
  if (status === 'NO_PROPOSAL') return 'badge badge-bad';
  if (status === 'CANCELLED') return 'badge badge-cancelled';
  return 'badge badge-progress'; // IN_PROGRESS(...)
};

const short = (h, n = 8) => (h ? `${h.slice(0, 2 + n)}…${h.slice(-4)}` : '');
const num = (n) => (typeof n === 'number' ? n.toLocaleString() : n);

// Symbol when known, otherwise fall back to the shortened resourceID.
const TokenCell = ({ it }) =>
  it.symbol ? (
    <span className="tok" title={it.name || it.resourceID}>{it.symbol}</span>
  ) : (
    <span className="mono muted" title={it.resourceID}>{short(it.resourceID, 6)}</span>
  );

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 90) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/reconcile.json`, { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  const directions = useMemo(
    () => (data ? Object.entries(data.directions) : []),
    [data],
  );

  if (error) {
    return (
      <main className="wrap">
        <div className="card error">Failed to load <code>data/reconcile.json</code>: {error}</div>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="wrap">
        <div className="card muted">Loading…</div>
      </main>
    );
  }

  const total = data.totalUnexecuted ?? directions.reduce((n, [, d]) => n + d.unexecuted, 0);
  const clean = total === 0;
  const totals = data.totals;
  const recent = data.recent || [];

  // Flat list of every unreconciled transfer (across both directions) for the alert banner.
  const unreconciled = directions.flatMap(([dir, d]) =>
    (d.items || []).map((it) => ({ ...it, dir, label: d.label || dir })),
  );

  const q = query.trim().toLowerCase();
  const matches = (it) =>
    !q ||
    String(it.nonce).includes(q) ||
    it.status.toLowerCase().includes(q) ||
    (it.symbol || '').toLowerCase().includes(q) ||
    (it.tx || '').toLowerCase().includes(q) ||
    (it.resourceID || '').toLowerCase().includes(q);

  return (
    <main className="wrap">
      <header className="header">
        <div>
          <h1>Palm&nbsp;⇄&nbsp;Ethereum bridge reconciliation</h1>
          <p className="sub">
            Updated {new Date(data.generatedAt).toLocaleString()}{' '}
            <span className="muted">({timeAgo(data.generatedAt)})</span>
          </p>
        </div>
        <div className={`pill ${clean ? 'pill-ok' : 'pill-warn'}`}>
          {clean ? '✓ All transfers reconciled' : `${total} unreconciled`}
        </div>
      </header>

      {!clean && (
        <section className="alert" role="alert">
          <div className="alert-head">
            <span className="alert-icon" aria-hidden="true">⚠</span>
            <strong>
              {total} unreconciled transfer{total === 1 ? '' : 's'} need{total === 1 ? 's' : ''} attention
            </strong>
          </div>
          <ul className="alert-list">
            {unreconciled.map((it) => (
              <li key={`${it.dir}-${it.nonce}`} className="alert-item">
                <span className="hl-dir">{DIR_SHORT[it.dir] || it.label}</span>
                <span className="hl-block" title="deposit block on the origin chain">
                  block {it.block}
                </span>
                <span className="muted mono">nonce {it.nonce}</span>
                {it.symbol && <span className="tok">{it.symbol}</span>}
                <span className={STATUS_CLASS(it.status)}>{it.status}</span>
                <a className="mono" href={EXPLORER[it.dir]?.(it.tx)} target="_blank" rel="noreferrer">
                  {short(it.tx)}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {totals && (
        <section className="stats">
          {[['palm>ethereum'], ['ethereum>palm']].map(([dir]) => {
            const t = totals[dir];
            if (!t) return null;
            return (
              <div key={dir} className="stat card">
                <div className="stat-label">{data.directions[dir]?.label || dir}</div>
                <div className="stat-value">{num(t.deposits)}</div>
                <div className="stat-sub muted">
                  {num(t.executed)} executed{t.unexecuted ? ` · ${num(t.unexecuted)} pending` : ''}
                </div>
              </div>
            );
          })}
          <div className="stat card">
            <div className="stat-label">Total transfers</div>
            <div className="stat-value">{num(totals.allDeposits)}</div>
            <div className="stat-sub muted">lifetime, both directions</div>
          </div>
        </section>
      )}

      {!clean && (
        <input
          className="filter"
          type="search"
          placeholder="Filter by nonce, status, token, tx or resourceID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {directions.map(([dir, d]) => {
        const items = d.items.filter(matches);
        return (
          <section key={dir} className={`card ${d.unexecuted > 0 ? 'card-flagged' : ''}`}>
            <div className="section-head">
              <h2>{d.label || dir.replace('>', ' → ')}</h2>
              <div className="chips">
                <span className={`chip ${d.unexecuted === 0 ? 'chip-ok' : 'chip-warn'}`}>
                  {d.unexecuted} unexecuted
                </span>
                {Object.entries(d.byStatus || {}).map(([label, n]) => (
                  <span key={label} className="chip chip-muted">{label}: {n}</span>
                ))}
                {d.whitelisted ? (
                  <span className="chip chip-muted">{d.whitelisted} whitelisted</span>
                ) : null}
              </div>
            </div>

            {d.items.length === 0 ? (
              <p className="ok-line">All deposits executed on the destination chain.</p>
            ) : items.length === 0 ? (
              <p className="muted">No items match the filter.</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>nonce</th>
                      <th>status</th>
                      <th className="num">deposit block</th>
                      <th>deposit tx</th>
                      <th>token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => (
                      <tr key={it.nonce}>
                        <td className="mono">{it.nonce}</td>
                        <td><span className={STATUS_CLASS(it.status)}>{it.status}</span></td>
                        <td className="num"><span className="block-hl mono">{it.block}</span></td>
                        <td>
                          <a className="mono" href={EXPLORER[dir]?.(it.tx)} target="_blank" rel="noreferrer">
                            {short(it.tx)}
                          </a>
                        </td>
                        <td><TokenCell it={it} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}

      {recent.length > 0 && (
        <section className="card">
          <div className="section-head">
            <h2>Recent transfers</h2>
            <div className="chips">
              <span className="chip chip-muted">last {recent.length}</span>
              {data.recentOrder === 'block' && (
                <span className="chip chip-muted" title="Block timestamps unavailable — ordered by block number">
                  approx. order
                </span>
              )}
            </div>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>when</th>
                  <th>direction</th>
                  <th>token</th>
                  <th className="num">nonce</th>
                  <th>deposit tx</th>
                  <th>executed tx</th>
                  <th>status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((it) => (
                  <tr key={`${it.direction}-${it.nonce}`}>
                    <td className="muted" title={it.timestamp ? new Date(it.timestamp).toLocaleString() : ''}>
                      {it.timestamp ? timeAgo(it.timestamp) : `#${it.block}`}
                    </td>
                    <td className="nowrap">{DIR_SHORT[it.direction] || it.direction}</td>
                    <td><TokenCell it={it} /></td>
                    <td className="num mono">{it.nonce}</td>
                    <td>
                      <a className="mono" href={EXPLORER[it.direction]?.(it.tx)} target="_blank" rel="noreferrer">
                        {short(it.tx)}
                      </a>
                    </td>
                    <td>
                      {it.execTx ? (
                        <a className="mono" href={EXEC_EXPLORER[it.direction]?.(it.execTx)} target="_blank" rel="noreferrer">
                          {short(it.execTx)}
                        </a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td><span className={STATUS_CLASS(it.status)}>{it.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="foot muted">
        Static dashboard · data committed to git by the reconcile action ·{' '}
        <a href="data/reconcile.json" target="_blank" rel="noreferrer">reconcile.json</a>
      </footer>
    </main>
  );
}
