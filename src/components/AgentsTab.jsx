import React, { useEffect, useState } from 'react';
import { useStore } from '../utils/store';
import { ChatLog } from './ChatLog';

export function AgentsTab() {
  const {
    agents,
    activeAgentId,
    setActiveAgentId,
    messagesBySlug,
    jumpToAgent,
    activeTab,
    setActiveTab,
    voiceCall,
    startVoiceCall,
    hangUpVoiceCall,
    addToast
  } = useStore();

  const modelAgents = agents.filter(a => a.id !== 'peer-floor' && !a.retired);
  const agent = modelAgents.find(a => a.id === activeAgentId) || modelAgents[0];

  // Load messages when agent changes
  useEffect(() => {
    if (agent && agent.id !== 'peer-floor') {
      // In real app, would load DM messages
    }
  }, [agent]);

  const slug = `dm-${agent.id}-seth`;
  const msgs = messagesBySlug[slug] || [];

  return (
    <div className="page">
      {/* Agent Switcher */}
      <div style={{ padding: '12px 16px', display: 'flex', gap: '8px', overflowX: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        {modelAgents.map(a => {
          const meta = getStatusMeta(a.status);
          return (
            <button
              key={a.id}
              className={`agent-pill ${activeAgentId === a.id ? 'active' : ''}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 14px',
                borderRadius: '999px',
                border: '1px solid var(--line)',
                background: activeAgentId === a.id ? 'var(--accent-soft)' : 'transparent',
                color: activeAgentId === a.id ? 'var(--accent)' : 'var(--text)',
                fontSize: '13px',
                fontWeight: '600',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0
              }}
              onClick={() => { setActiveAgentId(a.id); jumpToAgent(a.id); }}
            >
              <span className="dot" style={{ background: a.color || 'var(--accent)', width: 8, height: 8 }} />
              {a.name}
              <span className={`badge ${meta.tone}`} style={{ fontSize: '10px', padding: '1px 6px', marginLeft: '4px' }}>{meta.label}</span>
            </button>
          );
        })}
      </div>

      {/* Active Agent Detail */}
      {agent && (
        <AgentDetailCard agent={agent} messages={msgs} slug={slug} />
      )}

      {/* Peer Floor always available */}
      <div style={{ padding: '16px', borderTop: '1px solid var(--line)' }}>
        <button className="agent-pill" style={{ width: '100%', justifyContent: 'center', gap: '8px', padding: '12px' }} onClick={() => { setActiveAgentId('peer-floor'); jumpToAgent('peer-floor'); }}>
          <span className="dot" style={{ background: 'var(--accent)', width: 8, height: 8 }} />
          Team Chat (#peer-floor)
          <span className="badge badge-accent" style={{ fontSize: '10px' }}>{(messagesBySlug['peer-floor'] || []).length} msgs</span>
        </button>
      </div>

      {/* Voice Call Bar */}
      {voiceCall?.alive && <VoiceCallBar />}
    </div>
  );
}

function AgentDetailCard({ agent, messages, slug }) {
  const { setActiveAgentId, jumpToAgent, startVoiceCall, hangUpVoiceCall, addToast } = useStore();
  const meta = getStatusMeta(agent.status);
  const hasSession = agent.session && (agent.session.session_url || agent.session.continue_prompt);

  return (
    <div className="glass-card" style={{ margin: '16px', borderRadius: 'var(--radius-xl)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div className={`avatar ${agent.colorText ? 'text-white' : ''}`} style={{ background: agent.color || 'var(--accent)', width: 48, height: 48 }}>
            {agent.name.charAt(0).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: '20px', fontWeight: '700' }}>{agent.name}</h2>
              <span className={`badge ${meta.tone}`}>{meta.label}</span>
              {agent.hasLiveUsage && (
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {agent.usagePct}% · {agent.usageObservedAt ? `updated ${formatRelative(agent.usageObservedAt)}` : ''}
                </span>
              )}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {agent.role}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {agent.session?.continue_prompt && (
            <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(agent.session.continue_prompt); addToast('Prompt copied', 'info'); }}>
              📋 Copy Prompt
            </button>
          )}
          {agent.session?.session_url && (
            <a href={agent.session.session_url} target="_blank" rel="noopener" className="btn btn-secondary btn-sm">Open Session</a>
          )}
          <button className="btn btn-primary" onClick={() => startVoiceCall(slug)}>🎙 Voice</button>
        </div>
      </div>

      {/* Usage meter */}
      {agent.hasLiveUsage && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Usage</span>
            <strong>{agent.usagePct}%</strong>
          </div>
          <div className="meter"><div className={`meter-fill ${agent.usagePct >= 85 ? 'meter-fill-danger' : agent.usagePct >= 70 ? 'meter-fill-warning' : ''}`} style={{ width: `${agent.usagePct}%` }} /></div>
        </div>
      )}

      {/* Session Card */}
      {agent.session && (
        <div className="glass-card" style={{ marginBottom: '16px', padding: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>Live Session</span>
            <span className={`badge ${agent.session.reported_state === 'running' ? 'badge-success' : 'badge-warning'}`}>
              {agent.session.reported_state}
            </span>
          </div>
          {agent.session.task_title && <p style={{ fontSize: '14px', marginBottom: '8px' }}>{agent.session.task_title}</p>}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {agent.session.session_url && (
              <a href={agent.session.session_url} target="_blank" rel="noopener" className="btn btn-secondary btn-sm">Open Runtime</a>
            )}
            {agent.session.continue_prompt && (
              <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(agent.session.continue_prompt); addToast('Prompt copied', 'info'); }}>
                Copy Continue Prompt
              </button>
            )}
          </div>
        </div>
      )}

      {/* Chat Log */}
      <div style={{ marginTop: '16px' }}>
        <div className="section-head">
          <span className="section-title">Chat</span>
          <button className="section-link" onClick={() => { setActiveAgentId('peer-floor'); jumpToAgent('peer-floor'); }}>#peer-floor</button>
        </div>
        <ChatLog messages={messages} slug={slug} currentUser="Seth" />
      </div>
    </div>
  );
}

function getStatusMeta(status) {
  const map = {
    running: { label: 'Running', tone: 'success' },
    working: { label: 'Working', tone: 'success' },
    waiting: { label: 'Waiting', tone: 'warning' },
    waiting_prompt: { label: 'Waiting for prompt', tone: 'warning' },
    paused_quota: { label: 'Paused by quota', tone: 'warning' },
    blocked: { label: 'Blocked', tone: 'danger' },
    unknown: { label: 'Unconfirmed', tone: 'info' },
    offline: { label: 'Offline', tone: 'info' },
    completed: { label: 'Completed', tone: 'success' }
  };
  return map[status] || map.unknown;
}

function formatRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}