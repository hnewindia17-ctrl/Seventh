import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Route, Router as WouterRouter, Switch } from 'wouter';
import { Activity, ArrowDownUp, BarChart3, BookOpen, ChevronDown, CircleHelp, Crosshair, Expand, Grid2X2, LayoutPanelLeft, Minimize2, Pause, Play, RotateCcw, Search, SlidersHorizontal, Star, Sun, Target, TrendingDown, TrendingUp, X } from 'lucide-react';
import AbsorptionVisualizer from '@/components/absorption-visualizer';
import DomVisualizer from '@/components/dom-visualizer';
import { IcebergRadar } from '@/components/iceberg-radar';
import { TradeAlertModal, TradeAlertMonitor } from '@/components/trade-alert-modal';
import type { IcebergAlert } from '@/hooks/use-iceberg-engine';
import { useBinanceMarket, useMarketPulse, usePerpetualSymbols, type Candle, type ContractType, type DepthLevel, type Liquidation, type MarketStatus, type SymbolInfo, type Trade } from '@/hooks/use-binance-market';
import { analyzeAbsorption, buildSwingLiquidity, buildVolumeProfile, buildVwapBands, detectCurrentPressureDivergence, detectDivergences, detectFlowEvents, stackedImbalance, type AbsorptionZone, type Divergence, type FlowEvent, type PressureDivergenceSnapshot, type SwingLiquidity } from '@/utils/orderflow';
import { evaluateTradeAlert, type TradeAlertEvaluation } from '@/utils/trade-alert-engine';

const timeframes = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1D', '1W', '1M'];
const fmt = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const compact = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(2)}K` : value.toFixed(2);

function Tip({ children }: { children: string }) {
  return <span className="tip" title={children}><CircleHelp size={12} /></span>;
}

function Panel({ title, hint, children, className = '', id }: { title: string; hint?: string; children: ReactNode; className?: string; id?: string }) {
  return <section id={id} className={`panel ${className}`}><div className="panel-head"><div className="panel-title">{title}{hint && <Tip>{hint}</Tip>}</div>{children && <span className="panel-rule" />}</div>{children}</section>;
}

function StatusPill({ status, onReconnect }: { status: MarketStatus; onReconnect: () => void }) {
  const label = status === 'connected' ? 'LIVE' : status === 'connecting' ? 'CONNECTING' : status === 'paused' ? 'PAUSED' : status === 'error' ? 'ERROR' : 'DISCONNECTED';
  return <button className={`status-pill ${status}`} onClick={onReconnect} data-testid="button-reconnect" title="Reconnect public market streams"><span className="status-dot" />{label}<span className="status-divider" /><RotateCcw size={12} /></button>;
}

function SymbolPicker({ symbol, symbols, favorites, contractType, onSelect, onFavorite }: { symbol: string; symbols: ReturnType<typeof usePerpetualSymbols>['symbols']; favorites: string[]; contractType: ContractType; onSelect: (symbol: string) => void; onFavorite: (symbol: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => symbols.filter((item) => item.symbol.includes(query.toUpperCase())).slice(0, 14), [symbols, query]);
  const topVolume = symbols.slice(0, 4);
  const favoriteSymbols = favorites.map((item) => symbols.find((candidate) => candidate.symbol === item)).filter((item): item is (typeof symbols)[number] => Boolean(item)).slice(0, 4);
  const shortcut = (item: string) => <button key={item} className={item === symbol ? 'active' : ''} onClick={() => { onSelect(item); setOpen(false); }} data-testid={`button-symbol-${item}`}>{item.replace('USDT', '')}</button>;
  const quoteLabel = contractType === 'usdt-m' ? 'USDT-M' : 'COIN-M';
  return <div className="symbol-picker"><button className="symbol-button" onClick={() => setOpen((value) => !value)} data-testid="button-symbol-picker"><span className="symbol-mark">B</span><span><strong>{symbol}</strong><small>{quoteLabel} Perpetual</small></span><ChevronDown size={15} /></button>{open && <div className="symbol-popover"><div className="search-wrap"><Search size={14} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${quoteLabel} perpetuals`} data-testid="input-symbol-search" /><button onClick={() => setOpen(false)} data-testid="button-close-symbol-picker"><X size={13} /></button></div>{favoriteSymbols.length > 0 && <div className="shortcut-block"><span>FAVORITES</span><div className="shortcut-row">{favoriteSymbols.map((item) => shortcut(item.symbol))}</div></div>}<div className="shortcut-block"><span>TOP VOLUME</span><div className="shortcut-row">{topVolume.length ? topVolume.map((item) => shortcut(item.symbol)) : <span className="empty-small">Waiting for Binance pairs</span>}</div></div><div className="symbol-list">{filtered.length ? filtered.map((item) => <div className="symbol-row" key={item.symbol}><button onClick={() => { onSelect(item.symbol); setOpen(false); }} data-testid={`button-select-symbol-${item.symbol}`}><strong>{item.baseAsset}</strong><span>/ {item.quoteAsset}</span></button><button className={`star ${favorites.includes(item.symbol) ? 'selected' : ''}`} onClick={() => onFavorite(item.symbol)} data-testid={`button-favorite-${item.symbol}`}><Star size={13} fill={favorites.includes(item.symbol) ? 'currentColor' : 'none'} /></button></div>) : <div className="empty-small">{symbols.length ? 'No perpetual matches' : 'Loading Binance symbols…'}</div>}</div></div>}</div>;
}

type ScreenSort = 'volume' | 'spike' | 'gainers' | 'losers' | 'pressure';

function VolumeScreener({ symbols, selected, onSelect }: { symbols: SymbolInfo[]; selected: string; onSelect: (symbol: string) => void }) {
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<ScreenSort>('volume');
  const ranked = useMemo(() => {
    const next = [...symbols];
    if (sort === 'gainers') return next.sort((a, b) => b.change - a.change).slice(0, 8);
    if (sort === 'losers') return next.sort((a, b) => a.change - b.change).slice(0, 8);
    if (sort === 'pressure') return next.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 8);
    if (sort === 'spike') return next.sort((a, b) => b.volumeSpike - a.volumeSpike).slice(0, 8);
    return next.sort((a, b) => b.volume - a.volume).slice(0, 8);
  }, [sort, symbols]);

  return <section className={`screener ${open ? 'is-open' : ''}`}><div className="screener-bar"><div className="screener-title"><ArrowDownUp size={13} /><span>MARKET SCREENER</span><small>{symbols.length || '—'} perpetuals tracked</small></div><div className="screener-tabs">{(['volume', 'spike', 'gainers', 'losers', 'pressure'] as ScreenSort[]).map((item) => <button key={item} className={sort === item ? 'active' : ''} onClick={() => { setSort(item); setOpen(true); }}>{item === 'volume' ? 'VOLUME' : item === 'spike' ? 'SPIKE' : item === 'gainers' ? 'GAINERS' : item === 'losers' ? 'LOSERS' : 'PRESSURE'}</button>)}</div><button className="screener-toggle" onClick={() => setOpen((value) => !value)}>{open ? 'CLOSE' : 'OPEN'} <ChevronDown size={12} className={open ? 'rotated' : ''} /></button></div>{open && <div className="screener-grid">{ranked.map((item, index) => <button key={item.symbol} className={`screener-row ${selected === item.symbol ? 'selected' : ''}`} onClick={() => onSelect(item.symbol)}><span className="screener-rank">{String(index + 1).padStart(2, '0')}</span><strong>{item.baseAsset}</strong><span className="screener-symbol">/USDT</span><span className="screener-price">{fmt(item.lastPrice, item.lastPrice > 1000 ? 2 : 4)}</span><span className={`screener-change ${item.change >= 0 ? 'green' : 'red'}`}>{sort === 'spike' ? `${item.volumeSpike.toFixed(1)}×` : `${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}%`}</span><span className="screener-volume">{compact(item.volume)}</span>{item.change >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}</button>)}</div>}</section>;
}

function TopBar({ symbol, setSymbol, interval, setInterval, favorites, onFavorite, symbols, contractType, setContractType, status, onReconnect, paused, onPause, compactMode, onCompact, secondaryOpen, onSecondary }: { symbol: string; setSymbol: (value: string) => void; interval: string; setInterval: (value: string) => void; favorites: string[]; onFavorite: (value: string) => void; symbols: ReturnType<typeof usePerpetualSymbols>['symbols']; contractType: ContractType; setContractType: (value: ContractType) => void; status: MarketStatus; onReconnect: () => void; paused: boolean; onPause: () => void; compactMode: boolean; onCompact: () => void; secondaryOpen: boolean; onSecondary: () => void }) {
  return <><header className="topbar"><div className="brand"><div className="brand-glyph"><span /><span /><span /></div><div><strong>ORDERFLOW</strong><small>BINANCE / {contractType.toUpperCase()}</small></div></div><div className="top-divider" /><div className="contract-switch" aria-label="Contract type"><button className={contractType === 'usdt-m' ? 'active' : ''} onClick={() => setContractType('usdt-m')} data-testid="button-contract-usdt">USDT-M</button><button className={contractType === 'coin-m' ? 'active coin' : ''} onClick={() => setContractType('coin-m')} data-testid="button-contract-coin">COIN-M</button></div><SymbolPicker {...{ symbol, symbols, favorites, contractType, onSelect: setSymbol, onFavorite }} /><div className="control-group timeframes">{timeframes.map((item) => <button key={item} className={interval === item ? 'active' : ''} onClick={() => setInterval(item)} data-testid={`button-timeframe-${item}`}>{item}</button>)}</div><div className="top-actions"><button className="icon-button" onClick={onCompact} title="Toggle compact layout" data-testid="button-layout-toggle">{compactMode ? <LayoutPanelLeft size={15} /> : <Grid2X2 size={15} />}</button><button className={`icon-button ${secondaryOpen ? 'is-active' : ''}`} onClick={onSecondary} title="Show secondary analysis surfaces" aria-expanded={secondaryOpen} data-testid="button-secondary-surfaces"><SlidersHorizontal size={15} /></button><button className={`feed-button ${paused ? 'is-paused' : ''}`} onClick={onPause} data-testid="button-pause-feed">{paused ? <Play size={13} /> : <Pause size={13} />}{paused ? 'Resume' : 'Pause feed'}</button><StatusPill status={status} onReconnect={onReconnect} /></div></header><div className="ticker-strip"><div className="ticker-label"><Activity size={13} /> LIVE BINANCE FEED</div><div className="ticker-copy">Aggressive flow, liquidity & execution pressure <span>•</span> click the analysis icon for secondary surfaces</div><div className="ticker-right"><span className="live-bar" /> stream interval 100ms <span className="ticker-time">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} UTC</span></div></div></>;
}

