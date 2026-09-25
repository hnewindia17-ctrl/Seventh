import type { CSSProperties } from 'react';
import type { AbsorptionZone } from '@/utils/orderflow';
import './absorption-wall.css';

type AbsorptionWallProps = {
  zone: AbsorptionZone;
  price: number | null;
};

const compactVolume = (value: number) => {
  if (!Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 1e9) return `${(absolute / 1e9).toFixed(2)}B`;
  if (absolute >= 1e6) return `${(absolute / 1e6).toFixed(2)}M`;
  if (absolute >= 1e3) return `${(absolute / 1e3).toFixed(2)}K`;
  return absolute.toFixed(2);
};

const formatPrice = (value: number | null) => {
  if (value == null || !Number.isFinite(value)) return '—';
  const digits = value >= 1000 ? 2 : 4;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

const formatPercent = (value: number | null) => {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
};

export default function AbsorptionWall({ zone, price }: AbsorptionWallProps) {
  const buyerTrap = zone.direction === 'buyer-trap';
  const wallTone = buyerTrap ? 'sell-wall' : 'buy-wall';
  const fill = zone.attackVolume > 0
    ? Math.max(0, Math.min(100, Math.round((zone.absorbedVolume / zone.attackVolume) * 100)))
    : 0;
  const ratio = zone.attackVolume > 0 ? zone.absorbedVolume / zone.attackVolume : 0;
  const distance = price == null || !Number.isFinite(price) || price === 0
    ? null
    : ((zone.price - price) / Math.abs(price)) * 100;
  const style = {
    '--aw-fill': `${fill}%`,
    '--aw-intensity': `${Math.max(0.45, Math.min(1, ratio))}`,
  } as CSSProperties;

  return (
    <article
      className={`absorption-wall ${buyerTrap ? 'buyer-trap' : 'seller-trap'} ${wallTone}`}
      style={style}
      aria-labelledby={`absorption-wall-title-${zone.id}`}
      data-testid="absorption-wall"
    >
      <header className="aw-header">
        <div className="aw-heading">
          <div className="aw-eyebrow">
            <span className="aw-live-dot" aria-hidden="true" />
             LIVE ABSORPTION ESTIMATE
            <span className="aw-divider" aria-hidden="true" />
            {zone.probabilityLabel}
          </div>
          <h2 id={`absorption-wall-title-${zone.id}`}>
            {buyerTrap ? 'BUYER ATTACK' : 'SELLER ATTACK'}
            <span>{buyerTrap ? ' / SELL-SIDE ABSORPTION' : ' / BUY-SIDE ABSORPTION'}</span>
          </h2>
        </div>
        <div className="aw-probability" aria-label={`${zone.probability}% probability proxy`}>
          <strong>{zone.probability}%</strong>
          <span>PROBABILITY<br />PROXY</span>
        </div>
      </header>

      <div className="aw-body">
        <section
          className="aw-stage"
          aria-label={`${buyerTrap ? 'Red sell-side' : 'Green buy-side'} liquidity wall at ${formatPrice(zone.price)}. Incoming ${buyerTrap ? 'buy' : 'sell'} flow is being absorbed.`}
        >
          <div className="aw-stage-grid" aria-hidden="true" />
          <div className="aw-axis aw-axis-high"><span>HIGHER PRICE</span><i /></div>
          <div className="aw-axis aw-axis-low"><span>LOWER PRICE</span><i /></div>

          <div className="aw-incoming" aria-hidden="true">
            <div className="aw-flow-copy">
              <span>{buyerTrap ? 'AGGRESSIVE BUY FLOW' : 'AGGRESSIVE SELL FLOW'}</span>
              <small>{compactVolume(zone.attackVolume)} qty incoming</small>
            </div>
            <div className="aw-stream">
              <i className="aw-packet packet-one" />
              <i className="aw-packet packet-two" />
              <i className="aw-packet packet-three" />
              <i className="aw-packet packet-four" />
            </div>
          </div>

          <div className="aw-wall-row">
               <div className="aw-wall-label">
              <span className="aw-wall-status" />
              <strong>{buyerTrap ? 'SELL LIQUIDITY WALL' : 'BUY LIQUIDITY WALL'}</strong>
               <small>PASSIVE {buyerTrap ? 'ASK' : 'BID'} · PROXY</small>
            </div>
             <div className="aw-liquidity-wall" role="img" aria-label={`Estimated ${buyerTrap ? 'sell' : 'buy'} liquidity wall from public trades and depth, ${fill}% of incoming pressure held`}>
              <span className="aw-wall-core" />
              <span className="aw-wall-fill" />
              <span className="aw-wall-stripe stripe-one" />
              <span className="aw-wall-stripe stripe-two" />
              <span className="aw-wall-stripe stripe-three" />
               <b className="aw-wall-readout">{fill}% EST. HELD</b>
            </div>
            <div className="aw-hit-ring" aria-hidden="true"><span>FLOW<br />HELD</span></div>
          </div>

          <div className="aw-level">
            <span>ABSORPTION LEVEL</span>
            <strong>{formatPrice(zone.price)}</strong>
            {distance != null && <small>{formatPercent(distance)} from last</small>}
          </div>
        </section>

        <aside className="aw-metrics" aria-label="Absorption wall measurements">
          <div className="aw-metric aw-metric-primary">
            <span>ATTACK VOLUME</span>
            <strong>{compactVolume(zone.attackVolume)} <em>QTY</em></strong>
            <small>{buyerTrap ? 'Taker buys into ask' : 'Taker sells into bid'}</small>
          </div>
          <div className="aw-metric aw-metric-primary">
            <span>ABSORBED VOLUME</span>
            <strong>{compactVolume(zone.absorbedVolume)} <em>QTY</em></strong>
            <small>{fill}% of incoming pressure held</small>
          </div>
          <div className="aw-metric">
            <span>ABSORPTION RATIO</span>
            <strong>{ratio > 0 ? `${ratio.toFixed(2)}×` : '—'}</strong>
            <small>derived stalled-response share</small>
          </div>
          <div className="aw-metric">
            <span>PRICE RESPONSE</span>
            <strong>{formatPercent(zone.priceResponsePct)}</strong>
            <small>movement after attack</small>
          </div>
          <div className="aw-metric aw-metric-wide">
            <span>VISIBLE PASSIVE DEPTH</span>
            <strong>{zone.visibleDepthLevels ? <>{compactVolume(zone.visibleDepthQty)} <em>QTY</em></> : '—'}</strong>
            <small>{zone.visibleDepthLevels ? `${zone.visibleDepthLevels} book levels · ${compactVolume(zone.visibleDepthNotional)} USDT visible` : 'Current public book unavailable'}</small>
          </div>
        </aside>
      </div>

      <footer className="aw-footer">
        <span className="aw-legend-item"><i className="aw-legend-swatch aw-legend-flow" /> INCOMING {buyerTrap ? 'BUY' : 'SELL'} PRESSURE</span>
        <span className="aw-legend-item"><i className="aw-legend-swatch aw-legend-wall" /> PASSIVE {buyerTrap ? 'SELL' : 'BUY'} WALL</span>
        <span className="aw-legend-note">Proxy signal · public market data · not confirmation</span>
      </footer>
    </article>
  );
}