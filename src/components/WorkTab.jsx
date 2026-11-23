import React, { useState, useMemo } from 'react';
import { useStore } from '../utils/store';
import { WorkItemCard } from './WorkItemCard';
import { AttentionQueue } from './AttentionQueue';

export function WorkTab() {
  const {
    workstreams,
    workFilter,
    setWorkFilter,
    items,
    assignments,
    needsSeth,
    heartbeats,
    runs,
    getAttentionItems,
    jumpToAgent
  } = useStore();

  const [expandedId, setExpandedId] = useState(null);

  const filters = [
    { id: 'all', label: 'Active' },
    { id: 'opportunities', label: 'Ideas' },
    { id: 'workstreams', label: 'Core' },
    { id: 'hold', label: 'Parked' },
    { id: 'attention', label: '🔴 Attention' }
  ];

  const filteredItems = useMemo(() => {
    if (workFilter === 'all') return items.filter(i => getItemMeta(i.state).label !== 'On Hold');
    if (workFilter === 'opportunities') return items.filter(i => i.rawKind === 'opportunity' && getItemMeta(i.state).label !== 'On Hold');
    if (workFilter === 'workstreams') return items.filter(i => i.rawKind === 'workstream' && getItemMeta(i.state).label !== 'On Hold');
    if (workFilter === 'hold') return items.filter(i => getItemMeta(i.state).label === 'On Hold');
    if (workFilter === 'attention') {
      // Show items needing attention
      const attentionIds = new Set(getAttentionItems?.().map(i => i.ref) || []);
      return items.filter(i => attentionIds.has(i.id) || i.needsSeth?.length > 0 || i.blockedReason || i.state?.key === 'blocked');
    }
    return items;
  }, [items, workFilter, workstreams, getAttentionItems]);

  // Build workstream map for cards
  const workstreamCards = workstreams.filter(w => {
    if (workFilter === 'opportunities') return w.rawKind === 'opportunity';
    if (workFilter === 'workstreams') return w.rawKind === 'workstream';
    if (workFilter === 'hold') return getItemMeta(w.state).label === 'On Hold';
    if (workFilter === 'attention') {
      const attentionIds = new Set(getAttentionItems?.().map(i => i.ref) || []);
      return attentionIds.has(w.id) || w.blockedReason || w.needsSeth?.length > 0 || w.state?.key === 'blocked';
    }
    return getItemMeta(w.state).label !== 'On Hold';
  });

  return (
    <div className="page">
      {/* Filter tabs */}
      <div style={{ padding: '12px 16px', display: 'flex', gap: '8px', overflowX: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none', borderBottom: '1px solid var(--line)' }}>
        {filters.map(f => (
          <button
            key={f.id}
            className={`seg-btn ${workFilter === f.id ? 'active' : ''}`}
            style={{
              padding: '8px 16px',
              borderRadius: '999px',
              border: '1px solid var(--line)',
              background: workFilter === f.id ? 'var(--accent-soft)' : 'transparent',
              color: workFilter === f.id ? 'var(--accent)' : 'var(--text)',
              fontSize: '13px',
              fontWeight: '600',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
            onClick={() => { useStore.getState().setWorkFilter(f.id); }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Attention Queue (AI Maestro pattern) - shown at top when on attention filter */}
      {workFilter === 'attention' && <AttentionQueue onItemClick={(item) => handleAttentionClick(item)} />}

      {/* Workstream cards (LangGraph node view) */}
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {workstreamCards.length === 0 ? (
          <div className="empty" style={{ padding: '32px 16px', textAlign: 'center' }}>
            No {workFilter === 'attention' ? 'attention items' : workFilter} found
          </div>
        ) : (
          workstreamCards.map(ws => (
            <WorkItemCard
              key={ws.id}
              item={ws}
              isExpanded={expandedId === ws.id}
              onToggle={() => setExpandedId(expandedId === ws.id ? null : ws.id)}
              onAction={(action) => handleWorkAction(ws, action)}
            />
          ))
        )}

        {/* Assignment items (crewAI task→agent) */}
        {workFilter !== 'opportunities' && workFilter !== 'workstreams' && assignments.length > 0 && (
          <>
            <div className="section-head" style={{ marginTop: '24px' }}>
              <span className="section-title">Assignments</span>
            </div>
            {assignments
              .filter(a => a.status !== 'completed' && a.status !== 'cancelled')
              .slice(0, 10)
              .map(a => (
                <AssignmentCard key={a.id} assignment={a} />
              ))}
          </>
        )}

        {/* Regular items */}
        {filteredItems.length > 0 && workFilter !== 'attention' && (
          <>
            <div className="section-head" style={{ marginTop: '24px' }}>
              <span className="section-title">Items</span>
            </div>
            {filteredItems.map(item => (
              <WorkItemCard
                key={item.id}
                item={item}
                isExpanded={expandedId === item.id}
                onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                onAction={(action) => handleWorkAction(item, action)}
              />
            ))}
          </>
        )}

        {filteredItems.length === 0 && workstreamCards.length === 0 && assignments.length === 0 && (
          <div className="empty" style={{ padding: '32px 16px', textAlign: 'center' }}>
            Nothing here. <button className="btn btn-primary btn-sm" onClick={() => { useStore.getState().setWorkFilter('all'); }}>Show active</button>
          </div>
        )}
      </div>
    </div>
  );
}

function handleAttentionClick(item) {
  if (item.type === 'stale_run' || item.type === 'blocked_assignment' || item.type === 'blocked_work') {
    useStore.getState().setWorkFilter('attention');
  } else if (item.type === 'needs_seth') {
    useStore.getState().setActiveTab('today');
  } else if (item.type === 'idle_agent') {
    useStore.getState().setActiveTab('agents');
  }
}

function handleWorkAction(item, action) {
  const { jumpToAgent, addToast } = useStore.getState();
  switch (action) {
    case 'open':
      // Would open detail sheet
      addToast(`Opening ${item.title}`, 'info');
      break;
    case 'chat':
      jumpToAgent(item.ownerId);
      break;
    case 'qc':
      addToast('QC gate opened', 'info');
      break;
    case 'dispatch':
      addToast('Dispatching...', 'info');
      break;
  }
}

function AssignmentCard({ assignment }) {
  const meta = getAssignmentMeta(assignment.status);
  const agentName = assignment.agentId || assignment.assignee || 'Unassigned';

  return (
    <button className="glass-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
      <span className={`dot ${meta.dot}`} />
      <div className="flex-1 min-w-0">
        <div style={{ fontWeight: '600', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{assignment.title || assignment.id}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {agentName} · {meta.label}
        </div>
      </div>
      <span className={`badge ${meta.tone}`} style={{ fontSize: '11px' }}>{meta.label}</span>
    </button>
  );
}

function getAssignmentMeta(status) {
  const map = {
    assigned: { label: 'Assigned', tone: 'info', dot: 'dot-muted' },
    received: { label: 'Picked up', tone: 'warning', dot: 'dot-amber' },
    scheduled: { label: 'Scheduled', tone: 'info', dot: 'dot-muted' },
    waiting_dependency: { label: 'Waiting', tone: 'warning', dot: 'dot-amber' },
    running: { label: 'Running', tone: 'success', dot: 'dot-green' },
    interrupted: { label: 'Interrupted', tone: 'danger', dot: 'dot-red' },
    retry_wait: { label: 'Retry wait', tone: 'warning', dot: 'dot-amber' },
    review_pending: { label: 'Needs review', tone: 'warning', dot: 'dot-amber' },
    verified: { label: 'Verified', tone: 'success', dot: 'dot-green' },
    failed: { label: 'Failed', tone: 'danger', dot: 'dot-red' },
    cancelled: { label: 'Cancelled', tone: 'info', dot: 'dot-muted' },
    timed_out: { label: 'Timed out', tone: 'danger', dot: 'dot-red' }
  };
  return map[status] || map.assigned;
}

function getItemMeta(state) {
  if (!state) return { label: 'Unknown', key: 'unknown' };
  const map = {
    backlog: { label: 'Backlog', key: 'backlog' },
    ready: { label: 'Ready', key: 'ready' },
    in_progress: { label: 'In Progress', key: 'in_progress' },
    review: { label: 'Review', key: 'review' },
    review_pending: { label: 'Needs Review', key: 'review_pending' },
    verified: { label: 'Verified', key: 'verified' },
    done: { label: 'Done', key: 'done' },
    on_hold: { label: 'On Hold', key: 'on_hold' },
    blocked: { label: 'Blocked', key: 'blocked' }
  };
  return map[state.key || state] || { label: state?.label || 'Unknown', key: state?.key || 'unknown' };
}