import React, { useState, useCallback } from 'react';
import { useStore } from '../utils/store';

export function VoiceBriefButton() {
  const [copied, setCopied] = useState(false);
  const { agents, needsSeth, workstreams, addToast, voiceEnabled } = useStore();

  const buildBrief = useCallback(() => {
    const active = agents.filter(a => a.status === 'running' || a.status === 'working').length;
    const waiting = agents.filter(a => a.status === 'waiting' || a.status === 'waiting_prompt').length;
    const blocked = agents.filter(a => a.status === 'blocked').length;
    const needsYou = needsSeth.length;
    const wsCount = workstreams.length;

    let brief = `The Stack brief. `;
    brief += `Active: ${active}. Waiting: ${waiting}. Blocked: ${blocked}. `;
    brief += `Needs you: ${needsYou}. Workstreams: ${wsCount}. `;

    if (blocked > 0) {
      const blockedAgents = agents.filter(a => a.status === 'blocked');
      brief += `Blocked: ${blockedAgents.map(a => a.name).join(', ')}. `;
    }
    if (needsYou > 0) {
      brief += `Decisions waiting: ${needsSeth.map(n => n.title).join('; ')}. `;
    }
    brief += `End of brief.`;

    return brief;
  }, [agents, needsSeth, workstreams]);

  const handleCopy = () => {
    const brief = buildBrief();
    navigator.clipboard.writeText(brief);
    setCopied(true);
    addToast('Brief copied for voice call', 'success');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      className="btn btn-secondary"
      onClick={handleCopy}
      style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}
      disabled={!voiceEnabled}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="22" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
      <span>{copied ? 'Copied!' : '🎙 Copy Brief for Voice'}</span>
    </button>
  );
}