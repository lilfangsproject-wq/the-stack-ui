import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ============================================================================
// The Stack Mobile - Unified State Store
// Combines: Agent HQ patterns + LangGraph state + OpenHands runtime state
// ============================================================================

// Agent definitions (from existing Stack)
const DEFAULT_AGENTS = [
  { id: 'gemini', name: 'Gemini', role: 'Research & Verification', model: 'Gemini 2.5', color: '#4285F4', reset: '~4 hours', order: 1 },
  { id: 'cursor', name: 'Cursor', role: 'Engineering & PRs', model: 'Claude 3.5', color: '#000', colorText: '#fff', reset: 'Daily', order: 2 },
  { id: 'claude', name: 'Claude', role: 'Architecture & Deep Work', model: 'Opus 4.1', color: '#D97706', reset: '~4 hours', order: 3 },
  { id: 'chatgpt', name: 'ChatGPT', role: 'Ideation & Checks', model: 'GPT-4o', color: '#10A37F', reset: 'Daily', order: 4 },
  { id: 'nori', name: 'Nori', role: 'Trends & Ops', model: 'Grok', color: '#6366F1', reset: 'Daily', order: 5 },
  { id: 'grokbot', name: 'Grokbot', role: 'Stack Challenger', model: 'Grok', color: '#9CA3AF', reset: 'Daily', order: 6, retired: true }
];

// Workflow definitions (Agent HQ pattern)
const DEFAULT_WORKFLOWS = {
  dev: {
    name: 'Development',
    statuses: ['backlog', 'ready', 'in_progress', 'review', 'verified', 'done'],
    transitions: {
      start: { from: 'ready', to: 'in_progress', protected: false },
      submit_review: { from: 'in_progress', to: 'review', protected: true },
      approve: { from: 'review', to: 'verified', protected: true },
      complete: { from: 'verified', to: 'done', protected: false },
      rework: { from: 'review', to: 'in_progress', protected: false }
    },
    evidenceGates: {
      submit_review: ['commit_sha', 'branch_url', 'test_receipt'],
      approve: ['review_url'],
      complete: ['deploy_url', 'live_check']
    },
    routingRules: [
      { taskType: 'code', status: 'ready', agentId: 'cursor', priority: 1 },
      { taskType: 'review', status: 'review', agentId: 'claude', priority: 1 },
      { taskType: 'architecture', status: 'ready', agentId: 'claude', priority: 1 },
      { taskType: 'research', status: 'ready', agentId: 'gemini', priority: 1 }
    ]
  }
};

// Evidence field definitions
const EVIDENCE_FIELDS = {
  commit_sha: { label: 'Commit SHA', required: true, severity: 'block' },
  branch_url: { label: 'Branch URL', required: true, severity: 'block' },
  test_receipt: { label: 'Test Receipt', required: true, severity: 'block' },
  review_url: { label: 'Review URL', required: true, severity: 'block' },
  deploy_url: { label: 'Deploy URL', required: true, severity: 'block' },
  live_check: { label: 'Live Check', required: true, severity: 'block' },
  session_id: { label: 'Session ID', required: false, severity: 'warn' }
};

const generateId = (prefix = 'id') => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const now = () => new Date().toISOString();

