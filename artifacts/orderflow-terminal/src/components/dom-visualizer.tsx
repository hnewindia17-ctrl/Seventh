import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Activity, ArrowDown, ArrowUp, Bell, BellOff, Radar, Volume2 } from 'lucide-react';
import type { DepthLevel } from '@/hooks/use-binance-market';

type DomVisualizerProps = {
  bids: DepthLevel[];
  asks: DepthLevel[];
  price: number | null;
  symbol: string;
};

type DomWall = DepthLevel & {
  density: number;
  multiple: number;
  notional: number;
  distancePct: number;
  qualifies: boolean;
};

const compact = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 1e9) return `${(absolute / 1e9).toFixed(2)}B`;
  if (absolute >= 1e6) return `${(absolute / 1e6).toFixed(2)}M`;
  if (absolute >= 1e3) return `${(absolute / 1e3).toFixed(2)}K`;
  return absolute.toFixed(2);
};

const priceLabel = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? '—'
  : value.toLocaleString('en-US', { minimumFractionDigits: value >= 1000 ? 2 : 4, maximumFractionDigits: value >= 1000 ? 2 : 4 });

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

function enrichWalls(levels: DepthLevel[], side: DepthLevel['side'], mid: number | null): DomWall[] {
  const visible = levels.filter((level) => level.side === side).slice(0, 24);
  const medianQty = median(visible.map((level) => level.qty));
  const peakQty = Math.max(1, ...visible.map((level) => level.qty));
  const qualificationFloor = Math.max(medianQty * 2.2, peakQty * 0.48);
  return visible.map((level) => ({
    ...level,
    density: Math.min(1, level.qty / peakQty),
    multiple: medianQty > 0 ? level.qty / medianQty : 0,
    notional: level.price * level.qty,
    distancePct: mid ? Math.abs(level.price - mid) / mid * 100 : 0,
    qualifies: level.qty >= qualificationFloor && level.qty > 0,
  }));
}

function WallSignal({ wall, side }: { wall: DomWall | undefined; side: 'bid' | 'ask' }) {
  const bid = side === 'bid';
  return <div className={`dom-signal ${bid ? 'bid' : 'ask'}${wall?.qualifies ? ' qualified' : ''}`} data-testid={`dom-signal-${side}`}>
    <div className="dom-signal-head"><span><i /> {bid ? 'BID POI' : 'ASK POI'}</span><b>{wall?.qualifies ? 'ABSORPTION READY' : 'WATCHING'}</b></div>
    <div className="dom-signal-title">{bid ? 'BUYERS ABSORB SELLERS' : 'SELLERS ABSORB BUYERS'}</div>
    {wall ? <div className="dom-signal-grid">
      <span>LIMIT LEVEL <strong>{priceLabel(wall.price)}</strong></span>
      <span>LIMIT QTY <strong>{compact(wall.qty)}</strong></span>
      <span>LIMIT VALUE <strong>{compact(wall.notional)} USDT</strong></span>
      <span>DEPTH DENSITY <strong>{wall.multiple.toFixed(1)}× MEDIAN</strong></span>
    </div> : <div className="dom-signal-empty">Waiting for visible {bid ? 'bid' : 'ask'} liquidity.</div>}
    <div className="dom-signal-note">{bid ? 'Passive bids can absorb aggressive market sells.' : 'Passive asks can absorb aggressive market buys.'}</div>
  </div>;
}

function LadderRow({ wall, side, maxQty, mid }: { wall: DomWall | undefined; side: 'bid' | 'ask'; maxQty: number; mid: number | null }) {
  const bid = side === 'bid';
  if (!wall) return <div className={`dom-ladder-row empty ${side}`} aria-hidden="true"><span>—</span><i /><span>—</span></div>;
  const density = Math.min(1, wall.qty / Math.max(1, maxQty));
  const style = { '--dom-density': density, '--dom-fill': `${Math.max(6, density * 100)}%` } as CSSProperties;
  return <div className={`dom-ladder-row ${side}${wall.qualifies ? ' wall' : ''}`} style={style} data-testid={`dom-level-${side}-${wall.price}`}>
    <span className="dom-price">{priceLabel(wall.price)}</span>
    <span className="dom-depth-track"><i /></span>
    <span className="dom-qty">{compact(wall.qty)} <small>{compact(wall.notional)} USDT</small></span>
    {wall.qualifies && <b className="dom-wall-tag">{bid ? 'BID WALL' : 'ASK WALL'}</b>}
    {mid != null && <em>{wall.distancePct.toFixed(2)}%</em>}
  </div>;
}

