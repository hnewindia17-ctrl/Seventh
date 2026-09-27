import { AlertTriangle, ArrowDown, ArrowUp, Check, CircleDot, ShieldCheck, X } from 'lucide-react';
import { useEffect } from 'react';
import type { DivergenceAlert } from '@/utils/divergence-alert-engine';
import type { TradeAlert, TradeAlertEvaluation } from '@/utils/trade-alert-engine';

type TradeAlertModalProps = {
  alert: TradeAlert | null;
  evaluation: TradeAlertEvaluation;
  actionStatus: string | null;
  onDismiss: () => void;
  onExecute: () => void;
};

const formatPrice = (value: number) => value >= 1000
  ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 });

const formatNotional = (value: number) => value >= 1e9
  ? `${(value / 1e9).toFixed(2)}B`
  : value >= 1e6
    ? `${(value / 1e6).toFixed(2)}M`
    : value >= 1e3
      ? `${(value / 1e3).toFixed(2)}K`
      : value.toFixed(2);

export function DivergenceWatchPanel({ alerts, onDismiss }: { alerts: DivergenceAlert[]; onDismiss: (key: string) => void }) {
  if (!alerts.length) return null;
  return <section className="divergence-watch-panel" aria-label="Divergence watch alerts" aria-live="polite">
    <div className="divergence-watch-heading"><div><span className="divergence-watch-kicker">ADVANCED DIVERGENCE WATCH</span><strong>REVERSAL PREPARATION SIGNAL</strong></div><span className="divergence-watch-count">{alerts.length} ACTIVE</span></div>
    <div className="divergence-watch-grid">
      {alerts.map((alert) => {
        const bullish = alert.bias === 'bullish';
        const pricePressure = alert.kind === 'price-pressure';
        return <article className={`divergence-watch-card ${bullish ? 'bullish' : 'bearish'}`} key={alert.key}>
          <div className="divergence-watch-card-head">
            <div className="divergence-watch-type"><span className="divergence-watch-icon">{bullish ? <ArrowUp size={17} /> : <ArrowDown size={17} />}</span><div><strong>{pricePressure ? 'PRICE ↔ CUMULATIVE PRESSURE' : 'CUMULATIVE PRESSURE ↔ SUB-BAR DIRECTION'}</strong><small>{alert.symbol} · {alert.timeframe} · {alert.bars}-BAR STRUCTURE</small></div></div>
            <button className="divergence-watch-dismiss" onClick={() => onDismiss(alert.key)} aria-label={`Dismiss ${pricePressure ? 'price and pressure' : 'pressure and direction'} divergence alert`}><X size={13} /></button>
          </div>
          <div className="divergence-watch-status"><span className="divergence-watch-pulse" /><strong>{bullish ? 'BULLISH REVERSAL WATCH' : 'BEARISH REVERSAL WATCH'}</strong><em>PREPARE FOR TRADE</em></div>
          <div className="divergence-watch-numbers">
            <div className="flow-amount buying"><span>BUYING / AGGRESSIVE</span><strong>{formatNotional(alert.buyNotional)} <em>USDT</em></strong></div>
            <div className="flow-amount selling"><span>SELLING / AGGRESSIVE</span><strong>{formatNotional(alert.sellNotional)} <em>USDT</em></strong></div>
            <div className="flow-ratio"><span>BUY : SELL RATIO</span><strong>{alert.flowRatio.toFixed(2)}<em>×</em></strong></div>
          </div>
          <div className="divergence-watch-footer"><span>PRICE {alert.priceChangePct >= 0 ? '+' : ''}{alert.priceChangePct.toFixed(2)}% · PRESSURE {alert.pressureShare >= 0 ? '+' : ''}{(alert.pressureShare * 100).toFixed(1)}% · DIRECTION {alert.directionBalance >= 0 ? '+' : ''}{(alert.directionBalance * 100).toFixed(1)}%</span><b className={alert.flowImbalanceConfirmed ? 'confirmed' : 'developing'}>{alert.flowImbalanceConfirmed ? 'FLOW IMBALANCE CONFIRMED' : 'FLOW IMBALANCE DEVELOPING'}</b></div>
        </article>;
      })}
    </div>
  </section>;
}

