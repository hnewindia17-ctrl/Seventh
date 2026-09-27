import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  BellOff,
  BellRing,
  ChevronDown,
  CircleHelp,
  Filter,
  Gauge,
  History,
  Layers3,
  Radio,
  RefreshCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Volume2,
  Waves,
} from 'lucide-react';
import { type ContractType, type SymbolInfo } from '@/hooks/use-binance-market';
import {
  type IcebergAlert,
  type IcebergSideFilter,
  useIcebergEngine,
} from '@/hooks/use-iceberg-engine';

interface IcebergRadarProps {
  symbol: string;
  symbols: SymbolInfo[];
  contractType?: ContractType;
  onSymbolChange: (symbol: string) => void;
  onAlert?: (alert: IcebergAlert) => void;
  onHistory?: (alerts: IcebergAlert[]) => void;
}

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const timeFormat = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const notionalFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
const ACTIVE_WINDOW_MS = 8000;

function playIcebergTone(context: AudioContext) {
  try {
    if (context.state === 'suspended') void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(620, context.currentTime + 0.16);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.055, context.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.24);
  } catch {
    // A browser may suspend or block audio; the visual event history remains available.
  }
}

function formatPrice(price: number) {
  return price >= 10000 ? price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : price.toFixed(2);
}

function formatNotional(value: number) {
  return notionalFormat.format(value);
}

function directionStyles(direction: IcebergAlert['direction']) {
  return direction === 'buy'
    ? { tone: 'text-emerald-300', fill: 'bg-emerald-400', wash: 'bg-emerald-400/10', border: 'border-emerald-400/25', label: 'BUY' }
    : { tone: 'text-rose-300', fill: 'bg-rose-400', wash: 'bg-rose-400/10', border: 'border-rose-400/25', label: 'SELL' };
}

