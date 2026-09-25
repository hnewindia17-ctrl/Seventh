import type { IcebergAlert } from '@/hooks/use-iceberg-engine';
import type { Candle, DepthLevel, Trade } from '@/hooks/use-binance-market';
import type { AbsorptionAnalysis } from '@/utils/orderflow';

export type TradeAlertBias = 'buy' | 'sell';

export type TradeAlertGate = {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
};

export type TradeAlert = {
  key: string;
  bias: TradeAlertBias;
  symbol: string;
  timeframe: string;
  entryPrice: number;
  confidence: number;
  createdAt: number;
  reasons: string[];
};

export type TradeAlertEvaluation = {
  alert: TradeAlert | null;
  readiness: 'armed' | 'waiting' | 'blocked';
  summary: string;
  gates: TradeAlertGate[];
  metrics: {
    priceChangePct: number | null;
    pressureShare: number | null;
    directionBalance: number | null;
    domRatio: number | null;
    icebergAgeMs: number | null;
  };
};

type IndicatorVisibility = {
  institutionalFlow: boolean;
  liquidityWalls: boolean;
  icebergOrders: boolean;
  absorptionZones: boolean;
};

type TradeAlertInput = {
  symbol: string;
  timeframe: string;
  price: number | null;
  candles: Candle[];
  bids: DepthLevel[];
  asks: DepthLevel[];
  trades: Trade[];
  absorption: AbsorptionAnalysis;
  icebergAlerts: IcebergAlert[];
  stacked: { bidStack: number; askStack: number; active: boolean };
  visibility: IndicatorVisibility;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

const pct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

function emptyEvaluation(summary = 'Waiting for a complete live data window.') : TradeAlertEvaluation {
  return {
    alert: null,
    readiness: 'waiting',
    summary,
    gates: [],
    metrics: { priceChangePct: null, pressureShare: null, directionBalance: null, domRatio: null, icebergAgeMs: null },
  };
}

export function evaluateTradeAlert(input: TradeAlertInput): TradeAlertEvaluation {
  const {
    symbol,
    timeframe,
    price,
    candles,
    bids,
    asks,
    trades,
    absorption,
    icebergAlerts,
    stacked,
    visibility,
  } = input;

  if (!symbol || !timeframe || price == null || !Number.isFinite(price) || candles.length < 24 || bids.length < 6 || asks.length < 6) {
    return emptyEvaluation();
  }

  const recent = candles.slice(-12);
  const latest = recent[recent.length - 1];
  if (!latest || !Number.isFinite(latest.close) || latest.close <= 0) return emptyEvaluation();

  const priceChangePct = ((latest.close - recent[0].open) / recent[0].open) * 100;
  const recentVolume = sum(recent.map((candle) => candle.volume));
  const recentDelta = sum(recent.map((candle) => candle.delta));
  const pressureShare = recentVolume > 0 ? recentDelta / recentVolume : 0;
  const directionBalance = sum(recent.map((candle) => candle.directionBias)) / recent.length;
  const flowWindow = recent.slice(-3);
  const flowVolume = sum(flowWindow.map((candle) => candle.volume));
  const flowDelta = sum(flowWindow.map((candle) => candle.delta));
  const flowShare = flowVolume > 0 ? flowDelta / flowVolume : 0;
  const tapeWindow = trades.slice(0, 24);
  const tapeBuyNotional = sum(tapeWindow.filter((trade) => trade.side === 'buy').map((trade) => trade.notional));
  const tapeSellNotional = sum(tapeWindow.filter((trade) => trade.side === 'sell').map((trade) => trade.notional));

  const bidNotional = sum(bids.slice(0, 12).map((level) => level.price * level.qty));
  const askNotional = sum(asks.slice(0, 12).map((level) => level.price * level.qty));
  const domRatio = Math.max(bidNotional, askNotional) / Math.max(Math.min(bidNotional, askNotional), 1e-8);
  const latestIceberg = icebergAlerts
    .filter((alert) => alert.status === 'ACTIVE' && alert.timestamp <= latest.time + 120_000)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const barMs = candles.length > 1 ? Math.max(1, latest.time - candles[candles.length - 2].time) : 60_000;
  const icebergAgeMs = latestIceberg ? Math.max(0, latest.time - latestIceberg.timestamp) : null;
  const freshIceberg = Boolean(latestIceberg && icebergAgeMs != null && icebergAgeMs <= barMs * 3);
  const activeIndicators = visibility.institutionalFlow && visibility.liquidityWalls && visibility.icebergOrders && visibility.absorptionZones;

  const candidates: Array<{ bias: TradeAlertBias; reasons: string[]; strength: number }> = [];

  for (const bias of ['buy', 'sell'] as const) {
    const buy = bias === 'buy';
    const directionWord = buy ? 'BUY' : 'SELL';
    const priceDivergence = buy
      ? priceChangePct <= 0.08 && pressureShare >= 0.06 && directionBalance >= 0.1
      : priceChangePct >= -0.08 && pressureShare <= -0.06 && directionBalance <= -0.1;
    const tapeAligned = tapeWindow.length >= 6 && (buy
      ? tapeBuyNotional > tapeSellNotional * 1.08
      : tapeSellNotional > tapeBuyNotional * 1.08);
    const flowAligned = buy
      ? flowShare >= 0.1 && latest.delta > 0 && tapeAligned
      : flowShare <= -0.1 && latest.delta < 0 && tapeAligned;
    const deltaAligned = buy
      ? recent.slice(-4).every((candle) => candle.delta > 0) && recent.slice(-4).some((candle) => candle.largeBuyVolume > 0)
      : recent.slice(-4).every((candle) => candle.delta < 0) && recent.slice(-4).some((candle) => candle.largeSellVolume > 0);
    const pressureAligned = buy ? pressureShare >= 0.06 : pressureShare <= -0.06;
    const directionAligned = buy ? directionBalance >= 0.1 : directionBalance <= -0.1;
    const domAligned = stacked.active
      && (buy ? stacked.bidStack >= 3 && bidNotional > askNotional * 1.08 : stacked.askStack >= 3 && askNotional > bidNotional * 1.08);
    const absorptionZone = absorption.strongest;
    const absorptionAligned = Boolean(
      absorptionZone
      && absorptionZone.probability >= 66
      && (buy ? absorptionZone.direction === 'seller-trap' : absorptionZone.direction === 'buyer-trap')
      && absorptionZone.endTime >= latest.time - barMs * 3,
    );
    const icebergAligned = Boolean(
      freshIceberg
      && latestIceberg
      && (buy ? latestIceberg.direction === 'buy' : latestIceberg.direction === 'sell')
      && latestIceberg.hiddenNotional > 0,
    );

    const gates: TradeAlertGate[] = [
      {
        key: 'divergence',
        label: 'PRICE / PRESSURE / DIRECTION DIVERGENCE',
        passed: priceDivergence,
        detail: priceDivergence ? `${pct(priceChangePct)} price vs ${directionWord.toLowerCase()} cumulative flow` : 'Price has not diverged from both cumulative studies',
      },
      {
        key: 'order-flow',
        label: 'ORDER FLOW CONFLUENCE',
        passed: flowAligned,
        detail: flowAligned ? `${directionWord} aggression ${Math.abs(flowShare * 100).toFixed(1)}% of volume + tape` : 'Three-bar aggressive flow or tape is not unanimous',
      },
      {
        key: 'delta',
        label: 'DELTA CONFIRMATION',
        passed: deltaAligned,
        detail: deltaAligned ? `Four-bar delta and large ${buy ? 'buy' : 'sell'} proxy agree` : 'Delta sequence or large-flow proxy is missing',
      },
      {
        key: 'pressure',
        label: 'PRESSURE GAUGE',
        passed: pressureAligned,
        detail: pressureAligned ? `${directionWord} pressure share ${Math.abs(pressureShare * 100).toFixed(1)}%` : 'Cumulative pressure is not on the same side',
      },
      {
        key: 'direction',
        label: 'CANDLE DIRECTION BALANCE',
        passed: directionAligned,
        detail: directionAligned ? `${directionWord} attack balance ${Math.abs(directionBalance * 100).toFixed(1)}%` : 'Candle-direction attack balance is not aligned',
      },
      {
        key: 'dom',
        label: 'LIQUIDITY WALLS / DOM',
        passed: domAligned,
        detail: domAligned ? `${buy ? 'Bid' : 'Ask'} stack ${buy ? stacked.bidStack : stacked.askStack}/12 · ${domRatio.toFixed(2)}× notional` : 'Resting liquidity stack does not confirm the bias',
      },
      {
        key: 'absorption',
        label: 'ICEBERG / ABSORPTION',
        passed: absorptionAligned && icebergAligned,
        detail: absorptionAligned && icebergAligned
          ? `${absorptionZone?.probability}% absorption + fresh ${directionWord.toLowerCase()} iceberg`
          : 'Fresh matching iceberg and matching absorption are both required',
      },
      {
        key: 'active-indicators',
        label: 'ACTIVE INDICATORS',
        passed: activeIndicators,
        detail: activeIndicators ? 'Order flow, DOM, iceberg, and absorption surfaces are ON' : 'Required indicator surfaces must remain ON',
      },
    ];

    if (gates.every((gate) => gate.passed)) {
      const strength = clamp(
        92
        + Math.abs(flowShare) * 16
        + Math.abs(pressureShare) * 10
        + Math.abs(directionBalance) * 4
        + Math.min(domRatio, 2) * 1.2,
        92,
        99.9,
      );
      candidates.push({
        bias,
        strength,
        reasons: [
          `Price ${pct(priceChangePct)} against ${directionWord.toLowerCase()} pressure and direction balance`,
          `${directionWord} order flow + delta confirmation`,
          `${buy ? 'Bid' : 'Ask'} DOM stack ${buy ? stacked.bidStack : stacked.askStack}/12 · ${domRatio.toFixed(2)}× wall notional`,
          `${absorptionZone?.probability}% ${absorptionZone?.label.toLowerCase()}`,
          `Fresh ${directionWord.toLowerCase()} iceberg absorption`,
        ],
      });
    }
  }

  const gatesForDisplay = candidates.length
    ? ['divergence', 'order-flow', 'delta', 'pressure', 'direction', 'dom', 'absorption', 'active-indicators'].map((key) => ({
      key,
      label: key === 'divergence' ? 'PRICE / PRESSURE / DIRECTION DIVERGENCE' : key === 'order-flow' ? 'ORDER FLOW CONFLUENCE' : key === 'delta' ? 'DELTA CONFIRMATION' : key === 'pressure' ? 'PRESSURE GAUGE' : key === 'direction' ? 'CANDLE DIRECTION BALANCE' : key === 'dom' ? 'LIQUIDITY WALLS / DOM' : key === 'absorption' ? 'ICEBERG / ABSORPTION' : 'ACTIVE INDICATORS',
      passed: true,
      detail: 'All required confirmation data agrees',
    }))
    : [];

  if (candidates.length) {
    const candidate = candidates.sort((a, b) => b.strength - a.strength)[0];
    const key = `${symbol}:${timeframe}:${latest.time}:${candidate.bias}`;
    return {
      alert: {
        key,
        bias: candidate.bias,
        symbol,
        timeframe,
        entryPrice: price,
        confidence: Number(candidate.strength.toFixed(1)),
        createdAt: Date.now(),
        reasons: candidate.reasons,
      },
      readiness: 'armed',
      summary: `All ${gatesForDisplay.length}/8 strict gates confirmed`,
      gates: gatesForDisplay,
      metrics: { priceChangePct, pressureShare, directionBalance, domRatio, icebergAgeMs },
    };
  }

  const latestReadyGates = ['divergence', 'order-flow', 'delta', 'pressure', 'direction', 'dom', 'absorption', 'active-indicators'].map((key) => ({
    key,
    label: key === 'divergence' ? 'PRICE / PRESSURE / DIRECTION DIVERGENCE' : key === 'order-flow' ? 'ORDER FLOW CONFLUENCE' : key === 'delta' ? 'DELTA CONFIRMATION' : key === 'pressure' ? 'PRESSURE GAUGE' : key === 'direction' ? 'CANDLE DIRECTION BALANCE' : key === 'dom' ? 'LIQUIDITY WALLS / DOM' : key === 'absorption' ? 'ICEBERG / ABSORPTION' : 'ACTIVE INDICATORS',
    passed: false,
    detail: 'Waiting for unanimous buy or sell confirmation',
  }));

  return {
    alert: null,
    readiness: activeIndicators ? 'waiting' : 'blocked',
    summary: activeIndicators ? 'Scanning — partial matches are suppressed' : 'Blocked — required indicator surfaces are OFF',
    gates: latestReadyGates,
    metrics: { priceChangePct, pressureShare, directionBalance, domRatio, icebergAgeMs },
  };
}