import type { Candle, DepthLevel, Trade } from '@/hooks/use-binance-market';

export type DivergenceKind = 'pressure' | 'direction';
export type DivergenceType = 'bullish' | 'bearish';

export type Divergence = {
  type: DivergenceType;
  study: DivergenceKind;
  fromTime: number;
  toTime: number;
  priceFrom: number;
  priceTo: number;
  studyFrom: number;
  studyTo: number;
};

export type PressureDivergenceSnapshot = {
  type: DivergenceType;
  fromTime: number;
  toTime: number;
  priceChangePct: number;
  pressureDelta: number;
  pressureShare: number;
  bars: number;
};

export type VolumeProfileNode = {
  price: number;
  volume: number;
  isPoc: boolean;
};

export type VwapPoint = {
  time: number;
  vwap: number;
  upper1: number;
  upper2: number;
  lower1: number;
  lower2: number;
};

export type FlowEvent = {
  time: number;
  kind: 'absorption' | 'sweep-high' | 'sweep-low';
  price: number;
  detail: string;
};

export type SwingLiquidity = {
  side: 'bid' | 'ask';
  swingType: 'high' | 'low';
  swingTime: number;
  swingPrice: number;
  zonePrice: number;
  totalQty: number;
  totalNotional: number;
  levelCount: number;
  distancePct: number;
};

function studyValue(candle: Candle, study: DivergenceKind) {
  return study === 'pressure'
    ? candle.delta
    : candle.directionBias || (candle.close >= candle.open ? 1 : -1);
}

function cumulativeStudy(candles: Candle[], study: DivergenceKind) {
  let running = 0;
  return candles.map((candle) => {
    running += studyValue(candle, study);
    return running;
  });
}

function isPivotLow(values: number[], index: number) {
  return values[index] <= values[index - 1] && values[index] <= values[index + 1];
}

function isPivotHigh(values: number[], index: number) {
  return values[index] >= values[index - 1] && values[index] >= values[index + 1];
}

export function detectDivergences(candles: Candle[], study: DivergenceKind): Divergence[] {
  if (candles.length < 8) return [];

  const recent = candles.slice(-80);
  const pricesLow = recent.map((candle) => candle.low);
  const pricesHigh = recent.map((candle) => candle.high);
  const flow = cumulativeStudy(recent, study);
  const results: Divergence[] = [];
  const lows = recent.map((_, index) => index).filter((index) => index > 0 && index < recent.length - 1 && isPivotLow(pricesLow, index));
  const highs = recent.map((_, index) => index).filter((index) => index > 0 && index < recent.length - 1 && isPivotHigh(pricesHigh, index));

  for (let index = 1; index < lows.length; index += 1) {
    const from = lows[index - 1];
    const to = lows[index];
    if (pricesLow[to] < pricesLow[from] && flow[to] > flow[from]) {
      results.push({ type: 'bullish', study, fromTime: recent[from].time, toTime: recent[to].time, priceFrom: pricesLow[from], priceTo: pricesLow[to], studyFrom: flow[from], studyTo: flow[to] });
    }
  }

  for (let index = 1; index < highs.length; index += 1) {
    const from = highs[index - 1];
    const to = highs[index];
    if (pricesHigh[to] > pricesHigh[from] && flow[to] < flow[from]) {
      results.push({ type: 'bearish', study, fromTime: recent[from].time, toTime: recent[to].time, priceFrom: pricesHigh[from], priceTo: pricesHigh[to], studyFrom: flow[from], studyTo: flow[to] });
    }
  }

  return results.slice(-4);
}

