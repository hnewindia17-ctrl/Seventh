import { useCallback, useEffect, useRef, useState } from 'react';

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; delta: number; buyVolume: number; sellVolume: number; directionBias: number; largeBuyVolume: number; largeSellVolume: number };
export type DepthLevel = { price: number; qty: number; side: 'bid' | 'ask' };
export type Trade = { id: number; price: number; qty: number; notional: number; time: number; side: 'buy' | 'sell'; isLarge: boolean };
export type Liquidation = { id: number; price: number; qty: number; notional: number; time: number; side: 'buy' | 'sell' };
export type MarketStatus = 'connecting' | 'connected' | 'disconnected' | 'paused' | 'error';
export type ContractType = 'usdt-m' | 'coin-m';
export type SymbolInfo = { symbol: string; baseAsset: string; quoteAsset: string; contractType: ContractType; volume: number; volumeSpike: number; change: number; lastPrice: number };
export type MarketPulse = { openInterest: number | null; fundingRate: number | null; markPrice: number | null; nextFundingTime: number | null; updatedAt: number | null };

const ENDPOINTS: Record<ContractType, { rest: string; ws: string }> = {
  'usdt-m': { rest: 'https://fapi.binance.com', ws: 'wss://fstream.binance.com/stream?' },
  'coin-m': { rest: 'https://dapi.binance.com', ws: 'wss://dstream.binance.com/stream?' },
};

const num = (value: unknown) => Number(value);

