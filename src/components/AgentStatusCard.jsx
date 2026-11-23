import React from 'react';
import { useStore } from '../utils/store';

export function AgentStatusCard({ agent }) {
  const { setActiveTab, jumpToAgent } = useStore();

  const statusMeta = {
    running: { label: 'Running', tone: 'success', dot: 'dot-green' },
    working: { label: 'Working', tone: 'success', dot: 'dot-green' },
    waiting: { label: 'Waiting', tone: 'warning', dot: 'dot-amber' },
    waiting_prompt: { label: 'Waiting for prompt', tone: 'warning', dot: 'dot-amber' },
    paused_quota: { label: 'Paused by quota', tone: 'warning', dot: 'dot-amber' },
    blocked: { label: 'Blocked', tone: 'danger', dot: 'dot-red' },
    unknown: { label: 'Unconfirmed', tone: 'info', dot: 'dot-muted' },
    offline: { label: 'Offline', tone: 'info', dot: 'dot-muted' },
    completed: { label: 'Completed', tone: 'success', dot: 'dot-green' }
  };

  const meta = statusMeta[agent.status] || statusMeta.unknown;
  const hasSession = agent.session && (agent.session.session_url || agent.session.continue_prompt);

  return (
    <button
      className="teammate-row glass-card"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '12px 16px',
        borderRadius: 'var(--radius)',
        border: '1px solid var(--line)',
        background: 'var(--glass)',
        cursor: 'pointer',
        textAlign: 'left'
      }}
      onClick={() => { setActiveTab('agents'); jumpToAgent(agent.id); }}
    >
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <div className={`avatar ${agent.colorText ? 'text-white' : ''}`} style={{ background: agent.color || 'var(--accent)', width: 40, height: 40 }}>
          {agent.name.charAt(0).toUpperCase()}
        </div>
        <span className={`dot ${meta.dot}`} style={{ position: 'absolute', bottom: 0, right: 0, border: '2px solid var(--bg)' }} />
      </div>

      <div className="flex-1 min-w-0" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: '600', fontSize: '15px' }}>{agent.name}</span>
          <span className={`badge ${meta.tone}`} style={{ fontSize: '10px', padding: '2px 6px' }}>{meta.label}</span>
          {agent.hasLiveUsage && (
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {agent.usagePct}% · {agent.usageObservedAt ? `updated ${formatRelative(agent.usageObservedAt)}` : ''}
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {agent.activitySummary || agent.lastSeen || 'No recent activity'}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {hasSession && agent.session?.continue_prompt && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(agent.session.continue_prompt); useStore.getState().addToast('Prompt copied', 'info'); }}
            style={{ padding: '6px 10px', fontSize: '11px' }}
          >
            📋 Copy
          </button>
        )}
        {hasSession && agent.session?.session_url && (
          <a href={agent.session.session_url} target="_blank" rel="noopener" className="btn btn-ghost btn-sm" onClick={(e) => e.stopPropagation()}>
            Open
          </a>
        )}
        <span className={`badge ${meta.tone}`} style={{ fontSize: '11px', padding: '2px 8px' }}>{meta.label}</span>
      </div>
    </button>
  );
}

function formatRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}