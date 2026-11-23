import React, { useEffect, useCallback } from 'react';
import { useStore } from './utils/store';
import { TodayTab } from './components/TodayTab';
import { AgentsTab } from './components/AgentsTab';
import { WorkTab } from './components/WorkTab';
import { OpsTab } from './components/OpsTab';
import { ToastRoot } from './components/ToastRoot';
import { Sheet } from './components/Sheet';

export function App() {
  const {
    activeTab,
    setActiveTab,
    pin,
    bffUrl,
    githubPat,
    hydrateFromSync,
    addToast,
    online,
    syncing,
    lastSyncIso,
    outbox,
    addToOutbox,
    clearOutbox,
    sheetOpen
  } = useStore();

  // Sync with BFF
  const sync = useCallback(async () => {
    if (!bffUrl || !pin) return;
    try {
      const res = await fetch(`${bffUrl}/api/sync`, {
        headers: { 'x-stack-pin': pin }
      });
      if (res.ok) {
        const data = await res.json();
        hydrateFromSync(data);
        addToast('Synced', 'success');
      } else {
        addToast('Sync failed', 'error');
      }
    } catch (e) {
      addToast('Offline', 'warning');
    }
  }, [bffUrl, pin, hydrateFromSync, addToast]);

  // Auto-sync on mount and when online
  useEffect(() => {
    if (online && bffUrl && pin) sync();
    const interval = setInterval(() => {
      if (online && bffUrl && pin) sync();
    }, 60000);
    return () => clearInterval(interval);
  }, [online, bffUrl, pin, sync]);

  // Flush outbox
  useEffect(() => {
    if (outbox.length === 0) return;
    // In real app, would POST to /api/ping
    // For now just clear
    clearOutbox();
  }, [outbox, clearOutbox]);

  // Show PIN gate if not configured
  if (!pin || !bffUrl) {
    return <PinGate onComplete={sync} />;
  }

  return (
    <div className="page">
      <TopBar onSync={sync} />
      <main style={{ paddingTop: '56px', paddingBottom: '104px', flex: 1, overflow: 'auto' }}>
        {activeTab === 'today' && <TodayTab />}
        {activeTab === 'agents' && <AgentsTab />}
        {activeTab === 'work' && <WorkTab />}
        {activeTab === 'ops' && <OpsTab />}
      </main>
      <BottomBar activeTab={activeTab} onChange={setActiveTab} />
      <ToastRoot />
      {sheetOpen && <Sheet />}
    </div>
  );
}

function TopBar({ onSync }) {
  const { online, syncing, lastSyncIso, outbox, agents, addToast, pin, bffUrl } = useStore();

  return (
    <header className="topbar">
      <h1 className="topbar-title">The Stack</h1>
      <div className="topbar-actions">
        <button
          className={`btn btn-icon btn-ghost ${syncing ? 'animate-spin' : ''}`}
          onClick={onSync}
          disabled={syncing}
          aria-label={syncing ? 'Syncing…' : 'Sync now'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
        <span className={`dot ${online ? 'dot-green' : 'dot-muted'}`} style={{ width: 8, height: 8 }} />
        {outbox.length > 0 && (
          <span className="badge badge-warning" style={{ fontSize: 10, padding: '2px 6px' }}>
            {outbox.length} pending
          </span>
        )}
      </div>
    </header>
  );
}

function BottomBar({ activeTab, onChange }) {
  const tabs = [
    { id: 'today', label: 'Today', icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    )},
    { id: 'agents', label: 'Team', icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 17 3.5 20.5V7.5A2.5 2.5 0 0 1 6 5h12a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 17Z" />
      </svg>
    )},
    { id: 'work', label: 'Work', icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="5" width="16" height="14" rx="3" />
        <path d="M9 10h6M9 14h4" />
      </svg>
    )},
    { id: 'ops', label: 'Ops', icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    )}
  ];

  return (
    <nav className="bottombar" role="navigation" aria-label="Primary">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`nav-btn ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => onChange(tab.id)}
          aria-current={activeTab === tab.id ? 'page' : undefined}
          aria-label={tab.label}
        >
          <span className="nav-icon">{tab.icon}</span>
          <span>{tab.label}</span>
          {activeTab === tab.id && <span className="dot-green-small" />}
        </button>
      ))}
    </nav>
  );
}

function PinGate({ onComplete }) {
  const [pin, setPin] = React.useState('');
  const [bffUrl, setBffUrl] = React.useState('');
  const [githubPat, setGithubPat] = React.useState('');
  const [githubRepo, setGithubRepo] = React.useState('lilfangsproject-wq/ai-workspace');
  const [githubBranch, setGithubBranch] = React.useState('main');
  const [testing, setTesting] = React.useState(false);
  const [error, setError] = React.useState('');
  const { setPin: storeSetPin, bffUrl: storeBffUrl, githubPat: storePat, addToast } = useStore();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!pin || !bffUrl) {
      setError('PIN and BFF URL required');
      return;
    }
    setTesting(true);
    setError('');
    try {
      const res = await fetch(`${bffUrl}/api/sync`, { headers: { 'x-stack-pin': pin } });
      if (res.ok) {
        storeSetPin(pin);
        // Would save bffUrl, githubPat, etc. to store
        addToast('Connected', 'success');
        onComplete();
      } else {
        setError('Invalid PIN or BFF URL');
      }
    } catch {
      setError('Connection failed');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', background: 'var(--bg)' }}>
      <div className="glass-card" style={{ width: '100%', maxWidth: '400px', padding: '32px' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" style={{ marginBottom: '16px' }}>
            <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z" />
          </svg>
          <h1 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '8px' }}>The Stack Mobile</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Unified AI Agent Workspace</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '8px', color: 'var(--text-muted)' }}>BFF URL</label>
            <input
              className="input"
              type="url"
              placeholder="https://your-worker.workers.dev"
              value={bffUrl}
              onChange={(e) => setBffUrl(e.target.value)}
              required
            />
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '8px', color: 'var(--text-muted)' }}>Access PIN</label>
            <input
              className="input"
              type="password"
              placeholder="••••••"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              required
              autoComplete="off"
            />
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '8px', color: 'var(--text-muted)' }}>GitHub PAT (optional)</label>
            <input
              className="input"
              type="password"
              placeholder="ghp_…"
              value={githubPat}
              onChange={(e) => setGithubPat(e.target.value)}
            />
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '8px', color: 'var(--text-muted)' }}>GitHub Repo</label>
            <input
              className="input"
              type="text"
              placeholder="owner/repo"
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
            />
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '8px', color: 'var(--text-muted)' }}>Branch</label>
            <input
              className="input"
              type="text"
              placeholder="main"
              value={githubBranch}
              onChange={(e) => setGithubBranch(e.target.value)}
            />
          </div>

          {error && <div className="toast toast-error" style={{ marginBottom: '16px', textAlign: 'center' }}>{error}</div>}

          <button className="btn btn-primary w-full" type="submit" disabled={testing} style={{ padding: '16px' }}>
            {testing ? (
              <span className="flex items-center justify-center gap-8">
                <span className="spinner" /> Connecting…
              </span>
            ) : (
              'Connect Workspace'
            )}
          </button>
        </form>

        <p style={{ marginTop: '24px', fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center' }}>
          Zero-spend · Offline-capable · PWA
        </p>
      </div>
    </div>
  );
}