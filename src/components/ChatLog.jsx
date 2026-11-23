import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useStore } from '../utils/store';

export function ChatLog({ messages = [], slug, currentUser = 'Seth' }) {
  const [newMessage, setNewMessage] = useState('');
  const [mentionPop, setMentionPop] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const messagesEndRef = useRef(null);
  const { agents, activeAgentId, addToOutbox, addToast, jumpToAgent, setActiveTab } = useStore();

  const peerFloorAgents = agents.filter(a => a.id !== 'peer-floor' && !a.retired);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!newMessage.trim()) return;
    const payload = { slug, author: currentUser, body: newMessage, request_id: `req-${Date.now()}` };
    addToOutbox(payload);
    addToast('Sent', 'success');
    setNewMessage('');
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
    setNewMessage(value);
    const lastAt = value.lastIndexOf('@');
    if (lastAt >= 0 && value.length - lastAt < 20 && !value.slice(lastAt).includes(' ')) {
      setMentionQuery(value.slice(lastAt + 1));
      setMentionPop(true);
    } else {
      setMentionPop(false);
    }
  };

  const insertMention = (name) => {
    const lastAt = newMessage.lastIndexOf('@');
    const before = newMessage.slice(0, lastAt);
    setNewMessage(`${before}@${name} `);
    setMentionPop(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const mentionSuggestions = mentionPop
    ? peerFloorAgents.filter(a => a.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 5)
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Messages */}
      <div style={{ maxHeight: '400px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', paddingRight: '8px' }}>
        {messages.length === 0 ? (
          <div className="empty" style={{ textAlign: 'center', padding: '32px 16px' }}>
            No messages yet. Start the conversation!
          </div>
        ) : (
          messages.map((m, i) => (
            <MessageBubble key={`${m.id}-${i}`} message={m} isOwn={m.author === currentUser} />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Mention suggestions */}
      {mentionPop && mentionSuggestions.length > 0 && (
        <div style={{ position: 'absolute', bottom: '100%', left: '16px', right: '16px', marginBottom: '8px', zIndex: 10 }}>
          <div className="glass-card" style={{ maxHeight: '180px', overflow: 'auto' }}>
            {mentionSuggestions.map(a => (
              <button key={a.id} className="btn btn-secondary w-full" style={{ justifyContent: 'flex-start', padding: '12px 16px' }} onClick={() => insertMention(a.name)}>
                @{a.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Composer */}
      <form onSubmit={handleSubmit} className="composer-wrap">
        <div className="mention-pop" style={{ position: 'absolute', bottom: '100%', left: '16px', right: '16px', marginBottom: '8px', zIndex: 10, display: mentionPop && mentionSuggestions.length > 0 ? 'block' : 'none' }}>
          <div className="glass-card" style={{ maxHeight: '180px', overflow: 'auto' }}>
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
            placeholder={slug === 'peer-floor' ? 'Message the whole team…' : `Message ${activeAgentId}…`}
            value={newMessage}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button className="btn btn-primary" type="submit" disabled={!newMessage.trim()} style={{ height: '44px', padding: '0 20px' }}>Send</button>
        </div>
      </form>
    </div>
  );
}

function MessageBubble({ message, isOwn }) {
  const time = formatTime(message.created_at);
  return (
    <div style={{ display: 'flex', flexDirection: isOwn ? 'row-reverse' : 'row', gap: '8px', alignItems: 'flex-end' }}>
      {!isOwn && <span className="avatar avatar-sm" style={{ background: 'var(--accent)' }}>{message.author?.charAt(0) || '?'}</span>}
      <div style={{ maxWidth: '75%', display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {!isOwn && <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-muted)' }}>{message.author}</span>}
        <div style={{
          padding: '10px 14px',
          borderRadius: isOwn ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
          background: isOwn ? 'var(--accent-soft)' : 'rgba(255,255,255,0.05)',
          border: isOwn ? '1px solid var(--accent)' : '1px solid var(--line)',
          color: isOwn ? 'var(--on-accent)' : 'var(--text)',
          fontSize: '14px',
          lineHeight: 1.4,
          wordBreak: 'break-word'
        }}>
          {message.body}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{time}</span>
          {message.backend_accepted_at && <span className="badge badge-success" style={{ fontSize: '9px' }}>Delivered</span>}
        </div>
        </div>
      {isOwn && <span className="avatar avatar-sm" style={{ background: 'var(--success)' }}>✓</span>}
    </div>
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