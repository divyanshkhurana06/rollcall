import { useState, useEffect } from 'react'

const API = '/api'
const short = (a: string) => `${a.slice(0, 10)}...${a.slice(-6)}`
const fmtP = (p: number) => (p < 0.001 ? '<0.001' : p.toFixed(3))

const SAMPLES = [
  { label: '3-of-8 · 2201 txs', addr: '0xBb4716A4A47342aAd4f162ebc34AF8414360Cdc5' },
  { label: '2-of-4 · 10952 txs', addr: '0x2b6c5bDf0a3Ab8DaA6174391Cc57Be2f6AE6276A' },
  { label: '3-of-5', addr: '0xe5036d08d75decbEC728C34a8318D9E3244392d6' },
  { label: '3-of-3', addr: '0x97cd81555F18d612C02FC4468118C48adD9f1245' },
]

export default function App() {
  const [addr, setAddr] = useState(SAMPLES[0].addr)
  const [chain, setChain] = useState('ethereum')
  const [data, setData] = useState<any>(null)
  const [quote, setQuote] = useState<any>(null)
  const [calib, setCalib] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => { fetch(`${API}/method/calibration`).then(r => r.json()).then(setCalib).catch(() => {}) }, [])

  async function run(target = addr) {
    setBusy(true); setErr(''); setData(null); setQuote(null)
    try {
      setStep('pricing the job...')
      const q = await (await fetch(`${API}/quote/${chain}/${target}`)).json()
      if (q.error) throw new Error(q.error)
      setQuote(q)
      setStep('recovering approvers, testing independence, dating signers...')
      const res = await fetch(`${API}/report/${chain}/${target}?max=200&perms=4000`, {
        headers: { 'X-PAYMENT': 'demo' },
      })
      const body = await res.json()
      if (res.status === 402) throw new Error('402 - payment required (facilitator did not verify)')
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
          <div className="logo">Roll Call<span> / control surface</span></div>
          <div className="tag">Who can take everything, how fast, and are they still awake?</div>
          <div className="mast-spacer" />
          <div className="mast-link">method v{r?.header.methodVersion ?? '1.0.0'}</div>
        </div>
      </header>

      <div className="wrap">
        <div className="search">
          <input value={addr} onChange={(e) => setAddr(e.target.value.trim())}
                 onKeyDown={(e) => e.key === 'Enter' && !busy && run()} placeholder="0x... Safe address" spellCheck={false} />
          <select value={chain} onChange={(e) => setChain(e.target.value)}>
            {['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'gnosis'].map((c) => <option key={c}>{c}</option>)}
          </select>
          <button className="btn" onClick={() => run()} disabled={busy}>{busy ? 'Analysing...' : 'Analyse'}</button>
        </div>
        <div className="samples">
          <span className="lbl">live examples</span>
          {SAMPLES.map((s) => (
            <button key={s.addr} className="chip" onClick={() => { setAddr(s.addr); run(s.addr) }}>{s.label}</button>
          ))}
        </div>

        {err && <div className="panel err pad" style={{ marginBottom: 24 }}>{err}</div>}
        {busy && <div className="loading"><span className="spin" /><span className="step">{step}</span></div>}

        {quote && !r && !busy && (
          <div className="panel pad"><Quote q={quote} /></div>
        )}

        {r && (
          <>
            <Headline r={r} />
            <Liveness r={r} />
            <Independence r={r} />
            <Quorum r={r} />
            <Findings r={r} />
            <Payment data={data} />
            <Method r={r} calib={calib} />
          </>
        )}
      </div>
    </>
  )
}

function Quote({ q }: any) {
  return (
    <>
      <div className="sec-title" style={{ marginBottom: 8 }}>Quote</div>
      <div className="kv">
        <div className="k">shape</div><div className="v">{q.shape.threshold} of {q.shape.owners} · {q.shape.knownTransactions} transactions</div>
        <div className="k">price</div><div className="v">{q.quote.amount} {q.quote.asset} on {q.quote.network}</div>
        {Object.entries(q.quote.breakdown).map(([k, v]: any) => (
          <div key={k} style={{ display: 'contents' }}><div className="k" style={{ paddingLeft: 14 }}>{k}</div><div className="v">{v}</div></div>
        ))}
      </div>
      <p className="note" style={{ marginTop: 10 }}>{q.note}</p>
    </>
  )
}

function Headline({ r }: any) {
  const R = r.reachability
  const curve = r.inferred.quorumCurve
  const eqMin = Math.min(...curve.map((c: any) => c.effectiveQuorum))
  const dep = r.tested.independence.filter((p: any) => p.pValue < 0.01 && p.excess > 0).length
  const cls = (b: boolean, w: boolean) => (b ? 'crit' : w ? 'warn' : 'ok')
  return (
    <div className="sec">
      <div className="panel"><div className="headline">
        <div className="stat"><div className="k">Declared threshold</div><div className="v">{r.observed.threshold} of {r.observed.owners.length}</div><div className="s">Safe v{r.observed.version ?? '?'}</div></div>
        <div className="stat"><div className="k">Effective quorum</div>
          <div className={`v ${cls(false, eqMin < r.observed.threshold)}`}>{eqMin} of {r.observed.threshold}</div>
          <div className="s">{r.inferred.robustness.verdict}</div></div>
        <div className="stat"><div className="k">Signers gone dark</div>
          <div className={`v ${cls(!R.canStillReachThreshold, R.darkSigners > 0)}`}>{R.darkSigners}</div>
          <div className="s">{R.darkAfterDays}d+ no signal</div></div>
        <div className="stat"><div className="k">Margin to frozen</div>
          <div className={`v ${cls(R.marginToFrozen < 0, R.marginToFrozen <= 1)}`}>{R.marginToFrozen}</div>
          <div className="s">{R.canStillReachThreshold ? 'can still act' : 'cannot reach quorum'}</div></div>
        <div className="stat"><div className="k">Dependent pairs</div>
          <div className={`v ${cls(false, dep > 0)}`}>{dep}</div><div className="s">p &lt; 0.01</div></div>
      </div></div>
    </div>
  )
}

function Liveness({ r }: any) {
  const max = Math.max(365, ...r.liveness.map((l: any) => l.daysSinceAnySignal ?? 365))
  return (
    <div className="sec tier-observed">
      <div className="sec-head"><div className="sec-title">Observed</div>
        <div className="sec-sub">read from chain state and event logs - facts, no inference</div></div>
      <div className="panel">
        {r.liveness.map((l: any) => {
          const d = l.daysSinceAnySignal
          const k = l.indeterminate ? 'unk' : d === null || d >= 365 ? 'crit' : d >= 180 ? 'warn' : 'ok'
          const pct = l.indeterminate ? 0 : Math.min(100, ((d ?? max) / max) * 100)
          const invisible = !l.indeterminate && l.nonce === 0 && d !== null && d < 90
          return (
            <div className="signer" key={l.signer}>
              <div className={`dot ${k}`} />
              <div className="addr">{short(l.signer)}</div>
              <div className="sig-flag">
                {invisible && <span className="invisible-badge">nonce 0 · invisible to explorers</span>}</div>
              <div className="bar"><i className={k} style={{ width: `${pct}%` }} /></div>
              <div className="since" title={l.statement}>
                {l.indeterminate ? 'indeterminate' : d === null ? 'no signal ever' : `${d}d since signal`}</div>
            </div>
          )
        })}
      </div>
      <p className="note" style={{ marginTop: 9 }}>
        Searched {r.header.chainsSearched.join(', ')}.{' '}
        {r.reachability.indeterminateSigners > 0 && <> <b>{r.reachability.indeterminateSigners} signer(s) are indeterminate</b> -
        a lookup did not complete, so no claim is made about them and they are counted as neither live nor dark. </>}
        Signers marked <b>nonce 0</b> have never sent a transaction -
        every block explorer shows them as inactive. Their approvals were recovered from packed signature blobs
        inside <code>execTransaction</code> calldata. Absence of an observed signature is not proof a key is lost.
      </p>
    </div>
  )
}

function Independence({ r }: any) {
  const signers: string[] = r.observed.owners
  const n = signers.length
  const map = new Map<string, any>()
  for (const p of r.tested.independence) map.set(key(p.a, p.b), p)
  return (
    <div className="sec tier-tested">
      <div className="sec-head"><div className="sec-title">Tested</div>
        <div className="sec-sub">permutation test against a stated null - {r.header.permutations.independence.toLocaleString()} draws, seed {r.header.seed}</div></div>
      <div className="panel pad">
        <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <div className="matrix" style={{ gridTemplateColumns: `repeat(${n}, 30px)`, width: n * 32 }}>
              {signers.map((a, i) => signers.map((b, j) => {
                if (i === j) return <div key={`${i}-${j}`} className="cell diag" />
                const p = map.get(key(a, b))
                const sig = p && p.excess > 0 ? 1 - Math.min(1, Math.log10(1 / Math.max(p.pValue, 1e-4)) / 4) : 1
                return <div key={`${i}-${j}`} className="cell" title={p ? `${short(a)} ~ ${short(b)}\np = ${fmtP(p.pValue)}\nobserved ${(p.observed*100).toFixed(0)}% vs expected ${(p.expected*100).toFixed(0)}%` : 'insufficient data'}
                  style={{ background: heat(sig) }}>{p && p.pValue < 0.01 && p.excess > 0 ? '!' : ''}</div>
              }))}
            </div>
            <div className="mx-legend" style={{ marginTop: 8 }}>
              <span>independent</span><div className="mx-scale" /><span>dependent</span>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            {r.tested.independence.filter((p: any) => p.pValue < 0.05 && p.excess > 0).slice(0, 5).map((p: any) => (
              <div key={key(p.a, p.b)} style={{ marginBottom: 10 }}>
                <div className="addr" style={{ fontSize: 12 }}>{short(p.a)} ~ {short(p.b)}</div>
                <div className="note">co-signed <b>{p.counts.both}/{p.counts.n}</b> - {(p.observed * 100).toFixed(0)}% observed
                  vs {(p.expected * 100).toFixed(0)}% expected · <b>p = {fmtP(p.pValue)}</b></div>
              </div>
            ))}
            {!r.tested.independence.some((p: any) => p.pValue < 0.05 && p.excess > 0) &&
              <div className="note">No pair shows co-signing dependence at p &lt; 0.05.</div>}
            <p className="caveat" style={{ marginTop: 12 }}>
              Measures statistical dependence, not identity. Two independent people who always agree
              produce the same signal as one person holding two keys. The null preserves each signer's
              marginal rate and the per-transaction signer count, so a 3-of-3 does not read as collusion.
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
        <div className="sec-sub">depends on a parameter we chose - reported as a curve, never a constant</div></div>
      <div className="panel">
        {r.inferred.quorumCurve.map((q: any) => (
          <div className="curve-row" key={q.alpha}>
            <div style={{ color: 'var(--ink-3)' }}>α = {q.alpha}</div>
            <div className="pips">
              {Array.from({ length: t }).map((_, i) => (
                <div key={i} className={`pip ${i < q.effectiveQuorum ? 'on' : 'declared'}`} />
              ))}
              <span style={{ color: 'var(--ink-3)', marginLeft: 10, fontSize: 11 }}>{q.unitCount} independent unit(s)</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <b style={{ color: q.effectiveQuorum < t ? 'var(--warn)' : 'var(--ink)' }}>{q.effectiveQuorum}</b>
              <span style={{ color: 'var(--ink-3)' }}> of {t}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="note" style={{ marginTop: 9 }}>
        Effective quorum is a <b>lower bound</b> on the number of independent decision units needed to reach threshold,
        where signers merge into one unit if their dependence is significant at α. It is published as a function of α
        because a single number here would be unfalsifiable. This finding is <b>{r.inferred.robustness.verdict}</b>
        {r.inferred.robustness.stable ? ' - it holds across the whole tested range.' : ' - it moves with α, so treat it as a flag, not a finding.'}
      </p>
    </div>
  )
}

function Findings({ r }: any) {
  if (!r.findings.length) return null
  return (
    <div className="sec">
      <div className="sec-head"><div className="sec-title">Findings</div><div className="sec-sub">every claim carries its tier and its caveat</div></div>
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
              <div className="f-ev">{f.evidence.map((e: any, j: number) => (
                <span className="ev" key={j}><b>{e.label}</b> · {e.value}</span>))}</div>
            )}
            {f.caveat && <div className="caveat">{f.caveat}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

function Payment({ data }: any) {
  const s = data.settlement, q = data.quote, rec = data.receipt, att = data.attestation
  return (
    <div className="sec">
      <div className="sec-head"><div className="sec-title">Settlement &amp; archive</div>
        <div className="sec-sub">metered by work · attested to Hedera Consensus Service</div></div>
      <div className="panel pad">
        <div className="kv">
          <div className="k">paid</div><div className="v">{q.amount} {q.asset} on {q.network} · {s?.mode}</div>
          <div className="k">priced by</div><div className="v">{q.units.pairs} signer pairs · {q.units.txs} txs · {q.units.chains} chain(s)</div>
          <div className="k">attestation</div><div className="v">{att.bodyHash}</div>
          <div className="k">hcs topic</div><div className="v">{rec.submitted
            ? <a href={rec.explorer} target="_blank" rel="noreferrer">{rec.topicId} · seq {rec.sequenceNumber}</a>
            : <span style={{ color: 'var(--ink-3)' }}>not submitted - {rec.reason}</span>}</div>
        </div>
        <p className="note" style={{ marginTop: 11 }}>
          Anyone can recompute today's answer. Nobody else has last year's. Each report emits a timestamped
          digest so <i>"on this date, two of these signers had already been dark for 300 days"</i> is provable
          after an incident rather than asserted.
        </p>
      </div>
    </div>
  )
}

function Method({ r, calib }: any) {
  return (
    <div className="sec">
      <div className="sec-head"><div className="sec-title">Method</div>
        <div className="sec-sub">reproducible from this header · error rates published, not assumed</div></div>
      <div className="panel pad">
        <div className="kv">
          <div className="k">method version</div><div className="v">{r.header.methodVersion}</div>
          <div className="k">input digest</div><div className="v">{r.header.inputDigest}</div>
          <div className="k">seed / permutations</div><div className="v">{r.header.seed} / {r.header.permutations.independence.toLocaleString()} independence, {r.header.permutations.timing.toLocaleString()} timing</div>
          <div className="k">window</div><div className="v">{r.header.txWindow.count} executed transactions</div>
          <div className="k">sources</div><div className="v">{r.header.sources.join(' · ')}</div>
        </div>

        {calib && (
          <div className="calib" style={{ marginTop: 16 }}>
            <div className="box">
              <h4>False positives (negative controls)</h4>
              {Object.entries(calib.familyWiseFPR).map(([a, v]: any) => (
                <div className="line" key={a}><span>α = {a}</span><b>{(v * 100).toFixed(1)}%</b></div>))}
            </div>
            <div className="box">
              <h4>Detection power (positive controls)</h4>
              {Object.entries(calib.power).map(([a, v]: any) => (
                <div className="line" key={a}><span>α = {a}</span><b>{(v * 100).toFixed(1)}%</b></div>))}
            </div>
            <div className="box">
              <h4>Design</h4>
              <div className="line"><span>trials</span><b>{calib.trials}</b></div>
              <div className="line"><span>synthetic Safe</span><b>{calib.threshold}-of-{calib.nSigners}</b></div>
              <div className="line"><span>transactions</span><b>{calib.nTx}</b></div>
              <div className="line"><span>permutations</span><b>{calib.permutations.toLocaleString()}</b></div>
              <div className="line" title="An empirical p-value cannot go below 1/(N+1), so finer alphas are not reported.">
                <span>resolution</span><b>p &gt;= {calib.minResolvableP?.toFixed(4)}</b></div>
            </div>
          </div>
        )}

        <div className="note" style={{ marginTop: 16 }}>
          <b style={{ color: 'var(--ink-2)' }}>Known limitations</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {r.coverage.limitations.map((l: string, i: number) => <li key={i}>{l}</li>)}
          </ul>
        </div>
      </div>
    </div>
  )
}

const key = (a: string, b: string) => [a.toLowerCase(), b.toLowerCase()].sort().join('|')
function heat(t: number) {
  const stops = [[224, 92, 92], [122, 95, 191], [59, 74, 95], [26, 30, 37]]
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.floor(x), f = x - i
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)]
  return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(',')})`
}