export default function DomVisualizer({ bids, asks, price, symbol }: DomVisualizerProps) {
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const previousWallKeysRef = useRef<Set<string>>(new Set());
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const mid = price ?? (bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk);
  const bidWalls = useMemo(() => enrichWalls(bids, 'bid', mid), [bids, mid]);
  const askWalls = useMemo(() => enrichWalls(asks, 'ask', mid), [asks, mid]);
  const strongestBid = bidWalls.filter((wall) => wall.qualifies).sort((a, b) => b.qty - a.qty)[0] ?? bidWalls[0];
  const strongestAsk = askWalls.filter((wall) => wall.qualifies).sort((a, b) => b.qty - a.qty)[0] ?? askWalls[0];
  const bidRows = bidWalls.slice(0, 14);
  const askRows = askWalls.slice(0, 14);
  const maxBidQty = Math.max(1, ...bidRows.map((wall) => wall.qty));
  const maxAskQty = Math.max(1, ...askRows.map((wall) => wall.qty));
  const bidTotal = bidWalls.slice(0, 15).reduce((sum, wall) => sum + wall.qty, 0);
  const askTotal = askWalls.slice(0, 15).reduce((sum, wall) => sum + wall.qty, 0);
  const qualifiedKeys = useMemo(() => new Set([...bidWalls, ...askWalls].filter((wall) => wall.qualifies).map((wall) => `${wall.side}:${wall.price}`)), [askWalls, bidWalls]);

  const playAlert = (side: 'bid' | 'ask') => {
    const context = audioContextRef.current;
    if (!context) return;
    try {
      if (context.state === 'suspended') void context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(side === 'bid' ? 540 : 880, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(side === 'bid' ? 390 : 640, context.currentTime + .14);
      gain.gain.setValueAtTime(.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(.055, context.currentTime + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .2);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + .22);
    } catch {
      // Audio is optional; visual wall states remain available when blocked.
    }
  };

  const primeAudio = () => {
    if (typeof window === 'undefined' || !window.AudioContext) return;
    try {
      audioContextRef.current ??= new window.AudioContext();
      setAudioReady(true);
      playAlert('bid');
    } catch {
      setAudioReady(false);
    }
  };

  useEffect(() => {
    if (alertsEnabled && audioReady) {
      const newWalls = [...qualifiedKeys].filter((key) => !previousWallKeysRef.current.has(key));
      if (newWalls.length) playAlert(newWalls[0].startsWith('bid:') ? 'bid' : 'ask');
    }
    previousWallKeysRef.current = qualifiedKeys;
  }, [alertsEnabled, audioReady, qualifiedKeys]);

  return <section id="dom-liquidity" className="panel dom-panel" data-testid="dom-visualizer">
    <div className="panel-head">
      <div className="panel-title"><Radar size={12} /> DEPTH OF MARKET / LIQUIDITY WALLS</div>
      <div className="dom-head-actions"><span className="dom-live"><i /> {symbol} · DEPTH 100MS</span><button className={`dom-alert-toggle${alertsEnabled ? ' enabled' : ''}`} onClick={() => { if (!alertsEnabled) primeAudio(); setAlertsEnabled((enabled) => !enabled); }} aria-pressed={alertsEnabled} aria-label={alertsEnabled ? 'Disable DOM liquidity alerts' : 'Enable DOM liquidity alerts'} data-testid="button-dom-alerts">{alertsEnabled ? <Bell size={12} /> : <BellOff size={12} />}{alertsEnabled ? 'ALERTS ON' : 'ALERTS OFF'}</button></div>
    </div>
    <div className="dom-summary"><Activity size={12} /><span>PASSIVE LIMIT LIQUIDITY MAP</span><strong>{bidWalls.filter((wall) => wall.qualifies).length} BID WALLS</strong><strong>{askWalls.filter((wall) => wall.qualifies).length} ASK WALLS</strong><span className="dom-summary-mid">MID <b>{priceLabel(mid)}</b> · SPREAD <b>{bestBid != null && bestAsk != null ? priceLabel(bestAsk - bestBid) : '—'}</b></span></div>
    <div className="dom-signal-grid-wrap"><WallSignal wall={strongestBid} side="bid" /><WallSignal wall={strongestAsk} side="ask" /></div>
    <div className="dom-ladder">
      <div className="dom-ladder-head"><span>PRICE</span><span>RELATIVE DEPTH DENSITY</span><span>LIMIT QTY / VALUE</span></div>
      <div className="dom-ladder-column-head"><span><ArrowUp size={11} /> ASK LIQUIDITY · SELLERS ABSORB BUYERS</span><b>{compact(askTotal)} QTY</b></div>
      <div className="dom-ladder-list">{askRows.map((wall) => <LadderRow key={`ask-${wall.price}`} wall={wall} side="ask" maxQty={maxAskQty} mid={mid} />)}</div>
      <div className="dom-midline"><i /><span>LAST TRADE {priceLabel(price)}</span><i /></div>
      <div className="dom-ladder-column-head bid"><span><ArrowDown size={11} /> BID LIQUIDITY · BUYERS ABSORB SELLERS</span><b>{compact(bidTotal)} QTY</b></div>
      <div className="dom-ladder-list">{bidRows.map((wall) => <LadderRow key={`bid-${wall.price}`} wall={wall} side="bid" maxQty={maxBidQty} mid={mid} />)}</div>
    </div>
    <div className="dom-footnote"><Volume2 size={11} /> <b>Depth signal:</b> wall qualification requires a level to exceed the visible side median by 2.2× and remain among the highest-density levels. A bid wall is passive liquidity capable of absorbing sellers; an ask wall can absorb buyers. Public order-book depth is cancellable and is not proof of executed fills.{audioReady && alertsEnabled ? ' Audio cue armed after this interaction.' : ''}</div>
  </section>;
}