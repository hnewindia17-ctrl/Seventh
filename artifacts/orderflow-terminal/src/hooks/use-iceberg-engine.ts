import { useEffect, useRef, useState } from 'react';
import type { ContractType } from '@/hooks/use-binance-market';

export type IcebergDirection = 'buy' | 'sell';
export type IcebergSideFilter = 'all' | IcebergDirection;
export type RadarConnection = 'connecting' | 'live' | 'offline';

export interface IcebergAlert {
  id: string;
  price: number;
  direction: IcebergDirection;
  visibleQty: number;
  executedQty: number;
  hiddenQty: number;
  visibleDepth: number;
  executedSize: number;
  hiddenSize: number;
  visibleNotional: number;
  executedNotional: number;
  hiddenNotional: number;
  absorptionPercent: number;
  timestamp: number;
  status: 'ACTIVE' | 'COOLING';
}

interface IcebergSettings {
  multiplier: number;
  minNotional: number;
  side: IcebergSideFilter;
  visualAlerts: boolean;
}

interface RollingPrint {
  quantity: number;
  timestamp: number;
}

interface BinancePayload {
  e?: string;
  p?: string;
  q?: string;
  m?: boolean;
  T?: number;
  U?: number;
  u?: number;
  pu?: number;
  b?: [string, string][];
  a?: [string, string][];
}

const WINDOW_MS = 8000;
const MAX_ALERTS = 24;
const MAX_HISTORY = 5000;
const MAX_LEVELS = 160;
const HISTORY_KEY_PREFIX = 'orderflow-iceberg-history-v1:';

function normalizeSymbol(symbol: string) {
  return symbol.toLowerCase().replace(/[^a-z0-9]/g, '') || 'btcusdt';
}

function priceKey(value: string | number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return numeric.toFixed(12).replace(/\.?0+$/, '');
}

function isIcebergAlert(value: unknown): value is IcebergAlert {
  if (!value || typeof value !== 'object') return false;
  const alert = value as Partial<IcebergAlert>;
  return typeof alert.id === 'string'
    && typeof alert.price === 'number'
    && (alert.direction === 'buy' || alert.direction === 'sell')
    && typeof alert.visibleQty === 'number'
    && typeof alert.executedQty === 'number'
    && typeof alert.hiddenQty === 'number'
    && typeof alert.visibleNotional === 'number'
    && typeof alert.executedNotional === 'number'
    && typeof alert.hiddenNotional === 'number'
    && typeof alert.absorptionPercent === 'number'
    && typeof alert.timestamp === 'number'
    && (alert.status === 'ACTIVE' || alert.status === 'COOLING');
}