function ModuleRail() {
  const modules = [
    { key: 'price-action', number: '01', title: 'Primary Price Action', detail: 'OHLC / VWAP / walls' },
    { key: 'flow-pressure', number: '02', title: 'Cumulative Price Pressure', detail: 'OHLC flow / delta' },
    { key: 'flow-direction', number: '03', title: 'Candle Direction Balance', detail: 'buyer vs seller attack' },
    { key: 'liquidity-heatmap', number: '04', title: 'Liquidity Heatmap', detail: 'resting order depth' },
    { key: 'recent-tape', number: '05', title: 'Trade Tape', detail: 'aggressive executions' },
    { key: 'absorption-visualizer', number: '06', title: 'Absorption Visualizer', detail: 'traps / price refusal' },
     { key: 'dom-liquidity', number: '07', title: 'DOM Liquidity Walls', detail: 'passive POI absorption' },
     { key: 'iceberg-radar', number: '08', title: 'Iceberg Liquidity Radar', detail: 'hidden institutional flow' },
  ];
  const focusModule = (key: string) => document.getElementById(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return <nav className="module-rail" aria-label="Terminal modules"><div className="module-rail-label">MODULES</div>{modules.map((module, index) => <button key={module.key} className={`module-item ${index < 3 ? 'primary' : ''}`} onClick={() => focusModule(module.key)} data-testid={`button-module-${module.key}`}><span className="module-number">{module.number}</span><span className="module-copy"><strong>{module.title}</strong><small>{module.detail}</small></span><i className="module-live">LIVE</i></button>)}</nav>;
}

function Overview({ symbol, price, change, quoteVolume, bids, asks, candles, status, onReconnect }: { symbol: string; price: number | null; change: number | null; quoteVolume: number | null; bids: DepthLevel[]; asks: DepthLevel[]; candles: Candle[]; status: MarketStatus; onReconnect: () => void }) {
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null;
  const last = candles[candles.length - 1];
  const range = last ? last.high - last.low : null;
  const totalBuy = candles.slice(-20).reduce((sum, item) => sum + item.buyVolume, 0);
  const totalSell = candles.slice(-20).reduce((sum, item) => sum + item.sellVolume, 0);
  const bias = totalBuy + totalSell ? ((totalBuy - totalSell) / (totalBuy + totalSell)) * 100 : null;
  return <div className="overview"><div className="price-block"><span className="eyebrow">{symbol} · LAST TRADE</span><div className="last-price" data-testid="text-last-price">{fmt(price, price && price > 1000 ? 2 : 4)}</div><div className={`change ${change != null && change >= 0 ? 'positive' : 'negative'}`}>{change == null ? '—' : `${change >= 0 ? '+' : ''}${fmt(change)}%`} <span>24h change</span></div></div><div className="metric"><span>24H VOLUME <Tip>Quote volume traded on Binance Futures over the last 24 hours.</Tip></span><strong>{compact(quoteVolume)} <em>USDT</em></strong><small>rolling session</small></div><div className="metric"><span>BEST BID <Tip>Highest visible resting buy price from the live depth stream.</Tip></span><strong className="green">{fmt(bestBid, 2)}</strong><small>top of book</small></div><div className="metric"><span>BEST ASK <Tip>Lowest visible resting sell price from the live depth stream.</Tip></span><strong className="red">{fmt(bestAsk, 2)}</strong><small>top of book</small></div><div className="metric"><span>SPREAD <Tip>The distance between the best ask and best bid.</Tip></span><strong>{spread == null ? '—' : spread.toFixed(2)}</strong><small>{price ? `${((spread! / price) * 100).toFixed(3)}% of price` : 'waiting'}</small></div><div className="metric"><span>FLOW BIAS <Tip>Buy volume minus sell volume divided by total volume across the last 20 loaded candles.</Tip></span><strong className={bias == null ? '' : bias >= 0 ? 'green' : 'red'}>{bias == null ? '—' : `${bias >= 0 ? '+' : ''}${bias.toFixed(1)}%`}</strong><small>last 20 candles</small></div><div className="metric status-metric"><span>FEED STATUS</span><strong className={`status-text ${status}`}>{status}</strong><button onClick={onReconnect} data-testid="button-overview-reconnect">Reconnect stream</button></div><div className="range-note">{range ? <><BarChart3 size={14} /> Current candle range <b>{fmt(range, 2)}</b></> : 'Waiting for candle data'}</div></div>;
}

function MarketPulseBar({ openInterest, fundingRate, markPrice, nextFundingTime, imbalance }: ReturnType<typeof useMarketPulse> & { imbalance: { bidStack: number; askStack: number; active: boolean } }) {
  const funding = fundingRate == null ? '—' : `${fundingRate >= 0 ? '+' : ''}${(fundingRate * 100).toFixed(4)}%`;
  const fundingTone = fundingRate == null ? '' : fundingRate >= 0 ? 'red' : 'green';
  const countdown = nextFundingTime ? `${Math.max(0, Math.round((nextFundingTime - Date.now()) / 3_600_000 * 10) / 10)}h` : '—';
  const imbalanceLabel = imbalance.active ? (imbalance.bidStack >= imbalance.askStack ? 'BUY STACK' : 'SELL STACK') : 'BALANCED';
  return <div className="pulse-bar"><div className="pulse-label"><Crosshair size={13} /><span>LIVE DERIVATIVES PULSE</span></div><div className="pulse-metric"><span>OPEN INTEREST</span><strong>{compact(openInterest)}</strong><small>contracts</small></div><div className="pulse-metric"><span>FUNDING RATE</span><strong className={fundingTone}>{funding}</strong><small>next settlement {countdown}</small></div><div className="pulse-metric"><span>MARK PRICE</span><strong>{fmt(markPrice, markPrice && markPrice > 1000 ? 2 : 4)}</strong><small>premium index</small></div><div className="pulse-metric"><span>STACKED IMBALANCE</span><strong className={imbalance.active ? imbalance.bidStack >= imbalance.askStack ? 'green' : 'red' : ''}>{imbalanceLabel}</strong><small>{Math.max(imbalance.bidStack, imbalance.askStack)} levels ≥ 300%</small></div><div className="pulse-status"><i /> Binance Futures public metrics refresh every 15s</div></div>;
}

function DivergenceBanner({ divergence }: { divergence: PressureDivergenceSnapshot | null }) {
  if (!divergence) {
    return <div className="divergence-banner neutral" role="status" aria-live="polite" data-testid="status-pressure-divergence">
      <span className="divergence-pulse" />
      <div className="divergence-copy"><strong>NO HEAVY PRICE / PRESSURE DIVERGENCE</strong><span>Watching the last 12 bars for price stagnation against strong cumulative pressure.</span></div>
      <time>LIVE SCAN</time>
    </div>;
  }
  const priceState = divergence.priceChangePct > 0.08 ? 'PRICE RISING' : divergence.priceChangePct < -0.08 ? 'PRICE FALLING' : 'PRICE RANGE';
  const pressureState = divergence.pressureDelta >= 0 ? 'PRESSURE RISING' : 'PRESSURE FALLING';
  const direction = divergence.type === 'bullish' ? 'BULLISH' : 'BEARISH';
  return <div className={`divergence-banner strong ${divergence.type}`} role="alert" aria-live="assertive" data-testid="status-pressure-divergence">
    <span className="divergence-pulse" />
    <div className="divergence-copy">
      <strong>HEAVY {direction} PRICE / PRESSURE DIVERGENCE</strong>
      <span>{priceState} <b>·</b> {pressureState}</span>
      <small>{divergence.bars}-bar pressure delta {divergence.pressureDelta >= 0 ? '+' : '−'}{compact(Math.abs(divergence.pressureDelta))} qty · price {divergence.priceChangePct >= 0 ? '+' : ''}{divergence.priceChangePct.toFixed(2)}%</small>
    </div>
    <time>{new Date(divergence.toTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
  </div>;
}

type RiskLevels = { entry: number | null; stop: number | null; target: number | null };
type ChartScale = 'linear' | 'log';
type IndicatorKey = 'bullishSweeps' | 'bearishSweeps' | 'institutionalFlow' | 'icebergOrders' | 'sessionVwap' | 'liquidityWalls' | 'poc' | 'volumeProfile' | 'absorptionZones';
type IndicatorVisibility = Record<IndicatorKey, boolean>;
type OverlayLabel = { key: string; x: number; y: number; text: string; tone: 'bull' | 'bear' | 'amber' | 'cyan'; priority: number; width: number };

const defaultIndicatorVisibility: IndicatorVisibility = {
  bullishSweeps: true,
  bearishSweeps: true,
  institutionalFlow: true,
  icebergOrders: true,
  sessionVwap: true,
  liquidityWalls: true,
  poc: true,
  volumeProfile: true,
  absorptionZones: true,
};

const indicatorItems: Array<{ key: IndicatorKey; label: string; short: string; tone: 'bull' | 'bear' | 'amber' | 'cyan' }> = [
  { key: 'bullishSweeps', label: 'Bullish Sweeps', short: 'LOW SWEEPS', tone: 'bull' },
  { key: 'bearishSweeps', label: 'Bearish Sweeps', short: 'HIGH SWEEPS', tone: 'bear' },
  { key: 'institutionalFlow', label: 'Institutional (INST) Flow', short: 'INST FLOW', tone: 'amber' },
  { key: 'icebergOrders', label: 'Iceberg Orders', short: 'ICEBERG', tone: 'cyan' },
  { key: 'sessionVwap', label: 'Session VWAP', short: 'VWAP', tone: 'amber' },
  { key: 'liquidityWalls', label: 'Liquidity Walls / DOM Walls', short: 'DOM WALLS', tone: 'cyan' },
  { key: 'poc', label: 'POC', short: 'POC', tone: 'amber' },
  { key: 'volumeProfile', label: 'Volume Profile', short: 'PROFILE', tone: 'cyan' },
  { key: 'absorptionZones', label: 'Absorption Zones', short: 'ABSORPTION', tone: 'bear' },
];

function IndicatorControlPanel({ visibility, onChange }: { visibility: IndicatorVisibility; onChange: (key: IndicatorKey) => void }) {
  const [expanded, setExpanded] = useState(true);
  const soloAbsorption = () => {
    indicatorItems.forEach(({ key }) => {
      if (key !== 'absorptionZones' && visibility[key]) onChange(key);
    });
    if (!visibility.absorptionZones) onChange('absorptionZones');
  };
  return <section className={`indicator-controls${expanded ? ' expanded' : ''}`} aria-label="Chart indicator controls">
    <div className="indicator-controls-head">
      <button className="indicator-controls-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls="indicator-control-list">
        <SlidersHorizontal size={13} /><span>INDICATORS</span><small>{indicatorItems.filter(({ key }) => visibility[key]).length}/9 ON</small><ChevronDown size={13} className={expanded ? 'rotated' : ''} />
      </button>
      <button className="solo-absorption" onClick={soloAbsorption} aria-label="Solo Absorption: turn off every indicator except Absorption Zones">SOLO ABSORPTION</button>
    </div>
    {expanded && <div className="indicator-control-list" id="indicator-control-list">{indicatorItems.map(({ key, label, short, tone }) => {
      const on = visibility[key];
      return <button key={key} className={`indicator-switch ${on ? 'on' : 'off'} ${tone}`} role="switch" aria-checked={on} onClick={() => onChange(key)} data-testid={`switch-indicator-${key}`}>
        <span className="indicator-switch-copy"><i />{label}<small>{short}</small></span><span className="switch-state">{on ? 'ON' : 'OFF'}</span>
      </button>;
    })}</div>}
  </section>;
}

function RiskCalculator({ price, levels, onChange }: { price: number | null; levels: RiskLevels; onChange: (levels: RiskLevels) => void }) {
  const entry = levels.entry == null ? '' : String(levels.entry);
  const stop = levels.stop == null ? '' : String(levels.stop);
  const target = levels.target == null ? '' : String(levels.target);
  const entryValue = levels.entry ?? 0;
  const stopValue = levels.stop ?? 0;
  const targetValue = levels.target ?? 0;
  const risk = Math.abs(entryValue - stopValue);
  const reward = Math.abs(targetValue - entryValue);
  const ratio = risk > 0 && reward > 0 ? reward / risk : null;
  const update = (key: keyof RiskLevels, value: string) => onChange({ ...levels, [key]: value === '' ? null : Number(value) });
  return <Panel title="RISK / REWARD CALCULATOR" hint="Set entry, stop-loss and target levels. The three levels become draggable overlays on the primary price chart."><div className="risk-tool"><div className="risk-input"><label>ENTRY<input value={entry} onChange={(event) => update('entry', event.target.value)} inputMode="decimal" placeholder={price ? fmt(price, 2) : 'Price'} /></label><label>STOP LOSS<input value={stop} onChange={(event) => update('stop', event.target.value)} inputMode="decimal" placeholder="81,000" /></label><label>TAKE PROFIT<input value={target} onChange={(event) => update('target', event.target.value)} inputMode="decimal" placeholder="82,000" /></label></div><div className="risk-result"><Target size={16} /><div><span>PLANNED R:R</span><strong>{ratio == null ? '—' : `1 : ${ratio.toFixed(2)}`}</strong></div><small>{ratio != null ? ratio >= 2 ? 'strong setup' : 'below 1:2' : 'enter all three levels'}</small></div></div></Panel>;
}

function ChartNavigation({ candles, visibleCount, onVisibleCount, windowEnd, onWindowEnd }: { candles: Candle[]; visibleCount: number; onVisibleCount: (value: number) => void; windowEnd: number; onWindowEnd: (value: number) => void }) {
  const maxEnd = candles.length;
  const canBack = windowEnd > visibleCount;
  const canForward = windowEnd < maxEnd;
  return <div className="chart-navigation"><span><Crosshair size={12} /> SYNCED HISTORY <b>{Math.min(visibleCount, candles.length)} / {candles.length || '—'}</b></span><div><button disabled={!canBack} onClick={() => onWindowEnd(Math.max(visibleCount, windowEnd - visibleCount))}>← older</button><button onClick={() => onVisibleCount(Math.max(30, visibleCount - 20))}>−</button><button onClick={() => onVisibleCount(Math.min(1000, visibleCount + 20))}>+</button><button disabled={!canForward} onClick={() => onWindowEnd(Math.min(maxEnd, windowEnd + visibleCount))}>newer →</button><button onClick={() => onWindowEnd(maxEnd)}>LATEST</button></div></div>;
}

function SwingLiquidityOverlay({ zones, min, max, pad, height, width, y }: { zones: SwingLiquidity[]; min: number; max: number; pad: { l: number; r: number; t: number; b: number }; height: number; width: number; y: (value: number) => number }) {
  const span = max - min || 1;
  return <>{zones.map((zone) => {
    if (zone.zonePrice < min || zone.zonePrice > max) return null;
    const band = Math.max(span * 0.006, zone.zonePrice * 0.00018);
    const top = y(zone.zonePrice + band);
    const bottom = y(zone.zonePrice - band);
    const tone = zone.side === 'bid' ? 'bid' : 'ask';
    const title = `${zone.swingType === 'high' ? 'Swing high' : 'Swing low'} · ${zone.side === 'bid' ? 'bid' : 'ask'} liquidity ${compact(zone.totalNotional)} USDT · ${zone.levelCount} levels · ${zone.distancePct.toFixed(2)}% from swing`;
    return <g key={`swing-liquidity-${zone.side}-${zone.swingTime}`} className={`swing-liquidity ${tone}`}><title>{title}</title><rect x={pad.l} y={Math.min(top, bottom)} width={width - pad.l - pad.r} height={Math.max(3, Math.abs(bottom - top))} className="swing-liquidity-zone" /><line x1={pad.l} x2={width - pad.r} y1={y(zone.zonePrice)} y2={y(zone.zonePrice)} className="swing-liquidity-line" /><text x={pad.l + 7} y={y(zone.zonePrice) + (zone.swingType === 'high' ? -7 : 13)} className="swing-liquidity-label">{zone.swingType === 'high' ? 'HIGH' : 'LOW'} {zone.side === 'bid' ? 'BID' : 'ASK'} · {compact(zone.totalNotional)} USDT</text></g>;
  })}</>;
}

function CandleChart({ symbol, candles, compactMode, interval, bids, asks, trades, price, divergences, events, absorptionZones, icebergAlerts, visibility, hoveredTime, onHover, onPan, onZoom, riskLevels, onRiskChange, visibleStart, visibleEnd, scaleMode, autoFit }: { symbol: string; candles: Candle[]; compactMode: boolean; interval: string; bids: DepthLevel[]; asks: DepthLevel[]; trades: Trade[]; price: number | null; divergences: Divergence[]; events: FlowEvent[]; absorptionZones: AbsorptionZone[]; icebergAlerts: IcebergAlert[]; visibility: IndicatorVisibility; hoveredTime: number | null; onHover: (time: number | null) => void; onPan: (deltaBars: number) => void; onZoom: (delta: number) => void; riskLevels: RiskLevels; onRiskChange: (levels: RiskLevels) => void; visibleStart: number; visibleEnd: number; scaleMode: ChartScale; autoFit: boolean }) {
  const dragRef = useRef<{ pointerId: number; x: number; lastX: number; pinchDistance: number | null } | null>(null);
  const anchoredWallsRef = useRef<{ symbol: string; bid?: { price: number; initialQty: number }; ask?: { price: number; initialQty: number } }>({ symbol });
  const placedLabelsRef = useRef(new Map<string, OverlayLabel>());
  useEffect(() => {
    const node = document.querySelector<SVGSVGElement>('.candle-svg');
    if (!node) return undefined;
    let pinchDistance: number | null = null;
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        dragRef.current = null;
        pinchDistance = distance(event.touches);
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || pinchDistance == null) return;
      event.preventDefault();
      const nextDistance = distance(event.touches);
      if (Math.abs(nextDistance - pinchDistance) > 8) {
        onZoom(nextDistance > pinchDistance ? -1 : 1);
        pinchDistance = nextDistance;
      }
    };
    const onTouchEnd = (event: TouchEvent) => { if (event.touches.length < 2) pinchDistance = null; };
    node.addEventListener('touchstart', onTouchStart, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    node.addEventListener('touchend', onTouchEnd);
    node.addEventListener('touchcancel', onTouchEnd);
    return () => {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [onZoom]);
  useEffect(() => {
    const node = document.querySelector<SVGSVGElement>('.candle-svg');
    if (!node) return undefined;
    node.querySelector('.collision-overlay-layer')?.remove();
    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.setAttribute('class', 'collision-overlay-layer');
    placedLabelsRef.current.forEach((label) => {
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', `overlay-badge ${label.tone}`);
      group.setAttribute('pointer-events', 'none');
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(label.x));
      rect.setAttribute('y', String(label.y - 13));
      rect.setAttribute('width', String(label.width));
      rect.setAttribute('height', '16');
      rect.setAttribute('rx', '2');
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String(label.x + 6));
      text.setAttribute('y', String(label.y - 2));
      text.textContent = label.text;
      group.append(rect, text);
      layer.append(group);
    });
    node.append(layer);
    return () => layer.remove();
  }, [candles, compactMode, visibleEnd, visibleStart, visibility]);
  const width = 900; const height = compactMode ? 300 : 385; const pad = { l: 8, r: 52, t: 18, b: 36 };
  const visible = (visibility.institutionalFlow ? candles : candles.map((candle) => ({ ...candle, largeBuyVolume: 0, largeSellVolume: 0 }))).slice(visibleStart, visibleEnd);
  if (!visible.length) return <div className="chart-empty"><div className="skeleton-line wide" /><div className="skeleton-line" /><p>Loading live candles from Binance Futures…</p></div>;
  const min = Math.min(...visible.map((c) => c.low)); const max = Math.max(...visible.map((c) => c.high)); const span = max - min || 1; const xStep = (width - pad.l - pad.r) / visible.length; const y = (value: number) => pad.t + ((max - value) / span) * (height - pad.t - pad.b); const candleWidth = Math.max(3, xStep * 0.56);
  const profile = buildVolumeProfile(visible).map((node) => visibility.poc ? node : { ...node, isPoc: false }).filter((node) => visibility.volumeProfile || (visibility.poc && node.isPoc));
  const vwap = visibility.sessionVwap ? buildVwapBands(visible) : [];
  const maxProfileVolume = Math.max(1, ...profile.map((node) => node.volume));
  const swingLiquidity = buildSwingLiquidity(visible, bids, asks);
   const currentPrice = price ?? trades[0]?.price ?? visible[visible.length - 1]?.close ?? null;
   if (anchoredWallsRef.current.symbol !== symbol) anchoredWallsRef.current = { symbol };
   (['bid', 'ask'] as const).forEach((side) => {
     if (anchoredWallsRef.current[side]) return;
     const levels = (side === 'bid' ? bids : asks).filter((level) => Number.isFinite(level.price) && Number.isFinite(level.qty) && level.qty > 0);
     const heaviest = levels.reduce<DepthLevel | undefined>((best, level) => !best || level.qty > best.qty ? level : best, undefined);
     if (heaviest) anchoredWallsRef.current[side] = { price: heaviest.price, initialQty: heaviest.qty };
   });
    const walls = visibility.liquidityWalls ? (['bid', 'ask'] as const).map((side) => {
     const anchor = anchoredWallsRef.current[side];
     if (!anchor) return undefined;
     const levels = side === 'bid' ? bids : asks;
     const visibleLevel = levels.find((level) => level.price === anchor.price);
     return { price: anchor.price, qty: visibleLevel?.qty ?? 0, side, initialQty: anchor.initialQty, visible: Boolean(visibleLevel) };
    }).filter((wall): wall is { price: number; qty: number; side: DepthLevel['side']; initialQty: number; visible: boolean } => Boolean(wall)) : [];
  const barMs = visible.length > 1 ? Math.max(1, visible[1].time - visible[0].time) : 60_000;
   const contactBandFor = (wallPrice: number) => Math.max(span * .002, wallPrice * .00025);
   const wallFlowFor = (wall: (typeof walls)[number]) => {
     const contactBand = contactBandFor(wall.price);
     const contacted = currentPrice != null && Math.abs(currentPrice - wall.price) <= contactBand;
     const opposingSide: Trade['side'] = wall.side === 'ask' ? 'buy' : 'sell';
     const estimatedAggressorNotional = contacted
       ? trades.filter((trade) => trade.side === opposingSide && Math.abs(trade.price - wall.price) <= contactBand * 1.5).reduce((sum, trade) => sum + (trade.notional || trade.price * trade.qty), 0)
       : 0;
     return { contacted, estimatedAggressorNotional, initialNotional: wall.price * wall.initialQty, visibleNotional: wall.price * wall.qty, remainingRatio: Math.min(1, wall.qty / Math.max(wall.initialQty, Number.EPSILON)) };
   };
  const formatCandleTime = (time: number) => {
    const date = new Date(time);
    if (interval.endsWith('D') || interval.endsWith('W') || interval.endsWith('M')) return date.toLocaleDateString([], { month: 'short', day: '2-digit', year: '2-digit' });
    return date.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
   const renderedEvents = events.filter((event) => event.kind === 'sweep-low' ? visibility.bullishSweeps : event.kind === 'sweep-high' ? visibility.bearishSweeps : visibility.absorptionZones);
   const eventMap = new Map(renderedEvents.map((event) => [event.time, event]));
  const xForTime = (time: number) => {
    const index = visible.findIndex((candle) => candle.time === time);
    return index < 0 ? null : pad.l + index * xStep + xStep / 2;
  };
  const labelCandidates: OverlayLabel[] = [];
  visible.forEach((candle, index) => {
    const x = pad.l + index * xStep + xStep / 2;
    const event = eventMap.get(candle.time);
    const iceberg = icebergAlerts.find((alert) => alert.timestamp >= candle.time && alert.timestamp < candle.time + barMs && alert.price >= candle.low && alert.price <= candle.high);
    if (visibility.institutionalFlow && (candle.largeBuyVolume > 0 || candle.largeSellVolume > 0)) labelCandidates.push({ key: `inst-${candle.time}`, x: x + 8, y: Math.max(pad.t + 16, y(candle.high) - 12), text: 'INST', tone: 'amber', priority: 88, width: 38 });
    if (visibility.icebergOrders && iceberg) labelCandidates.push({ key: `ice-${candle.time}`, x: x - 30, y: Math.max(pad.t + 17, y(candle.high) - 28), text: 'ICEBERG', tone: 'cyan', priority: 92, width: 58 });
    if (event?.kind === 'sweep-low' && visibility.bullishSweeps) labelCandidates.push({ key: `sweep-${candle.time}`, x: x - 36, y: y(event.price) + 17, text: 'BULL SWEEP', tone: 'bull', priority: 82, width: 72 });
    if (event?.kind === 'sweep-high' && visibility.bearishSweeps) labelCandidates.push({ key: `sweep-${candle.time}`, x: x - 36, y: y(event.price) - 12, text: 'BEAR SWEEP', tone: 'bear', priority: 82, width: 72 });
  });
  if (visibility.absorptionZones) absorptionZones.slice(-6).forEach((zone) => {
    const x = xForTime(zone.endTime);
    if (x == null || zone.price < min || zone.price > max) return;
    const buyerTrap = zone.direction === 'buyer-trap';
    labelCandidates.push({ key: `absorption-${zone.id}`, x: x + 9, y: y(zone.price) - 8, text: buyerTrap ? `BUY ABS ${compact(zone.absorbedVolume)}` : `SELL ABS ${compact(zone.absorbedVolume)}`, tone: buyerTrap ? 'bear' : 'bull', priority: 100, width: buyerTrap ? 87 : 91 });
  });
  walls.forEach((wall) => {
    if (wall.price < min || wall.price > max) return;
    const flow = wallFlowFor(wall);
    const isBid = wall.side === 'bid';
    const wallY = y(wall.price);
    labelCandidates.push({
      key: `wall-${wall.side}`,
      x: pad.l + 12,
      y: wallY - 10,
      text: `${isBid ? 'BUY' : 'SELL'} WALL · ${compact(flow.visibleNotional)}`,
      tone: isBid ? 'bull' : 'bear',
      priority: flow.contacted ? 96 : 62,
      width: 128,
    });
    if (flow.contacted) {
      labelCandidates.push({
        key: `wall-contact-${wall.side}`,
        x: pad.l + 12,
        y: wallY + 12,
        text: `CONTACT · EST ${compact(flow.estimatedAggressorNotional)}`,
        tone: isBid ? 'bull' : 'bear',
        priority: 94,
        width: 145,
      });
    }
  });
  const placedLabels = new Map<string, OverlayLabel>();
  const occupiedLabels: Array<{ x: number; y: number; width: number; height: number }> = [];
  [...labelCandidates].sort((a, b) => b.priority - a.priority).forEach((candidate) => {
    const x = Math.max(pad.l + 3, Math.min(width - pad.r - candidate.width - 3, candidate.x));
    const offsets = [0, -17, 17, -34, 34, -51, 51];
    const chosen = offsets.find((offset) => {
      const yPosition = Math.max(pad.t + 13, Math.min(height - pad.b - 4, candidate.y + offset));
      const box = { x, y: yPosition - 13, width: candidate.width, height: 16 };
      return occupiedLabels.every((other) => box.x + box.width < other.x || other.x + other.width < box.x || box.y + box.height < other.y || other.y + other.height < box.y);
    });
    if (chosen == null) return;
    const yPosition = Math.max(pad.t + 13, Math.min(height - pad.b - 4, candidate.y + chosen));
    const placed = { ...candidate, x, y: yPosition };
    placedLabels.set(candidate.key, placed);
    occupiedLabels.push({ x, y: yPosition - 13, width: candidate.width, height: 16 });
  });
  placedLabelsRef.current = placedLabels;
  const particleOffsets = Array.from({ length: 30 }, (_, index) => {
    const angle = (index / 22) * Math.PI * 2;
    const radius = 22 + (index % 5) * 13;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * .56, r: index % 3 === 0 ? 1.8 : 1.05, delay: `${(index % 7) * 120}ms` };
  });
  const path = (key: keyof typeof vwap[number]) => vwap.map((point, index) => `${index ? 'L' : 'M'} ${pad.l + index * xStep + xStep / 2} ${y(point[key])}`).join(' ');
  const riskLine = (key: keyof RiskLevels, label: string, color: string) => {
    const value = riskLevels[key];
    if (value == null || value < min || value > max) return null;
    return <g className="risk-overlay" onPointerDown={(event) => { (event.currentTarget as SVGElement).setPointerCapture(event.pointerId); const move = (moveEvent: PointerEvent) => { const rect = (event.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect(); const next = max - ((moveEvent.clientY - rect.top) / rect.height) * span; onRiskChange({ ...riskLevels, [key]: Math.max(min, Math.min(max, next)) }); }; const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); }; window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); }}><line x1={pad.l} x2={width - pad.r} y1={y(value)} y2={y(value)} stroke={color} strokeWidth="1.5" strokeDasharray="5 3" /><text x={pad.l + 5} y={y(value) - 4} className="risk-label" fill={color}>{label} {fmt(value, 2)}</text></g>;
  };
     return <div className="chart-wrap"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="candle-svg" role="img" aria-label="Live primary price action candlestick chart" onMouseLeave={() => onHover(null)} onWheel={(event) => { event.preventDefault(); onZoom(event.deltaY > 0 ? 1 : -1); }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { pointerId: event.pointerId, x: event.clientX, lastX: event.clientX, pinchDistance: null }; }} onPointerMove={(event) => { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; const dx = event.clientX - drag.lastX; if (Math.abs(dx) > 1) { onPan(Math.round(-(dx / width) * visible.length)); drag.lastX = event.clientX; } }} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}><defs><linearGradient id="wall-ask-fill" x1="0" x2="1"><stop offset="0" stopColor="#ef6f6a" stopOpacity=".03" /><stop offset=".58" stopColor="#ef6f6a" stopOpacity=".22" /><stop offset="1" stopColor="#ef6f6a" stopOpacity=".02" /></linearGradient><linearGradient id="wall-bid-fill" x1="0" x2="1"><stop offset="0" stopColor="#46d9b4" stopOpacity=".03" /><stop offset=".58" stopColor="#46d9b4" stopOpacity=".25" /><stop offset="1" stopColor="#46d9b4" stopOpacity=".02" /></linearGradient><filter id="wall-glow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>{[0, .25, .5, .75, 1].map((ratio) => <g key={ratio}><line x1={pad.l} x2={width - pad.r} y1={pad.t + ratio * (height - pad.t - pad.b)} y2={pad.t + ratio * (height - pad.t - pad.b)} className="chart-grid" /><text x={width - pad.r + 8} y={pad.t + ratio * (height - pad.t - pad.b) + 4} className="axis-label">{fmt(max - ratio * span, 0)}</text></g>)}{profile.map((node, index) => { const nodeY = y(node.price); const nodeHeight = Math.max(3, (height - pad.t - pad.b) / profile.length * .72); const nodeWidth = node.volume / maxProfileVolume * 76; return <rect key={`profile-${index}`} x={width - pad.r - nodeWidth} y={nodeY - nodeHeight / 2} width={nodeWidth} height={nodeHeight} className={node.isPoc ? 'profile-node poc' : 'profile-node'} />; })}<path d={path('upper2')} className="study-band band-outer" /><path d={path('upper1')} className="study-band" /><path d={path('vwap')} className="study-vwap" /><path d={path('lower1')} className="study-band" /><path d={path('lower2')} className="study-band band-outer" />{walls.map((wall, index) => { if (wall.price < min || wall.price > max) return null; const flow = wallFlowFor(wall); const wallOpacity = Math.max(.32, .88 - (1 - flow.remainingRatio) * .46); const label = wall.side === 'bid' ? 'BUYER WALL' : 'SELLER WALL'; const opposingLabel = wall.side === 'bid' ? 'SELL AGGRESSOR' : 'BUY AGGRESSOR'; const wallY = y(wall.price); const bandHeight = Math.max(5, height * .032); const vortexX = width * .71; const cardX = Math.min(width - pad.r - 238, Math.max(pad.l + 12, vortexX + 26)); const cardY = Math.max(pad.t + 4, Math.min(height - pad.b - 57, wallY - 30)); const status = flow.contacted ? 'CONTACT' : wall.visible ? 'WATCHING' : 'NO VISIBLE DEPTH'; return <g key={`wall-${wall.side}-${wall.price}`} className={`chart-wall-group ${wall.side}${flow.contacted ? ' is-contacted' : ''}`} style={{ opacity: wallOpacity }}><rect className="wall-field" x={pad.l} y={wallY - bandHeight / 2} width={width * .78} height={bandHeight} rx="5" /><line x1={pad.l} x2={width - pad.r} y1={wallY} y2={wallY} className="liquidity-wall" /><text x={pad.l + 10} y={wallY - 11} className="wall-label wall-label-primary">{label}</text><text x={pad.l + 10} y={wallY + 9} className="wall-value-label">{compact(flow.initialNotional)} USDT <tspan className="wall-value-separator">·</tspan> {compact(flow.visibleNotional)} VISIBLE</text>{flow.contacted && <g className="wall-vortex" transform={`translate(${vortexX} ${wallY})`} filter="url(#wall-glow)"><ellipse rx="45" ry="15" /><ellipse rx="30" ry="10" /><ellipse rx="14" ry="5" />{particleOffsets.map((particle, particleIndex) => <circle key={particleIndex} cx={particle.x} cy={particle.y} r={particle.r} style={{ animationDelay: particle.delay }} />)}</g>}<text x={width - pad.r - 7} y={wallY - 6} className="wall-status-label" textAnchor="end">{status} · {fmt(wall.price, 2)}</text>{flow.contacted && <><g className="wall-contact-spark"><circle cx={vortexX} cy={wallY} r="4" /><circle cx={vortexX - 11} cy={wallY - 8} r="1.5" /><circle cx={vortexX + 12} cy={wallY - 11} r="1.4" /><circle cx={vortexX + 16} cy={wallY + 8} r="1.2" /></g><g className="wall-contact-popup" transform={`translate(${cardX} ${cardY})`}><rect width="238" height="54" rx="3" /><text x="8" y="12" className="wall-contact-title">{label} CONTACT · ESTIMATE</text><text x="8" y="25">{opposingLabel} {compact(flow.estimatedAggressorNotional)} USDT</text><text x="8" y="37">INITIAL {compact(flow.initialNotional)} · VISIBLE {compact(flow.visibleNotional)}</text><text x="8" y="48" className="wall-contact-note">PUBLIC TRADES / DEPTH — NOT INDIVIDUAL ORDER FILL</text></g></>}</g>; })}{currentPrice != null && <g className="current-price-marker"><line x1={pad.l} x2={width - pad.r} y1={y(currentPrice)} y2={y(currentPrice)} /><rect x={width - pad.r + 1} y={y(currentPrice) - 10} width="50" height="20" rx="2" /><text x={width - pad.r + 26} y={y(currentPrice) + 3} textAnchor="middle">{fmt(currentPrice, currentPrice > 1000 ? 0 : 2)}</text></g>}{absorptionZones.slice(-6).map((zone) => { const x = xForTime(zone.endTime); if (x == null || zone.price < min || zone.price > max) return null; const buyerTrap = zone.direction === 'buyer-trap'; return <g key={`absorption-zone-${zone.id}`} className={`chart-absorption-zone ${zone.direction}`}><line x1={pad.l} x2={width - pad.r} y1={y(zone.price)} y2={y(zone.price)} /><circle cx={x} cy={y(zone.price)} r="6" /><text x={Math.min(width - pad.r - 128, Math.max(pad.l + 8, x + 9))} y={y(zone.price) - 7}>{buyerTrap ? 'BUYER ATTACK → SELL ABSORPTION' : 'SELLER ATTACK → BUY ABSORPTION'} · {compact(zone.absorbedVolume)} ABS</text></g>; })}{divergences.map((divergence, index) => { const x1 = xForTime(divergence.fromTime); const x2 = xForTime(divergence.toTime); if (x1 == null || x2 == null) return null; return <line key={`price-divergence-${divergence.study}-${index}`} x1={x1} x2={x2} y1={y(divergence.priceFrom)} y2={y(divergence.priceTo)} className={`divergence-line ${divergence.type}`} />; })}{riskLine('entry', 'ENTRY', 'var(--cyan)')}{riskLine('stop', 'STOP', 'var(--red)')}{riskLine('target', 'TARGET', 'var(--green)')}{visible.map((candle, index) => { const x = pad.l + index * xStep + xStep / 2; const bullish = candle.close >= candle.open; const color = bullish ? 'var(--green)' : 'var(--red)'; const event = eventMap.get(candle.time); const institutional = candle.largeBuyVolume > 0 || candle.largeSellVolume > 0; const iceberg = icebergAlerts.find((alert) => alert.timestamp >= candle.time && alert.timestamp < candle.time + barMs && alert.price >= candle.low && alert.price <= candle.high); return <g key={candle.time} className={`candle${iceberg ? ' iceberg-candle' : ''}`} onMouseEnter={() => onHover(candle.time)}><rect className="candle-hit-area" x={pad.l + index * xStep} y={pad.t} width={xStep} height={height - pad.t - pad.b} />{institutional && <><polygon className="institution-diamond" points={`${x},${Math.max(9, y(candle.high) - 16)} ${x + 6},${Math.max(9, y(candle.high) - 10)} ${x},${Math.max(9, y(candle.high) - 4)} ${x - 6},${Math.max(9, y(candle.high) - 10)}`} /><text className="institution-badge" x={x + 10} y={Math.max(13, y(candle.high) - 8)}>INST</text></>}{iceberg && <><rect className="iceberg-pillar" x={x - Math.max(4, candleWidth * .8)} y={Math.max(pad.t + 3, y(candle.high) - 7)} width={Math.max(8, candleWidth * 1.6)} height={Math.max(34, y(candle.low) - y(candle.high) + 14)} rx="2" /><ellipse className="iceberg-aura" cx={x} cy={y((candle.high + candle.low) / 2)} rx={Math.max(14, candleWidth * 1.7)} ry={Math.max(30, (y(candle.low) - y(candle.high)) * .65)} /><rect className="iceberg-badge" x={Math.max(pad.l, x - 29)} y={Math.max(pad.t + 4, y(candle.high) - 26)} width="58" height="14" rx="2" /><text className="iceberg-banner" x={x} y={Math.max(pad.t + 14, y(candle.high) - 16)} textAnchor="middle">ICEBERG</text></>}{event?.kind === 'absorption' && <circle className="absorption-mark" cx={x} cy={y(event.price)} r="6" />}{event?.kind.startsWith('sweep') && <text className="sweep-label" x={x} y={event.kind === 'sweep-high' ? y(event.price) - 8 : y(event.price) + 14}>SWEEP</text>}<line x1={x} x2={x} y1={y(candle.high)} y2={y(candle.low)} stroke={color} strokeWidth="1" /><rect x={x - candleWidth / 2} y={Math.min(y(candle.open), y(candle.close))} width={candleWidth} height={Math.max(1.5, Math.abs(y(candle.open) - y(candle.close)))} fill={color} opacity=".9" /></g>; })}{hoveredTime != null && visible.map((candle, index) => candle.time === hoveredTime ? <line key={`primary-crosshair-${candle.time}`} className="flow-crosshair" x1={pad.l + index * xStep + xStep / 2} x2={pad.l + index * xStep + xStep / 2} y1={pad.t} y2={height - pad.b} /> : null)}{visible.map((candle, index) => <text key={`time-${candle.time}`} className="time-label" x={pad.l + index * xStep + xStep / 2} y={height - 9} textAnchor="middle">{index % Math.max(1, Math.ceil(visible.length / 7)) === 0 ? formatCandleTime(candle.time) : ''}</text>)}</svg><div className="chart-legend"><span><i className="legend-green" /> bullish candle</span><span><i className="legend-red" /> bearish candle</span><span><i className="legend-amber" /> INST flow</span><span><i className="legend-cyan" /> ICEBERG / VWAP</span><span><i className="legend-absorption" /> absorption zones</span><span><Tip>Primary candles are live Binance klines; walls use the visible depth book.</Tip> DATA: LIVE</span></div></div>;
}

