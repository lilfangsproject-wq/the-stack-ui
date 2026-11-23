import React from 'react';
import { useStore } from '../utils/store';

export function ToastRoot() {
  const { toastQueue } = useStore();

  if (toastQueue.length === 0) return null;

  return (
    <div className="toast-root" role="region" aria-live="polite" aria-label="Notifications">
      {toastQueue.map(t => (
        <div key={t.id} className={`toast ${t.type === 'success' ? 'toast-success' : t.type === 'error' ? 'toast-error' : t.type === 'warning' ? 'toast-warning' : ''}`}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className={`dot ${t.type === 'success' ? 'dot-green' : t.type === 'error' ? 'dot-red' : 'dot-amber'}`} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: '14px' }}>{t.message}</span>
            <button onClick={() => useStore.getState().removeToast(t.id)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer', padding: '0 4px' }}>✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}