export const useStore = create(
  persist(
    (set, get) => ({
      // ===== UI State =====
      activeTab: 'today',
      view: 'today',
      sidebarOpen: false,
      sheetOpen: null,
      toastQueue: [],

      // ===== Auth & Config =====
      pin: '',
      bffUrl: '',
      githubPat: '',
      githubRepo: 'lilfangsproject-wq/ai-workspace',
      githubBranch: 'main',
      hubPrefix: 'Projects/The-Stack/hub',
      zeroSpendCap: 0,
      online: false,
      syncing: false,

      // ===== Agents (LangGraph node style) =====
      agents: DEFAULT_AGENTS.map(a => ({
        ...a,
        status: 'unknown',
        usagePct: 0,
        hasLiveUsage: false,
        usageObservedAt: null,
        activitySummary: '',
        lastSeen: null,
        activity24h: 0,
        lastCallAt: null,
        reset: a.reset,
        session: null
      })),

      // ===== Workflows (Agent HQ config as SoT) =====
      workflows: DEFAULT_WORKFLOWS,

      // ===== Workstreams / Tasks (LangGraph graph state) =====
      workstreams: [],
      workstreamLinks: {},
      opportunities: [],

      // ===== Assignments (crewAI task→agent) =====
      assignments: [],

      // ===== Runs (OpenHands runtime state) =====
      runs: new Map(), // instanceId -> RunInstance

      // ===== Communication =====
      channels: [],
      messagesBySlug: {},
      activeChannel: 'peer-floor',
      notifications: [],
      outbox: [],

      // ===== Health & Monitoring =====
      heartbeats: {},
      peerPresence: [],
      runtimeBeats: [],
      qcReceipts: [],
      health: null,
      needsSeth: [],

      // ===== Memory =====
      sharedMemory: { entries: [] },

      // ===== Voice (OpenJarvis) =====
      voiceCall: null,
      voiceEnabled: false,
      ttsVoice: 'sarah',
      sttEnabled: false,

      // ===== Actions =====
      setActiveTab: (tab) => set({ activeTab: tab, view: tab }),

      setPin: (pin) => set({ pin }),

      addToast: (message, type = 'info') => {
        const id = generateId('toast');
        set((state) => ({
          toastQueue: [...state.toastQueue, { id, message, type, at: now() }]
        }));
        setTimeout(() => {
          set((state) => ({
            toastQueue: state.toastQueue.filter((t) => t.id !== id)
          }));
        }, 4000);
      },

      removeToast: (id) => set((state) => ({
        toastQueue: state.toastQueue.filter((t) => t.id !== id)
      })),

      // Agent management
      updateAgent: (id, updates) => set((state) => ({
        agents: state.agents.map((a) => a.id === id ? { ...a, ...updates } : a)
      })),

      setAgentSession: (agentId, session) => set((state) => ({
        agents: state.agents.map((a) => a.id === agentId ? { ...a, session } : a)
      })),

      // Workstream management (LangGraph node operations)
      addWorkstream: (ws) => set((state) => ({
        workstreams: [...state.workstreams, { ...ws, id: ws.id || generateId('ws'), createdAt: now(), updatedAt: now() }]
      })),

      updateWorkstream: (id, updates) => set((state) => ({
        workstreams: state.workstreams.map((w) => w.id === id ? { ...w, ...updates, updatedAt: now() } : w)
      })),

      removeWorkstream: (id) => set((state) => ({
        workstreams: state.workstreams.filter((w) => w.id !== id)
      })),

      // Assignment management (crewAI task→agent)
      addAssignment: (assignment) => set((state) => ({
        assignments: [...state.assignments, { ...assignment, id: assignment.id || generateId('asg'), createdAt: now(), updatedAt: now() }]
      })),

      updateAssignment: (id, updates) => set((state) => ({
        assignments: state.assignments.map((a) => a.id === id ? { ...a, ...updates, updatedAt: now() } : a)
      })),

      // Run management (OpenHands runtime)
      addRun: (run) => set((state) => {
        const runs = new Map(state.runs);
        runs.set(run.instanceId, run);
        return { runs };
      }),

      updateRun: (instanceId, updates) => set((state) => {
        const runs = new Map(state.runs);
        const run = runs.get(instanceId);
        if (run) {
          runs.set(instanceId, { ...run, ...updates });
        }
        return { runs };
      }),

      removeRun: (instanceId) => set((state) => {
        const runs = new Map(state.runs);
        runs.delete(instanceId);
        return { runs };
      }),

      getRun: (instanceId) => get().runs.get(instanceId),

      getStaleRuns: (maxAgeMs = 5 * 60 * 1000) => {
        const runs = Array.from(get().runs.values());
        const nowMs = Date.now();
        return runs.filter((run) => nowMs - new Date(run.lastHeartbeatAt).getTime() > maxAgeMs);
      },

      // Reconciler (Agent HQ) - find eligible work
      getEligibleAssignments: () => {
        const { assignments, workflows, runs } = get();
        const activeRunIds = new Set(Array.from(runs.values()).filter(r => r.status !== 'completed' && r.status !== 'failed').map(r => r.instanceId));

        return assignments.filter((a) => {
          // Has routing rule
          const workflow = workflows[a.workflow] || workflows.dev;
          const rule = workflow.routingRules?.find((r) =>
            r.taskType === a.taskType &&
            r.status === a.status &&
            (r.agentId === a.agentId || !r.agentId)
          );
          if (!rule) return false;

          // No active run
          if (a.activeRun && activeRunIds.has(a.activeRun.instanceId)) return false;

          // Lease check
          if (a.leaseUntil && new Date(a.leaseUntil) > new Date()) return false;

          return true;
        });
      },

      // Build Task Contract (Agent HQ)
      buildTaskContract: (assignment, agent) => {
        const workflow = get().workflows[assignment.workflow] || get().workflows.dev;
        const outcomes = {};
        const evidenceGates = [];

        for (const [outcome, config] of Object.entries(workflow.transitions || {})) {
          outcomes[outcome] = { toStatus: config.toStatus, protected: config.protected };
        }
        for (const gate of workflow.evidenceGates?.[assignment.taskType] || []) {
          evidenceGates.push({ field: gate, ...EVIDENCE_FIELDS[gate] });
        }

        return {
          taskId: assignment.id,
          instanceId: generateId('inst'),
          durableRunId: generateId('run'),
          sessionKey: generateId('sess'),
          agentSlug: agent.id,
          workflow: assignment.workflow || 'dev',
          taskType: assignment.taskType || 'code',
          status: assignment.status,
          outcomes,
          evidenceGates,
          routing: { agentId: agent.id, runtime: agent.runtime || 'webhook' },
          evidence: {},
          createdAt: now()
        };
      },

      // Evidence Gate Validation (Agent HQ)
      validateEvidenceGates: (contract, outcome) => {
        const gates = contract.evidenceGates.filter((g) => g.outcome === outcome || !g.outcome);
        const results = { blocked: [], warnings: [], passed: [] };

        for (const gate of gates) {
          const value = contract.evidence[gate.field];
          const passed = value !== undefined && value !== null && value !== '';
          if (passed) {
            results.passed.push(gate.field);
          } else if (gate.severity === 'block') {
            results.blocked.push({ field: gate.field, message: gate.message || `Missing required evidence: ${gate.field}` });
          } else {
            results.warnings.push({ field: gate.field, message: gate.message || `Recommended evidence missing: ${gate.field}` });
          }
        }
        return results;
      },

      // Attention Queue (AI Maestro Attention View)
      getAttentionItems: () => {
        const { assignments, runs, heartbeats, needsSeth, workstreams } = get();
        const items = [];

        // Stale runs
        for (const run of Array.from(runs.values())) {
          if (run.isStale && run.isStale()) {
            items.push({
              id: `stale-${run.instanceId}`,
              type: 'stale_run',
              title: `Stale run: ${run.taskId}`,
              detail: `No heartbeat for ${Math.round((Date.now() - new Date(run.lastHeartbeatAt).getTime()) / 60000)} min`,
              severity: 'danger',
              agent: run.agentSlug,
              action: 'Re-dispatch',
              ref: run.instanceId
            });
          }
        }

        // Blocked assignments
        for (const a of assignments) {
          if (a.blockedReason) {
            items.push({
              id: `blocked-${a.id}`,
              type: 'blocked_assignment',
              title: `Blocked: ${a.title}`,
              detail: a.blockedReason,
              severity: 'danger',
              agent: a.agentId,
              action: 'Provide evidence',
              ref: a.id
            });
          }
        }

        // Needs Seth
        for (const n of needsSeth) {
          items.push({
            id: `need-${n.id}`,
            type: 'needs_seth',
            title: `Decision: ${n.title}`,
            detail: n.detail || n.action || 'Seth input required',
            severity: 'warning',
            agent: 'Seth',
            action: 'Decide',
            ref: n.id
          });
        }

        // Idle agents (checked in but no execution)
        for (const [agent, hb] of Object.entries(heartbeats)) {
          if (hb.last_authenticated_checkin_at && !hb.last_execution_verified_at) {
            const ageMin = Math.round((Date.now() - new Date(hb.last_authenticated_checkin_at).getTime()) / 60000);
            if (ageMin > 60) {
              items.push({
                id: `idle-${agent}`,
                type: 'idle_agent',
                title: `${agent} idle`,
                detail: `Checked in ${ageMin} min ago · no execution`,
                severity: 'warning',
                agent,
                action: 'Investigate',
                ref: agent
              });
            }
          }
        }

        // Blocked workstreams
        for (const w of workstreams) {
          if (w.blockedReason || w.state?.key === 'blocked') {
            items.push({
              id: `blocked-ws-${w.id}`,
              type: 'blocked_work',
              title: `Blocked: ${w.title}`,
              detail: w.blockedReason || 'Missing evidence',
              severity: 'danger',
              agent: w.ownerId,
              action: 'Provide evidence',
              ref: w.id
            });
          }
        }

        const sevOrder = { danger: 0, warning: 1, success: 2, info: 3 };
        return items.sort((a, b) => (sevOrder[a.severity] || 99) - (sevOrder[b.severity] || 99));
      },

      // Mobile 4 Questions (Open Mission Control)
      getMobileQuestions: () => {
        const items = get().getAttentionItems();
        return {
          needsAttention: items.filter(i => i.severity === 'danger').length,
          whoIsWorking: items.filter(i => i.type === 'idle_agent' || i.type === 'stale_run').length,
          whoCheckedProof: items.filter(i => i.type === 'blocked_assignment' || i.type === 'blocked_work').length,
          whatHappened: items.filter(i => i.type === 'needs_seth').length
        };
      },

      // Hydrate from /api/sync
      hydrateFromSync: (data) => set({
        headCommit: data.head_commit,
        commits: data.commits,
        workstreams: data.workstreams?.workstreams || [],
        workstreamLinks: data.workstreams?.links || {},
        opportunities: data.workstreams?.opportunities || [],
        needsSeth: data.needs_seth?.items?.filter(i => i && !i.resolved) || [],
        usage: data.usage,
        heartbeats: data.heartbeats?.agents || {},
        agentSessions: hydrateAgentSessions(data.agent_sessions, data.peer_presence, data.heartbeats?.agents || {}, data.runtimeBeats),
        peerPresence: data.peer_presence,
        qcReceipts: data.qc_receipts,
        commits: data.commits,
        online: true,
        lastSyncIso: new Date().toISOString()
      }),

      // Voice actions
      setVoiceCall: (call) => set({ voiceCall: call }),

      setVoiceEnabled: (enabled) => set({ voiceEnabled: enabled }),

      // Outbox
      addToOutbox: (item) => set((state) => ({ outbox: [...state.outbox, item] })),
      clearOutbox: () => set({ outbox: [] }),

      // Notifications
      addNotification: (notif) => set((state) => ({
        notifications: [{ ...notif, id: generateId('notif'), at: now(), unread: true }, ...state.notifications].slice(0, 100)
      })),

      markAllRead: () => set((state) => ({
        notifications: state.notifications.map(n => ({ ...n, unread: false }))
      })),
    }),
    {
      name: 'the-stack-mobile-v51',
      partialize: (state) => ({
        pin: state.pin,
        bffUrl: state.bffUrl,
        githubPat: state.githubPat,
        githubRepo: state.githubRepo,
        githubBranch: state.githubBranch,
        activeTab: state.activeTab,
        voiceEnabled: state.voiceEnabled,
        ttsVoice: state.ttsVoice,
        sttEnabled: state.sttEnabled
      })
    }
  )
);