type FlowKind = 'pressure' | 'direction';
type FlowCandle = Candle & { flowOpen: number; flowHigh: number; flowLow: number; flowClose: number; score: number };

function buildFlowCandles(candles: Candle[], kind: FlowKind): FlowCandle[] {
  let running = 0;
  return candles.slice(-70).map((candle) => {
    const score = kind === 'pressure'
      ? candle.delta
      : Math.max(-1, Math.min(1, candle.directionBias || (candle.close >= candle.open ? 1 : -1)));
    const flowOpen = running;
    running += score;
    const flowClose = running;
    const wick = kind === 'pressure'
      ? Math.max(Math.abs(score) * 0.16, (candle.buyVolume + candle.sellVolume) * 0.002)
      : Math.max(0.22, Math.abs(score) * 0.35);
    return {
      ...candle,
      flowOpen,
      flowClose,
      flowHigh: Math.max(flowOpen, flowClose) + wick,
      flowLow: Math.min(flowOpen, flowClose) - wick,
      score,
    };
  });
}

function FlowReadout({ candles, kind }: { candles: Candle[]; kind: FlowKind }) {
  const items = candles.slice(-20);
  const value = kind === 'pressure'
    ? items.reduce((sum, item) => sum + item.delta, 0)
    : items.reduce((sum, item) => sum + (item.directionBias || (item.close >= item.open ? 1 : -1)), 0);
  const positive = value >= 0;
  const label = kind === 'pressure'
    ? positive ? 'BUYERS DOMINANT' : 'SELLERS DOMINANT'
    : positive ? 'BUYERS ATTACKING' : 'SELLERS ATTACKING';
  const detail = kind === 'pressure'
    ? `${positive ? '+' : '−'}${compact(Math.abs(value))} base volume delta`
    : `${positive ? '+' : '−'}${Math.abs(value).toFixed(1)} direction balance`;
  return <div className={`flow-readout ${positive ? 'buy-read' : 'sell-read'}`}><span className="flow-readout-dot" /><div><strong>{label}</strong><small>{detail}</small></div><span className="flow-readout-help">{kind === 'pressure' ? 'Who is dominant?' : 'Who is attacking?'}</span></div>;
}

