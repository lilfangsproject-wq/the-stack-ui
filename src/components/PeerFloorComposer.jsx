import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '../utils/store';

export function PeerFloorComposer({ messages = [] }) {
  const [text, setText] = useState('');
  const [mentionPop, setMentionPop] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const inputRef = useRef(null);
  const { agents, activeTab, setActiveTab, addToOutbox, addToast } = useStore();

  const peerFloorAgents = agents.filter(a => a.id !== 'peer-floor' && !a.retired);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    const payload = { slug: 'peer-floor', author: 'Seth', body: text, request_id: `req-${Date.now()}` };
    addToOutbox(payload);
    addToast('Sent to #peer-floor', 'success');
    setText('');
    setMentionPop(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === '@' && !mentionPop) {
      setMentionPop(true);
      setMentionQuery('');
    }
    if (mentionPop && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      const filtered = peerFloorAgents.filter(a => a.name.toLowerCase().includes(mentionQuery.toLowerCase()));
      if (filtered.length > 0) {
        insertMention(filtered[0].name);
      }
    }
    if (mentionPop && e.key === 'Escape') {
      setMentionPop(false);
    }
  };

  const handleChange = (e) => {
    const value = e.target.value;
    setText(value);
    const lastAt = value.lastIndexOf('@');
    if (lastAt >= 0 && value.length - lastAt < 20 && !value.slice(lastAt).includes(' ')) {
      setMentionQuery(value.slice(lastAt + 1));
      setMentionPop(true);
    } else {
      setMentionPop(false);
    }
  };

  const insertMention = (name) => {
    const lastAt = text.lastIndexOf('@');
    const before = text.slice(0, lastAt);
    setText(`${before}@${name} `);
    setMentionPop(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const mentionSuggestions = mentionPop
    ? peerFloorAgents
        .filter(a => a.name.toLowerCase().includes(mentionQuery.toLowerCase()))
        .slice(0, 5)
    : [];

  return (
    <section style={{ margin: '16px', paddingBottom: '16px' }}>
      <div className="chip-strip" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
        <button className="chip" onClick={() => insertMention('all')}>@Everyone</button>
        {peerFloorAgents.map(a => (
          <button key={a.id} className="chip" onClick={() => insertMention(a.name)}>@{a.name}</button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="composer-wrap">
        <div className="mention-pop" style={{ position: 'absolute', bottom: '100%', left: '16px', right: '16px', marginBottom: '8px', zIndex: 10, display: mentionPop && mentionSuggestions.length > 0 ? 'block' : 'none' }}>
          <div className="glass-card" style={{ maxHeight: '200px', overflow: 'auto' }}>
            {mentionSuggestions.map(a => (
              <button key={a.id} className="btn btn-secondary w-full" style={{ justifyContent: 'flex-start', padding: '12px 16px' }} onClick={() => insertMention(a.name)}>
                @{a.name}
              </button>
            ))}
          </div>
        </div>

        <div className="composer" style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            className="input"
            style={{ flex: 1, minHeight: '44px', maxHeight: '120px', resize: 'none', padding: '12px 16px', fontSize: '16px', borderRadius: '12px', border: '1px solid var(--line)', background: 'rgba(255,255,255,0.05)' }}
            placeholder="Message the whole team…"
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button className="btn btn-primary" type="submit" disabled={!text.trim()} style={{ height: '44px', padding: '0 20px' }}>Send</button>
        </div>
      </form>

      {/* Recent messages preview */}
      {messages.length > 0 && (
        <div style={{ marginTop: '16px', maxHeight: '200px', overflow: 'auto' }}>
          {messages.slice(-5).map((m, i) => (
            <div key={`${m.id}-${i}`} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)', display: 'flex', gap: '8px' }}>
              <span style={{ fontWeight: '600', fontSize: '13px', color: 'var(--accent)' }}>{m.author}:</span>
              <span style={{ fontSize: '13px', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.body}</span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>{formatTime(m.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function formatTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}