export function detectCurrentPressureDivergence(candles: Candle[]): PressureDivergenceSnapshot | null {
  const recent = candles.slice(-12);
  if (recent.length < 6) return null;

  const first = recent[0];
  const last = recent[recent.length - 1];
  if (!first || !last || first.open <= 0) return null;

  const pressureDelta = recent.reduce((sum, candle) => sum + candle.delta, 0);
  const tradedVolume = recent.reduce((sum, candle) => sum + candle.volume, 0);
  if (!tradedVolume || !Number.isFinite(pressureDelta)) return null;

  const priceChangePct = ((last.close - first.open) / first.open) * 100;
  const pressureShare = pressureDelta / tradedVolume;
  const priceNeutralPct = 0.08;
  const pressureThreshold = 0.06;
  const type: DivergenceType | null = pressureShare >= pressureThreshold && priceChangePct <= priceNeutralPct
    ? 'bullish'
    : pressureShare <= -pressureThreshold && priceChangePct >= -priceNeutralPct
      ? 'bearish'
      : null;

  if (!type) return null;
  return {
    type,
    fromTime: first.time,
    toTime: last.time,
    priceChangePct,
    pressureDelta,
    pressureShare,
    bars: recent.length,
  };
}

export function buildVolumeProfile(candles: Candle[], binCount = 14): VolumeProfileNode[] {
  if (!candles.length) return [];
  const min = Math.min(...candles.map((candle) => candle.low));
  const max = Math.max(...candles.map((candle) => candle.high));
  const span = max - min || 1;
  const nodes = Array.from({ length: binCount }, (_, index) => ({
    price: min + ((index + 0.5) / binCount) * span,
    volume: 0,
    isPoc: false,
  }));

  candles.forEach((candle) => {
    const index = Math.max(0, Math.min(binCount - 1, Math.floor(((candle.close - min) / span) * binCount)));
    nodes[index].volume += candle.volume;
  });

  const poc = Math.max(...nodes.map((node) => node.volume));
  return nodes.map((node) => ({ ...node, isPoc: node.volume === poc }));
}

export function buildSwingLiquidity(
  candles: Candle[],
  bids: { price: number; qty: number }[],
  asks: { price: number; qty: number }[],
): SwingLiquidity[] {
  if (candles.length < 5 || (!bids.length && !asks.length)) return [];

  const recent = candles.slice(-160);
  const averageRange = recent.reduce((sum, candle) => sum + candle.high - candle.low, 0) / recent.length;
  const averagePrice = recent.reduce((sum, candle) => sum + candle.close, 0) / recent.length;
  const priceBand = Math.max(averageRange * 0.55, averagePrice * 0.0008);
  const candidates: Array<{ candle: Candle; swingType: 'high' | 'low'; levels: { price: number; qty: number }[] }> = [];

  for (let index = 2; index < recent.length - 2; index += 1) {
    const candle = recent[index];
    const neighborhood = recent.slice(index - 2, index + 3);
    const isHigh = candle.high >= Math.max(...neighborhood.map((item) => item.high));
    const isLow = candle.low <= Math.min(...neighborhood.map((item) => item.low));
    if (isHigh) candidates.push({ candle, swingType: 'high', levels: asks });
    if (isLow) candidates.push({ candle, swingType: 'low', levels: bids });
  }

  const zones = candidates.map(({ candle, swingType, levels }) => {
    const matched = levels.filter((level) => Math.abs(level.price - (swingType === 'high' ? candle.high : candle.low)) <= priceBand);
    if (!matched.length) return null;
    const totalQty = matched.reduce((sum, level) => sum + level.qty, 0);
    const totalNotional = matched.reduce((sum, level) => sum + level.price * level.qty, 0);
    const zonePrice = totalQty ? totalNotional / totalQty : matched[0].price;
    return {
      side: swingType === 'high' ? 'ask' as const : 'bid' as const,
      swingType,
      swingTime: candle.time,
      swingPrice: swingType === 'high' ? candle.high : candle.low,
      zonePrice,
      totalQty,
      totalNotional,
      levelCount: matched.length,
      distancePct: Math.abs(zonePrice - (swingType === 'high' ? candle.high : candle.low)) / Math.max(candle.close, 1) * 100,
    };
  }).filter((zone): zone is SwingLiquidity => Boolean(zone))
    .sort((a, b) => b.totalNotional - a.totalNotional);

  const selected: SwingLiquidity[] = [];
  for (const zone of zones) {
    if (selected.some((item) => item.side === zone.side)) continue;
    selected.push(zone);
    if (selected.length === 2) break;
  }
  return selected.sort((a, b) => a.zonePrice - b.zonePrice);
}