function FlowCandleChart({ candles, kind, compactMode, hoveredTime, onHover, divergences, visibleStart, visibleEnd }: { candles: Candle[]; kind: FlowKind; compactMode: boolean; hoveredTime: number | null; onHover: (time: number | null) => void; divergences: Divergence[]; visibleStart: number; visibleEnd: number }) {
  const width = 900;
  const height = compactMode ? 300 : 385;
  const pad = { l: 8, r: 50, t: 16, b: 36 };
  const items = buildFlowCandles(candles.slice(visibleStart, visibleEnd), kind);
  if (!items.length) return <div className="flow-chart-empty"><div className="skeleton-line wide" /><p>Waiting for live trade flow…</p></div>;
  const min = Math.min(...items.map((item) => item.flowLow));
  const max = Math.max(...items.map((item) => item.flowHigh));
  const span = max - min || 1;
  const xStep = (width - pad.l - pad.r) / items.length;
  const y = (value: number) => pad.t + ((max - value) / span) * (height - pad.t - pad.b);
   const candleWidth = Math.max(3, xStep * 0.56);
  const baseline = y(0);
  const xForTime = (time: number) => {
    const index = items.findIndex((item) => item.time === time);
    return index < 0 ? null : pad.l + index * xStep + xStep / 2;
  };
  const flowDivergences = divergences.filter((divergence) => divergence.study === kind);
  return <div className="flow-chart-wrap"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="flow-candle-svg" role="img" aria-label={kind === 'pressure' ? 'Cumulative price pressure candle chart' : 'Cumulative sub-bar direction balance candle chart'} onMouseLeave={() => onHover(null)}>{[0, .25, .5, .75, 1].map((ratio) => <g key={ratio}><line x1={pad.l} x2={width - pad.r} y1={pad.t + ratio * (height - pad.t - pad.b)} y2={pad.t + ratio * (height - pad.t - pad.b)} className="flow-grid" /><text x={width - pad.r + 7} y={pad.t + ratio * (height - pad.t - pad.b) + 3} className="axis-label">{kind === 'pressure' ? compact(max - ratio * span) : (max - ratio * span).toFixed(1)}</text></g>)}<line x1={pad.l} x2={width - pad.r} y1={baseline} y2={baseline} className="flow-zero" />{flowDivergences.map((divergence, index) => { const x1 = xForTime(divergence.fromTime); const x2 = xForTime(divergence.toTime); if (x1 == null || x2 == null) return null; return <line key={`flow-divergence-${index}`} x1={x1} x2={x2} y1={y(divergence.studyFrom)} y2={y(divergence.studyTo)} className={`divergence-line ${divergence.type}`} />; })}{items.map((item, index) => { const x = pad.l + index * xStep + xStep / 2; const bullish = item.flowClose >= item.flowOpen; const color = bullish ? 'var(--green)' : 'var(--red)'; const large = item.largeBuyVolume > 0 || item.largeSellVolume > 0; const selected = item.time === hoveredTime; return <g key={item.time} className={`flow-candle${selected ? ' selected' : ''}`} aria-label={`${new Date(item.time).toLocaleTimeString()} · ${bullish ? 'buyers' : 'sellers'} · ${kind === 'pressure' ? `delta ${fmt(item.score, 3)}` : `balance ${item.score.toFixed(2)}`}`}><rect className="flow-hit-area" data-testid={`flow-hit-${kind}-${item.time}`} x={pad.l + index * xStep} y={pad.t} width={xStep} height={height - pad.t - pad.b} onMouseEnter={() => onHover(item.time)} /><line x1={x} x2={x} y1={y(item.flowHigh)} y2={y(item.flowLow)} stroke={color} strokeWidth="1.2" /><rect x={x - candleWidth / 2} y={Math.min(y(item.flowOpen), y(item.flowClose))} width={candleWidth} height={Math.max(2, Math.abs(y(item.flowOpen) - y(item.flowClose)))} fill={color} opacity=".92" />{large && <circle cx={x} cy={Math.max(7, y(item.flowHigh) - 5)} r="3" fill="var(--amber)" stroke="#11161c" strokeWidth="1.5" />}</g>; })}{hoveredTime != null && items.map((item, index) => item.time === hoveredTime ? <line key={`crosshair-${item.time}`} className="flow-crosshair" x1={pad.l + index * xStep + xStep / 2} x2={pad.l + index * xStep + xStep / 2} y1={pad.t} y2={height - pad.b} /> : null)}</svg><div className="flow-chart-foot"><span><i className="legend-green" /> buyers</span><span><i className="legend-red" /> sellers</span><span><i className="legend-amber" /> large-flow proxy</span><span className="flow-chart-note">Each candle = selected timeframe bar</span></div></div>;
}

