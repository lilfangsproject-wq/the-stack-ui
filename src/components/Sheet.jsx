import React, { useEffect } from 'react';
import { useStore } from '../utils/store';

export function Sheet() {
  const { sheetOpen, addToast } = useStore();

  if (!sheetOpen) return null;

  const handleClose = () => {
    // In real app, would dispatch close action
  };

  return (
    <>
      <div className="sheet-overlay" onClick={handleClose} />
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="sheet-handle" />
        <div className="sheet-content">
          <div style={{ padding: '24px 16px', textAlign: 'center' }}>
            <h2 className="sheet-title">Sheet Content</h2>
            <p style={{ color: 'var(--text-muted)', marginTop: '8px' }}>
              This is where modal sheets would render.
            </p>
            <button className="btn btn-primary" style={{ marginTop: '24px', width: '100%' }} onClick={handleClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </>
  );
}