export function buildVwapBands(candles: Candle[]): VwapPoint[] {
  let cumulativeVolume = 0;
  let cumulativePriceVolume = 0;
  const typicalPrices = candles.map((candle) => (candle.high + candle.low + candle.close) / 3);

  return candles.map((candle, index) => {
    const typical = typicalPrices[index];
    cumulativeVolume += candle.volume;
    cumulativePriceVolume += typical * candle.volume;
    const vwap = cumulativeVolume ? cumulativePriceVolume / cumulativeVolume : typical;
    const variance = candles.slice(0, index + 1).reduce((sum, item, itemIndex) => {
      const distance = typicalPrices[itemIndex] - vwap;
      return sum + distance * distance * item.volume;
    }, 0) / Math.max(cumulativeVolume, 1);
    const deviation = Math.sqrt(Math.max(variance, 0));
    return { time: candle.time, vwap, upper1: vwap + deviation, upper2: vwap + deviation * 2, lower1: vwap - deviation, lower2: vwap - deviation * 2 };
  });
}

export function detectFlowEvents(candles: Candle[]): FlowEvent[] {
  if (candles.length < 8) return [];
  const volumes = candles.map((candle) => candle.volume);
  const averageVolume = volumes.reduce((sum, volume) => sum + volume, 0) / volumes.length;
  const volumeDeviation = Math.sqrt(volumes.reduce((sum, volume) => sum + (volume - averageVolume) ** 2, 0) / volumes.length);
  const rangeAverage = candles.reduce((sum, candle) => sum + candle.high - candle.low, 0) / candles.length;
  const events: FlowEvent[] = [];

  candles.forEach((candle, index) => {
    const prior = candles[index - 1];
    if (!prior) return;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const highSweep = candle.high > prior.high && candle.close < prior.high && upperWick > (candle.high - candle.low) * 0.35;
    const lowSweep = candle.low < prior.low && candle.close > prior.low && lowerWick > (candle.high - candle.low) * 0.35;
    if (highSweep) events.push({ time: candle.time, kind: 'sweep-high', price: candle.high, detail: 'Wick swept prior swing high and closed back inside' });
    if (lowSweep) events.push({ time: candle.time, kind: 'sweep-low', price: candle.low, detail: 'Wick swept prior swing low and closed back inside' });

    const aggressive = volumeDeviation > 0 && candle.volume > averageVolume + volumeDeviation * 2.5;
    const littleMovement = candle.high - candle.low <= Math.max(rangeAverage * 0.7, 1e-8);
    const strongDelta = Math.abs(candle.delta) > Math.max(candle.volume * 0.35, 1e-8);
    if (aggressive && littleMovement && strongDelta) {
      events.push({ time: candle.time, kind: 'absorption', price: candle.close, detail: 'Aggressive delta with limited price movement' });
    }
  });
  return events.slice(-18);
}

export function stackedImbalance(bids: { price: number; qty: number }[], asks: { price: number; qty: number }[]) {
  const bidStack = bids.slice(0, 12).filter((level, index) => {
    const ask = asks[index];
    return ask && level.qty / Math.max(ask.qty, 1e-8) >= 3;
  }).length;
  const askStack = asks.slice(0, 12).filter((level, index) => {
    const bid = bids[index];
    return bid && level.qty / Math.max(bid.qty, 1e-8) >= 3;
  }).length;
  return { bidStack, askStack, active: Math.max(bidStack, askStack) >= 3 };
}

export type AbsorptionDirection = 'buyer-trap' | 'seller-trap';

export type AbsorptionZone = {
  id: string;
  direction: AbsorptionDirection;
  label: string;
  price: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  attackVolume: number;
  absorbedVolume: number;
  attackNotional: number;
  absorbedNotional: number;
  notionalSource: 'aggTrade' | 'candle-derived';
  visibleDepthQty: number;
  visibleDepthNotional: number;
  visibleDepthLevels: number;
  delta: number;
  deltaImbalanceRatio: number;
  priceResponsePct: number;
  probability: number;
  probabilityLabel: 'HIGH PROXY' | 'MEDIUM PROXY' | 'EARLY PROXY';
};

