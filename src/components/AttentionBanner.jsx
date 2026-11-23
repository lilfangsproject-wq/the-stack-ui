import React from 'react';
import { useStore } from '../utils/store';

export function AttentionBanner() {
  const items = useStore(state => state.getAttentionItems?.() || []);
  if (items.length === 0) return null;

  const topItems = items.slice(0, 3);
  const count = items.length;
  const hasDanger = items.some(i => i.severity === 'danger');

  return (
    <section className="attention-banner glass-card" style={{ margin: '16px', borderRadius: 'var(--radius-xl)', animation: 'slide-up 0.3s ease-out' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '8px 12px', background: `rgba(${hasDanger ? '248,113,113' : '251,191,36'},0.12)`, border: `1px solid rgba(${hasDanger ? '248,113,113' : '251,191,36'},0.3)`, borderRadius: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className={`dot ${hasDanger ? 'dot-red' : 'dot-amber'}`} style={{ width: 10, height: 10 }} />
          <strong style={{ fontSize: '14px' }}>Needs attention</strong>
          <span className={`badge ${hasDanger ? 'badge-danger' : 'badge-warning'}`} style={{ fontSize: '11px', padding: '2px 6px' }}>{count}</span>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => useStore.getState().setActiveTab('work')}>View all</button>
      </div>
      <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {topItems.map((item) => (
          <button
            key={item.id}
            className="attention-item"
            style={{
              padding: '10px 12px',
              background: item.severity === 'danger' ? 'rgba(248,113,113,0.15)' : 'rgba(251,191,36,0.15)',
              border: `1px solid ${item.severity === 'danger' ? 'rgba(248,113,113,0.3)' : 'rgba(251,191,36,0.3)'}`,
              borderRadius: '8px',
              textAlign: 'left',
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: '8px'
            }}
            onClick={() => {
              if (item.type === 'stale_run' || item.type === 'blocked_assignment' || item.type === 'blocked_work') {
                useStore.getState().setActiveTab('work');
              } else if (item.type === 'needs_seth') {
                useStore.getState().setActiveTab('today');
              } else if (item.type === 'idle_agent') {
                useStore.getState().setActiveTab('agents');
              }
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: '600', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.detail}</div>
            </div>
            <span className={`badge ${item.severity === 'danger' ? 'badge-danger' : 'badge-warning'}`} style={{ fontSize: '10px', flexShrink: 0 }}>{item.action}</span>
          </button>
        ))}
      </div>
    </section>
  );
}