import React from 'react';
import { useStore } from '../utils/store';

export function AttentionQueue({ onItemClick }) {
  const items = useStore(state => state.getAttentionItems?.() || []);

  if (items.length === 0) return null;

  const dangerItems = items.filter(i => i.severity === 'danger');
  const warningItems = items.filter(i => i.severity === 'warning');

  return (
    <section style={{ margin: '16px', borderRadius: 'var(--radius-xl)', animation: 'slide-up 0.3s ease-out' }}>
      <div className="glass-card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', background: 'rgba(248,113,113,0.12)', borderBottom: '1px solid rgba(248,113,113,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="dot dot-red" style={{ width: 10, height: 10 }} />
            <strong style={{ fontSize: '14px' }}>Needs attention</strong>
            <span className="badge badge-danger" style={{ fontSize: '11px' }}>{items.length}</span>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => { useStore.getState().setWorkFilter('attention'); }}>View all</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
          {dangerItems.map(item => (
            <button
              key={item.id}
              className="attention-item"
              style={{
                padding: '12px 16px',
                background: 'rgba(248,113,113,0.1)',
                borderBottom: '1px solid rgba(248,113,113,0.15)',
                textAlign: 'left',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: '12px'
              }}
              onClick={() => onItemClick?.(item)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: '600', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.detail}</div>
              </div>
              <span className="badge badge-danger" style={{ fontSize: '10px', flexShrink: 0 }}>{item.action}</span>
            </button>
          ))}
          {warningItems.map(item => (
            <button
              key={item.id}
              className="attention-item"
              style={{
                padding: '12px 16px',
                background: 'rgba(251,191,36,0.1)',
                borderBottom: '1px solid rgba(251,191,36,0.15)',
                textAlign: 'left',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: '12px'
              }}
              onClick={() => onItemClick?.(item)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: '600', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.detail}</div>
              </div>
              <span className="badge badge-warning" style={{ fontSize: '10px', flexShrink: 0 }}>{item.action}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}