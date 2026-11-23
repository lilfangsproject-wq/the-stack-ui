import React, { useEffect, useCallback } from 'react';
import { useStore } from '../utils/store';
import { AttentionBanner } from './AttentionBanner';
import { AgentStatusCard } from './AgentStatusCard';
import { PeerFloorComposer } from './PeerFloorComposer';
import { VoiceBriefButton } from './VoiceBriefButton';

export function TodayTab() {
  const {
    activeTab,
    agents,
    messagesBySlug,
    needsSeth,
    link,
    lastSyncIso,
    outbox,
    sync,
    addToast
  } = useStore();

  const peerFloorMsgs = messagesBySlug['peer-floor'] || [];

  // Auto-sync on mount
  useEffect(() => {
    if (activeTab === 'today') sync();
  }, [activeTab, sync]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const modelAgents = agents.filter(a => a.id !== 'peer-floor' && !a.retired);
  const activeAgents = modelAgents.filter(a => a.status === 'running' || a.status === 'working');
  const waitingAgents = modelAgents.filter(a => a.status === 'waiting' || a.status === 'waiting_prompt');
  const blockedAgents = modelAgents.filter(a => a.status === 'blocked');

  return (
    <div className="page">
      {/* Greeting + Status */}
      <section className="hero today-hero glass-card" style={{ margin: '16px', borderRadius: 'var(--radius-xl)' }}>
        <div className="hero-top" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <span className="kicker" style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
            {greeting}
          </span>
          <div className="hero-top-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className={`badge ${link === 'live' ? 'badge-success' : link === 'polling' ? 'badge-warning' : 'badge-accent'}`}>
              <span className={`dot ${link === 'live' ? 'dot-green' : link === 'polling' ? 'dot-amber' : 'dot-muted'}`} style={{ width: 6, height: 6 }} />
              {link === 'live' ? 'Live' : link === 'polling' ? 'Syncing' : 'Offline'}
            </span>
            {outbox.length > 0 && <span className="badge badge-warning">{outbox.length} pending</span>}
          </div>
        </div>

        <h2 className="hero-title" style={{ fontSize: '28px', fontWeight: '700', letterSpacing: '-0.02em', marginBottom: '4px' }}>
          {greeting}, Seth
        </h2>
        <p className="hero-copy" style={{ color: 'var(--text-muted)', fontSize: '15px', lineHeight: 1.5 }}>
          {activeAgents.length} active · {waitingAgents.length} waiting · {blockedAgents.length} blocked · {needsSeth.length} needs you
        </p>

        {/* Voice Brief */}
        <VoiceBriefButton />
      </section>

      {/* Attention Banner (AI Maestro pattern) */}
      <AttentionBanner />

      {/* Team Status Cards - 4 Questions (Open Mission Control) */}
      <section style={{ padding: '0 16px 16px' }}>
        <div className="section-head">
          <span className="section-title">Your Team</span>
          <button className="section-link" onClick={() => useStore.getState().setActiveTab('agents')}>View all</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {modelAgents.map((agent) => (
            <AgentStatusCard key={agent.id} agent={agent} />
          ))}
        </div>
      </section>

      {/* Peer Floor Quick Compose */}
      <PeerFloorComposer messages={peerFloorMsgs.slice(-8)} />

      {/* Quick Actions */}
      <section style={{ padding: '0 16px 24px' }}>
        <div className="section-head">
          <span className="section-title">Quick Actions</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' }}>
          <button className="btn btn-secondary" style={{ justifyContent: 'flex-start', padding: '16px', textAlign: 'left' }} onClick={() => useStore.getState().setActiveTab('work')}>
            <span style={{ fontSize: '18px', marginRight: '8px' }}>📋</span>
            <div>
              <div style={{ fontWeight: '600' }}>Work</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Tasks & evidence</div>
            </div>
          </button>
          <button className="btn btn-secondary" style={{ justifyContent: 'flex-start', padding: '16px', textAlign: 'left' }} onClick={() => useStore.getState().setActiveTab('ops')}>
            <span style={{ fontSize: '18px', marginRight: '8px' }}>⚙️</span>
            <div>
              <div style={{ fontWeight: '600' }}>Ops</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Runtime & voice</div>
            </div>
          </button>
          <button className="btn btn-secondary" style={{ justifyContent: 'flex-start', padding: '16px', textAlign: 'left' }} onClick={() => useStore.getState().setActiveTab('agents')}>
            <span style={{ fontSize: '18px', marginRight: '8px' }}>👥</span>
            <div>
              <div style={{ fontWeight: '600' }}>Agents</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Sessions & chats</div>
            </div>
          </button>
          <button className="btn btn-secondary" style={{ justifyContent: 'flex-start', padding: '16px', textAlign: 'left' }} onClick={() => { useStore.getState().addToast('Voice brief copied', 'info'); navigator.clipboard.writeText(buildBriefText()); }}>
            <span style={{ fontSize: '18px', marginRight: '8px' }}>🎙</span>
            <div>
              <div style={{ fontWeight: '600' }}>Copy Brief</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>For voice call</div>
            </div>
          </button>
        </div>
      </section>
    </div>
  );
}

function buildBriefText() {
  const { agents, needsSeth, workstreams } = useStore.getState();
  const active = agents.filter(a => a.status === 'running' || a.status === 'working').length;
  const waiting = agents.filter(a => a.status === 'waiting' || a.status === 'waiting_prompt').length;
  const blocked = agents.filter(a => a.status === 'blocked').length;
  return `The Stack brief. Active: ${active}. Waiting: ${waiting}. Blocked: ${blocked}. Needs you: ${needsSeth.length}. Workstreams: ${workstreams.length}.`;
}