// Helper: hydrate agent sessions (from existing Stack logic)
function hydrateAgentSessions(hubSessions, peerPresence, heartbeats, runtimeBeats) {
  const base = hubSessions && typeof hubSessions === 'object' ? hubSessions : { version: 1, sessions: [] };
  const registry = Array.isArray(base.sessions) ? base.sessions : [];
  let sessions = registry.filter((s) => s && typeof s.agent === 'string').map((s) => ({
    ...s,
    agent: s.agent.toLowerCase(),
    verification: 'operator_registry',
    last_authenticated_checkin_at: null,
    last_execution_verified_at: null
  }));

  // Peer presence (assignment check-ins)
  for (const peer of peerPresence || []) {
    if (!peer || !peer.id) continue;
    const id = String(peer.id).toLowerCase();
    const sessionId = peer.configured && peer.session_id;
    const checkedInAt = sessionId ? peer.checked_in_at : null;
    let session = sessions.find((s) => s.agent === id && sessionId && s.session_id === sessionId);
    if (!session) {
      if (!checkedInAt && sessions.some((s) => s.agent === id)) continue;
      session = {
        id: `presence-${id}`,
        agent: id,
        runtime: 'Assignment peer session',
        host: 'unknown',
        state: 'unknown',
        reported_state: 'unknown',
        verification: 'assignment_registry',
        task_title: 'Teammate presence',
        session_id: sessionId || null,
        session_url: null,
        session_url_note: peer.configured ? 'Open agent runtime on device (no web deep-link)' : 'Needs setup key in Assignments',
        last_authenticated_checkin_at: null,
        last_execution_verified_at: null
      };
      sessions.push(session);
    }
    if (checkedInAt) {
      session.last_authenticated_checkin_at = checkedInAt;
      session.verification = 'd1_checkin';
    }
  }

  // Heartbeats
  const hbAgents = heartbeats || {};
  const reportedStates = { working: 'running', running: 'running', waiting: 'waiting_prompt', waiting_prompt: 'waiting_prompt', blocked: 'blocked', offline: 'offline', paused_quota: 'paused_quota' };
  for (const [agentId, hb] of Object.entries(hbAgents)) {
    const id = agentId.toLowerCase();
    if (!id || ['grokbot', 'stackbot', 'peer-floor'].includes(id)) continue;
    const ts = hb?.ts || hb?.updated_at;
    if (!ts) continue;
    const agentSessions = sessions.filter((s) => s.agent === id);
    let session = hb.session_id && agentSessions.find((s) => s.session_id === hb.session_id);
    const observedAt = Date.parse(ts);
    if (candidates.some((s) => [s.last_reported_at, s.last_implementation_evidence_at, s.last_authenticated_checkin_at].some((prior) => Date.parse(prior) >= observedAt))) continue;
    const declared = String(hb.state || '').toLowerCase();
    if (!session) {
      session = {
        id: `heartbeat-${id}`,
        agent: id,
        runtime: 'Hub heartbeat',
        host: 'unknown',
        state: 'unknown',
        reported_state: 'unknown',
        verification: 'hub_heartbeat',
        session_id: hb.session_id || null,
        task_title: 'Heartbeat',
        last_authenticated_checkin_at: null,
        last_execution_verified_at: null
      };
      sessions.push(session);
    }
    session.reported_state = reportedStates[declared] || 'unknown';
    session.last_reported_at = ts;
    session.task_title = hb.task || hb.evidence_path || session.task_title;
    session.evidence_path = hb.evidence_path || null;
  }

  // Runtime beats (host connector)
  for (const beat of Array.isArray(runtimeBeats) ? runtimeBeats : []) {
    if (!beat || !beat.agent) continue;
    const id = String(beat.agent).toLowerCase();
    const iso = beat.observed_at;
    if (!iso) continue;
    sessions.push({
      id: `host-${id}`,
      agent: id,
      runtime: beat.runtime || 'Host runtime',
      host: beat.host || 'host',
      state: 'unknown',
      reported_state: String(beat.reported_state || 'unknown').toLowerCase(),
      verification: 'd1_host_runtime',
      task_title: beat.task_title || 'Connected host',
      session_id: beat.session_id || null,
      session_url: null,
      session_url_note: 'Open this teammate on the connected host.',
      last_reported_at: iso,
      last_authenticated_checkin_at: null,
      last_execution_verified_at: null
    });
  }

  return { version: base.version || 1, updated_at: now(), sessions };
}