export function useBinanceMarket(symbol: string, interval: string, paused: boolean, contractType: ContractType = 'usdt-m') {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [bids, setBids] = useState<DepthLevel[]>([]);
  const [asks, setAsks] = useState<DepthLevel[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [liquidations, setLiquidations] = useState<Liquidation[]>([]);
  const [price, setPrice] = useState<number | null>(null);
  const [change, setChange] = useState<number | null>(null);
  const [quoteVolume, setQuoteVolume] = useState<number | null>(null);
  const [status, setStatus] = useState<MarketStatus>('connecting');
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const deltaRef = useRef<Map<number, { buy: number; sell: number; largeBuy: number; largeSell: number }>>(new Map());
  const recentNotionalRef = useRef<number[]>([]);

  const reconnect = useCallback(() => setReconnectKey((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (!symbol) {
      setStatus('connecting');
      return () => { cancelled = true; };
    }
    const lower = symbol.toLowerCase();
    const endpoint = ENDPOINTS[contractType];
    const rest = endpoint.rest;
    const loadSeed = async () => {
      setStatus('connecting');
      setCandles([]);
      setBids([]);
      setAsks([]);
      setTrades([]);
      setLiquidations([]);
      setPrice(null);
      setChange(null);
      setQuoteVolume(null);
      deltaRef.current = new Map();
      recentNotionalRef.current = [];
      try {
        const [klinesResponse, tickerResponse, depthResponse] = await Promise.all([
           fetch(`${rest}/dapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=1000`.replace('/dapi', contractType === 'usdt-m' ? '/fapi' : '/dapi')),
           fetch(`${rest}/dapi/v1/ticker/24hr?symbol=${symbol}`.replace('/dapi', contractType === 'usdt-m' ? '/fapi' : '/dapi')),
           fetch(`${rest}/dapi/v1/depth?symbol=${symbol}&limit=50`.replace('/dapi', contractType === 'usdt-m' ? '/fapi' : '/dapi')),
        ]);
        if (!klinesResponse.ok || !tickerResponse.ok || !depthResponse.ok) throw new Error('Market data request failed');
        const [klines, ticker, depth] = await Promise.all([klinesResponse.json(), tickerResponse.json(), depthResponse.json()]);
        if (cancelled) return;
        const rawKlines = klines as unknown[][];
        const volumes = rawKlines.map((k) => num(k[5])).sort((a, b) => a - b);
        const medianVolume = volumes[Math.floor(volumes.length / 2)] ?? 0;
        const largeVolumeCutoff = medianVolume * 2.2;
        setCandles(rawKlines.map((k) => {
          const volume = num(k[5]);
          const buyVolume = num(k[9]);
          const sellVolume = Math.max(0, volume - buyVolume);
          const delta = buyVolume - sellVolume;
          const isLargeDirectionalBar = volume >= largeVolumeCutoff;
          return { time: num(k[0]), open: num(k[1]), high: num(k[2]), low: num(k[3]), close: num(k[4]), volume, delta, buyVolume, sellVolume, directionBias: volume ? delta / volume : num(k[4]) >= num(k[1]) ? 1 : -1, largeBuyVolume: isLargeDirectionalBar && delta > 0 ? buyVolume : 0, largeSellVolume: isLargeDirectionalBar && delta < 0 ? sellVolume : 0 };
        }));
        setPrice(num(ticker.lastPrice));
        setChange(num(ticker.priceChangePercent));
        setQuoteVolume(num(ticker.quoteVolume));
        setBids((depth.bids as string[][]).map(([p, q]) => ({ price: num(p), qty: num(q), side: 'bid' as const })).sort((a, b) => b.price - a.price));
        setAsks((depth.asks as string[][]).map(([p, q]) => ({ price: num(p), qty: num(q), side: 'ask' as const })).sort((a, b) => a.price - b.price));
      } catch {
        if (!cancelled) setStatus('error');
      }
    };
    void loadSeed();
     const socket = new WebSocket(`${endpoint.ws}streams=${lower}@aggTrade/${lower}@depth@100ms/${lower}@kline_${interval}/${lower}@forceOrder`);
    socketRef.current = socket;
    socket.onopen = () => { if (!cancelled) setStatus(paused ? 'paused' : 'connected'); };
    socket.onclose = () => { if (!cancelled && !paused) setStatus('disconnected'); };
    socket.onerror = () => { if (!cancelled) setStatus('error'); };
    socket.onmessage = (event) => {
      if (cancelled || paused) return;
      const payload = JSON.parse(event.data) as { stream: string; data: Record<string, unknown> };
      const data = payload.data;
      setLastMessageAt(Date.now());
      if (payload.stream.endsWith('@aggTrade')) {
        const notional = num(data.p) * num(data.q);
        const recent = recentNotionalRef.current;
        const sorted = [...recent.slice(-40), notional].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        const isLarge = notional >= Math.max(25_000, median * 6);
        recentNotionalRef.current = [...recent.slice(-80), notional];
        const trade: Trade = { id: num(data.a), price: num(data.p), qty: num(data.q), notional, time: num(data.T), side: data.m ? 'sell' : 'buy', isLarge };
        setPrice(trade.price);
        const candleTime = Math.floor(trade.time / intervalMs(interval)) * intervalMs(interval);
        const current = deltaRef.current.get(candleTime) ?? { buy: 0, sell: 0, largeBuy: 0, largeSell: 0 };
        current[trade.side === 'buy' ? 'buy' : 'sell'] += trade.qty;
        if (isLarge) current[trade.side === 'buy' ? 'largeBuy' : 'largeSell'] += trade.qty;
        deltaRef.current.set(candleTime, current);
        setTrades((items) => [trade, ...items].slice(0, 42));
        setCandles((items) => items.map((candle) => {
          if (candle.time !== candleTime) return candle;
          const delta = current.buy - current.sell;
          const total = current.buy + current.sell;
          return { ...candle, delta, buyVolume: current.buy, sellVolume: current.sell, directionBias: total ? delta / total : candle.directionBias, largeBuyVolume: current.largeBuy, largeSellVolume: current.largeSell };
        }));
      } else if (payload.stream.endsWith('@depth@100ms')) {
        setBids((data.b as string[][]).map(([p, q]) => ({ price: num(p), qty: num(q), side: 'bid' as const })).sort((a, b) => b.price - a.price).slice(0, 50));
        setAsks((data.a as string[][]).map(([p, q]) => ({ price: num(p), qty: num(q), side: 'ask' as const })).sort((a, b) => a.price - b.price).slice(0, 50));
      } else if (payload.stream.includes('@kline_')) {
        const k = data.k as Record<string, unknown>;
        const next: Candle = { time: num(k.t), open: num(k.o), high: num(k.h), low: num(k.l), close: num(k.c), volume: num(k.v), delta: 0, buyVolume: 0, sellVolume: 0, directionBias: num(k.c) >= num(k.o) ? 1 : -1, largeBuyVolume: 0, largeSellVolume: 0 };
        const flow = deltaRef.current.get(next.time);
        if (flow) {
          const delta = flow.buy - flow.sell;
          Object.assign(next, { delta, buyVolume: flow.buy, sellVolume: flow.sell, directionBias: flow.buy + flow.sell ? delta / (flow.buy + flow.sell) : next.directionBias, largeBuyVolume: flow.largeBuy, largeSellVolume: flow.largeSell });
        }
        setPrice(next.close);
        setCandles((items) => {
          const previous = items.find((item) => item.time === next.time);
          const merged = flow || !previous ? next : { ...next, delta: previous.delta, buyVolume: previous.buyVolume, sellVolume: previous.sellVolume, directionBias: previous.directionBias, largeBuyVolume: previous.largeBuyVolume, largeSellVolume: previous.largeSellVolume };
           return items.length && items[items.length - 1].time === next.time ? [...items.slice(0, -1), merged] : [...items, merged].slice(-1000);
        });
       } else if (payload.stream.endsWith('@forceOrder')) {
         const order = data.o as Record<string, unknown>;
         const liquidation: Liquidation = {
           id: num(order.T) || Date.now(),
           price: num(order.ap) || num(order.p),
           qty: num(order.z) || num(order.q),
           notional: (num(order.ap) || num(order.p)) * (num(order.z) || num(order.q)),
           time: num(order.T) || Date.now(),
           side: order.S === 'BUY' ? 'buy' : 'sell',
         };
         setLiquidations((items) => [liquidation, ...items].slice(0, 16));
      }
    };
    return () => { cancelled = true; socket.close(); if (socketRef.current === socket) socketRef.current = null; };
   }, [contractType, symbol, interval, paused, reconnectKey]);

  return { candles, bids, asks, trades, liquidations, price, change, quoteVolume, status: paused ? 'paused' as MarketStatus : status, lastMessageAt, reconnect };
}

function intervalMs(interval: string) {
  const units: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, M: 2_592_000_000 };
  return Number(interval.slice(0, -1)) * (units[interval.slice(-1)] ?? 60_000);
}

export function usePerpetualSymbols(contractType: ContractType = 'usdt-m') {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    const rest = ENDPOINTS[contractType].rest;
    const apiPrefix = contractType === 'usdt-m' ? 'fapi' : 'dapi';
    Promise.all([fetch(`${rest}/${apiPrefix}/v1/exchangeInfo`), fetch(`${rest}/${apiPrefix}/v1/ticker/24hr`)]).then(async ([exchangeResponse, tickerResponse]) => {
      const [payload, tickerPayload] = await Promise.all([exchangeResponse.json(), tickerResponse.json()]);
      const tickers = new Map((tickerPayload as Array<Record<string, unknown>>).map((item) => [String(item.symbol), item]));
       const rawList = (payload.symbols as Array<Record<string, unknown>>).filter((item) => item.contractType === 'PERPETUAL' && item.status === 'TRADING' && (contractType === 'usdt-m' ? item.quoteAsset === 'USDT' : item.contractType === 'PERPETUAL')).map((item) => {
        const ticker = tickers.get(String(item.symbol));
          return { symbol: String(item.symbol), baseAsset: String(item.baseAsset), quoteAsset: String(item.quoteAsset ?? (contractType === 'usdt-m' ? 'USDT' : 'USD')), contractType, volume: num(ticker?.quoteVolume ?? ticker?.baseVolume), volumeSpike: 1, change: num(ticker?.priceChangePercent), lastPrice: num(ticker?.lastPrice) };
       });
       const sortedVolumes = rawList.map((item) => item.volume).sort((a, b) => a - b);
       const medianVolume = sortedVolumes[Math.floor(sortedVolumes.length / 2)] || 1;
       const list = rawList.map((item) => ({ ...item, volumeSpike: item.volume / medianVolume })).sort((a, b) => b.volume - a.volume);
      setSymbols(list);
    }).catch(() => setSymbols([])).finally(() => setLoading(false));
   }, [contractType]);
  return { symbols, loading };
}