export function TradeAlertMonitor({ evaluation, symbol, timeframe, actionStatus }: { evaluation: TradeAlertEvaluation; symbol: string; timeframe: string; actionStatus: string | null }) {
  const isArmed = evaluation.readiness === 'armed';
  return <section className={`trade-alert-monitor ${evaluation.readiness}`} aria-label="Animated trade alert system">
    <div className="trade-alert-monitor-head">
      <div className="trade-alert-monitor-title"><CircleDot size={14} /><span>ANIMATED TRADE ALERT SYSTEM</span><small>{symbol || 'PAIR'} · {timeframe}</small></div>
      <span className={`trade-alert-state ${evaluation.readiness}`}><i />{isArmed ? 'ARMED · 8/8' : evaluation.readiness === 'blocked' ? 'BLOCKED' : 'SCANNING'}</span>
    </div>
    <div className="trade-alert-monitor-body">
      <div className="trade-alert-monitor-copy">
        <strong>{evaluation.summary}</strong>
        <span><ShieldCheck size={12} /> Zero partial-match alerts · every gate must pass</span>
        {actionStatus && <em>{actionStatus}</em>}
      </div>
      <div className="trade-alert-gates">{evaluation.gates.map((gate) => <span key={gate.key} className={gate.passed ? 'passed' : 'pending'} title={gate.detail}><i>{gate.passed ? <Check size={9} /> : <X size={9} />}</i>{gate.label}</span>)}</div>
    </div>
  </section>;
}

export function TradeAlertModal({ alert, evaluation, actionStatus, onDismiss, onExecute }: TradeAlertModalProps) {
  useEffect(() => {
    if (!alert) return undefined;
    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousOverscroll = body.style.overscrollBehavior;
    body.classList.add('trade-alert-open');
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';
    return () => {
      body.classList.remove('trade-alert-open');
      body.style.overflow = previousOverflow;
      body.style.overscrollBehavior = previousOverscroll;
    };
  }, [alert]);
  if (!alert) return null;
  const buy = alert.bias === 'buy';
  return <div className="trade-alert-backdrop" role="presentation">
    <section className={`trade-alert-modal ${buy ? 'buy' : 'sell'}`} role="dialog" aria-modal="true" aria-labelledby="trade-alert-heading">
      <div className="trade-alert-modal-scanline" />
      <div className="trade-alert-modal-head">
        <div className="trade-alert-live"><span /><span>LIVE CONFLUENCE EVENT</span></div>
        <button className="trade-alert-close" onClick={onDismiss} aria-label="Dismiss trade alert"><X size={16} /></button>
      </div>
      <div className="trade-alert-signal">
        <div className="trade-alert-signal-mark">{buy ? '↗' : '↘'}</div>
        <div><span>{alert.symbol} · {alert.timeframe}</span><h2 id="trade-alert-heading">HIGH PROBABILITY {buy ? 'BUY' : 'SELL'} SIGNAL</h2><small>All required indicator conditions aligned</small></div>
      </div>
      <div className="trade-alert-stats">
        <div><span>TRIGGER EXECUTION PRICE</span><strong>{formatPrice(alert.entryPrice)}</strong><small>{buy ? 'aggressive long trigger' : 'aggressive short trigger'}</small></div>
        <div><span>CALCULATED CONFIDENCE</span><strong>{alert.confidence.toFixed(1)}<em>%</em></strong><small>{evaluation.gates.length}/8 gates confirmed</small></div>
      </div>
      <div className="trade-alert-reasons">
        <div className="trade-alert-reasons-head"><span>KEY CONFLUENCE REASONS</span><b><Check size={11} /> COMPLETE</b></div>
        <ul>{alert.reasons.map((reason) => <li key={reason}><span><Check size={11} /></span>{reason}</li>)}</ul>
      </div>
      {actionStatus && <div className="trade-alert-action-note"><AlertTriangle size={14} />{actionStatus}</div>}
      <div className="trade-alert-actions">
        <button className="trade-alert-execute" onClick={onExecute}>EXECUTE ORDER · {buy ? 'BUY' : 'SELL'}</button>
        <button className="trade-alert-dismiss" onClick={onDismiss}>DISMISS</button>
      </div>
      <p className="trade-alert-disclaimer">Public market-data terminal · execution staging only · verify before trading</p>
    </section>
  </div>;
}