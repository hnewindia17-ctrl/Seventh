import type { Candle, Trade } from '@/hooks/use-binance-market';

export type DivergenceAlertKind = 'price-pressure' | 'pressure-direction';
export type DivergenceAlertBias = 'bullish' | 'bearish';

export type DivergenceAlert = {
  key: string;
  kind: DivergenceAlertKind;
  bias: DivergenceAlertBias;
  symbol: string;
  timeframe: string;
  bars: number;
  createdAt: number;
  priceChangePct: number;
  pressureShare: number;
  directionBalance: number;
  pressureDelta: number;
  buyNotional: number;
  sellNotional: number;
  flowRatio: number;
  imbalancePct: number;
  dominantSide: 'BUYING' | 'SELLING' | 'BALANCED';
  flowImbalanceConfirmed: boolean;
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function flowAmounts(candles: Candle[], trades: Trade[], fromTime: number) {
  const recentTrades = trades.filter((trade) => trade.time >= fromTime).slice(0, 80);
  const traded = recentTrades.reduce(
    (totals, trade) => {
      totals[trade.side] += trade.notional;
      return totals;
    },
    { buy: 0, sell: 0 },
  );

  if (traded.buy > 0 || traded.sell > 0) return { buy: traded.buy, sell: traded.sell };

  return {
    buy: sum(candles.map((candle) => candle.buyVolume * candle.close)),
    sell: sum(candles.map((candle) => candle.sellVolume * candle.close)),
  };
}

function buildAlert(
  kind: DivergenceAlertKind,
  bias: DivergenceAlertBias,
  symbol: string,
  timeframe: string,
  latest: Candle,
  metrics: Pick<DivergenceAlert, 'bars' | 'priceChangePct' | 'pressureShare' | 'directionBalance' | 'pressureDelta'>,
  amounts: { buy: number; sell: number },
): DivergenceAlert {
  const total = amounts.buy + amounts.sell;
  const larger = Math.max(amounts.buy, amounts.sell);
  const smaller = Math.min(amounts.buy, amounts.sell);
  const flowRatio = larger / Math.max(smaller, 1);
  const imbalancePct = total > 0 ? Math.abs(amounts.buy - amounts.sell) / total * 100 : 0;
  const dominantSide = amounts.buy > amounts.sell * 1.05
    ? 'BUYING'
    : amounts.sell > amounts.buy * 1.05
      ? 'SELLING'
      : 'BALANCED';

  return {
    key: `${symbol}:${timeframe}:${latest.time}:${kind}:${bias}`,
    kind,
    bias,
    symbol,
    timeframe,
    ...metrics,
    createdAt: Date.now(),
    buyNotional: amounts.buy,
    sellNotional: amounts.sell,
    flowRatio,
    imbalancePct,
    dominantSide,
    flowImbalanceConfirmed: flowRatio >= 1.2 && imbalancePct >= 9,
  };
}

export function detectDivergenceAlerts(symbol: string, timeframe: string, candles: Candle[], trades: Trade[]): DivergenceAlert[] {
  if (!symbol || !timeframe || candles.length < 6) return [];

  const recent = candles.slice(-12);
  const first = recent[0];
  const latest = recent[recent.length - 1];
  if (!first || !latest || first.open <= 0) return [];

  const pressureDelta = sum(recent.map((candle) => candle.delta));
  const tradedVolume = sum(recent.map((candle) => candle.volume));
  if (!tradedVolume || !Number.isFinite(pressureDelta)) return [];

  const priceChangePct = ((latest.close - first.open) / first.open) * 100;
  const pressureShare = pressureDelta / tradedVolume;
  const directionBalance = sum(recent.map((candle) => candle.directionBias)) / recent.length;
  const amounts = flowAmounts(candles, trades, first.time);
  const metrics = { bars: recent.length, priceChangePct, pressureShare, directionBalance, pressureDelta };
  const alerts: DivergenceAlert[] = [];

  const pricePressureBullish = priceChangePct <= 0.08 && pressureShare >= 0.06;
  const pricePressureBearish = priceChangePct >= -0.08 && pressureShare <= -0.06;
  if (pricePressureBullish) alerts.push(buildAlert('price-pressure', 'bullish', symbol, timeframe, latest, metrics, amounts));
  if (pricePressureBearish) alerts.push(buildAlert('price-pressure', 'bearish', symbol, timeframe, latest, metrics, amounts));

  const pressureDirectionBullish = pressureShare >= 0.06 && directionBalance <= -0.1;
  const pressureDirectionBearish = pressureShare <= -0.06 && directionBalance >= 0.1;
  if (pressureDirectionBullish) alerts.push(buildAlert('pressure-direction', 'bullish', symbol, timeframe, latest, metrics, amounts));
  if (pressureDirectionBearish) alerts.push(buildAlert('pressure-direction', 'bearish', symbol, timeframe, latest, metrics, amounts));

  return alerts;
}