export type AbsorptionAnalysis = {
  zones: AbsorptionZone[];
  strongest: AbsorptionZone | null;
  rollingCvd: number;
  latestTime: number | null;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function rangeOf(candles: Candle[]) {
  return average(candles.map((candle) => Math.max(candle.high - candle.low, Math.abs(candle.close - candle.open))));
}

function notionalForWindow(trades: Trade[], startTime: number, endTime: number, side: Trade['side']) {
  const matching = trades.filter((trade) => trade.time >= startTime && trade.time <= endTime && trade.side === side);
  return {
    value: matching.reduce((sum, trade) => sum + trade.notional, 0),
    hasTrades: matching.length > 0,
  };
}

/**
 * Finds aggressive flow that fails to produce a proportionate price response.
 * Absorbed volume is explicitly a derived proxy: passive resting fills are not
 * exposed by the public Binance streams, so the estimate is based on stalled
 * price response rather than private order information.
 */
export function analyzeAbsorption(candles: Candle[], trades: Trade[], depth: DepthLevel[] = [], windowSize = 6): AbsorptionAnalysis {
  if (candles.length < 6) return { zones: [], strongest: null, rollingCvd: 0, latestTime: candles[candles.length - 1]?.time ?? null };

  const recent = candles.slice(-60);
  const latest = recent[recent.length - 1];
  const rollingCvd = recent.slice(-12).reduce((sum, candle) => sum + candle.delta, 0);
  if (!latest) return { zones: [], strongest: null, rollingCvd, latestTime: null };

  const barMs = recent.length > 1 ? Math.max(1, recent[recent.length - 1].time - recent[recent.length - 2].time) : 60_000;
  const zones: AbsorptionZone[] = [];

  for (let end = Math.max(windowSize, recent.length - 14); end < recent.length; end += 1) {
    const start = Math.max(0, end - windowSize + 1);
    const window = recent.slice(start, end + 1);
    const prior = recent.slice(Math.max(0, start - 18), start);
    if (window.length < 3 || prior.length < 3) continue;

    const totalVolume = window.reduce((sum, candle) => sum + candle.buyVolume + candle.sellVolume, 0);
    const buyVolume = window.reduce((sum, candle) => sum + candle.buyVolume, 0);
    const sellVolume = window.reduce((sum, candle) => sum + candle.sellVolume, 0);
    const delta = buyVolume - sellVolume;
    const averagePriorVolume = average(prior.map((candle) => candle.buyVolume + candle.sellVolume));
    const averageWindowRange = Math.max(rangeOf(prior), rangeOf(window), latest.close * 0.00005);
    const expectedMove = Math.max(averageWindowRange * Math.sqrt(window.length) * 0.32, latest.close * 0.00008);
    const priceResponse = window[window.length - 1].close - window[0].open;
    const priceResponsePct = priceResponse / Math.max(window[0].open, 1) * 100;
    const priorHigh = Math.max(...prior.map((candle) => candle.high));
    const priorLow = Math.min(...prior.map((candle) => candle.low));
    const windowHigh = Math.max(...window.map((candle) => candle.high));
    const windowLow = Math.min(...window.map((candle) => candle.low));
    const volumeElevated = totalVolume > averagePriorVolume * window.length * 1.12;
    const buyerAttack = delta > 0 && (buyVolume > sellVolume * 1.18 || volumeElevated);
    const sellerAttack = delta < 0 && (sellVolume > buyVolume * 1.18 || volumeElevated);
    const buyerStalled = priceResponse <= expectedMove && windowHigh <= priorHigh * 1.0007;
    const sellerStalled = priceResponse >= -expectedMove && windowLow >= priorLow * 0.9993;
    const direction: AbsorptionDirection | null = buyerAttack && buyerStalled ? 'buyer-trap' : sellerAttack && sellerStalled ? 'seller-trap' : null;
    if (!direction) continue;

    const attackVolume = direction === 'buyer-trap' ? buyVolume : sellVolume;
    const counterVolume = direction === 'buyer-trap' ? sellVolume : buyVolume;
    const directionalResponse = direction === 'buyer-trap' ? priceResponse : -priceResponse;
    const stallScore = clamp(1 - Math.abs(directionalResponse) / Math.max(expectedMove, 1e-8), 0, 1);
    const imbalanceScore = clamp(Math.abs(delta) / Math.max(totalVolume, 1e-8), 0, 1);
    const intensityScore = clamp(totalVolume / Math.max(averagePriorVolume * window.length, 1e-8) - 1, 0, 1);
    const absorbedShare = clamp(.48 + stallScore * .31 + imbalanceScore * .16 + intensityScore * .08, .35, .96);
    const absorbedVolume = attackVolume * absorbedShare;
    const zonePrice = direction === 'buyer-trap' ? Math.max(...window.map((candle) => candle.high)) : Math.min(...window.map((candle) => candle.low));
    const passiveSide: DepthLevel['side'] = direction === 'buyer-trap' ? 'ask' : 'bid';
    const visibleDepth = depth.filter((level) => level.side === passiveSide && Math.abs(level.price - zonePrice) <= Math.max(averageWindowRange * .75, zonePrice * .0007)).slice(0, 12);
    const visibleDepthQty = visibleDepth.reduce((sum, level) => sum + level.qty, 0);
    const visibleDepthNotional = visibleDepth.reduce((sum, level) => sum + level.price * level.qty, 0);
    const attackSide: Trade['side'] = direction === 'buyer-trap' ? 'buy' : 'sell';
    const tradeNotional = notionalForWindow(trades, window[0].time, window[window.length - 1].time + barMs, attackSide);
    const attackNotional = tradeNotional.hasTrades ? tradeNotional.value : attackVolume * window[window.length - 1].close;
    const ratio = attackVolume / Math.max(counterVolume, 1e-8);
    const probability = Math.round(clamp(52 + intensityScore * 15 + stallScore * 18 + imbalanceScore * 12, 52, 94));
    const startTime = window[0].time;
    const endTime = window[window.length - 1].time;

    zones.push({
      id: `${direction}-${endTime}`,
      direction,
      label: direction === 'buyer-trap' ? 'BUYER TRAP / HEAVY RESISTANCE' : 'SELLER TRAP / HEAVY SUPPORT',
      price: zonePrice,
      startTime,
      endTime,
      durationMs: Math.max(barMs, endTime - startTime + barMs),
      attackVolume,
      absorbedVolume,
      attackNotional,
      absorbedNotional: attackNotional * absorbedShare,
      notionalSource: tradeNotional.hasTrades ? 'aggTrade' : 'candle-derived',
      visibleDepthQty,
      visibleDepthNotional,
      visibleDepthLevels: visibleDepth.length,
      delta,
      deltaImbalanceRatio: ratio,
      priceResponsePct,
      probability,
      probabilityLabel: probability >= 80 ? 'HIGH PROXY' : probability >= 66 ? 'MEDIUM PROXY' : 'EARLY PROXY',
    });
  }

  const unique = new Map<string, AbsorptionZone>();
  zones.forEach((zone) => unique.set(zone.id, zone));
  const latestZones = [...unique.values()].sort((a, b) => b.endTime - a.endTime).slice(0, 8);
  const activeCutoff = latest.time - barMs * 3;
  const active = latestZones.filter((zone) => zone.endTime >= activeCutoff);
  const strongest = [...(active.length ? active : latestZones)].sort((a, b) => {
    const scoreA = a.probability * Math.log10(Math.max(a.absorbedVolume, 1) + 10);
    const scoreB = b.probability * Math.log10(Math.max(b.absorbedVolume, 1) + 10);
    return scoreB - scoreA;
  })[0] ?? null;

  return { zones: latestZones, strongest, rollingCvd, latestTime: latest.time };
}