import React, { useEffect, useState } from 'react';
import { useStore } from '../utils/store';

export function OpsTab() {
  const {
    heartbeats,
    runtimeBeats,
    agentSessions,
    health,
    qcReceipts,
    addToast,
    sync,
    voiceEnabled,
    setVoiceEnabled,
    ttsVoice,
    setTtsVoice,
    sttEnabled,
    setSttEnabled
  } = useStore();

  const [activeSection, setActiveSection] = useState('runtime');

  // Load runtime heartbeats
  useEffect(() => {
    // In real app, would fetch from /api/runtime/heartbeat
  }, []);

  const modelAgents = Object.keys(heartbeats).filter(k => !['grokbot', 'stackbot', 'peer-floor'].includes(k));

  return (
    <div className="page">
      {/* Section tabs */}
      <div style={{ padding: '12px 16px', display: 'flex', gap: '8px', overflowX: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none', borderBottom: '1px solid var(--line)' }}>
        {[
          { id: 'runtime', label: 'Runtime', icon: '⚙️' },
          { id: 'voice', label: 'Voice', icon: '🎙' },
          { id: 'health', label: 'Health', icon: '🏥' },
          { id: 'qc', label: 'QC', icon: '✅' }
        ].map(s => (
          <button
            key={s.id}
            className={`seg-btn ${activeSection === s.id ? 'active' : ''}`}
            style={{
              padding: '8px 16px',
              borderRadius: '999px',
              border: '1px solid var(--line)',
              background: activeSection === s.id ? 'var(--accent-soft)' : 'transparent',
              color: activeSection === s.id ? 'var(--accent)' : 'var(--text)',
              fontSize: '13px',
              fontWeight: '600',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
            onClick={() => setActiveSection(s.id)}
          >
            <span>{s.icon}</span>
            <span>{s.label}</span>
          </button>
        ))}
      </div>

      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {activeSection === 'runtime' && <RuntimeSection heartbeats={heartbeats} runtimeBeats={runtimeBeats} agentSessions={agentSessions} />}
        {activeSection === 'voice' && <VoiceSection voiceEnabled={voiceEnabled} setVoiceEnabled={setVoiceEnabled} ttsVoice={ttsVoice} setTtsVoice={setTtsVoice} sttEnabled={sttEnabled} setSttEnabled={setSttEnabled} />}
        {activeSection === 'health' && <HealthSection health={health} qcReceipts={qcReceipts} />}
        {activeSection === 'qc' && <QCSection qcReceipts={qcReceipts} />}
      </div>
    </div>
  );
}

function RuntimeSection({ heartbeats, runtimeBeats, agentSessions }) {
  const sessions = agentSessions?.sessions || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Runtime heartbeats from host connector */}
      {runtimeBeats.length > 0 && (
        <div className="glass-card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '12px' }}>
            Host Runtime Heartbeats
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {runtimeBeats.map(beat => (
              <div key={beat.agent} className="glass-card" style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span className="dot dot-green" />
                <div className="flex-1 min-w-0">
                  <div style={{ fontWeight: '600', fontSize: '14px' }}>{beat.agent}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{beat.runtime} · {beat.host}</div>
                </div>
                <span className="badge badge-success" style={{ fontSize: '10px' }}>Process verified</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent sessions from hub + D1 assignments + heartbeats */}
      <div className="glass-card" style={{ padding: '16px' }}>
        <div style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '12px' }}>
          Agent Sessions ({sessions.length})
        </div>
        {sessions.length === 0 ? (
          <div className="empty">No sessions registered</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {sessions.map(s => (
              <AgentSessionRow key={s.id} session={s} />
            ))}
          </div>
        )}
      </div>

      {/* Heartbeat status */}
      {Object.keys(heartbeats).length > 0 && (
        <div className="glass-card" style={{ padding: '16px' }}>
          <div style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '12px' }}>
            Hub Heartbeats
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {Object.entries(heartbeats)
              .filter(([k]) => !['grokbot', 'stackbot', 'peer-floor'].includes(k))
              .map(([agentId, hb]) => (
                <HeartbeatRow key={agentId} agentId={agentId} hb={hb} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentSessionRow({ session }) {
  const isVerified = session.verification === 'd1_host_runtime' || session.verification === 'assignment_registry';
  const hasAuth = !!session.last_authenticated_checkin_at;
  const hasExec = !!session.last_execution_verified_at;

  let badgeClass = 'badge-warning';
  let badgeLabel = 'Unverified';
  if (hasExec) { badgeClass = 'badge-success'; badgeLabel = 'Verified execution'; }
  else if (hasAuth) { badgeClass = 'badge-warning'; badgeLabel = 'Checked in'; }

  return (
    <div className="glass-card" style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
      <span className="dot" style={{ background: session.verification === 'd1_host_runtime' ? 'var(--success)' : session.verification === 'assignment_registry' ? 'var(--accent)' : 'var(--text-muted)' }} />
      <div className="flex-1 min-w-0">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: '600', fontSize: '14px', textTransform: 'capitalize' }}>{session.agent}</span>
          <span className={`badge ${badgeClass}`} style={{ fontSize: '10px' }}>{badgeLabel}</span>
          <span className="badge badge-accent" style={{ fontSize: '10px' }}>{session.verification}</span>
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
          {session.task_title || 'No task'} · {session.runtime || 'Unknown runtime'}
        </div>
      </div>
      {session.session_url && (
        <a href={session.session_url} target="_blank" rel="noopener" className="btn btn-secondary btn-sm">Open</a>
      )}
    </div>
  );
}

function HeartbeatRow({ agentId, hb }) {
  const reported = hb?.state || 'unknown';
  const ts = hb?.ts || hb?.updated_at;
  const ageMin = ts ? Math.round((Date.now() - new Date(ts).getTime()) / 60000) : null;
  const hasEvidence = hb?.evidence_path || hb?.task;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
      <span className="dot" style={{ background: reported === 'running' || reported === 'working' ? 'var(--success)' : reported === 'blocked' ? 'var(--danger)' : 'var(--warning)' }} />
      <div className="flex-1 min-w-0">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: '600', fontSize: '14px', textTransform: 'capitalize' }}>{agentId}</span>
          <span className="badge" style={{ background: reported === 'running' || reported === 'working' ? 'var(--success-soft)' : reported === 'blocked' ? 'var(--danger-soft)' : 'var(--warning-soft)', color: reported === 'running' || reported === 'working' ? 'var(--success)' : reported === 'blocked' ? 'var(--danger)' : 'var(--warning)' }}>
            {reported}
          </span>
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {hb?.task || hb?.evidence_path || 'No task'} · {ageMin !== null ? `${ageMin}m ago` : 'unknown'}
        </div>
      </div>
      {hasEvidence && <span className="badge badge-success" style={{ fontSize: '10px' }}>Evidence</span>}
    </div>
  );
}

function VoiceSection({ voiceEnabled, setVoiceEnabled, ttsVoice, setTtsVoice, sttEnabled, setSttEnabled }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div className="glass-card" style={{ padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: '600' }}>Voice Interface</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>OpenJarvis STT/TTS pipeline</div>
          </div>
          <label className="toggle" style={{ position: 'relative', width: '52px', height: '28px' }}>
            <input type="checkbox" checked={voiceEnabled} onChange={(e) => setVoiceEnabled(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
            <span className="toggle-slider" style={{ position: 'absolute', inset: 0, borderRadius: '999px', background: 'var(--line)', transition: '0.2s', cursor: 'pointer' }} />
          </label>
        </div>
      </div>

      {voiceEnabled && (
        <>
          <div className="glass-card" style={{ padding: '16px' }}>
            <div style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '12px' }}>
              TTS Voice
            </div>
            <select className="input" value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)} style={{ maxWidth: '240px' }}>
              <option value="sarah">Sarah (Premade, $0)</option>
              <option value="aura-2">Aura-2 (Workers AI, $0)</option>
              <option value="kokoro">Kokoro (Local, $0)</option>
              <option value="cartesia">Cartesia (API)</option>
              <option value="openai">OpenAI TTS (API)</option>
            </select>
          </div>

          <div className="glass-card" style={{ padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div>
                <div style={{ fontSize: '14px', fontWeight: '600' }}>Speech-to-Text</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>Whisper via Workers AI</div>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={sttEnabled} onChange={(e) => setSttEnabled(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="glass-card" style={{ padding: '16px' }}>
            <div style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '12px' }}>
              Test Voice
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={() => { console.log('TTS test'); }}>🔊 Test TTS</button>
              <button className="btn btn-secondary" onClick={() => { console.log('STT test'); }}>🎤 Test STT</button>
              <button className="btn btn-secondary" onClick={() => { navigator.clipboard.writeText(buildBriefText()); alert('Brief copied for voice call'); }}>📋 Copy Brief</button>
            </div>
          </div>
        </>
      )}
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

function HealthSection({ health, qcReceipts }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div className="glass-card" style={{ padding: '16px' }}>
        <div style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '12px' }}>
          Workforce Health
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className={`dot ${health?.status === 'healthy' ? 'dot-green' : health?.status === 'degraded' ? 'dot-red' : 'dot-amber'}`} />
              <span style={{ fontWeight: '600' }}>Overall</span>
            </div>
            <span className={`badge ${health?.status === 'healthy' ? 'badge-success' : health?.status === 'degraded' ? 'badge-danger' : 'badge-warning'}`}>
              {health?.status || 'unknown'}
            </span>
          </div>
          {health?.alerts?.map((alert, i) => (
            <div key={i} style={{ padding: '12px', background: alert.severity === 'red' ? 'rgba(248,113,113,0.15)' : 'rgba(251,191,36,0.15)', borderRadius: '8px', border: `1px solid ${alert.severity === 'red' ? 'rgba(248,113,113,0.3)' : 'rgba(251,191,36,0.3)'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <span className={`dot ${alert.severity === 'red' ? 'dot-red' : 'dot-amber'}`} />
                <strong>{alert.agent}</strong>
                <span className={`badge ${alert.severity === 'red' ? 'badge-danger' : 'badge-warning'}`}>{alert.severity}</span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>{alert.issue}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>Recovery: {alert.recovery}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function QCSection({ qcReceipts }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div className="glass-card" style={{ padding: '16px' }}>
        <div style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '12px' }}>
          QC Receipts ({qcReceipts?.length || 0})
        </div>
        {qcReceipts?.length === 0 ? (
          <div className="empty">No QC receipts yet</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {qcReceipts.slice(-10).map((r, i) => (
              <div key={i} className="glass-card" style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: '600', fontSize: '13px' }}>{r.builder} → {r.reviewer}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{r.commit_sha?.slice(0, 8)} · {r.checks_passed ? 'Passed' : 'Failed'}</div>
                </div>
                <span className={`badge ${r.checks_passed ? 'badge-success' : 'badge-danger'}`} style={{ fontSize: '10px' }}>
                  {r.checks_passed ? 'Verified' : 'Failed'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}