function readHistory(symbol: string): IcebergAlert[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(`${HISTORY_KEY_PREFIX}${normalizeSymbol(symbol)}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(isIcebergAlert).slice(0, MAX_HISTORY)
      : [];
  } catch {
    return [];
  }
}

function canUseHistoryStorage() {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.getItem(`${HISTORY_KEY_PREFIX}storage-check`);
    return true;
  } catch {
    return false;
  }
}

function writeHistory(symbol: string, history: IcebergAlert[]) {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(
      `${HISTORY_KEY_PREFIX}${normalizeSymbol(symbol)}`,
      JSON.stringify(history.slice(0, MAX_HISTORY)),
    );
    return true;
  } catch {
    return false;
  }
}

const trimMap = (map: Map<string, number>) => {
  if (map.size <= MAX_LEVELS) return;
  const oldestKeys = Array.from(map.keys()).slice(0, map.size - MAX_LEVELS);
  oldestKeys.forEach((key) => map.delete(key));
};

export function useIcebergEngine(
  symbol: string,
  settings: IcebergSettings,
  contractType: ContractType = 'usdt-m',
) {
  const [alerts, setAlerts] = useState<IcebergAlert[]>([]);
  const [history, setHistory] = useState<IcebergAlert[]>(() => readHistory(symbol));
  const [historyStorageAvailable, setHistoryStorageAvailable] = useState(() => canUseHistoryStorage());
  const [latestAlert, setLatestAlert] = useState<IcebergAlert | null>(null);
  const [connection, setConnection] = useState<RadarConnection>('connecting');
  const [depthReady, setDepthReady] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number>(Date.now());
  const settingsRef = useRef(settings);
  const historyRef = useRef(history);
  const depthRef = useRef({ bids: new Map<string, number>(), asks: new Map<string, number>() });
  const printsRef = useRef(new Map<string, RollingPrint[]>());
  const emittedRef = useRef(new Map<string, number>());

  settingsRef.current = settings;
  historyRef.current = history;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let reconnectAttempt = 0;
    let depthSynced = false;
    let depthBuffer: BinancePayload[] = [];
    let depthSyncGeneration = 0;
    const abortController = new AbortController();

    const normalizedSymbol = normalizeSymbol(symbol);
    setAlerts([]);
    const restoredHistory = readHistory(normalizedSymbol);
    historyRef.current = restoredHistory;
    setHistory(restoredHistory);
    setHistoryStorageAvailable(canUseHistoryStorage());
    setLatestAlert(null);
    setDepthReady(false);
    depthRef.current = { bids: new Map(), asks: new Map() };

    const publish = (nextAlert: IcebergAlert, persist = true) => {
      setLatestAlert(nextAlert);
      if (persist) {
        const nextHistory = [
          nextAlert,
          ...historyRef.current.filter((alert) => alert.id !== nextAlert.id),
        ].slice(0, MAX_HISTORY);
        historyRef.current = nextHistory;
        setHistory(nextHistory);
        setHistoryStorageAvailable(writeHistory(normalizedSymbol, nextHistory));
      }
      setAlerts((current) => {
        const next = [nextAlert, ...current].slice(0, MAX_ALERTS);
        return next;
      });
    };

    const detect = (
      price: number,
      direction: IcebergDirection,
      executedQty: number,
      visibleQty: number,
      timestamp: number,
    ) => {
      if (!depthSynced) return;
      const settingsNow = settingsRef.current;
      const baseline = Math.max(visibleQty, 0.01);
      const executedNotional = executedQty * price;
      const visibleNotional = visibleQty * price;
      if (executedQty < baseline * settingsNow.multiplier) return;
      const levelKey = `${price.toFixed(2)}-${direction}`;
      const lastEmitted = emittedRef.current.get(levelKey) ?? 0;
      if (timestamp - lastEmitted < 4800) return;
      emittedRef.current.set(levelKey, timestamp);
      publish({
        id: `${levelKey}-${timestamp}`,
        price,
        direction,
        visibleQty: Math.round(visibleQty * 100) / 100,
        executedQty: Math.round(executedQty * 100) / 100,
        hiddenQty: Math.round(Math.max(executedQty - visibleQty, 0) * 100) / 100,
        visibleDepth: Math.round(visibleQty * 100) / 100,
        executedSize: Math.round(executedQty * 100) / 100,
        hiddenSize: Math.round(Math.max(executedQty - visibleQty, 0) * 100) / 100,
        visibleNotional: Math.round(visibleNotional * 100) / 100,
        executedNotional: Math.round(executedNotional * 100) / 100,
        hiddenNotional: Math.round(Math.max(executedNotional - visibleNotional, 0) * 100) / 100,
        absorptionPercent: Math.min(99.9, Math.max(1, (visibleQty / executedQty) * 100)),
        timestamp,
        status: 'ACTIVE',
      });
    };

    const processTrade = (payload: { p?: string; q?: string; m?: boolean; T?: number }) => {
      const price = Number(payload.p);
      const quantity = Number(payload.q);
      if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) return;
      const direction: IcebergDirection = payload.m ? 'sell' : 'buy';
      const timestamp = Number(payload.T) || Date.now();
      const key = priceKey(price);
      const prints = printsRef.current.get(key) ?? [];
      prints.push({ quantity, timestamp });
      const cutoff = timestamp - WINDOW_MS;
      const recent = prints.filter((print) => print.timestamp >= cutoff);
      printsRef.current.set(key, recent);
      if (printsRef.current.size > MAX_LEVELS) {
        const firstKey = printsRef.current.keys().next().value;
        if (firstKey) printsRef.current.delete(firstKey);
      }
      const depth = direction === 'buy'
        ? depthRef.current.asks.get(key) ?? 0
        : depthRef.current.bids.get(key) ?? 0;
      detect(price, direction, recent.reduce((sum, print) => sum + print.quantity, 0), depth, timestamp);
      setLastEventAt(timestamp);
    };

    const applyDepth = (payload: { b?: [string, string][]; a?: [string, string][] }) => {
      const update = (entries: [string, string][] | undefined, map: Map<string, number>) => {
        entries?.forEach(([rawPrice, rawQuantity]) => {
          const key = priceKey(rawPrice);
          const quantity = Number(rawQuantity);
          if (quantity === 0) map.delete(key);
          else if (Number.isFinite(quantity)) map.set(key, quantity);
        });
        trimMap(map);
      };
      update(payload.b, depthRef.current.bids);
      update(payload.a, depthRef.current.asks);
      setLastEventAt(Date.now());
    };

    const processDepth = (payload: BinancePayload) => {
      if (!depthSynced) {
        depthBuffer = [...depthBuffer.slice(-4999), payload];
        return;
      }
      applyDepth(payload);
    };

    const syncDepth = async () => {
      const generation = ++depthSyncGeneration;
      depthSynced = false;
      depthBuffer = [];
      setDepthReady(false);
      try {
        const depthEndpoint = contractType === 'coin-m'
          ? 'https://dapi.binance.com/dapi/v1/depth'
          : 'https://fapi.binance.com/fapi/v1/depth';
        const response = await fetch(`${depthEndpoint}?symbol=${normalizedSymbol.toUpperCase()}&limit=1000`, { signal: abortController.signal });
        if (!response.ok) throw new Error(`Depth snapshot failed: ${response.status}`);
        const snapshot = await response.json() as { lastUpdateId?: number; bids?: [string, string][]; asks?: [string, string][] };
        if (disposed || generation !== depthSyncGeneration) return;
        depthRef.current = { bids: new Map(), asks: new Map() };
        applyDepth({ b: snapshot.bids, a: snapshot.asks });
        const snapshotId = Number(snapshot.lastUpdateId) || 0;
        depthBuffer
          .filter((update) => update.u == null || Number(update.u) > snapshotId)
          .forEach((update) => applyDepth(update));
        depthBuffer = [];
        depthSynced = true;
        setDepthReady(true);
      } catch {
        if (!disposed && generation === depthSyncGeneration) {
          setDepthReady(false);
        }
      }
    };

    const connect = () => {
      if (disposed || typeof WebSocket === 'undefined') {
        setConnection('offline');
        return;
      }
      const streamHost = contractType === 'coin-m' ? 'wss://dstream.binance.com/stream' : 'wss://fstream.binance.com/stream';
      setConnection('connecting');
      const streamUrl = `${streamHost}?streams=${normalizedSymbol}@depth@100ms/${normalizedSymbol}@aggTrade`;
      socket = new WebSocket(streamUrl);
      socket.onopen = () => {
        reconnectAttempt = 0;
        setConnection('live');
        setLastEventAt(Date.now());
        void syncDepth();
      };
      socket.onmessage = (event) => {
        try {
          const packet = JSON.parse(event.data) as { data?: BinancePayload } & BinancePayload;
          const payload = packet.data ?? packet;
          if (payload.e === 'depthUpdate') processDepth(payload);
          if (payload.e === 'aggTrade') processTrade(payload);
        } catch {
          // Binance may occasionally emit a control payload; ignore it safely.
        }
      };
      socket.onerror = () => {
        if (!disposed) setConnection('offline');
      };
      socket.onclose = () => {
        if (disposed) return;
        depthSyncGeneration += 1;
        depthSynced = false;
        depthBuffer = [];
        setDepthReady(false);
        setConnection('offline');
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, Math.min(15000, 1200 * 2 ** Math.min(reconnectAttempt, 4)));
      };
    };

    connect();
    return () => {
      disposed = true;
      depthSyncGeneration += 1;
      abortController.abort();
      if (socket) socket.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [contractType, symbol]);

  const visibleAlerts = alerts.filter((alert) => {
    if (settings.side !== 'all' && alert.direction !== settings.side) return false;
    return alert.executedNotional >= settings.minNotional;
  });

  return {
    alerts: visibleAlerts,
    history,
    historyStorageAvailable,
    latestAlert,
    connection,
    depthReady,
    lastEventAt,
    alertCount: visibleAlerts.length,
    historyCount: history.length,
  };
}