export function useUsdtSymbols() {
  return usePerpetualSymbols('usdt-m');
}

export function useMarketPulse(symbol: string, contractType: ContractType = 'usdt-m') {
  const [pulse, setPulse] = useState<MarketPulse>({ openInterest: null, fundingRate: null, markPrice: null, nextFundingTime: null, updatedAt: null });

  useEffect(() => {
    let cancelled = false;
    if (!symbol) {
      return () => { cancelled = true; };
    }
    const loadPulse = async () => {
      try {
        const rest = ENDPOINTS[contractType].rest;
        const apiPrefix = contractType === 'usdt-m' ? 'fapi' : 'dapi';
        const [interestResponse, premiumResponse] = await Promise.all([
          fetch(`${rest}/${apiPrefix}/v1/openInterest?symbol=${symbol}`),
          fetch(`${rest}/${apiPrefix}/v1/premiumIndex?symbol=${symbol}`),
        ]);
        if (!interestResponse.ok || !premiumResponse.ok) throw new Error('Market pulse request failed');
        const [interest, premium] = await Promise.all([interestResponse.json(), premiumResponse.json()]);
        if (cancelled) return;
        setPulse({
          openInterest: num(interest.openInterest),
          fundingRate: num(premium.lastFundingRate),
          markPrice: num(premium.markPrice),
          nextFundingTime: num(premium.nextFundingTime),
          updatedAt: Date.now(),
        });
      } catch {
        if (!cancelled) setPulse((current) => ({ ...current, updatedAt: Date.now() }));
      }
    };

    void loadPulse();
    const timer = window.setInterval(loadPulse, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [contractType, symbol]);

  return pulse;
}