function FlowDetailCard({ candles, hoveredTime }: { candles: Candle[]; hoveredTime: number | null }) {
  const pressureItems = useMemo(() => buildFlowCandles(candles, 'pressure'), [candles]);
  const directionItems = useMemo(() => buildFlowCandles(candles, 'direction'), [candles]);
  const candle = hoveredTime == null ? undefined : candles.find((item) => item.time === hoveredTime);
  const pressure = hoveredTime == null ? undefined : pressureItems.find((item) => item.time === hoveredTime);
  const direction = hoveredTime == null ? undefined : directionItems.find((item) => item.time === hoveredTime);
  const large = candle ? candle.largeBuyVolume > 0 || candle.largeSellVolume > 0 : false;
  const directionScore = direction?.score ?? candle?.directionBias ?? null;
  return <div className={`flow-detail-card${candle ? ' has-selection' : ''}`} aria-live="polite" data-testid="flow-detail-card"><div className="flow-detail-heading"><span>SELECTED FLOW BAR</span>{candle ? <time>{new Date(candle.time).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time> : <em>Hover a candle to inspect</em>}</div>{candle ? <div className="flow-detail-grid"><div><span>BUY VOLUME</span><strong className="green">{compact(candle.buyVolume)}</strong></div><div><span>SELL VOLUME</span><strong className="red">{compact(candle.sellVolume)}</strong></div><div><span>DELTA</span><strong className={candle.delta >= 0 ? 'green' : 'red'}>{candle.delta >= 0 ? '+' : '−'}{compact(Math.abs(candle.delta))}</strong></div><div><span>CUM. PRESSURE</span><strong className={pressure && pressure.flowClose >= 0 ? 'green' : 'red'}>{pressure ? `${pressure.flowClose >= 0 ? '+' : '−'}${compact(Math.abs(pressure.flowClose))}` : '—'}</strong></div><div><span>DIRECTION BALANCE</span><strong className={directionScore != null && directionScore >= 0 ? 'green' : 'red'}>{directionScore == null ? '—' : `${directionScore >= 0 ? '+' : '−'}${Math.abs(directionScore).toFixed(2)}`}</strong></div><div><span>LARGE-FLOW PROXY</span><strong className={large ? 'amber' : 'muted'}>{large ? 'YES' : 'NO'}</strong></div></div> : <div className="flow-detail-placeholder">Move across either candle panel to synchronize the crosshair and reveal buy/sell execution detail.</div>}</div>;
}

function Heatmap({ bids, asks, price }: { bids: DepthLevel[]; asks: DepthLevel[]; price: number | null }) {
  const levels = [...asks.slice(0, 18).reverse(), ...bids.slice(0, 18)]; const maxQty = Math.max(1, ...levels.map((item) => item.qty)); const [hover, setHover] = useState<DepthLevel | null>(null);
  return <div className="heatmap-wrap">{hover && <div className="heatmap-hover"><strong>{hover.side === 'bid' ? 'Bid liquidity' : 'Ask liquidity'}</strong><span>{fmt(hover.price, 2)} · {compact(hover.qty)} contracts</span></div>}<div className="heatmap-grid">{levels.length ? levels.map((item, index) => <button key={`${item.side}-${item.price}-${index}`} className={`heat-row ${item.side}`} onMouseEnter={() => setHover(item)} onMouseLeave={() => setHover(null)} data-testid={`heatmap-level-${item.side}-${index}`}><span className="heat-price">{fmt(item.price, 2)}</span><span className="heat-track"><i style={{ width: `${Math.max(5, item.qty / maxQty * 100)}%` }} /></span><span className="heat-qty">{compact(item.qty)}</span></button>) : <div className="empty-state"><BookOpen size={20} /><span>Depth levels will appear when the stream connects.</span></div>}</div>{price && <div className="price-marker" style={{ top: `${(asks.length / Math.max(1, levels.length)) * 100}%` }}><span /> {fmt(price, 2)}</div>}<div className="heat-legend"><span><i className="ask-swatch" /> ask liquidity</span><span><i className="bid-swatch" /> bid liquidity</span><span><Tip>Bars show relative resting quantity across the visible order book. This is not executed volume.</Tip> hover a row for detail</span></div></div>;
}

function Orderbook({ bids, asks }: { bids: DepthLevel[]; asks: DepthLevel[] }) {
  const bidTotal = bids.slice(0, 15).reduce((sum, item) => sum + item.qty, 0); const askTotal = asks.slice(0, 15).reduce((sum, item) => sum + item.qty, 0); const total = bidTotal + askTotal; const ratio = total ? bidTotal / total * 100 : null;
  return <Panel title="ORDERBOOK IMBALANCE" hint="Visible depth is grouped from the live depth@100ms stream. Imbalance compares the top 15 bid and ask levels."><div className="imbalance-head"><strong>{ratio == null ? '—' : `${ratio.toFixed(1)}%`}</strong><span>bid-side share</span><b className={ratio != null && ratio > 50 ? 'green' : 'red'}>{ratio == null ? '—' : ratio > 50 ? 'BUY WALL' : 'SELL WALL'}</b></div><div className="imbalance-track"><i style={{ width: `${ratio ?? 50}%` }} /></div><div className="imbalance-labels"><span>Bids <b>{compact(bidTotal)}</b></span><span>Asks <b>{compact(askTotal)}</b></span></div></Panel>;
}

function Tape({ trades }: { trades: Trade[] }) {
  return <Panel title="RECENT TRADE TAPE" hint="Each row is one aggregate trade from Binance. Buy means the taker lifted the ask; sell means the taker hit the bid."><div className="tape-head"><span>TIME</span><span>SIDE</span><span>PRICE</span><span>SIZE</span></div><div className="tape">{trades.length ? trades.slice(0, 22).map((trade) => <div className="tape-row" key={trade.id}><span>{new Date(trade.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><b className={trade.side === 'buy' ? 'green' : 'red'}>{trade.side.toUpperCase()}</b><span>{fmt(trade.price, 2)}</span><strong>{trade.qty.toFixed(4)}</strong></div>) : <div className="empty-state compact-empty"><Activity size={18} /><span>Trade tape is waiting for live aggTrade messages.</span></div>}</div></Panel>;
}

function HeavyFlow({ trades, liquidations }: { trades: Trade[]; liquidations: Liquidation[] }) {
  const largeTrades = trades.filter((trade) => trade.isLarge).slice(0, 8);
  return <Panel title="LARGE-FLOW / LIQUIDATION RADAR" hint="Large aggressive prints are a size proxy. Liquidations come from Binance's public forceOrder stream. Neither identifies an institution."><div className="large-flow-note">INSTITUTIONAL-SIZE PROXY <Tip>Unusually large taker trades relative to the current stream baseline.</Tip><span className="radar-count">{liquidations.length} liquidations</span></div><div className="large-flow-list">{largeTrades.length || liquidations.length ? [...largeTrades.map((trade) => <div className="large-flow-row" key={`large-${trade.id}`}><span className={`large-flow-badge ${trade.side}`}>{trade.side === 'buy' ? 'BUY' : 'SELL'}</span><strong>{compact(trade.notional)} USDT</strong><span>{fmt(trade.price, 2)}</span><time>{new Date(trade.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>), ...liquidations.slice(0, 4).map((order) => <div className="large-flow-row liquidation-row" key={`liquidation-${order.id}`}><span className="large-flow-badge liquidation">LIQ</span><strong>{compact(order.notional)} USDT</strong><span>{fmt(order.price, 2)}</span><time>{new Date(order.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>)] : <div className="empty-small">Large prints and liquidations will appear here as they arrive.</div>}</div></Panel>;
}

function AppShell() {
  const [symbol, setSymbol] = useState('');
  const [contractType, setContractType] = useState<ContractType>('usdt-m');
  const [interval, setInterval] = useState('5m');
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [visibleCount, setVisibleCount] = useState(70);
  const [windowEnd, setWindowEnd] = useState(0);
  const [chartFullscreen, setChartFullscreen] = useState(false);
  const [icebergAlerts, setIcebergAlerts] = useState<IcebergAlert[]>([]);
  const [riskLevels, setRiskLevels] = useState<RiskLevels>({ entry: null, stop: null, target: null });
  const [indicatorVisibility, setIndicatorVisibility] = useState<IndicatorVisibility>(defaultIndicatorVisibility);
  const [tradeAlert, setTradeAlert] = useState<ReturnType<typeof evaluateTradeAlert>['alert']>(null);
  const [alertActionStatus, setAlertActionStatus] = useState<string | null>(null);
  const lastAlertKeyRef = useRef<string | null>(null);
  const { symbols } = usePerpetualSymbols(contractType);
  const { candles, bids, asks, trades, liquidations, price, change, quoteVolume, status, reconnect } = useBinanceMarket(symbol, interval, paused, contractType);
  const pulse = useMarketPulse(symbol, contractType);
  const pressureDivergences = useMemo(() => detectDivergences(candles, 'pressure'), [candles]);
  const directionDivergences = useMemo(() => detectDivergences(candles, 'direction'), [candles]);
  const divergences = useMemo(() => [...pressureDivergences, ...directionDivergences].sort((a, b) => a.toTime - b.toTime).slice(-4), [directionDivergences, pressureDivergences]);
  const currentPressureDivergence = useMemo(() => detectCurrentPressureDivergence(candles), [candles]);
  const events = useMemo(() => detectFlowEvents(candles), [candles]);
  const absorptionAnalysis = useMemo(() => analyzeAbsorption(candles, trades, [...bids, ...asks]), [asks, bids, candles, trades]);
  const imbalance = useMemo(() => stackedImbalance(bids, asks), [asks, bids]);
  const tradeAlertEvaluation: TradeAlertEvaluation = useMemo(() => evaluateTradeAlert({
    symbol,
    timeframe: interval,
    price,
    candles,
    bids,
    asks,
    trades,
    absorption: absorptionAnalysis,
    icebergAlerts,
    stacked: imbalance,
    visibility: {
      institutionalFlow: indicatorVisibility.institutionalFlow,
      liquidityWalls: indicatorVisibility.liquidityWalls,
      icebergOrders: indicatorVisibility.icebergOrders,
      absorptionZones: indicatorVisibility.absorptionZones,
    },
  }), [absorptionAnalysis, asks, bids, candles, icebergAlerts, imbalance, indicatorVisibility.absorptionZones, indicatorVisibility.icebergOrders, indicatorVisibility.institutionalFlow, indicatorVisibility.liquidityWalls, interval, price, symbol, trades]);
  const effectiveEnd = windowEnd === 0 ? candles.length : Math.min(candles.length, Math.max(visibleCount, windowEnd));
  const effectiveStart = Math.max(0, effectiveEnd - visibleCount);
  useEffect(() => {
    const contractSymbols = symbols.filter((item) => item.contractType === contractType);
    if (contractSymbols.length && !contractSymbols.some((item) => item.symbol === symbol)) {
      setSymbol(contractSymbols[0].symbol);
      setFavorites((current) => current.length ? current.filter((item) => contractSymbols.some((candidate) => candidate.symbol === item)) : contractSymbols.slice(0, 2).map((item) => item.symbol));
    }
  }, [contractType, symbol, symbols]);
  useEffect(() => {
    const candidate = tradeAlertEvaluation.alert;
    if (!candidate || candidate.key === lastAlertKeyRef.current) return;
    lastAlertKeyRef.current = candidate.key;
    setTradeAlert(candidate);
    setAlertActionStatus(null);
  }, [tradeAlertEvaluation.alert]);
  useEffect(() => {
    setTradeAlert(null);
    setAlertActionStatus(null);
    lastAlertKeyRef.current = null;
  }, [interval, symbol]);
  const toggleFavorite = (value: string) => setFavorites((items) => items.includes(value) ? items.filter((item) => item !== value) : [...items, value]);
  const changeInterval = (value: string) => { setHoveredTime(null); setWindowEnd(0); setInterval(value); };
  const selectSymbol = (value: string) => { setHoveredTime(null); setWindowEnd(0); setSymbol(value); };
  const changeContract = (value: ContractType) => {
    setContractType(value);
    setHoveredTime(null);
    setWindowEnd(0);
    setTradeAlert(null);
    setSymbol('');
  };
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  useEffect(() => {
    if (!chartFullscreen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChartFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chartFullscreen]);
  const panChart = (deltaBars: number) => {
    setWindowEnd((current) => {
      const end = current === 0 ? candles.length : current;
      return Math.max(visibleCount, Math.min(candles.length, end + deltaBars));
    });
  };
  const zoomChart = (delta: number) => {
    setVisibleCount((current) => {
      const next = Math.max(30, Math.min(1000, current + delta * 10));
      setWindowEnd((end) => end === 0 ? 0 : Math.max(next, Math.min(candles.length, end)));
      return next;
    });
  };
  const toggleIndicator = (key: IndicatorKey) => setIndicatorVisibility((current) => ({ ...current, [key]: !current[key] }));
  const executeTradeAlert = () => {
    if (!tradeAlert) return;
    setRiskLevels((current) => ({ ...current, entry: tradeAlert.entryPrice }));
    setAlertActionStatus(`${tradeAlert.bias.toUpperCase()} order staged at ${fmt(tradeAlert.entryPrice, tradeAlert.entryPrice > 1000 ? 2 : 4)} — no live execution endpoint is connected.`);
    setTradeAlert(null);
  };
  const dismissTradeAlert = () => {
    setTradeAlert(null);
    setAlertActionStatus('Alert dismissed — waiting for a new complete confluence event.');
  };

  return <main className={`${compactMode ? 'terminal compact' : 'terminal'}${chartFullscreen ? ' chart-fullscreen' : ''}${secondaryOpen ? ' secondary-open' : ''}`}>
     <TopBar {...{ symbol, setSymbol: selectSymbol, interval, setInterval: changeInterval, favorites, onFavorite: toggleFavorite, symbols, contractType, setContractType: changeContract, status, onReconnect: reconnect, paused, onPause: () => setPaused((value) => !value), compactMode, onCompact: () => setCompactMode((value) => !value), secondaryOpen, onSecondary: () => setSecondaryOpen((value) => !value) }} />
    <div className="workspace">
      <div className="terminal-body">
        <div className="main-grid">
          <div className="left-column flow-panel-stack">
             <IndicatorControlPanel visibility={indicatorVisibility} onChange={toggleIndicator} />
            <TradeAlertMonitor evaluation={tradeAlertEvaluation} symbol={symbol} timeframe={interval} actionStatus={alertActionStatus} />
            <ChartNavigation candles={candles} visibleCount={visibleCount} onVisibleCount={(value) => { setVisibleCount(value); setWindowEnd(0); }} windowEnd={effectiveEnd} onWindowEnd={setWindowEnd} />
            <Panel id="price-action" title="COIN PRICE CHART" hint="Live OHLC price action with volume profile, point of control and visible orderbook liquidity walls.">
               <div className="flow-module-head"><span className="instrument-label">{symbol} <small>· {interval}</small></span><span className="chart-inline-meta"><span className="legend-green" /> BULL <span className="legend-red" /> BEAR</span><span className="live-tag"><i /> LIVE</span><button className="chart-fullscreen-button" onClick={() => setChartFullscreen((value) => !value)} title={chartFullscreen ? 'Restore terminal layout' : 'Expand chart'} data-testid={chartFullscreen ? 'button-chart-restore' : 'button-chart-fullscreen'}>{chartFullscreen ? <Minimize2 size={13} /> : <Expand size={13} />}{chartFullscreen ? 'RESTORE' : 'FULLSCREEN'}</button></div>
              <div className="flow-module-subtitle">OHLC price action · volume profile / POC · DOM liquidity walls</div>
                   <CandleChart symbol={symbol} candles={candles} compactMode={compactMode} interval={interval} bids={bids} asks={asks} trades={trades} price={price} divergences={divergences} events={events} absorptionZones={indicatorVisibility.absorptionZones ? absorptionAnalysis.zones : []} icebergAlerts={indicatorVisibility.icebergOrders ? icebergAlerts : []} visibility={indicatorVisibility} hoveredTime={hoveredTime} onHover={setHoveredTime} onPan={panChart} onZoom={zoomChart} riskLevels={riskLevels} onRiskChange={setRiskLevels} visibleStart={effectiveStart} visibleEnd={effectiveEnd} scaleMode="linear" autoFit />
              <div className="chart-study-strip"><span><i className="study-line vwap-line" /> SESSION VWAP</span><span><i className="study-line wall-line" /> LIQUIDITY WALLS</span><span><i className="study-line poc-line" /> POC / PROFILE</span><span className="chart-study-note">Divergence lines update with each live bar</span></div>
             </Panel>
             <Panel id="flow-pressure" title="CUMULATIVE CANDLE / PRICE PRESSURE" hint="The running aggressive-volume balance. Green means buyers are dominant; red means sellers are dominant. Divergence lines compare price lows/highs to this flow series.">
               <div className="flow-module-head"><span className="instrument-label">{symbol} <small>· {interval}</small></span><span className="live-tag"><i /> LIVE</span></div>
               <div className="flow-module-subtitle">OHLC structural pressure flow · buyer initiation vs seller rejection and range activity</div>
                <FlowCandleChart candles={candles} kind="pressure" compactMode={compactMode} hoveredTime={hoveredTime} onHover={setHoveredTime} divergences={divergences} visibleStart={effectiveStart} visibleEnd={effectiveEnd} />
               <FlowReadout candles={candles} kind="pressure" />
             </Panel>
             <FlowDetailCard candles={candles} hoveredTime={hoveredTime} />
              <AbsorptionVisualizer candles={candles} trades={trades} depth={[...bids, ...asks]} price={price} />
              <DomVisualizer bids={bids} asks={asks} price={price} symbol={symbol} />
               <IcebergRadar symbols={symbols} symbol={symbol.toLowerCase()} onSymbolChange={(value) => selectSymbol(value.toUpperCase())} onAlert={(alert) => setIcebergAlerts((current) => [alert, ...current.filter((item) => item.id !== alert.id)].slice(0, 80))} />
            <Panel id="flow-direction" title="CUMULATIVE CANDLE-DIRECTION BALANCE" hint="The running direction of sub-bar aggression. Green means buyers are attacking the current market; red means sellers are attacking.">
              <div className="flow-module-head"><span className="instrument-label">{symbol} <small>· {interval}</small></span><span className="live-tag"><i /> LIVE</span></div>
              <div className="flow-module-subtitle">One candle = selected bar · direction balance shows who is currently attacking</div>
               <FlowCandleChart candles={candles} kind="direction" compactMode={compactMode} hoveredTime={hoveredTime} onHover={setHoveredTime} divergences={divergences} visibleStart={effectiveStart} visibleEnd={effectiveEnd} />
              <FlowReadout candles={candles} kind="direction" />
            </Panel>
            <div className="lower-grid">
              <Panel title="SESSION READ" hint="A compact read of the current loaded candle set.">
                <div className="session-read"><div><span>Loaded candles</span><b>{candles.length || '—'}</b></div><div><span>Range high</span><b>{candles.length ? fmt(Math.max(...candles.map((item) => item.high)), 2) : '—'}</b></div><div><span>Range low</span><b>{candles.length ? fmt(Math.min(...candles.map((item) => item.low)), 2) : '—'}</b></div><div><span>Top of book</span><b>{bestBid && bestAsk ? `${fmt(bestBid, 1)} / ${fmt(bestAsk, 1)}` : '—'}</b></div></div>
              </Panel>
               <HeavyFlow trades={trades} liquidations={liquidations} />
               <RiskCalculator price={price} levels={riskLevels} onChange={setRiskLevels} />
            </div>
          </div>
          <aside className="right-column secondary-dock">
            <Panel id="liquidity-heatmap" title="LIQUIDITY HEATMAP" hint="A real-time visual of resting bid and ask quantity from the Binance depth stream. Use hover for row details."><Heatmap {...{ bids, asks, price }} /></Panel>
            <Orderbook {...{ bids, asks }} />
            <div id="recent-tape"><Tape trades={trades} /></div>
          </aside>
        </div>
      </div>
      <div className="secondary-surfaces">
        <div className="secondary-rail-wrap"><ModuleRail /></div>
        <Overview {...{ symbol, price, change, quoteVolume, bids, asks, candles, status, onReconnect: reconnect }} />
        <VolumeScreener symbols={symbols} selected={symbol} onSelect={selectSymbol} />
        <MarketPulseBar {...pulse} imbalance={imbalance} />
        <DivergenceBanner divergence={currentPressureDivergence} />
      </div>
    </div>
    <TradeAlertModal alert={tradeAlert} evaluation={tradeAlertEvaluation} actionStatus={alertActionStatus} onDismiss={dismissTradeAlert} onExecute={executeTradeAlert} />
    <footer className="disclaimer"><span><Sun size={13} /> Public market data only</span><span>Analytics, not financial advice. Binance streams can disconnect or arrive delayed. No execution, account, or private endpoints are used.</span><span className="footer-brand">ORDERFLOW TERMINAL / v0.1</span></footer>
  </main>;
}

export default function App() {
  return <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Switch><Route path="/" component={AppShell} /></Switch></WouterRouter>;
}
