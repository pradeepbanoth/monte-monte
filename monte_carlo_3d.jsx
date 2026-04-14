import { useState, useEffect, useRef, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════════
   NSE / BSE  3D MONTE CARLO RISK SIMULATOR  v10.0
   ───────────────────────────────────────────────────────────────────
   DESIGN GOALS:
   • Beginner-friendly inputs  —  advanced engine underneath
   • Runs ONLY when user presses the button (zero auto-execution)
   • All values entered by the user
   • Mathematically correct GBM with Ito correction
   • Realistic Indian market defaults (NSE presets, SEBI costs, RBI Rf)
   • Clean 3D fan chart  +  plain-English output panel

   MATH ENGINE:
   • GBM:  S(t+1) = S(t) · exp[(μ − ½σ²)·dt + σ·√dt·Z]
           Ito correction (−½σ²·dt) always included
   • dt   = 1/252  (NSE trading days per year)
   • Rf   = 6.5%   (RBI repo rate)
   • Sharpe / Sortino  properly annualised by √(252/T)
   • VaR, CVaR computed from sorted terminal-price distribution
   • SEBI 2024 transaction costs (STT, stamp, exchange, GST, bid-ask)
═══════════════════════════════════════════════════════════════════ */

/* ─── RANDOM NORMAL  (Box-Muller, batched for speed) ─────────────── */
let _buf = [], _idx = 0;
function rn() {
  if (_idx >= _buf.length) {
    _buf = [];
    for (let i = 0; i < 2000; i++) {
      let u = 0, v = 0;
      while (!u) u = Math.random();
      while (!v) v = Math.random();
      const r = Math.sqrt(-2 * Math.log(u));
      const t = 2 * Math.PI * v;
      _buf.push(r * Math.cos(t), r * Math.sin(t));
    }
    _idx = 0;
  }
  return _buf[_idx++];
}

/* ─── GBM SIMULATION (correct Ito, circuit breaker) ─────────────── */
function simChunk(S0, mu, sig, days, n, circuit) {
  const dt     = 1 / 252;
  const sqrtDt = Math.sqrt(dt);
  /* Ito-corrected drift: (μ − ½σ²)·dt */
  const drift  = (mu - 0.5 * sig * sig) * dt;
  const vol    = sig * sqrtDt;
  const cap    = circuit > 0 ? circuit / 100 : 0.2;   // log-return cap
  const paths  = [];

  for (let i = 0; i < n; i++) {
    const path = new Float32Array(days + 1);
    path[0] = S0;
    let s = S0;
    for (let t = 0; t < days; t++) {
      const ret = Math.max(-cap, Math.min(cap, drift + vol * rn()));
      s = Math.max(0.01, s * Math.exp(ret));
      path[t + 1] = s;
    }
    paths.push(path);
  }
  return paths;
}

async function runSim(S0, mu, sig, days, N, circuit, onProg, alive) {
  const CHUNK = 150;
  const all   = [];
  for (let done = 0; done < N; done += CHUNK) {
    if (!alive.current) return null;
    const chunk = simChunk(S0, mu, sig, days, Math.min(CHUNK, N - done), circuit);
    all.push(...chunk);
    onProg((done + chunk.length) / N);
    await new Promise(r => setTimeout(r, 0));   // yield to UI
  }
  return all;
}

/* ─── SEBI 2024 TRANSACTION COSTS ───────────────────────────────── */
function tx(buyP, sellP, qty, seg) {
  const bv = buyP * qty, sv = sellP * qty, tv = bv + sv;
  let b = 0, stt = 0, stamp = 0, exch = 0;
  const sebi = 0.000001 * tv;
  if      (seg === "delivery") { stt = 0.001*sv; stamp = 0.00015*bv; exch = 0.0000325*tv; }
  else if (seg === "intraday") { b = Math.min(20,0.0003*tv)*2; stt = 0.000025*tv; stamp = 0.00003*bv; exch = 0.0000325*tv; }
  else if (seg === "futures")  { b = Math.min(20,0.0003*tv)*2; stt = 0.0001*sv;   stamp = 0.00002*bv; exch = 0.000019*tv; }
  else if (seg === "options")  { b = 40; stt = 0.001*sv; stamp = 0.00003*bv; exch = 0.0000503*tv; }
  return b + stt + stamp + sebi + exch + 0.18 * (b + sebi + exch);
}

/* ─── METRICS (single pass, all ratios annualised) ───────────────── */
function metrics(paths, S0, slP, tgtP, qty, seg) {
  const n = paths.length, T = paths[0].length - 1;
  const tFrac = Math.max(1/252, T/252);
  const Rf    = 0.065;

  /* sort terminal prices */
  const finals = new Float64Array(n);
  for (let i = 0; i < n; i++) finals[i] = paths[i][T];
  finals.sort((a, b) => a - b);

  const mean   = finals.reduce((a, b) => a + b, 0) / n;
  const pct    = f => finals[Math.min(n - 1, Math.max(0, Math.floor(n * f)))];

  /* CVaR */
  const w5  = Math.max(1, Math.floor(n * 0.05));
  const w1  = Math.max(1, Math.floor(n * 0.01));
  let cv95  = 0, cv99 = 0;
  for (let i = 0; i < w5; i++) cv95 += finals[i]; cv95 /= w5;
  for (let i = 0; i < w1; i++) cv99 += finals[i]; cv99 /= w1;

  /* single pass: drawdown, hit counts, return stats */
  let sumDD = 0, maxDD = 0;
  let hitTgt = 0, tSum = 0, hitSl = 0, sSum = 0;
  let r20 = 0, r30 = 0, r50 = 0;
  let sWin = 0, cWin = 0, sLoss = 0, cLoss = 0;
  let sumR2 = 0, sumDR2 = 0, cDR = 0, varSum = 0;

  for (const path of paths) {
    let peak = path[0], mdd = 0, ht = false, hs = false;
    for (let t = 1; t < path.length; t++) {
      if (path[t] > peak) peak = path[t];
      const dd = (peak - path[t]) / peak;
      if (dd > mdd) mdd = dd;
      if (!ht && tgtP > S0  && path[t] >= tgtP) { tSum += t; hitTgt++; ht = true; }
      if (!hs && slP > 0 && slP < S0 && path[t] <= slP) { sSum += t; hitSl++;  hs = true; }
    }
    sumDD += mdd;
    if (mdd > maxDD) maxDD = mdd;
    if (mdd >= 0.2) r20++;
    if (mdd >= 0.3) r30++;
    if (mdd >= 0.5) r50++;

    const pnl = path[T] - S0, r = pnl / S0;
    if (pnl > 0) { sWin += pnl; cWin++; } else { sLoss += -pnl; cLoss++; }
    sumR2  += r * r;
    varSum += (path[T] - mean) ** 2;
    if (r < 0) { sumDR2 += r * r; cDR++; }
  }

  const avgMDD     = sumDD / n;
  const probProfit = cWin / n;
  const probTgt    = tgtP > S0        ? hitTgt / n : null;
  const probSl     = slP > 0 && slP < S0 ? hitSl / n : null;
  const d2Tgt      = hitTgt > 0 ? Math.round(tSum / hitTgt) : null;
  const d2Sl       = hitSl  > 0 ? Math.round(sSum / hitSl)  : null;

  const meanR      = (mean - S0) / S0;
  const stdR       = Math.sqrt(sumR2 / n);
  const dDev       = cDR > 0 ? Math.sqrt(sumDR2 / cDR) : stdR;
  const annRet     = (1 + meanR) ** (1 / tFrac) - 1;

  /* annualise period Sharpe/Sortino: × √(1/tFrac) */
  const aF      = Math.sqrt(1 / tFrac);
  const sharpe  = stdR > 0 ? ((meanR - Rf * tFrac) / stdR)  * aF : 0;
  const sortino = dDev > 0 ? ((meanR - Rf * tFrac) / dDev)  * aF : 0;
  const avgW    = cWin  > 0 ? sWin  / cWin  : 0;
  const avgL    = cLoss > 0 ? sLoss / cLoss : 0;
  const bR      = avgL  > 0.001 ? avgW / avgL : 0;
  const omega   = cLoss > 0.0001 ? sWin / sLoss : 9.99;
  const calmar  = avgMDD > 0.001 ? annRet / avgMDD : 0;
  const ev      = probProfit * avgW - (1 - probProfit) * avgL;

  /* Kelly */
  const cK  = stdR > 0 ? (meanR - Rf*tFrac) / (stdR*stdR) : 0;
  let dK    = 0;
  if (bR > 0 && probProfit > 0) { const kn = probProfit*(bR+1)-1; dK = kn>0 ? kn/bR : 0; }
  const kelly = Math.max(0, Math.min(1, (cK + dK) / 2));

  /* P&L with SEBI costs */
  const totTx  = tx(S0, S0, qty, seg) + tx(S0, mean, qty, seg);
  const netPnL = (mean - S0) * qty - totTx;
  const ci95   = (1.96 * Math.sqrt(varSum / (n * n))).toFixed(2);

  /* 5-factor risk score */
  const rs = Math.round(
    Math.min(100, (1-probProfit)*100) * 0.25 +
    Math.min(100, Math.abs(pct(.05)-S0)/S0*100) * 0.20 +
    Math.min(100, avgMDD*100) * 0.20 +
    Math.min(100, Math.max(0, 2-sharpe)*50) * 0.15 +
    Math.min(100, Math.max(0, 2-omega)*50)  * 0.20
  );

  return {
    mean, ci95, finals, probProfit, probTgt, probSl, d2Tgt, d2Sl,
    p1:pct(.01), p5:pct(.05), p25:pct(.25), p50:pct(.50),
    p75:pct(.75), p95:pct(.95), p99:pct(.99),
    var95:pct(.05), cvar95:cv95, cvar99:cv99,
    avgMDD, maxDD, ror20:r20/n, ror30:r30/n, ror50:r50/n,
    annRet, sharpe, sortino, calmar, omega, ev, halfKelly:kelly/2,
    grossPnL:(mean-S0)*qty, netPnL, totTx,
    breakeven: S0 + totTx/qty, riskScore:rs,
    worstFinal:finals[0], bestFinal:finals[n-1],
    var95PnL: (pct(.05)-S0)*qty - tx(S0,pct(.05),qty,seg),
    worstPnL: (finals[0]-S0)*qty - tx(S0,finals[0],qty,seg),
    bestPnL:  (finals[n-1]-S0)*qty - tx(S0,finals[n-1],qty,seg),
  };
}

/* ─── NSE PRESETS ─────────────────────────────────────────────────── */
const PRESETS = {
  "-- Custom --":       { p:1000, s:25, m:12, d:30, lot:1,    seg:"delivery", c:20 },
  "NIFTY 50":           { p:24500,s:15, m:12, d:22, lot:50,   seg:"futures",  c:10 },
  "BANKNIFTY":          { p:52000,s:22, m:13, d:22, lot:15,   seg:"futures",  c:10 },
  "SENSEX":             { p:81000,s:15, m:12, d:22, lot:10,   seg:"futures",  c:10 },
  "Reliance":           { p:2950, s:24, m:13, d:30, lot:250,  seg:"futures",  c:20 },
  "TCS":                { p:4150, s:20, m:13, d:30, lot:150,  seg:"futures",  c:20 },
  "Infosys":            { p:1780, s:23, m:12, d:30, lot:300,  seg:"futures",  c:20 },
  "HDFC Bank":          { p:1680, s:21, m:11, d:30, lot:550,  seg:"futures",  c:20 },
  "ICICI Bank":         { p:1280, s:24, m:13, d:30, lot:700,  seg:"futures",  c:20 },
  "SBI":                { p:815,  s:32, m:15, d:30, lot:1500, seg:"futures",  c:20 },
  "Tata Motors":        { p:935,  s:38, m:16, d:30, lot:550,  seg:"futures",  c:20 },
  "Bajaj Finance":      { p:7200, s:35, m:16, d:30, lot:125,  seg:"futures",  c:20 },
  "ITC":                { p:465,  s:18, m:10, d:30, lot:3200, seg:"delivery", c:20 },
  "Wipro":              { p:545,  s:24, m:11, d:30, lot:1500, seg:"delivery", c:20 },
  "Adani Enterprises":  { p:2450, s:55, m:18, d:22, lot:250,  seg:"futures",  c:10 },
  "Gold (GoldBees)":    { p:6580, s:13, m:9,  d:30, lot:1,   seg:"delivery", c:20 },
};

/* ─── FORMAT HELPERS ─────────────────────────────────────────────── */
const fINR  = v => { if (v==null||!isFinite(v)) return "₹—"; const a=Math.abs(v); const s=a>=1e7?(a/1e7).toFixed(2)+" Cr":a>=1e5?(a/1e5).toFixed(2)+" L":a>=1e3?a.toLocaleString("en-IN",{maximumFractionDigits:2}):a.toFixed(2); return (v<0?"-₹":"₹")+s; };
const fPnl  = v => v==null?"₹—":(v>=0?"+₹":"-₹")+Math.abs(v).toLocaleString("en-IN",{maximumFractionDigits:0});
const fp    = v => v==null?"—":(v*100).toFixed(1)+"%";
const f2    = v => (!isFinite(v)||v==null)?"—":v.toFixed(2);
const f3    = v => (!isFinite(v)||v==null)?"—":v.toFixed(3);
const fd    = v => v==null?"—":`${v}d (~${Math.ceil(v/5)}w)`;

/* ─── COLOUR CONSTANTS ───────────────────────────────────────────── */
const C = {
  bg:"#03090f", card:"#06121e", border:"#0d2035",
  dim:"#3a5a72", muted:"#2a4055", text:"#c0d4e4",
  green:"#00ff9d", red:"#ff3060", cyan:"#00c8ff",
  amber:"#ffc040", orange:"#ff8800", white:"#ffffff",
};

/* ─── SMALL UI PIECES ────────────────────────────────────────────── */
function Inp({ label, hint, value, onChange, type = "number", step = 1, min, prefix, err }) {
  return (
    <div style={{ marginBottom: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <label style={{ color: err ? C.red : C.dim, fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", fontWeight: 700 }}>{label}</label>
        {hint && <span style={{ color: C.muted, fontSize: 9 }}>{hint}</span>}
        {err  && <span style={{ color: C.red,   fontSize: 9 }}>{err}</span>}
      </div>
      <div style={{ position: "relative" }}>
        {prefix && <span style={{ position:"absolute", left:9, top:"50%", transform:"translateY(-50%)", color:C.amber, fontSize:13, fontWeight:700, pointerEvents:"none", zIndex:1 }}>{prefix}</span>}
        <input
          type={type} value={value} step={step} min={min}
          onChange={e => onChange(type === "number" ? +e.target.value : e.target.value)}
          style={{
            width: "100%",
            background: C.card,
            border: "1px solid " + (err ? C.red : C.border),
            borderRadius: 5,
            padding: prefix ? "8px 10px 8px 24px" : "8px 10px",
            color: C.text, fontSize: 12,
            fontFamily: "'IBM Plex Mono', monospace",
            outline: "none", transition: "border .15s",
          }}
          onFocus={e => (e.target.style.borderColor = err ? C.red : C.green)}
          onBlur={e  => (e.target.style.borderColor = err ? C.red : C.border)}
        />
      </div>
    </div>
  );
}

function MetricBox({ label, value, sub, color, big, glow }) {
  return (
    <div style={{
      background: glow ? "rgba(0,255,157,.05)" : "rgba(255,255,255,.02)",
      border: "1px solid " + (glow ? "rgba(0,255,157,.2)" : C.border),
      borderRadius: 6, padding: "9px 11px", marginBottom: 7,
    }}>
      <div style={{ color: C.muted, fontSize: 8, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
      <div style={{ color: color || C.text, fontSize: big ? 18 : 13, fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ color: C.muted, fontSize: 9, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Row({ label, value, color }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", padding:"4px 0", borderBottom:"1px solid "+C.muted+"22" }}>
      <span style={{ color:C.dim, fontSize:9 }}>{label}</span>
      <span style={{ color:color||C.text, fontSize:9, fontWeight:700 }}>{value}</span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════════════════════════════ */
export default function App() {
  /* ── Plotly ── */
  const [ready,    setReady]    = useState(false);
  const [running,  setRunning]  = useState(false);
  const [progress, setProgress] = useState(0);
  const [result,   setResult]   = useState(null);
  const [hasRun,   setHasRun]   = useState(false);
  const [elapsed,  setElapsed]  = useState("");
  const chartRef = useRef(null);
  const aliveRef = useRef(true);

  /* ── User Inputs ── */
  const [presetKey, setPresetKey] = useState("NIFTY 50");
  const [stockName, setStockName] = useState("NIFTY 50");
  const [entryP,    setEntry]     = useState(24500);
  const [qty,       setQty]       = useState(50);
  const [seg,       setSeg]       = useState("futures");
  const [slP,       setSl]        = useState(23500);
  const [tgtP,      setTgt]       = useState(26000);
  const [muPct,     setMuPct]     = useState(12);
  const [sigPct,    setSigPct]    = useState(15);
  const [simDays,   setDays]      = useState(22);
  const [nPaths,    setNPaths]    = useState(1000);
  const [circuit,   setCircuit]   = useState(10);

  /* ── Load Plotly once ── */
  useEffect(() => {
    aliveRef.current = true;
    if (window.Plotly) { setReady(true); return; }
    const s = document.createElement("script");
    s.src     = "https://cdn.plot.ly/plotly-2.27.0.min.js";
    s.async   = true;
    s.onload  = () => { if (aliveRef.current) setReady(true); };
    s.onerror = () => {
      const s2 = document.createElement("script");
      s2.src   = "https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.26.0/plotly.min.js";
      s2.onload= () => { if (aliveRef.current) setReady(true); };
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
    return () => { aliveRef.current = false; };
  }, []);

  /* ── Apply preset ── */
  function applyPreset(name) {
    setPresetKey(name);
    const p = PRESETS[name];
    if (!p) return;
    setStockName(name === "-- Custom --" ? "" : name);
    setEntry(p.p);
    setSigPct(p.s);
    setMuPct(p.m);
    setDays(p.d);
    setQty(p.lot);
    setSeg(p.seg);
    setCircuit(p.c);
    setSl(parseFloat((p.p * 0.94).toFixed(2)));
    setTgt(parseFloat((p.p * 1.15).toFixed(2)));
    setResult(null);
    setHasRun(false);
  }

  /* ── Validation ── */
  const errs = {
    entry:  entryP  <= 0              ? "Must be > 0"       : null,
    qty:    qty     <= 0              ? "Must be ≥ 1"       : null,
    sl:     slP > 0 && slP >= entryP  ? "Must be < entry"   : null,
    tgt:    tgtP> 0 && tgtP<= entryP  ? "Must be > entry"   : null,
    sig:    sigPct  <= 0              ? "Must be > 0"       : null,
    days:   simDays <= 0              ? "Must be ≥ 1"       : null,
    paths:  nPaths  < 100             ? "Min 100 paths"     : null,
  };
  const hasErr = Object.values(errs).some(Boolean);

  /* ── RUN — triggered ONLY by button press ── */
  const handleRun = useCallback(async () => {
    if (!ready || !chartRef.current || running || hasErr) return;
    setRunning(true);
    setProgress(0);
    const t0 = performance.now();

    try {
      const mu  = muPct  / 100;
      const sig = sigPct / 100;

      const paths = await runSim(
        entryP, mu, sig, simDays, nPaths, circuit,
        p => { if (aliveRef.current) setProgress(p); },
        aliveRef
      );

      if (!paths || !aliveRef.current) return;

      const m = metrics(paths, entryP, slP, tgtP, qty, seg);
      if (!aliveRef.current) return;

      setResult(m);
      setHasRun(true);
      setElapsed(((performance.now() - t0) / 1000).toFixed(2) + "s");
      render3D(paths, m, entryP, simDays, slP, tgtP);
    } catch (e) {
      console.error("Simulation error:", e);
    } finally {
      if (aliveRef.current) { setRunning(false); setProgress(0); }
    }
  }, [ready, running, hasErr, entryP, muPct, sigPct, simDays, nPaths, circuit, slP, tgtP, qty, seg]);

  /* ── 3D CHART RENDERER ── */
  function render3D(paths, m, S0, T, sl, tgt) {
    const sorted = paths.slice().sort((a, b) => a[T] - b[T]);
    const N      = sorted.length;
    const xs     = Array.from({ length: T + 1 }, (_, i) => i);
    const step   = Math.max(1, Math.floor(N / 120));
    const traces = [];

    /* Colour-coded path fan */
    for (let i = 0; i < N; i += step) {
      const f = i / (N - 1);
      const col =
        f < 0.10 ? `rgba(255,48,96,${(0.18 + f * 1.6).toFixed(2)})` :
        f < 0.30 ? "rgba(255,130,0,0.28)"  :
        f < 0.55 ? "rgba(255,192,64,0.24)" :
        f < 0.80 ? "rgba(0,200,255,0.20)"  :
                   `rgba(0,255,157,${(0.16 + (f - 0.80) * 1.8).toFixed(2)})`;

      traces.push({
        type: "scatter3d", mode: "lines",
        x: xs,
        y: Array.from(sorted[i]),
        z: new Array(T + 1).fill(i),
        line: { color: col, width: 0.9 },
        showlegend: false, hoverinfo: "skip",
      });
    }

    /* Key percentile paths */
    [
      { f: 0.50, c: "#ffffff", w: 4,   n: "Median (P50)"  },
      { f: 0.05, c: "#ff3060", w: 2.5, n: "VaR 95% (P5)"  },
      { f: 0.01, c: "#ff6600", w: 2,   n: "VaR 99% (P1)"  },
      { f: 0.25, c: "#ffc040", w: 1.8, n: "Bear (P25)"    },
      { f: 0.75, c: "#00c8ff", w: 1.8, n: "Bull (P75)"    },
      { f: 0.95, c: "#00ff9d", w: 2.5, n: "Bull (P95)"    },
    ].forEach(k => {
      const idx = Math.min(Math.floor(N * k.f), N - 1);
      traces.push({
        type: "scatter3d", mode: "lines",
        x: xs, y: Array.from(sorted[idx]), z: new Array(T + 1).fill(idx),
        line: { color: k.c, width: k.w },
        name: k.n, showlegend: true,
        hovertemplate: `<b>${k.n}</b><br>Day %{x}<br>₹%{y:,.0f}<extra></extra>`,
      });
    });

    /* Horizontal planes — x/y/z all length 5 (no mismatch bug) */
    const plane = (price, color, label) => {
      traces.push({
        type: "scatter3d", mode: "lines",
        x: [0, T, T, 0, 0],
        y: [price, price, price, price, price],
        z: [0, 0, N, N, 0],
        line: { color, width: 2, dash: "dot" },
        name: label, showlegend: true,
        hovertemplate: `${label}: ₹${price.toLocaleString("en-IN")}<extra></extra>`,
      });
    };
    if (sl > 0 && sl < S0)  plane(sl,  "#ff3060", "⚠ Stop-Loss");
    if (tgt > S0)            plane(tgt, "#00ff9d", "🎯 Target");

    /* Entry price reference */
    traces.push({
      type: "scatter3d", mode: "lines",
      x: [0, T], y: [S0, S0], z: [N / 2, N / 2],
      line: { color: "#fff", width: 2, dash: "dash" },
      name: "Entry Price", showlegend: true,
      hovertemplate: `Entry ₹${S0.toLocaleString("en-IN")}<extra></extra>`,
    });

    /* Terminal distribution histogram wall (at x = T) */
    const af = m.finals, nB = 40;
    const lo = af[0] * 0.97, hi = af[af.length - 1] * 1.03;
    const bw = (hi - lo) / nB;
    const bins = new Int32Array(nB);
    for (let i = 0; i < af.length; i++)
      bins[Math.min(nB - 1, Math.floor((af[i] - lo) / bw))]++;
    const maxB = Math.max.apply(null, bins);
    const hSc  = N * 0.4;
    for (let b = 0; b < nB; b++) {
      if (!bins[b]) continue;
      const mid = lo + (b + 0.5) * bw;
      const bh  = (bins[b] / maxB) * hSc;
      const f   = b / (nB - 1);
      const bc  = f < 0.20 ? "#ff3060" : f < 0.45 ? "#ff8800" : f < 0.70 ? "#ffc040" : f < 0.85 ? "#00c8ff" : "#00ff9d";
      traces.push({
        type: "scatter3d", mode: "lines",
        x: [T, T], y: [mid, mid], z: [0, bh],
        line: { color: bc, width: 5 },
        showlegend: false,
        hovertemplate: `₹${mid.toFixed(0)}: ${bins[b]} paths<extra>Distribution</extra>`,
      });
    }

    window.Plotly.react(
      chartRef.current,
      traces,
      {
        paper_bgcolor: C.bg,
        margin: { l: 0, r: 0, t: 0, b: 0 },
        uirevision: "camera",
        scene: {
          aspectmode: "manual",
          aspectratio: { x: 2.2, y: 1.4, z: 0.72 },
          bgcolor: C.bg,
          camera: { eye: { x: 1.38, y: -1.85, z: 0.72 }, up: { x: 0, y: 0, z: 1 } },
          xaxis: { title: "Trading Days", color: C.dim, gridcolor: "#0d2035", showbackground: true, backgroundcolor: C.bg, tickfont: { color: C.dim, family: "IBM Plex Mono", size: 9 } },
          yaxis: { title: stockName + " (₹)", color: C.dim, gridcolor: "#0d2035", showbackground: true, backgroundcolor: "#030f1e", tickfont: { color: C.dim, family: "IBM Plex Mono", size: 9 }, tickprefix: "₹" },
          zaxis: { title: "Sim #", color: "#0a1828", gridcolor: "#060f1a", showbackground: true, backgroundcolor: C.bg, tickfont: { color: "#0a1828", size: 8 } },
        },
        legend: {
          font: { color: "#608090", family: "IBM Plex Mono", size: 9 },
          bgcolor: "rgba(3,9,15,.9)", bordercolor: C.border, borderwidth: 1,
          x: 0.01, y: 0.99,
        },
      },
      { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["toImage", "sendDataToCloud"] }
    );
  }

  /* ── Derived display values ── */
  const invested = entryP * qty;
  const rrRatio  = slP > 0 && tgtP > entryP && slP < entryP
    ? ((tgtP - entryP) / (entryP - slP)).toFixed(2) : null;
  const riskColor = !result ? C.dim
    : result.riskScore > 65 ? C.red
    : result.riskScore > 38 ? C.amber
    : C.green;
  const riskLabel = !result ? "—"
    : result.riskScore > 65 ? "HIGH RISK"
    : result.riskScore > 38 ? "MODERATE"
    : "LOW RISK";
  const signalColor = !result ? C.dim
    : result.ev > 0 && result.probProfit > 0.52 ? C.green
    : result.ev < 0 || result.probProfit < 0.42 ? C.red
    : C.amber;
  const signalText = !result ? "—"
    : result.ev > 0 && result.probProfit > 0.52 ? "POSITIVE EDGE — Trade may be favourable"
    : result.ev < 0 ? "NEGATIVE EDGE — Trade looks unfavourable"
    : "NEUTRAL — Wait for a better setup";

  /* ══════════════════════════════════════════════════════════════
     RENDER
  ══════════════════════════════════════════════════════════════ */
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: C.bg, color: C.text, fontFamily: "'IBM Plex Mono', monospace", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 2px; }
        input[type=range] { -webkit-appearance: none; background: transparent; width: 100%; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: ${C.green}; cursor: pointer; margin-top: -5.5px; box-shadow: 0 0 6px rgba(0,255,157,.5); }
        input[type=range]::-webkit-slider-runnable-track { height: 3px; background: transparent; }
        input[type=number]::-webkit-inner-spin-button { opacity: .3; }
        select { -webkit-appearance: none; appearance: none; }
        @keyframes pulse { 0%,100% { opacity:1; box-shadow: 0 0 8px ${C.green}; } 50% { opacity:.3; box-shadow: none; } }
        @keyframes shimmer { 0% { left:-70%; } 100% { left:130%; } }
        @keyframes fadein { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
        .fadein { animation: fadein .4s ease forwards; }
      `}</style>

      {/* ══ HEADER ══ */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 18px", borderBottom: "1px solid " + C.border, background: "rgba(0,0,0,.65)", flexShrink: 0, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* India flag */}
          <div style={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            {["#ff9933", "#fff", "#138808"].map(c => <div key={c} style={{ width: 3, height: 3, borderRadius: 1, background: c }} />)}
          </div>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.green, animation: "pulse 2s infinite" }} />
          <div>
            <div style={{ color: C.green, fontSize: 12, fontWeight: 700, letterSpacing: ".18em" }}>NSE MONTE CARLO 3D</div>
            <div style={{ color: C.muted, fontSize: 8, letterSpacing: ".08em" }}>RISK SIMULATION ENGINE · v10.0 · SEBI 2024 · RBI Rf=6.5%</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {elapsed && hasRun && <span style={{ color: C.muted, fontSize: 9 }}>{nPaths.toLocaleString()} paths · {elapsed}</span>}
          <button
            onClick={handleRun}
            disabled={!ready || running || hasErr}
            style={{
              padding: "9px 26px", fontSize: 11, fontWeight: 700, letterSpacing: ".14em",
              fontFamily: "'IBM Plex Mono', monospace",
              background: (!ready || running || hasErr) ? "#0a1828" : `linear-gradient(135deg, ${C.green}, ${C.cyan})`,
              color: (!ready || running || hasErr) ? C.muted : C.bg,
              border: "none", borderRadius: 5,
              cursor: (!ready || running || hasErr) ? "not-allowed" : "pointer",
              boxShadow: (!ready || running || hasErr) ? "none" : "0 0 20px rgba(0,255,157,.3)",
              transition: "all .2s",
            }}
          >
            {!ready ? "⏳ LOADING..." : running ? `⚡ ${Math.round(progress * 100)}%` : hasErr ? "⚠ FIX ERRORS" : "▶  RUN SIMULATION"}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {running && (
        <div style={{ height: 2, background: C.muted, flexShrink: 0 }}>
          <div style={{ height: "100%", width: (progress * 100) + "%", background: `linear-gradient(90deg,${C.green},${C.cyan})`, transition: "width .12s linear" }} />
        </div>
      )}

      {/* ══ BODY ══ */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ── LEFT: INPUTS ── */}
        <div style={{ width: 268, flexShrink: 0, borderRight: "1px solid " + C.border, overflowY: "auto", padding: "16px 14px", background: "rgba(0,0,0,.2)" }}>

          {/* Step badge */}
          <div style={{ background: "rgba(0,200,255,.06)", border: "1px solid rgba(0,200,255,.15)", borderRadius: 5, padding: "8px 11px", marginBottom: 16 }}>
            <div style={{ color: C.cyan, fontSize: 9, fontWeight: 700, letterSpacing: ".1em", marginBottom: 4 }}>HOW TO USE</div>
            <div style={{ color: C.muted, fontSize: 9, lineHeight: 1.8 }}>
              1 · Pick a stock preset<br />
              2 · Edit entry, stop, target<br />
              3 · Press <span style={{ color: C.green, fontWeight: 700 }}>▶ RUN SIMULATION</span>
            </div>
          </div>

          {/* Preset selector */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ color: C.dim, fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", fontWeight: 700, display: "block", marginBottom: 5 }}>Stock / Index Preset</label>
            <div style={{ position: "relative" }}>
              <select
                value={presetKey}
                onChange={e => applyPreset(e.target.value)}
                style={{ width: "100%", background: C.card, border: "1px solid " + C.border, color: C.text, padding: "8px 28px 8px 10px", borderRadius: 5, fontSize: 11, fontFamily: "'IBM Plex Mono',monospace", outline: "none" }}
              >
                {Object.keys(PRESETS).map(k => <option key={k} value={k}>{k}</option>)}
              </select>
              <span style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", color: C.dim, fontSize: 11, pointerEvents: "none" }}>▾</span>
            </div>
          </div>

          {presetKey === "-- Custom --" && (
            <Inp label="Stock / Symbol Name" value={stockName} onChange={setStockName} type="text" hint="e.g. NIFTY" />
          )}

          {/* Main trade inputs */}
          <div style={{ borderTop: "1px solid " + C.border, paddingTop: 14, marginBottom: 2 }}>
            <div style={{ color: C.green, fontSize: 9, fontWeight: 700, letterSpacing: ".1em", marginBottom: 12 }}>TRADE SETUP</div>
          </div>

          <Inp label="Entry Price (₹)" value={entryP} onChange={setEntry} step={0.05} min={0.01} prefix="₹" hint="Your buy price" err={errs.entry} />
          <Inp label="Stop-Loss (₹)"  value={slP}    onChange={setSl}    step={0.05} min={0}    prefix="₹" hint={slP>0&&slP<entryP?fp(1-slP/entryP)+" below":"0 = off"} err={errs.sl} />
          <Inp label="Target (₹)"     value={tgtP}   onChange={setTgt}   step={0.05} min={0}    prefix="₹" hint={tgtP>entryP?"+"+fp(tgtP/entryP-1)+" upside":"0 = off"} err={errs.tgt} />

          {/* R:R box */}
          {rrRatio && (
            <div style={{ background: "rgba(255,192,64,.05)", border: "1px solid rgba(255,192,64,.18)", borderRadius: 5, padding: "9px 11px", marginBottom: 14 }}>
              <div style={{ color: C.amber, fontSize: 9, fontWeight: 700, marginBottom: 7 }}>RISK : REWARD RATIO</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ color: C.red,   fontSize: 12, fontWeight: 700 }}>{fPnl((slP - entryP) * qty)}</div>
                  <div style={{ color: C.muted, fontSize: 8 }}>Max Loss</div>
                </div>
                <div style={{ color: C.amber, fontSize: 16, fontWeight: 700 }}>1 : {rrRatio}</div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ color: C.green, fontSize: 12, fontWeight: 700 }}>{fPnl((tgtP - entryP) * qty)}</div>
                  <div style={{ color: C.muted, fontSize: 8 }}>Max Gain</div>
                </div>
              </div>
            </div>
          )}

          <Inp label="Quantity / Lot" value={qty} onChange={setQty} step={1} min={1} hint="No. of shares" err={errs.qty} />

          {/* Segment */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ color: C.dim, fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", fontWeight: 700, display: "block", marginBottom: 5 }}>Segment</label>
            <div style={{ position: "relative" }}>
              <select value={seg} onChange={e => setSeg(e.target.value)}
                style={{ width: "100%", background: C.card, border: "1px solid " + C.border, color: C.text, padding: "8px 28px 8px 10px", borderRadius: 5, fontSize: 11, fontFamily: "'IBM Plex Mono',monospace", outline: "none" }}>
                {["delivery", "intraday", "futures", "options"].map(s => <option key={s} value={s}>{s.toUpperCase()}</option>)}
              </select>
              <span style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", color: C.dim, pointerEvents: "none" }}>▾</span>
            </div>
          </div>

          {/* Invested value */}
          <div style={{ background: "rgba(0,200,255,.04)", border: "1px solid rgba(0,200,255,.1)", borderRadius: 5, padding: "8px 11px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: C.muted, fontSize: 9 }}>TOTAL INVESTED</span>
            <span style={{ color: C.cyan, fontSize: 13, fontWeight: 700 }}>{fINR(invested)}</span>
          </div>

          {/* Model params */}
          <div style={{ borderTop: "1px solid " + C.border, paddingTop: 14, marginBottom: 12 }}>
            <div style={{ color: C.amber, fontSize: 9, fontWeight: 700, letterSpacing: ".1em", marginBottom: 12 }}>SIMULATION MODEL</div>
          </div>

          {[
            ["Annual Expected Return", muPct, setMuPct, -80, 120, 1, v => (v > 0 ? "+" : "") + v + "% /yr"],
            ["Annual Volatility (σ)",  sigPct,setSigPct,  1, 130, 1, v => v + "% /yr"],
            ["Simulation Days",        simDays,setDays,   1, 504, 1, v => v + "d (" + Math.round(v / 21) + "m)"],
            ["No. of Paths (N)",       nPaths, setNPaths,100,5000,100,v => v.toLocaleString()],
            ["Circuit Breaker",        circuit,setCircuit, 0,  20, 5, v => v === 0 ? "OFF" : v + "%/day"],
          ].map(([lbl, val, set, mn, mx, st, fmt]) => (
            <div key={lbl} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ color: C.muted, fontSize: 9, letterSpacing: ".06em", textTransform: "uppercase" }}>{lbl}</span>
                <span style={{ color: C.green, fontSize: 11, fontWeight: 700 }}>{fmt(val)}</span>
              </div>
              <div style={{ position: "relative", height: 3, background: C.border, borderRadius: 2 }}>
                <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: ((val - mn) / (mx - mn) * 100) + "%", background: `linear-gradient(90deg,${C.green},${C.cyan})`, borderRadius: 2, pointerEvents: "none" }} />
                <input type="range" min={mn} max={mx} step={st} value={val} onChange={e => set(+e.target.value)}
                  style={{ position: "absolute", top: -11, left: 0, width: "100%", height: 26, opacity: 0, cursor: "pointer" }} />
              </div>
            </div>
          ))}

          {/* Model info box */}
          <div style={{ background: "rgba(255,255,255,.02)", border: "1px solid " + C.border, borderRadius: 5, padding: "9px 11px", marginTop: 6 }}>
            <div style={{ color: C.muted, fontSize: 8, lineHeight: 1.85 }}>
              <b style={{ color: C.dim }}>GBM:</b> S(t+1)=S(t)·exp[(μ−½σ²)dt+σ√dt·Z]<br />
              <b style={{ color: C.dim }}>NSE calendar:</b> dt = 1/252<br />
              <b style={{ color: C.dim }}>Risk-free rate:</b> Rf = 6.5% (RBI)<br />
              <b style={{ color: C.dim }}>Costs:</b> SEBI 2024 (STT + stamp + GST)
            </div>
          </div>
        </div>

        {/* ── CENTER: 3D CHART ── */}
        <div style={{ flex: 1, position: "relative", minWidth: 0, background: C.bg }}>
          {/* Loading overlay */}
          {!ready && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, zIndex: 10 }}>
              <div style={{ color: C.green, fontSize: 11, letterSpacing: ".2em" }}>LOADING 3D ENGINE...</div>
              <div style={{ width: 160, height: 2, background: C.border, borderRadius: 1, overflow: "hidden", position: "relative" }}>
                <div style={{ position: "absolute", width: "40%", height: "100%", background: `linear-gradient(90deg,${C.green},${C.cyan})`, borderRadius: 1, animation: "shimmer 1.1s ease-in-out infinite" }} />
              </div>
            </div>
          )}

          {/* Idle state before first run */}
          {ready && !hasRun && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, zIndex: 5, pointerEvents: "none", textAlign: "center", padding: 24 }}>
              <div style={{ fontSize: 40, opacity: .1 }}>📈</div>
              <div style={{ color: C.muted, fontSize: 16, fontWeight: 700, letterSpacing: ".16em" }}>READY TO SIMULATE</div>
              <div style={{ color: C.dim, fontSize: 11, maxWidth: 380, lineHeight: 2 }}>
                Select a stock preset on the left.<br />
                Enter your entry price, stop-loss and target.<br />
                Then press <span style={{ color: C.green, fontWeight: 700 }}>▶ RUN SIMULATION</span>.
              </div>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", marginTop: 8, opacity: .5 }}>
                {["NIFTY 50", "Reliance", "TCS", "SBI", "HDFC Bank", "Tata Motors"].map(k => (
                  <div key={k} style={{ textAlign: "center" }}>
                    <div style={{ color: C.muted, fontSize: 10 }}>{k}</div>
                    <div style={{ color: C.dim, fontSize: 9 }}>₹{PRESETS[k]?.p.toLocaleString("en-IN")} · σ={PRESETS[k]?.s}%</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div ref={chartRef} style={{ width: "100%", height: "100%" }} />
        </div>

        {/* ── RIGHT: RESULTS PANEL ── */}
        <div style={{ width: 250, flexShrink: 0, borderLeft: "1px solid " + C.border, overflowY: "auto", padding: "14px 12px", background: "rgba(0,0,0,.2)" }}>

          {!hasRun ? (
            <div style={{ color: C.muted, fontSize: 10, textAlign: "center", marginTop: 80, lineHeight: 2.5 }}>
              Results appear here<br />after you press<br /><span style={{ color: C.green, fontWeight: 700 }}>▶ RUN SIMULATION</span>
            </div>
          ) : result && (
            <div className="fadein">

              {/* Signal card */}
              <div style={{ background: signalColor + "12", border: "1px solid " + signalColor + "35", borderRadius: 6, padding: "10px 11px", marginBottom: 12 }}>
                <div style={{ color: C.muted, fontSize: 8, fontWeight: 700, letterSpacing: ".1em", marginBottom: 4 }}>⚡ TRADE SIGNAL</div>
                <div style={{ color: signalColor, fontSize: 10, fontWeight: 700, lineHeight: 1.5 }}>{signalText}</div>
                <div style={{ display: "flex", gap: 5, marginTop: 7, flexWrap: "wrap" }}>
                  <span style={{ background: (result.ev>=0?C.green:C.red)+"20", border:"1px solid "+(result.ev>=0?C.green:C.red)+"40", color:result.ev>=0?C.green:C.red, fontSize:8, borderRadius:3, padding:"2px 6px", fontWeight:700 }}>EV {fINR(result.ev)}/sh</span>
                  <span style={{ background:C.amber+"20", border:"1px solid "+C.amber+"40", color:C.amber, fontSize:8, borderRadius:3, padding:"2px 6px", fontWeight:700 }}>½-Kelly {fp(result.halfKelly)}</span>
                </div>
              </div>

              {/* Top 3 KPIs */}
              <MetricBox label="Expected Price" value={fINR(result.mean)} sub={"Entry " + fINR(entryP) + " · " + (result.mean >= entryP ? "▲ Bullish" : "▼ Bearish")} color={result.mean >= entryP ? C.green : C.red} big glow={result.mean >= entryP} />
              <MetricBox label="Net Expected P&L (after SEBI costs)" value={fPnl(result.netPnL)} sub={"Gross " + fPnl(result.grossPnL) + " · Tx " + fINR(result.totTx)} color={result.netPnL >= 0 ? C.green : C.red} />
              <MetricBox label="Probability of Profit" value={fp(result.probProfit)} sub="% of paths closing above entry" color={result.probProfit > 0.5 ? C.green : result.probProfit > 0.4 ? C.amber : C.red} />

              {/* Target / Stop probability */}
              {(result.probTgt !== null || result.probSl !== null) && (
                <div style={{ marginBottom: 10 }}>
                  {result.probTgt !== null && (
                    <div style={{ background: "rgba(0,255,157,.05)", border: "1px solid rgba(0,255,157,.2)", borderRadius: 5, padding: "8px 11px", marginBottom: 7 }}>
                      <div style={{ color: C.muted, fontSize: 8 }}>P(HIT TARGET {fINR(tgtP)})</div>
                      <div style={{ color: C.green, fontSize: 18, fontWeight: 700 }}>{fp(result.probTgt)}</div>
                      {result.d2Tgt && <div style={{ color: C.muted, fontSize: 9, marginTop: 2 }}>Avg {fd(result.d2Tgt)} to first touch</div>}
                    </div>
                  )}
                  {result.probSl !== null && (
                    <div style={{ background: "rgba(255,48,96,.05)", border: "1px solid rgba(255,48,96,.2)", borderRadius: 5, padding: "8px 11px" }}>
                      <div style={{ color: C.muted, fontSize: 8 }}>P(HIT STOP {fINR(slP)})</div>
                      <div style={{ color: C.red, fontSize: 18, fontWeight: 700 }}>{fp(result.probSl)}</div>
                      {result.d2Sl && <div style={{ color: C.muted, fontSize: 9, marginTop: 2 }}>Avg {fd(result.d2Sl)} to first touch</div>}
                    </div>
                  )}
                </div>
              )}

              {/* Price distribution */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ color: C.muted, fontSize: 9, fontWeight: 700, letterSpacing: ".08em", marginBottom: 7 }}>PRICE DISTRIBUTION (₹)</div>
                {[
                  ["P1  — Extreme Bear",  result.p1,  C.red],
                  ["P5  — VaR 95%",       result.p5,  "#ff6600"],
                  ["P25 — Bear",          result.p25, C.amber],
                  ["P50 — Median",        result.p50, C.white],
                  ["P75 — Bull",          result.p75, C.cyan],
                  ["P95 — Bull",          result.p95, C.green],
                  ["P99 — Extreme Bull",  result.p99, "#80ffcc"],
                ].map(([l, v, c]) => (
                  <Row key={l} label={l} value={fINR(v)} color={c} />
                ))}
              </div>

              {/* Risk metrics */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ color: C.red, fontSize: 9, fontWeight: 700, letterSpacing: ".08em", marginBottom: 7 }}>DOWNSIDE RISK</div>
                <Row label="VaR 95% P&L"            value={fPnl(result.var95PnL)} color={C.red} />
                <Row label="CVaR 95% (Exp. Shortfall)" value={fINR(result.cvar95)} color={C.red} />
                <Row label="CVaR 99%"               value={fINR(result.cvar99)} color={C.red} />
                <Row label="Avg Max Drawdown"        value={fp(result.avgMDD)}   color={C.amber} />
                <Row label="Worst-path Drawdown"     value={fp(result.maxDD)}    color={C.orange} />
                <Row label="Risk of Ruin  20% DD"    value={fp(result.ror20)}    color={result.ror20 > .2 ? C.red : C.amber} />
                <Row label="Risk of Ruin  30% DD"    value={fp(result.ror30)}    color={result.ror30 > .1 ? C.red : C.amber} />
                <Row label="Risk of Ruin  50% DD"    value={fp(result.ror50)}    color={result.ror50 > .05 ? C.red : C.green} />
                <Row label="Worst-Case P&L"          value={fPnl(result.worstPnL)} color={C.red} />
                <Row label="Best-Case P&L"           value={fPnl(result.bestPnL)}  color={C.green} />
              </div>

              {/* Performance ratios */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ color: C.cyan, fontSize: 9, fontWeight: 700, letterSpacing: ".08em", marginBottom: 7 }}>PERFORMANCE RATIOS</div>
                {[
                  ["Sharpe  (Rf=6.5%)", f3(result.sharpe),  result.sharpe  > 1],
                  ["Sortino (Rf=6.5%)", f3(result.sortino), result.sortino > 1],
                  ["Calmar  (R/MDD)",   f3(result.calmar),  result.calmar  > 0.5],
                  ["Omega   (thresh=0)",f3(result.omega),   result.omega   > 1.5],
                  ["Ann. Return",       fp(result.annRet),  result.annRet  > 0],
                ].map(([l, v, good]) => (
                  <Row key={l} label={l} value={v} color={good ? C.green : C.amber} />
                ))}
              </div>

              {/* Risk score gauge */}
              <div style={{ border: "1px solid " + C.border, borderRadius: 7, padding: "11px 12px", marginBottom: 10, background: "rgba(255,255,255,.02)" }}>
                <div style={{ color: C.muted, fontSize: 8, fontWeight: 700, letterSpacing: ".1em", marginBottom: 8 }}>COMPOSITE RISK SCORE</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 7 }}>
                  <span style={{ color: riskColor, fontSize: 32, fontWeight: 700, lineHeight: 1 }}>{result.riskScore}</span>
                  <span style={{ color: riskColor, fontSize: 10, fontWeight: 700 }}>{riskLabel}</span>
                </div>
                <div style={{ height: 6, background: "#0a1828", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: result.riskScore + "%", background: `linear-gradient(90deg,${C.green},${C.amber},${C.red})`, borderRadius: 3, transition: "width .8s ease" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <span style={{ color: C.green, fontSize: 7 }}>LOW 0</span>
                  <span style={{ color: C.amber, fontSize: 7 }}>MODERATE 50</span>
                  <span style={{ color: C.red,   fontSize: 7 }}>HIGH 100</span>
                </div>
              </div>

              {/* Misc small stats */}
              <div style={{ background: "rgba(0,200,255,.04)", border: "1px solid rgba(0,200,255,.1)", borderRadius: 5, padding: "9px 11px" }}>
                <div style={{ color: C.cyan, fontSize: 8, fontWeight: 700, letterSpacing: ".1em", marginBottom: 7 }}>TRADE COSTS & SIZING</div>
                <Row label="Breakeven (after costs)" value={fINR(result.breakeven)} color={C.cyan} />
                <Row label="Total SEBI tx cost"      value={fINR(result.totTx)}     color={C.amber} />
                <Row label="95% Confidence ±"        value={"₹" + result.ci95}     color={C.muted} />
                <Row label="½-Kelly position size"   value={fp(result.halfKelly)}   color={C.green} />
                <Row label="EV per share"             value={fINR(result.ev)}        color={result.ev >= 0 ? C.green : C.red} />
              </div>

            </div>
          )}
        </div>
      </div>

      {/* ══ FOOTER ══ */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 18px", borderTop: "1px solid " + C.border, background: "rgba(0,0,0,.5)", flexShrink: 0 }}>
        <span style={{ color: C.muted, fontSize: 7, letterSpacing: ".07em" }}>GBM + ITO CORRECTION · NSE CIRCUIT BREAKERS · SEBI 2024 TX COSTS · RBI Rf=6.5% · 252 TRADING DAYS/YR</span>
        <span style={{ color: C.muted, fontSize: 7 }}>EDUCATIONAL USE ONLY — NOT SEBI REGISTERED FINANCIAL ADVICE</span>
      </div>
    </div>
  );
}
