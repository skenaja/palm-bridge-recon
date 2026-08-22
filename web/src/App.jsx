import { useEffect, useMemo, useState } from 'react';

// The deposit tx lives on the ORIGIN chain, so link each direction to its origin explorer.
const EXPLORER = {
  'palm>ethereum': (h) => `https://explorer.palm.io/tx/${h}`,
  'ethereum>palm': (h) => `https://etherscan.io/tx/${h}`,
};

const STATUS_CLASS = (status) => {
  if (status === 'NO_PROPOSAL') return 'badge badge-bad';
  if (status === 'CANCELLED') return 'badge badge-cancelled';
  return 'badge badge-progress'; // IN_PROGRESS(...)
};

const short = (h, n = 8) => (h ? `${h.slice(0, 2 + n)}…${h.slice(-4)}` : '');

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

  const q = query.trim().toLowerCase();
  const matches = (it) =>
    !q ||
    String(it.nonce).includes(q) ||
    it.status.toLowerCase().includes(q) ||
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
        <input
          className="filter"
          type="search"
          placeholder="Filter by nonce, status, tx or resourceID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {directions.map(([dir, d]) => {
        const items = d.items.filter(matches);
        return (
          <section key={dir} className="card">
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
                      <th>resourceID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => (
                      <tr key={it.nonce}>
                        <td className="mono">{it.nonce}</td>
                        <td><span className={STATUS_CLASS(it.status)}>{it.status}</span></td>
                        <td className="num mono">{it.block}</td>
                        <td>
                          <a className="mono" href={EXPLORER[dir]?.(it.tx)} target="_blank" rel="noreferrer">
                            {short(it.tx)}
                          </a>
                        </td>
                        <td className="mono muted" title={it.resourceID}>{short(it.resourceID, 6)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}

      <footer className="foot muted">
        Static dashboard · data committed to git by the daily reconcile action ·{' '}
        <a href="data/reconcile.json" target="_blank" rel="noreferrer">reconcile.json</a>
      </footer>
    </main>
  );
}