function StatusBadge({ alert }: { alert: IcebergAlert }) {
  const styles = directionStyles(alert.direction);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold tracking-[0.13em] ${styles.wash} ${styles.border} ${styles.tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${styles.fill} ${alert.status === 'ACTIVE' ? 'live-dot' : ''}`} />
      {alert.status}
    </span>
  );
}

function PressureGauge({ alerts }: { alerts: IcebergAlert[] }) {
  const score = useMemo(() => {
    if (!alerts.length) return 50;
    const buy = alerts.filter((alert) => alert.direction === 'buy').reduce((sum, alert) => sum + alert.hiddenNotional, 0);
    const sell = alerts.filter((alert) => alert.direction === 'sell').reduce((sum, alert) => sum + alert.hiddenNotional, 0);
    return Math.round(Math.min(100, Math.max(0, 50 + ((buy - sell) / Math.max(buy + sell, 1)) * 50)));
  }, [alerts]);
  const label = score > 58 ? 'BUY PRESSURE' : score < 42 ? 'SELL PRESSURE' : 'BALANCED';
  const accent = score > 58 ? 'text-emerald-300' : score < 42 ? 'text-rose-300' : 'text-amber-300';
  return (
    <div className="rounded-xl border border-border/80 bg-black/10 p-4" data-testid="gauge-pressure">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          <Gauge className="h-3.5 w-3.5" />
          Pressure gauge
        </div>
        <span className={`mono text-[10px] font-semibold tracking-[0.14em] ${accent}`}>{label}</span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-rose-400/20">
        <div className="absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-rose-400/80 to-rose-400/10" />
        <div className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-emerald-400/80 to-emerald-400/10" />
        <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/60" />
        <div className="absolute -top-1 h-4 w-1 rounded-full bg-foreground shadow-[0_0_10px_hsl(var(--foreground)/.7)] transition-transform duration-500" style={{ transform: `translateX(${(score - 50) * 1.2}px)` }} />
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
        <span>SELL</span>
        <span className="mono text-foreground">{score}/100</span>
        <span>BUY</span>
      </div>
    </div>
  );
}

function DepthHeatmap({ alerts, visualAlerts }: { alerts: IcebergAlert[]; visualAlerts: boolean }) {
  const bounds = useMemo(() => {
    const prices = alerts.map((alert) => alert.price);
    const min = prices.length ? Math.min(...prices) : 0;
    const max = prices.length ? Math.max(...prices) : 1;
    return { min, max: max === min ? min + 1 : max };
  }, [alerts]);
  const bars = useMemo(() => Array.from({ length: 22 }, (_, index) => ({
    index,
    left: 14 + ((index * 37) % 70),
    right: 10 + ((index * 23) % 50),
    opacity: 0.28 + ((index * 11) % 45) / 100,
  })), []);

  return (
    <div className="panel-grid relative min-h-[340px] overflow-hidden rounded-xl border border-border/80 bg-[#0b1117] p-4" data-testid="visual-heatmap">
      <div className="absolute inset-x-0 top-0 flex items-center justify-between border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          <Waves className="h-3.5 w-3.5 text-primary" />
          Hidden liquidity map
        </div>
        <div className="mono text-[10px] text-muted-foreground">8s rolling window</div>
      </div>
      <div className="absolute inset-x-4 top-[62px] bottom-7 flex items-center">
        <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-border/80" />
        {bars.map((bar) => (
          <div key={bar.index} className="absolute h-[2px] rounded-full bg-sky-300/30" style={{ left: `${bar.left}%`, right: `${bar.right}%`, top: `${12 + bar.index * 3.5}%`, opacity: bar.opacity }} />
        ))}
        <div className="absolute left-1/2 top-[12%] h-[76%] w-px bg-primary/35" />
        {alerts.map((alert, index) => {
          const styles = directionStyles(alert.direction);
          const position = ((alert.price - bounds.min) / (bounds.max - bounds.min)) * 72 + 14;
          const vertical = 18 + ((index * 31) % 66);
          return (
            <div
              key={alert.id}
              className={`absolute ${styles.tone} ${visualAlerts && alert.status === 'ACTIVE' ? 'alert-ripple' : ''}`}
              style={{ left: `${Math.min(88, Math.max(9, position))}%`, top: `${vertical}%` }}
              title={`${styles.label} ${formatPrice(alert.price)}`}
              data-testid={`heatmap-alert-${alert.id}`}
            >
              <div className={`relative z-10 flex h-7 w-7 items-center justify-center rounded-full border ${styles.border} ${styles.wash} backdrop-blur-sm`}>
                {alert.direction === 'buy' ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
              </div>
            </div>
          );
        })}
        {!alerts.length && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            Waiting for hidden liquidity events
          </div>
        )}
      </div>
      <div className="absolute inset-x-4 bottom-3 flex justify-between mono text-[9px] text-muted-foreground">
        <span>LOWER BID</span>
        <span className="text-primary/80">MID PRICE</span>
        <span>UPPER ASK</span>
      </div>
    </div>
  );
}

function AlertRow({ alert, index }: { alert: IcebergAlert; index: number }) {
  const styles = directionStyles(alert.direction);
  const rowAlert = {
    ...alert,
    status: Date.now() - alert.timestamp <= ACTIVE_WINDOW_MS ? 'ACTIVE' as const : 'COOLING' as const,
  };
  return (
    <div className="rise-in grid grid-cols-[1.2fr_.9fr_.9fr_1fr_.8fr_.85fr] items-center gap-3 border-b border-border/60 px-4 py-3 text-xs last:border-0" style={{ animationDelay: `${Math.min(index * 40, 280)}ms` }} data-testid={`row-iceberg-${alert.id}`}>
      <div className="flex items-center gap-2.5">
        <div className={`flex h-7 w-7 items-center justify-center rounded-md ${styles.wash} ${styles.tone}`}>
          {alert.direction === 'buy' ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
        </div>
        <div>
          <p className="mono font-semibold text-foreground">{formatPrice(alert.price)}</p>
          <p className={`text-[10px] font-semibold tracking-[0.12em] ${styles.tone}`}>{styles.label} ICEBERG</p>
        </div>
      </div>
      <div><span className="mono block text-muted-foreground">{formatNotional(alert.visibleNotional)}</span><small className="mono text-[9px] text-muted-foreground/70">{numberFormat.format(alert.visibleQty)} qty</small></div>
      <div><span className="mono block text-foreground">{formatNotional(alert.executedNotional)}</span><small className="mono text-[9px] text-muted-foreground/70">{numberFormat.format(alert.executedQty)} qty</small></div>
      <div><span className={`mono block font-semibold ${styles.tone}`}>+{formatNotional(alert.hiddenNotional)}</span><small className={`mono text-[9px] ${styles.tone}/70`}>{numberFormat.format(alert.hiddenQty)} qty</small></div>
      <span className="mono text-foreground">{alert.absorptionPercent.toFixed(1)}%</span>
      <div className="flex items-center justify-between gap-2">
        <StatusBadge alert={rowAlert} />
        <span className="hidden mono text-[10px] text-muted-foreground xl:block">{timeFormat.format(alert.timestamp)}</span>
      </div>
    </div>
  );
}

export function IcebergRadar({ symbol, symbols, contractType = 'usdt-m', onSymbolChange, onAlert, onHistory }: IcebergRadarProps) {
  const [multiplier, setMultiplier] = useState(3);
  const [minNotional, setMinNotional] = useState(0);
  const [side, setSide] = useState<IcebergSideFilter>('all');
  const [visualAlerts, setVisualAlerts] = useState(true);
  const [deliveryAlerts, setDeliveryAlerts] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() => typeof Notification === 'undefined' ? 'default' : Notification.permission);
  const [alertSetupMessage, setAlertSetupMessage] = useState('');
  const [historyLimit, setHistoryLimit] = useState(50);
  const audioContextRef = useRef<AudioContext | null>(null);
  const lastDeliveredAlertRef = useRef<string | null>(null);
  const onAlertRef = useRef(onAlert);
  onAlertRef.current = onAlert;
  const [expanded, setExpanded] = useState(true);
  const [symbolMenuOpen, setSymbolMenuOpen] = useState(false);
  const [symbolQuery, setSymbolQuery] = useState('');
  const { alerts, history, latestAlert, connection, depthReady, lastEventAt, alertCount, historyCount, historyStorageAvailable } = useIcebergEngine(symbol, { multiplier, minNotional, side, visualAlerts }, contractType);
  const filteredHistory = useMemo(() => history.filter((alert) => {
    if (side !== 'all' && alert.direction !== side) return false;
    return alert.executedNotional >= minNotional;
  }), [history, minNotional, side]);
  const visibleHistory = filteredHistory.slice(0, historyLimit);
  const oldestStoredEvent = history.length ? history[history.length - 1] : undefined;

  useEffect(() => {
    if (latestAlert) onAlertRef.current?.(latestAlert);
  }, [latestAlert]);

  const onHistoryRef = useRef(onHistory);
  onHistoryRef.current = onHistory;
  useEffect(() => {
    if (history.length) onHistoryRef.current?.(history);
  }, [history]);

  useEffect(() => {
    setHistoryLimit(50);
    lastDeliveredAlertRef.current = null;
  }, [symbol]);

  useEffect(() => {
    if (!latestAlert || latestAlert.id === lastDeliveredAlertRef.current) return;
    if (connection === 'offline') {
      lastDeliveredAlertRef.current = latestAlert.id;
      return;
    }
    if (connection !== 'live') return;
    lastDeliveredAlertRef.current = latestAlert.id;
    if (!deliveryAlerts) return;
    if (audioContextRef.current) playIcebergTone(audioContextRef.current);
    if (document.visibilityState !== 'visible' && notificationPermission === 'granted' && 'Notification' in window) {
      try {
        new Notification(`${latestAlert.direction.toUpperCase()} ICEBERG · ${symbol.toUpperCase()}`, {
          body: `${formatPrice(latestAlert.price)} · ${formatNotional(latestAlert.hiddenNotional)} estimated hidden size`,
          tag: `iceberg-${latestAlert.id}`,
        });
      } catch {
        setAlertSetupMessage('Browser blocked the background notification. The event is still saved in local history.');
      }
    }
  }, [connection, deliveryAlerts, latestAlert, notificationPermission, symbol]);

  const toggleDeliveryAlerts = async () => {
    if (deliveryAlerts) {
      setDeliveryAlerts(false);
      setAlertSetupMessage('Sound and desktop alerts are off.');
      return;
    }

    lastDeliveredAlertRef.current = latestAlert?.id ?? null;
    let permissionRequest: Promise<NotificationPermission> | null = null;
    if (typeof Notification !== 'undefined') {
      if (Notification.permission === 'default') {
        try {
          permissionRequest = Notification.requestPermission();
        } catch {
          permissionRequest = null;
        }
      } else {
        setNotificationPermission(Notification.permission);
      }
    }

    let audioAvailable = false;
    try {
      if (typeof window !== 'undefined' && window.AudioContext) {
        const context = audioContextRef.current ?? new window.AudioContext();
        audioContextRef.current = context;
        if (context.state === 'suspended') void context.resume();
        playIcebergTone(context);
        audioAvailable = true;
      }
    } catch {
      audioAvailable = false;
    }

    let permission: NotificationPermission = notificationPermission;
    if (permissionRequest) {
      try {
        permission = await permissionRequest;
        setNotificationPermission(permission);
      } catch {
        permission = 'denied';
        setNotificationPermission('denied');
      }
    }
    setDeliveryAlerts(true);
    setAlertSetupMessage(
      audioAvailable
        ? permission === 'granted'
          ? 'Sound is armed; desktop notifications are permitted while this page runs.'
          : 'Sound is armed. Desktop notifications are unavailable or blocked by the browser.'
        : permission === 'granted'
          ? 'Desktop notifications are permitted; this browser could not enable sound.'
          : 'This browser blocked sound and notifications. Visual history remains on.',
    );
  };

  const symbolOptions = useMemo(() => symbols.map((item) => ({
    value: item.symbol.toLowerCase(),
    label: item.symbol,
    price: item.lastPrice > 0 ? `$${formatPrice(item.lastPrice)}` : '—',
    change: Number.isFinite(item.change) ? `${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}%` : '—',
    positive: item.change >= 0,
  })), [symbols]);
  const filteredSymbolOptions = useMemo(() => {
    const query = symbolQuery.trim().toUpperCase();
    if (!query) return symbolOptions;
    return symbolOptions.filter((option) => option.label.includes(query) || option.label.replace('USDT', '').includes(query));
  }, [symbolOptions, symbolQuery]);
  const currentSymbol = symbolOptions.find((option) => option.value === symbol) ?? {
    value: symbol,
    label: symbol.toUpperCase(),
    price: '—',
    change: '—',
    positive: true,
  };

  const connectionCopy = connection === 'live'
    ? depthReady ? 'BINANCE LIVE · DEPTH READY' : 'BINANCE LIVE · SYNCING DEPTH'
    : connection === 'connecting'
      ? 'CONNECTING'
      : 'STREAM OFFLINE';
  const connectionTone = connection === 'live' && depthReady ? 'text-emerald-300' : connection === 'connecting' || (connection === 'live' && !depthReady) ? 'text-amber-300' : 'text-muted-foreground';

  return (
    <section id="iceberg-radar" className="overflow-hidden rounded-2xl border border-border bg-card/75 shadow-[0_18px_60px_hsl(224_40%_4%/.28)]" data-testid="section-iceberg-radar">
      <div className="border-b border-border bg-gradient-to-r from-primary/[.06] via-transparent to-accent/[.04] px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
              <Layers3 className="h-5 w-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                 <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">Iceberg Liquidity Radar &amp; Heatmap</h2>
                <span className={`inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1 text-[9px] font-semibold tracking-[0.15em] ${connectionTone}`} data-testid="status-radar-connection">
                  <span className={`h-1.5 w-1.5 rounded-full bg-current ${connection === 'live' ? 'live-dot' : ''}`} />
                  {connectionCopy}
                </span>
              </div>
              <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">Detecting execution that outruns displayed depth to surface passive institutional absorption before it moves price.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="inline-flex items-center gap-2 rounded-lg border border-border bg-secondary/70 px-3 py-2 text-[11px] font-semibold text-secondary-foreground transition-colors hover:bg-secondary" onClick={() => setExpanded((value) => !value)} data-testid="button-toggle-radar">
              {expanded ? 'Collapse' : 'Expand'}
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
            <button type="button" className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] font-semibold transition-colors ${visualAlerts ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/15' : 'border-border bg-secondary/70 text-muted-foreground hover:bg-secondary'}`} onClick={() => setVisualAlerts((value) => !value)} data-testid="button-toggle-visual-alerts">
              {visualAlerts ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
              Visual alerts {visualAlerts ? 'on' : 'off'}
            </button>
            <button type="button" className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] font-semibold transition-colors ${deliveryAlerts ? 'border-emerald-400/35 bg-emerald-400/10 text-emerald-200' : 'border-border bg-secondary/70 text-muted-foreground hover:bg-secondary'}`} onClick={() => void toggleDeliveryAlerts()} aria-pressed={deliveryAlerts} data-testid="button-toggle-delivery-alerts">
              {deliveryAlerts ? <BellRing className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              {deliveryAlerts ? 'Sound / desktop on' : 'Arm sound / desktop'}
            </button>
          </div>
        </div>
      </div>
      {expanded && (
        <div className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-col gap-3 rounded-xl border border-border/80 bg-secondary/30 p-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <button type="button" className="inline-flex min-w-[142px] items-center justify-between gap-4 rounded-lg border border-border bg-background/80 px-3 py-2.5 text-left text-xs font-semibold" onClick={() => setSymbolMenuOpen((value) => !value)} data-testid="button-select-symbol">
                  <span className="mono">{currentSymbol.label}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
                {symbolMenuOpen && (
                  <div className="absolute left-0 top-[calc(100%+6px)] z-30 w-64 overflow-hidden rounded-lg border border-border bg-card p-1 shadow-2xl">
                    <label className="m-1 flex items-center gap-2 rounded-md border border-border/70 bg-background/70 px-2.5 py-2 text-muted-foreground">
                      <Search className="h-3.5 w-3.5 shrink-0" />
                      <input
                        autoFocus
                        value={symbolQuery}
                        onChange={(event) => setSymbolQuery(event.target.value)}
                        placeholder="Search all USDT perpetuals"
                        className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                        data-testid="input-iceberg-symbol-search"
                      />
                    </label>
                    <div className="max-h-[min(60vh,420px)] overflow-y-auto">
                      {filteredSymbolOptions.length ? filteredSymbolOptions.map((option) => (
                        <button type="button" key={option.value} className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs hover:bg-secondary ${option.value === symbol ? 'bg-secondary text-primary' : 'text-foreground'}`} onClick={() => { onSymbolChange(option.value); setSymbolMenuOpen(false); setSymbolQuery(''); }} data-testid={`button-symbol-${option.value}`}>
                          <span className="mono font-semibold">{option.label}</span>
                          <span className={option.positive ? 'text-emerald-300' : 'text-rose-300'}>{option.change}</span>
                        </button>
                      )) : (
                        <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                          {symbols.length ? 'No matching perpetuals' : 'Loading Binance perpetuals…'}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="hidden h-7 w-px bg-border sm:block" />
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Radio className={`h-3.5 w-3.5 ${connectionTone}`} />
                <span className="mono text-foreground">{currentSymbol.price}</span>
               <span className={currentSymbol.positive ? 'text-emerald-300' : 'text-rose-300'}>{currentSymbol.change}</span>
              </div>
              <div className="hidden h-7 w-px bg-border sm:block" />
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><Activity className="h-3.5 w-3.5 text-primary" /><span className="mono">{alertCount} events</span></div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><History className="h-3.5 w-3.5 text-primary" /><span className="mono">{historyCount} saved</span></div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <div className="flex items-center gap-1.5 text-muted-foreground"><SlidersHorizontal className="h-3.5 w-3.5" /> Threshold</div>
              {[2, 3, 4, 5].map((value) => (
                <button type="button" key={value} className={`rounded-md border px-2.5 py-1.5 mono text-[10px] font-semibold transition-colors ${multiplier === value ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-background/60 text-muted-foreground hover:text-foreground'}`} onClick={() => setMultiplier(value)} data-testid={`button-threshold-${value}`}>{value}x</button>
              ))}
              <div className="ml-1 flex items-center gap-1.5 text-muted-foreground"><span>Notional</span>
                {[{ value: 0, label: 'Any', id: 'any' }, { value: 100000, label: '>100k', id: '100k' }, { value: 500000, label: '>500k', id: '500k' }].map((filter) => (
                  <button type="button" key={filter.id} className={`rounded-md border px-2.5 py-1.5 mono text-[10px] font-semibold transition-colors ${minNotional === filter.value ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-background/60 text-muted-foreground hover:text-foreground'}`} onClick={() => setMinNotional(filter.value)} data-testid={`button-notional-${filter.id}`}>{filter.label}{filter.value ? ' USDT' : ''}</button>
                ))}
              </div>
            </div>
          </div>

          {alertSetupMessage && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-background/35 px-3 py-2 text-[10px] text-muted-foreground" role="status" data-testid="status-iceberg-alert-setup">
              <span>{alertSetupMessage}</span>
              <span>Browser alerts only work while this page is running; phone sleep/lock is not guaranteed.</span>
            </div>
          )}
          {historyCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cyan-300/20 bg-cyan-300/[.04] px-3 py-2 text-[10px] text-cyan-100/80" role="status" data-testid="status-iceberg-history-restored">
              <span><strong className="font-semibold text-cyan-200">RECOVERED ICEBERG HISTORY:</strong> {historyCount} saved event{historyCount === 1 ? '' : 's'} restored for {symbol.toUpperCase()}.</span>
              <span>Historical markers are restored on matching loaded candles.</span>
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
            <DepthHeatmap alerts={alerts} visualAlerts={visualAlerts} />
            <div className="space-y-3">
              <PressureGauge alerts={alerts} />
              <div className="rounded-xl border border-border/80 bg-black/10 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"><Filter className="h-3.5 w-3.5" /> Side filter</div>
                  <span className="mono text-[10px] text-muted-foreground">{alerts.length} shown</span>
                </div>
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-background/70 p-1">
                  {(['all', 'buy', 'sell'] as IcebergSideFilter[]).map((value) => (
                    <button type="button" key={value} className={`rounded-md px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors ${side === value ? 'bg-secondary text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setSide(value)} data-testid={`button-filter-${value}`}>{value}</button>
                  ))}
                </div>
                  <div className="mt-4 space-y-2.5 text-[11px] text-muted-foreground">
                  <div className="flex items-center justify-between"><span>Visible depth multiple</span><span className="mono text-foreground">{multiplier.toFixed(1)}x</span></div>
                  <div className="flex items-center justify-between"><span>Minimum notional</span><span className="mono text-foreground">{minNotional ? formatNotional(minNotional) : 'Any size'}</span></div>
                  <div className="flex items-center justify-between"><span>Last event</span><span className="mono text-foreground">{timeFormat.format(lastEventAt)}</span></div>
                </div>
              </div>
              <div className={`flex items-start gap-2.5 rounded-xl border p-3 text-[11px] leading-relaxed ${connection === 'offline' ? 'border-rose-300/25 bg-rose-300/[.04] text-rose-100/80' : 'border-primary/20 bg-primary/[.05] text-muted-foreground'}`}>
                {connection === 'offline' ? <RefreshCcw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-300" /> : <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />}
                <span>{connection === 'offline' ? 'Binance iceberg stream is offline. No synthetic alerts are shown; reconnect the market stream to resume detection.' : depthReady ? 'Depth snapshot is synchronized with aggregate trades. Iceberg detection is active on the rolling 8 second window.' : 'Live stream connected; synchronizing the depth snapshot before iceberg detection starts.'}</span>
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-border/80 bg-black/10">
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"><History className="h-3.5 w-3.5 text-primary" /> Iceberg event history · {symbol.toUpperCase()}</div>
              <span className="mono text-[10px] text-muted-foreground">{historyStorageAvailable ? `${historyCount} SAVED ON THIS BROWSER` : 'SESSION-ONLY HISTORY'} · {filteredHistory.length} MATCH FILTERS</span>
            </div>
            {!historyStorageAvailable && <div className="border-b border-amber-300/20 bg-amber-300/[.05] px-4 py-2 text-[10px] text-amber-100/80" role="status" data-testid="status-iceberg-storage">Browser storage is blocked or full. Events will remain visible for this session but will not survive a reload.</div>}
            <div className="hidden grid-cols-[1.2fr_.9fr_.9fr_1fr_.8fr_.85fr] gap-3 border-b border-border/60 px-4 py-2 text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground sm:grid">
              <span>Price / side</span><span>Visible USDT</span><span>Executed USDT</span><span>Hidden USDT</span><span>Passive absorb.</span><span>Status / time</span>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {visibleHistory.length ? visibleHistory.map((alert, index) => <AlertRow key={alert.id} alert={alert} index={index} />) : (
                <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-6 text-center" data-testid="empty-iceberg-alerts">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-secondary/60"><Activity className="h-4 w-4 text-muted-foreground" /></div>
                  <p className="text-xs font-medium text-foreground">{historyCount ? 'No stored events match the current filters' : 'History starts when this browser detects a live event'}</p>
                  <p className="max-w-sm text-[11px] text-muted-foreground">{historyCount ? 'Adjust the side or notional filters to view more saved events.' : 'Past iceberg events cannot be reconstructed from historical candles; this log records events from now on.'}</p>
                </div>
              )}
            </div>
            {filteredHistory.length > visibleHistory.length && (
              <div className="flex items-center justify-between gap-3 border-t border-border/70 px-4 py-3 text-[10px] text-muted-foreground">
                <span>Most recent first · oldest saved event {oldestStoredEvent ? timeFormat.format(oldestStoredEvent.timestamp) : '—'}</span>
                <button type="button" className="rounded-md border border-border bg-secondary/70 px-3 py-1.5 font-semibold text-foreground hover:bg-secondary" onClick={() => setHistoryLimit((value) => Math.min(filteredHistory.length, value + 50))} data-testid="button-load-older-icebergs">Load older events</button>
              </div>
            )}
            {filteredHistory.length > 0 && filteredHistory.length <= visibleHistory.length && oldestStoredEvent && (
              <div className="border-t border-border/70 px-4 py-2 text-[10px] text-muted-foreground">
                History saved in this browser · oldest retained event {timeFormat.format(oldestStoredEvent.timestamp)} · up to 5,000 events per symbol
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
