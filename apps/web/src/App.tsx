import { useState, useEffect } from 'react'

const API = '/api'
const short = (a: string) => `${a.slice(0, 10)}...${a.slice(-6)}`
const fmtP = (p: number) => (p < 0.001 ? '<0.001' : p.toFixed(3))
const key2 = (a: string, b: string) => [a.toLowerCase(), b.toLowerCase()].sort().join('|')

/** Some standardized deployments report TVL in wildly different units. Never print a number we cannot vouch for. */
function usd(n: number | null): string {
  if (n === null || !isFinite(n) || n <= 0) return '-'
  if (n > 1e15) return 'unit mismatch'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`
  return `$${n.toFixed(0)}`
}

const SAMPLES = [
  { label: '3-of-8 - 2201 txs', addr: '0xBb4716A4A47342aAd4f162ebc34AF8414360Cdc5' },
  { label: '2-of-4 - 10952 txs', addr: '0x2b6c5bDf0a3Ab8DaA6174391Cc57Be2f6AE6276A' },
  { label: '3-of-5', addr: '0xe5036d08d75decbEC728C34a8318D9E3244392d6' },
  { label: '3-of-3', addr: '0x97cd81555F18d612C02FC4468118C48adD9f1245' },
]

export default function App() {
  const [view, setView] = useState<'protocols' | 'board' | 'report'>('protocols')
  const [addr, setAddr] = useState(SAMPLES[0].addr)
  const [chain, setChain] = useState('ethereum')
  const [data, setData] = useState<any>(null)
  const [calib, setCalib] = useState<any>(null)
  const [health, setHealth] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [err, setErr] = useState('')
  const [resolution, setResolution] = useState<any>(null)

  useEffect(() => {
    fetch(`${API}/method/calibration`).then((r) => r.json()).then(setCalib).catch(() => {})
    fetch(`${API}/health`).then((r) => r.json()).then(setHealth).catch(() => {})
  }, [])

  async function run(target = addr) {
    setBusy(true); setErr(''); setData(null); setResolution(null); setView('report')
    try {
      // Work out what was pasted before pricing anything. A protocol contract resolves to the Safe
      // above it, which is the thing worth measuring; an EOA gets told so plainly.
      setStep('working out what this address is')
      const r = await (await fetch(`${API}/resolve/${chain}/${target}`)).json()
      setResolution(r)
      if (!r.safe) { setBusy(false); setStep(''); return }
      if (r.safe.toLowerCase() !== target.toLowerCase()) { target = r.safe; setAddr(r.safe) }

      setStep('pricing the job by work')
      const q = await (await fetch(`${API}/quote/${chain}/${target}`)).json()
      if (q.error) throw new Error(q.error)
      setStep('recovering approvers, testing independence, dating signers')
      const res = await fetch(`${API}/report/${chain}/${target}?max=200&perms=4000`, { headers: { 'X-PAYMENT': 'demo' } })
      const body = await res.json()
      if (res.status === 402) throw new Error('402 payment required. Pay with: npm run agent')
      if (body.error) throw new Error(body.error)
      setData(body)
    } catch (e: any) { setErr(e.message ?? String(e)) }
    finally { setBusy(false); setStep('') }
  }

  const r = data?.report

  return (
    <>
      <header className="mast">
        <div className="mast-in">
          <div className="logo">Roll Call<em> / control surface</em></div>
          <div className="tag">Who can take everything, how fast, and are they still awake?</div>
          <div className="mast-spacer" />
          <div className="tabs">
            <button className={view === 'protocols' ? 'tab on' : 'tab'} onClick={() => setView('protocols')}>Protocols</button>
            <button className={view === 'board' ? 'tab on' : 'tab'} onClick={() => setView('board')}>All Safes</button>
            <button className={view === 'report' ? 'tab on' : 'tab'} onClick={() => setView('report')}>Report</button>
          </div>
          <div className="mast-meta">v{r?.header.methodVersion ?? '1.0.0'}</div>
        </div>
      </header>

      <div className="wrap">
        {view === 'protocols' && <Protocols onInspect={(a) => { setAddr(a); run(a) }} />}
        {view === 'board' && <Board onInspect={(a) => { setAddr(a); run(a) }} health={health} />}

        {view === 'report' && (
          <>
            <div style={{ height: 26 }} />
            <div className="search">
              <input value={addr} onChange={(e) => setAddr(e.target.value.trim())}
                     onKeyDown={(e) => e.key === 'Enter' && !busy && run()} placeholder="0x... Safe address" spellCheck={false} />
              <select value={chain} onChange={(e) => setChain(e.target.value)}>
                {['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'gnosis'].map((c) => <option key={c}>{c}</option>)}
              </select>
              <button className="btn" onClick={() => run()} disabled={busy}>{busy ? 'Analysing' : 'Analyse'}</button>
            </div>
            <div className="samples">
              <span className="lbl">live examples</span>
              {SAMPLES.map((s) => <button key={s.addr} className="chip" onClick={() => { setAddr(s.addr); run(s.addr) }}>{s.label}</button>)}
            </div>

            {err && <div className="panel err pad" style={{ marginBottom: 24 }}>{err}</div>}
            {busy && <div className="loading"><span className="spin" /><span className="step">{step}</span></div>}

            {resolution && !busy && (
              <div className={`panel pad resolution ${resolution.safe ? '' : 'dead-end'}`} style={{ marginBottom: 22 }}>
                <div className="res-kind">{resolution.kind.replace(/-/g, ' ')}</div>
                <div className="res-msg">{resolution.message}</div>
                {resolution.hint && <div className="note" style={{ marginTop: 6 }}>{resolution.hint}</div>}
                {resolution.via && (
                  <div className="note" style={{ marginTop: 6 }}>
                    authority path: <code>{resolution.via}</code>
                  </div>
                )}
                {resolution.kind === 'controlled-contract' && (
                  <div className="note" style={{ marginTop: 6 }}>
                    measuring <span className="addr">{short(resolution.safe)}</span> instead of the contract you pasted.
                  </div>
                )}
              </div>
            )}

            {r && (
              <div className="fade">
                <Headline r={r} />
                <div className="cols">
                  <div>
                    <Liveness r={r} />
                  </div>
                  <div>
                    <Exposure r={r} />
                  </div>
                </div>
                <Participation r={r} />
                <Independence r={r} />
                <Quorum r={r} />
                <Findings r={r} />
                <Settlement data={data} />
                <Method r={r} calib={calib} />
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}

/* ============================ protocols ============================ */
/** Chain-state balances, so no unit guard is needed - unlike subgraph TVL, which gets `usd()`. */
const held = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M`
  : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${Math.round(n)}`

function Protocols({ onInspect }: { onInspect: (a: string) => void }) {
  const [scan, setScan] = useState<any>(null)
  const [err, setErr] = useState('')
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    fetch(`${API}/protocols`).then(async (r) => {
      const b = await r.json()
      if (b.error) setErr(b.error); else setScan(b)
    }).catch((e) => setErr(String(e)))
  }, [])

  if (err) return <div className="panel err pad" style={{ marginTop: 30 }}>{err}</div>
  if (!scan) return <div className="loading"><span className="spin" /><span className="step">loading protocol scan</span></div>

  const measured = scan.rows.filter((r: any) => r.status === 'measured')
  const noSafe = scan.rows.filter((r: any) => r.status === 'no-safe')
  const shown = showAll ? measured : measured.filter((r: any) => r.valueUsd > 0)
  const frozen = measured.filter((r: any) => r.marginToFrozen !== null && r.marginToFrozen < 0)

  return (
    <div className="fade">
      <div className="hero">
        <h1>Who can change the thing <span>holding your money?</span></h1>
        <p>
          Roll Call starts from protocols you have heard of, reads what each contract holds straight from
          chain state, resolves who can change it, and measures whether that signer set is as large as it
          claims. <b>{held(scan.totalValueUsd)}</b> across <b>{scan.scanned}</b> contracts,
          {' '}<b>{scan.measured}</b> of them with a Safe in the authority path.
        </p>
        <div className="pills">
          <div className="pill crit"><div className="n">{held(scan.valueOneKeyFromFrozen)}</div>
            <div className="l">behind a signer set with zero margin</div></div>
          <div className="pill warn"><div className="n">{held(scan.valueBehindWeakQuorum)}</div>
            <div className="l">honest quorum below declared</div></div>
          {scan.valueWithNoDelay > 0 && <div className="pill crit"><div className="n">{held(scan.valueWithNoDelay)}</div>
            <div className="l">no timelock: effective next block</div></div>}
          {frozen.length > 0 && <div className="pill crit"><div className="n">{frozen.length}</div>
            <div className="l">cannot reach quorum on evidence searched</div></div>}
        </div>
      </div>

      <div className="panel">
        <div className="proto-head">
          <div>Protocol</div><div>Contract</div><div>Value held</div><div>Declared</div>
          <div>Honest</div><div>Dark</div><div>Margin</div><div>Delay</div><div />
        </div>
        {shown.map((r: any) => {
          const frozenRow = r.marginToFrozen !== null && r.marginToFrozen < 0
          const tight = r.marginToFrozen === 0
          return (
            <div className="proto-row" key={r.address} onClick={() => r.safe && onInspect(r.safe)}>
              <div className="pname">{r.protocol}</div>
              <div className="prole">{r.role}</div>
              <div className={`num ${r.valueUsd >= 1e9 ? 'big' : ''}`}>{held(r.valueUsd)}</div>
              <div className="num">{r.threshold} of {r.owners}</div>
              <div className={`num ${r.gap > 0 ? 'warnp' : ''}`}>{r.honestQuorum}</div>
              <div className={`num ${r.darkSigners > 0 ? 'warnp' : ''}`}>{r.darkSigners}</div>
              <div className={`num ${frozenRow ? 'critp' : tight ? 'warnp' : ''}`}
                   title={frozenRow ? 'On the evidence searched, the signers still showing activity cannot reach threshold'
                     : tight ? 'One more signer going dark and this Safe can no longer act' : ''}>
                {r.marginToFrozen}</div>
              <div className={`num ${r.timeToHarmHours === 0 ? 'critp' : ''}`}
                   title={r.timeToHarmHours === 0
                     ? 'No timelock in the shortest path: a signature takes effect in the next block'
                     : `${r.timeToHarmHours}h between a signature and the change landing`}>
                {r.timeToHarmHours === null ? '-' : r.timeToHarmHours === 0 ? 'none' : `${r.timeToHarmHours}h`}</div>
              <div className="rowbtn">{r.safe ? 'inspect' : ''}</div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center' }}>
        <button className="chip" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'hide empty contracts' : `show ${measured.length - shown.length} more with no balance`}
        </button>
        <span className="note">{noSafe.length} contracts resolve to a timelock, DAO or EOA rather than a Safe.</span>
      </div>

      <p className="note" style={{ marginTop: 14 }}>
        <b>Margin</b> is how many more signers can go dark before the remaining ones cannot reach threshold.
        Zero means one lost key ends it; negative means, on the evidence searched, it has already happened.
        <b> Delay</b> is the time between a malicious signature and the change landing, read from the
        timelock in the path. <b>none</b> means there is no timelock and therefore no reaction window.
      </p>
      <p className="note" style={{ marginTop: 8 }}>
        <b>What this does not claim.</b> A signer with no observed activity may still hold their key and
        simply not have been asked to sign. Value is the contract's own balance in ETH and five major
        assets, so it is a floor rather than a valuation. Authority is followed two hops, so a Safe behind
        a governance timelock and a DAO vote may not be found. Protocols whose authority resolves to a
        timelock or DAO are reported separately, not hidden: that is a different governance model, not a
        weaker one.
      </p>
      <p className="note" style={{ marginTop: 8 }}>
        {scan.assumptions.map((a: string, i: number) => <span key={i}>{a} </span>)}
        Scanned {new Date(scan.generatedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC at ETH ${scan.ethPriceUsd.toFixed(0)}.
        OP Stack addresses come from Optimism's superchain-registry, so they are verifiable rather than curated by us.
      </p>
    </div>
  )
}

/* ============================ leaderboard ============================ */
function Board({ onInspect, health }: { onInspect: (a: string) => void; health: any }) {
  const [lb, setLb] = useState<any>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    fetch(`${API}/leaderboard`).then(async (r) => {
      const b = await r.json()
      if (b.error) setErr(b.error); else setLb(b)
    }).catch((e) => setErr(String(e)))
  }, [])

  if (err) return <div className="panel err pad" style={{ marginTop: 30 }}>{err}</div>
  if (!lb) return <div className="loading"><span className="spin" /><span className="step">loading scan</span></div>

  const robust = lb.rows.filter((r: any) => r.gap > 0 && r.robust).length
  const soft = lb.rows.filter((r: any) => r.gap > 0 && !r.robust).length
  const invisible = lb.rows.reduce((a: number, r: any) => a + r.invisibleSigners, 0)
  const dark = lb.rows.reduce((a: number, r: any) => a + r.darkSigners, 0)
  const frozen = lb.rows.filter((r: any) => !r.canStillReachThreshold).length

  return (
    <div className="fade">
      <div className="hero">
        <h1>Every protocol tells you it is <span>decentralised.</span></h1>
        <p>
          Roll Call counts the people who could actually take your money, then checks which of them are
          still alive. Below are <b>{lb.rows.length}</b> live Safes, discovered from chain activity rather
          than hand picked, ranked by the distance between the quorum they declare and the one their own
          signing history supports.
        </p>
        <div className="pills">
          <div className={`pill ${robust ? 'warn' : ''}`}><div className="n">{robust}</div><div className="l">honest quorum below declared</div></div>
          <div className="pill"><div className="n">{soft}</div><div className="l">only at looser alpha</div></div>
          <div className={`pill ${dark ? 'warn' : ''}`}><div className="n">{dark}</div><div className="l">signers gone dark</div></div>
          <div className="pill"><div className="n">{invisible}</div><div className="l">invisible to explorers</div></div>
          {frozen > 0 && <div className="pill crit"><div className="n">{frozen}</div><div className="l">cannot reach quorum</div></div>}
        </div>
      </div>

      <div className="panel">
        <div className="board-head">
          <div>Safe</div><div>Declared</div><div>Honest</div><div>Gap</div>
          <div>Dark</div><div>Margin</div><div>Dep</div><div>Hidden</div><div />
        </div>
        {lb.rows.map((r: any) => (
          <div className="board-row" key={r.address} onClick={() => onInspect(r.address)}>
            <div className="addr">{short(r.address)}</div>
            <div className="num">{r.threshold} of {r.owners}</div>
            <div className="num">{r.effectiveQuorum}</div>
            <div className={`num gap g${r.gap > 0 && !r.robust ? 'soft' : Math.min(r.gap, 3)}`}
                 title={r.gap === 0 ? 'declared quorum is supported by the signing history'
                   : r.robust ? 'holds across every alpha tested'
                   : 'appears only at looser alpha, a flag rather than a finding'}>
              {r.gap > 0 ? `-${r.gap}` : '0'}{r.gap > 0 && !r.robust ? '?' : ''}
            </div>
            <div className={`num ${r.darkSigners > 0 ? 'warnp' : ''}`}>{r.darkSigners}</div>
            <div className={`num ${!r.canStillReachThreshold ? 'critp' : r.marginToFrozen <= 1 ? 'warnp' : ''}`}>
              {r.canStillReachThreshold ? r.marginToFrozen : 'frozen'}</div>
            <div className={`num ${r.dependentPairs > 0 ? 'warnp' : ''}`}>{r.dependentPairs}</div>
            <div className="num">{r.invisibleSigners}</div>
            <div className="rowbtn">inspect</div>
          </div>
        ))}
      </div>

      <p className="note" style={{ marginTop: 11 }}>
        Scanned {new Date(lb.generatedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC, method v{lb.methodVersion}.
        Safes are found from <code>ExecutionSuccess</code> logs, not curated, and included only with at least{' '}
        {lb.criteria.minOwners} owners and {lb.criteria.minTransactions} transactions, because fewer signers
        gives no pairs to test and less history gives a permutation distribution too coarse to resolve anything.{' '}
        <b>Gap</b> is the declared threshold minus the lowest honest quorum across the tested alpha grid; a{' '}
        <b>?</b> means it appears only at looser levels. <b>Hidden</b> counts signers with nonce 0, who have
        never sent a transaction and therefore look inactive on every block explorer.
        {health?.hcsTopic && <> Reports are attested to HCS topic <code>{health.hcsTopic}</code>.</>}
      </p>
    </div>
  )
}

/* ============================ report ============================ */
function Headline({ r }: any) {
  const R = r.reachability
  const eq = Math.min(...r.inferred.quorumCurve.map((c: any) => c.effectiveQuorum))
  const dep = r.tested.independence.filter((p: any) => p.pValue < 0.01 && p.excess > 0).length
  const cls = (crit: boolean, warn: boolean) => (crit ? 'crit' : warn ? 'warn' : 'ok')
  return (
    <div className="sec">
      <div className="panel"><div className="headline">
        <div className="stat"><div className="k">Declared threshold</div>
          <div className="v">{r.observed.threshold} of {r.observed.owners.length}</div>
          <div className="s">Safe v{r.observed.version ?? '?'}</div></div>
        <div className="stat"><div className="k">Honest quorum</div>
          <div className={`v ${cls(false, eq < r.observed.threshold)}`}>{eq} of {r.observed.threshold}</div>
          <div className="s">{r.inferred.robustness.verdict}</div></div>
        <div className="stat"><div className="k">Signers gone dark</div>
          <div className={`v ${cls(!R.canStillReachThreshold, R.darkSigners > 0)}`}>{R.darkSigners}</div>
          <div className="s">{R.darkAfterDays}d+ no signal</div></div>
        <div className="stat"><div className="k">Margin to frozen</div>
          <div className={`v ${cls(R.marginToFrozen < 0, R.marginToFrozen <= 1)}`}>{R.marginToFrozen}</div>
          <div className="s">{R.canStillReachThreshold ? 'can still act' : 'cannot reach quorum'}</div></div>
        <div className="stat"><div className="k">Dependent pairs</div>
          <div className={`v ${cls(false, dep > 0)}`}>{dep}</div>
          <div className="s">p &lt; 0.01</div></div>
      </div></div>
    </div>
  )
}

function Liveness({ r }: any) {
  const max = Math.max(365, ...r.liveness.map((l: any) => l.daysSinceAnySignal ?? 365))
  return (
    <div className="sec tier-observed">
      <div className="sec-head"><div className="sec-title">Observed</div>
        <div className="sec-sub">read from chain state and event logs, no inference</div></div>
      <div className="panel">
        {r.liveness.map((l: any) => {
          const d = l.daysSinceAnySignal
          const k = l.indeterminate ? 'unk' : d === null || d >= 365 ? 'crit' : d >= 180 ? 'warn' : 'ok'
          const pct = l.indeterminate ? 0 : Math.min(100, ((d ?? max) / max) * 100)
          const hidden = !l.indeterminate && l.nonce === 0 && d !== null && d < 90
          return (
            <div className="signer" key={l.signer} title={l.statement}>
              <div className={`dot ${k}`} />
              <div className="addr">{short(l.signer)}</div>
              <div>{hidden && <span className="flag">nonce 0 - invisible to explorers</span>}</div>
              <div className="bar"><i className={k} style={{ width: `${pct}%` }} /></div>
              <div className="since">{l.indeterminate ? 'indeterminate' : d === null ? 'no signal ever' : `${d}d since signal`}</div>
            </div>
          )
        })}
      </div>
      <p className="note" style={{ marginTop: 9 }}>
        Searched {r.header.chainsSearched.join(', ')}.{' '}
        {r.reachability.indeterminateSigners > 0 && <><b>{r.reachability.indeterminateSigners} indeterminate</b>: a lookup
        did not complete, so no claim is made and they count as neither live nor dark. </>}
        Signers flagged <b>nonce 0</b> have never sent a transaction. Their approvals were recovered from packed
        signature blobs inside <code>execTransaction</code> calldata, which is the only way they are visible at all.
        Absence of an observed signature is not proof a key is lost.
      </p>
    </div>
  )
}

function Exposure({ r }: any) {
  const e = r.exposure
  return (
    <div className="sec">
      <div className="sec-head"><div className="sec-title" style={{ color: 'var(--ink-2)' }}>Exposure</div></div>
      <div className="panel pad">
        {!e && <div className="note">The Graph gateway is not configured, so exposure was not queried.</div>}
        {e && <>
          {e.detail.map((d: any) => (
            <div className="expo" key={d.key}>
              <div className="nm">
                <span style={{ color: d.hasAccount ? 'var(--ink)' : 'var(--ink-3)' }}>{d.label}</span>
                <span className="fam">{d.family}</span>
              </div>
              <div className={`val ${d.hasAccount ? 'hit' : ''}`}>
                {d.hasAccount ? `${d.openPositions} open / ${d.totalPositions}` : 'no account'}
              </div>
            </div>
          ))}
          <p className="note" style={{ marginTop: 12 }}>
            One query shape, {e.queriedProtocols} standardized deployments, across two schema families
            (lending and dex-amm-extended). Adding a protocol costs a line in a table and zero lines of
            query code. That is the entire argument for standardized schemas, and it is why authority is
            worth measuring against money rather than in isolation.
          </p>
          <div className="boxes" style={{ marginTop: 12 }}>
            <div className="box">
              <h4>Protocol context</h4>
              {e.detail.map((d: any) => (
                <div className="line" key={d.key}><span>{d.label}</span><b>{usd(d.protocolTvlUsd)}</b></div>
              ))}
            </div>
          </div>
        </>}
      </div>
    </div>
  )
}

function Participation({ r }: any) {
  const p = r.participation
  if (!p || !p.rows.length) return null
  const s = p.summary
  return (
    <div className="sec tier-observed">
      <div className="sec-head"><div className="sec-title">Recovered approvals</div>
        <div className="sec-sub">who actually approved, decoded from execTransaction calldata</div></div>
      <div className="panel">
        {p.rows.slice(0, 5).map((row: any) => (
          <div className="appr" key={row.txHash}>
            <div className="appr-top">
              <a href={`https://etherscan.io/tx/${row.txHash}`} target="_blank" rel="noreferrer" className="addr">{short(row.txHash)}</a>
              <span className="note">{new Date(row.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')}</span>
              {row.agreement !== 'unavailable' && (
                <span className={`ev ${row.agreement === 'exact' ? 'ok' : ''}`}>
                  {row.agreement} match vs Safe service
                </span>
              )}
            </div>
            <div className="appr-grid">
              <div className="appr-lbl">gas paid by</div>
              <div className="addr">{short(row.executor)}
                {!p.owners.some((o: string) => o.toLowerCase() === row.executor.toLowerCase()) &&
                  <span className="flag" style={{ marginLeft: 8 }}>not an owner</span>}</div>
              <div className="appr-lbl">approved by</div>
              <div>
                {row.approvers.map((a: any) => {
                  const n = p.nonces?.[a.signer.toLowerCase()]
                  return (
                    <div key={a.signer} style={{ marginBottom: 3 }}>
                      <span className="addr">{short(a.signer)}</span>
                      <span className="note" style={{ marginLeft: 8 }}>{a.kind}</span>
                      {n === 0 && <span className="flag" style={{ marginLeft: 8 }}>nonce 0 - has never sent a transaction</span>}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="boxes" style={{ marginTop: 10 }}>
        <div className="box">
          <h4>Recovery</h4>
          <div className="line"><span>transactions</span><b>{s.transactionsRecovered}</b></div>
          <div className="line"><span>approvals recovered</span><b>{s.signerSlotsRecovered}</b></div>
          <div className="line"><span>unresolved words</span><b>{s.unresolvedWords}</b></div>
        </div>
        <div className="box">
          <h4>Cross-check</h4>
          <div className="line"><span>compared</span><b>{s.crossChecked}</b></div>
          <div className="line"><span>exact set match</span><b>{s.exactSetMatches}/{s.crossChecked}</b></div>
          <div className="line"><span>agreement</span><b>{(s.agreementRate * 100).toFixed(1)}%</b></div>
        </div>
        <div className="box">
          <h4>What this shows</h4>
          <div className="line"><span>invisible approvers</span><b>{s.invisibleApprovers.length}</b></div>
          <div className="line"><span>non-owner executors</span><b>{s.nonOwnerExecutors.length}</b></div>
        </div>
        <div className="box">
          <h4>Search coverage</h4>
          <div className="line"><span>blocks searched</span><b>{p.coverage?.coveredBlocks?.toLocaleString() ?? '-'}</b></div>
          <div className="line"><span>ranges unserved</span><b>{p.coverage?.failedRanges ?? '-'}</b></div>
          <div className="line"><span>complete</span><b>{p.coverage?.complete ? 'yes' : 'no'}</b></div>
        </div>
      </div>
      <p className="note" style={{ marginTop: 10 }}>
        A Safe transaction is executed by one address paying gas and approved by N owners whose signatures
        are packed into <code>execTransaction</code> calldata. Those approvers emit no event and never appear
        as <code>tx.from</code>, so an approver with nonce 0 has approved real transactions while remaining
        invisible on every block explorer. The cross-check compares this recovery against the Safe Transaction
        Service, an independent derivation of the same fact, rather than against itself.
        {p.coverage && !p.coverage.complete && (
          <> <b>This window is incomplete:</b> {p.coverage.failedRanges} block range(s) could not be served by
          any endpoint, so finding no approvals here would not be evidence that none exist.</>
        )}
      </p>
    </div>
  )
}

function Independence({ r }: any) {
  const signers: string[] = r.observed.owners
  const n = signers.length
  const map = new Map<string, any>()
  for (const p of r.tested.independence) map.set(key2(p.a, p.b), p)
  const sig = r.tested.independence.filter((p: any) => p.pValue < 0.05 && p.excess > 0)
  const size = n > 10 ? 22 : 30

  return (
    <div className="sec tier-tested">
      <div className="sec-head"><div className="sec-title">Tested</div>
        <div className="sec-sub">permutation test against a stated null, {r.header.permutations.independence.toLocaleString()} draws, seed {r.header.seed}</div></div>
      <div className="panel pad">
        <div style={{ display: 'flex', gap: 26, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <div className="mx" style={{ gridTemplateColumns: `repeat(${n}, ${size}px)`, width: n * (size + 3) }}>
              {signers.map((a, i) => signers.map((b, j) => {
                if (i === j) return <div key={`${i}-${j}`} className="cell diag" />
                const p = map.get(key2(a, b))
                const t = p && p.excess > 0 ? 1 - Math.min(1, Math.log10(1 / Math.max(p.pValue, 1e-4)) / 4) : 1
                return <div key={`${i}-${j}`} className="cell" style={{ background: heat(t) }}
                  title={p ? `${short(a)} ~ ${short(b)}\np = ${fmtP(p.pValue)}\nobserved ${(p.observed * 100).toFixed(0)}% vs expected ${(p.expected * 100).toFixed(0)}%\nco-signed ${p.counts.both}/${p.counts.n}` : 'insufficient history'}>
                  {p && p.pValue < 0.01 && p.excess > 0 ? '!' : ''}</div>
              }))}
            </div>
            <div className="mx-legend" style={{ marginTop: 9 }}>
              <span>independent</span><div className="mx-scale" /><span>dependent</span>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 280 }}>
            {sig.slice(0, 5).map((p: any) => (
              <div key={key2(p.a, p.b)} style={{ marginBottom: 11 }}>
                <div className="addr" style={{ fontSize: 12 }}>{short(p.a)} ~ {short(p.b)}</div>
                <div className="note">co-signed <b>{p.counts.both}/{p.counts.n}</b> - {(p.observed * 100).toFixed(0)}% observed
                  vs {(p.expected * 100).toFixed(0)}% expected under independence - <b>p = {fmtP(p.pValue)}</b></div>
              </div>
            ))}
            {!sig.length && <div className="note">No pair shows co-signing dependence at p &lt; 0.05.</div>}
            <p className="caveat" style={{ marginTop: 13 }}>
              Measures statistical dependence, not identity. Two independent people who always agree produce
              the same signal as one person holding two keys. The null preserves each signer's marginal rate
              and the per-transaction signer count, so a 3-of-3 does not read as collusion.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function Quorum({ r }: any) {
  const t = r.observed.threshold
  return (
    <div className="sec tier-inferred">
      <div className="sec-head"><div className="sec-title">Inferred</div>
        <div className="sec-sub">depends on a parameter we chose, so it is reported as a curve and never a constant</div></div>
      <div className="panel">
        {r.inferred.quorumCurve.map((q: any) => (
          <div className="curve" key={q.alpha}>
            <div style={{ color: 'var(--ink-4)' }}>alpha {q.alpha}</div>
            <div className="pips">
              {Array.from({ length: t }).map((_, i) => <div key={i} className={`pip ${i < q.effectiveQuorum ? 'on' : ''}`} />)}
              <span style={{ color: 'var(--ink-4)', marginLeft: 11, fontSize: 11 }}>{q.unitCount} independent unit(s)</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <b style={{ color: q.effectiveQuorum < t ? 'var(--warn)' : 'var(--ink)' }}>{q.effectiveQuorum}</b>
              <span style={{ color: 'var(--ink-4)' }}> of {t}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="note" style={{ marginTop: 9 }}>
        Honest quorum is a <b>lower bound</b> on the independent decision units needed to reach threshold, where
        signers merge into one unit if their dependence is significant at alpha. Published as a function of alpha
        because a single number would be unfalsifiable. This finding is <b>{r.inferred.robustness.verdict}</b>
        {r.inferred.robustness.stable ? ', holding across the whole tested range.' : ', so treat it as a flag rather than a conclusion.'}
      </p>
    </div>
  )
}

function Findings({ r }: any) {
  if (!r.findings.length) return null
  return (
    <div className="sec">
      <div className="sec-head"><div className="sec-title">Findings</div>
        <div className="sec-sub">every claim carries its tier and its caveat</div></div>
      <div className="panel">
        {r.findings.map((f: any, i: number) => (
          <div className="finding" key={i}>
            <div className="f-top">
              <span className={`sev ${f.severity}`} />
              <span className={`badge ${f.tier}`}>{f.tier.toUpperCase()}</span>
              <span className="f-title">{f.title}</span>
            </div>
            <div className="f-detail">{f.detail}</div>
            {f.evidence?.length > 0 && (
              <div className="f-ev">{f.evidence.map((e: any, j: number) =>
                <span className="ev" key={j}><b>{e.label}</b> {e.value}</span>)}</div>
            )}
            {f.caveat && <div className="caveat">{f.caveat}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

function Settlement({ data }: any) {
  const s = data.settlement, q = data.quote, rec = data.receipt, att = data.attestation
  return (
    <div className="sec">
      <div className="sec-head"><div className="sec-title" style={{ color: 'var(--ink-2)' }}>Settlement and archive</div>
        <div className="sec-sub">metered by work, attested to Hedera Consensus Service</div></div>
      <div className="panel pad">
        <div className="kv">
          <div className="k">price</div><div className="v">{q.hbar ?? q.amount} HBAR on {q.network}{s?.mode ? ` (${s.mode})` : ''}</div>
          <div className="k">priced by</div><div className="v">{q.units.pairs} signer pairs, {q.units.txs} transactions, {q.units.chains} chain(s)</div>
          {s?.transaction && <><div className="k">settlement tx</div>
            <div className="v"><a href={s.explorer} target="_blank" rel="noreferrer">{s.transaction}</a></div></>}
          <div className="k">attestation</div><div className="v">{att.bodyHash}</div>
          <div className="k">hcs</div><div className="v">{rec.submitted
            ? <a href={rec.explorer} target="_blank" rel="noreferrer">topic {rec.topicId}, sequence {rec.sequenceNumber}</a>
            : <span style={{ color: 'var(--ink-4)' }}>not submitted - {rec.reason}</span>}</div>
        </div>
        <p className="note" style={{ marginTop: 12 }}>
          Anyone can recompute today's answer. Nobody else has last year's. Each report emits a timestamped
          digest so <i>"on this date, two of these signers had already been dark for 300 days"</i> is provable
          after an incident rather than asserted. Price follows the actual job because independence testing is
          quadratic in signers.
        </p>
      </div>
    </div>
  )
}

function Method({ r, calib }: any) {
  return (
    <div className="sec">
      <div className="sec-head"><div className="sec-title" style={{ color: 'var(--ink-2)' }}>Method</div>
        <div className="sec-sub">reproducible from this header, error rates published rather than assumed</div></div>
      <div className="panel pad">
        <div className="kv">
          <div className="k">method version</div><div className="v">{r.header.methodVersion}</div>
          <div className="k">input digest</div><div className="v">{r.header.inputDigest}</div>
          <div className="k">seed / permutations</div><div className="v">{r.header.seed} / {r.header.permutations.independence.toLocaleString()} independence, {r.header.permutations.timing.toLocaleString()} timing</div>
          <div className="k">window</div><div className="v">{r.header.txWindow.count} executed transactions</div>
          <div className="k">sources</div><div className="v">{r.header.sources.join(', ')}</div>
        </div>

        {calib && (
          <div className="boxes" style={{ marginTop: 16 }}>
            <div className="box">
              <h4>False positives (negative controls)</h4>
              {Object.entries(calib.familyWiseFPR).map(([a, v]: any) =>
                <div className="line" key={a}><span>alpha {a}</span><b>{(v * 100).toFixed(1)}%</b></div>)}
            </div>
            <div className="box">
              <h4>Detection power (positive controls)</h4>
              {Object.entries(calib.power).map(([a, v]: any) =>
                <div className="line" key={a}><span>alpha {a}</span><b>{(v * 100).toFixed(1)}%</b></div>)}
            </div>
            <div className="box">
              <h4>Design</h4>
              <div className="line"><span>trials</span><b>{calib.trials}</b></div>
              <div className="line"><span>synthetic Safe</span><b>{calib.threshold}-of-{calib.nSigners}</b></div>
              <div className="line"><span>transactions</span><b>{calib.nTx}</b></div>
              <div className="line"><span>permutations</span><b>{calib.permutations.toLocaleString()}</b></div>
              <div className="line" title="An empirical p-value cannot go below 1/(N+1), so finer alphas are not reported."><span>resolution</span><b>p &gt;= {calib.minResolvableP?.toFixed(4)}</b></div>
            </div>
          </div>
        )}

        <div className="note" style={{ marginTop: 16 }}>
          <b>Known limitations</b>
          <ul>{r.coverage.limitations.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul>
        </div>
      </div>
    </div>
  )
}

function heat(t: number) {
  const stops = [[227, 93, 85], [63, 127, 116], [44, 68, 80], [25, 26, 30]]
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.floor(x), f = x - i
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)]
  return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(',')})`
}
