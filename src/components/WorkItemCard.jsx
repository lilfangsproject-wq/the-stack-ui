import React from 'react';
import { useStore } from '../utils/store';

export function WorkItemCard({ item, isExpanded, onToggle, onAction }) {
  const meta = getItemMeta(item.state);
  const conflicts = item.conflicts || [];

  return (
    <div className="glass-card" style={{ borderRadius: 'var(--radius-xl)', overflow: 'hidden' }}>
      <button
        className="w-full"
        style={{
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          textAlign: 'left',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer'
        }}
        onClick={onToggle}
      >
        {renderHeader()}
        {renderProgress()}
        {renderEvidenceGates()}
      </button>

      {isExpanded && (
        <div style={{ borderTop: '1px solid var(--line)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px', animation: 'slide-up 0.2s ease-out' }}>
          {renderChecklist()}
          {renderEvidenceFields()}
          {renderActions()}
        </div>
      )}
    </div>
  );

  function renderHeader() {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' }}>
            <span className="kicker" style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
              {item.rawKind === 'opportunity' ? 'Opportunity' : 'Workstream'}
            </span>
            <span className={`badge ${meta.tone}`} style={{ fontSize: '11px' }}>{meta.label}</span>
            {conflicts.length > 0 && <span className="badge badge-warning" style={{ fontSize: '10px' }}>⚠️ Clash</span>}
          </div>
          <h3 style={{ fontSize: '17px', fontWeight: '700', letterSpacing: '-0.02em', lineHeight: 1.3 }}>{item.title}</h3>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5, marginTop: '4px' }}>{item.summary || 'No description'}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px', flexWrap: 'wrap', fontSize: '12px', color: 'var(--text-muted)' }}>
            <span>Owner: <strong>{item.owner}</strong></span>
            {item.deadline && <span>Due {item.deadline}</span>}
            {item.evidence && Object.keys(item.evidence).length > 0 && (
              <span className="badge badge-success" style={{ fontSize: '10px' }}>
                Evidence: {Object.keys(item.evidence).length}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <span className={`dot ${meta.dot}`} style={{ width: 12, height: 12 }} />
          <span style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>▼</span>
        </div>
      </div>
    );
  }

  function renderProgress() {
    if (!item.checklist || item.checklist.length === 0) return null;
    const done = item.checklist.filter(c => c.done).length;
    const total = item.checklist.length;
    const pct = Math.round((done / total) * 100);
    return (
      <div style={{ marginTop: '8px' }}>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
          <span>{done}/{total} steps</span>
          <span>{pct}%</span>
        </div>
      </div>
    );
  }

  function renderEvidenceGates() {
    if (!item.evidenceGates || item.evidenceGates.length === 0) return null;
    return (
      <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--line)' }}>
        <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '8px' }}>
          Evidence Gates
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {item.evidenceGates.map(gate => {
            const hasValue = item.evidence?.[gate.field];
            const status = hasValue ? 'passed' : (gate.severity === 'block' ? 'blocked' : 'warned');
            return (
              <div key={gate.field} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                <span className={`dot ${status === 'passed' ? 'dot-green' : status === 'blocked' ? 'dot-red' : 'dot-amber'}`} style={{ width: 8, height: 8 }} />
                <span style={{ flex: 1, color: status === 'passed' ? 'var(--success)' : status === 'blocked' ? 'var(--danger)' : 'var(--warning)' }}>
                  {gate.label || gate.field}
                </span>
                {hasValue && <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{String(item.evidence[gate.field]).slice(0, 30)}</span>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderChecklist() {
    if (!item.checklist || item.checklist.length === 0) return null;
    return (
      <div>
        <div style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '12px' }}>
          Checklist
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {item.checklist.map((c, i) => (
            <label key={`${item.id}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '8px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
              <input type="checkbox" checked={c.done} onChange={() => {}} />
              <span style={{ flex: 1, textDecoration: c.done ? 'line-through' : 'none', color: c.done ? 'var(--text-muted)' : 'var(--text)' }}>{c.label}</span>
            </label>
          ))}
        </div>
      </div>
    );
  }

  function renderEvidenceFields() {
    if (!item.evidenceGates || item.evidenceGates.length === 0) return null;
    return (
      <div>
        <div style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '12px' }}>
          Evidence Gates
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {item.evidenceGates.map(gate => (
            <div key={gate.field} className="glass-card" style={{ padding: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontWeight: '600', fontSize: '13px' }}>{gate.label || gate.field}</span>
                <span className={`badge ${item.evidence?.[gate.field] ? 'badge-success' : gate.severity === 'block' ? 'badge-danger' : 'badge-warning'}`} style={{ fontSize: '10px' }}>
                  {item.evidence?.[gate.field] ? 'Provided' : gate.severity === 'block' ? 'Required' : 'Recommended'}
                </span>
              </div>
              <input
                className="input"
                type="text"
                placeholder={item.evidence?.[gate.field] ? 'Edit evidence' : `Enter ${gate.label || gate.field}`}
                defaultValue={item.evidence?.[gate.field] || ''}
                onChange={() => {}}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderActions() {
    return (
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', paddingTop: '8px' }}>
        <button className="btn btn-primary" onClick={() => onAction?.('open')}>Open</button>
        <button className="btn btn-secondary" onClick={() => onAction?.('chat')}>Chat Owner</button>
        <button className="btn btn-secondary" onClick={() => onAction?.('qc')}>QC Gate</button>
        <button className="btn btn-secondary" onClick={() => onAction?.('dispatch')}>Dispatch</button>
      </div>
    );
  }
}

function getItemMeta(state) {
  if (!state) return { label: 'Unknown', tone: 'info', dot: 'dot-muted', key: 'unknown' };
  const map = {
    backlog: { label: 'Backlog', tone: 'info', dot: 'dot-muted', key: 'backlog' },
    ready: { label: 'Ready', tone: 'success', dot: 'dot-green', key: 'ready' },
    in_progress: { label: 'In Progress', tone: 'warning', dot: 'dot-amber', key: 'in_progress' },
    review: { label: 'Review', tone: 'warning', dot: 'dot-amber', key: 'review' },
    review_pending: { label: 'Needs Review', tone: 'warning', dot: 'dot-amber', key: 'review_pending' },
    verified: { label: 'Verified', tone: 'success', dot: 'dot-green', key: 'verified' },
    done: { label: 'Done', tone: 'success', dot: 'dot-green', key: 'done' },
    on_hold: { label: 'On Hold', tone: 'info', dot: 'dot-muted', key: 'on_hold' },
    blocked: { label: 'Blocked', tone: 'danger', dot: 'dot-red', key: 'blocked' }
  };
  return map[state.key || state] || { label: state?.label || 'Unknown', tone: 'info', dot: 'dot-muted', key: state?.key || 'unknown' };
}