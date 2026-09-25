import { AlertTriangle, Check, CircleDot, ShieldCheck, X } from 'lucide-react';
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