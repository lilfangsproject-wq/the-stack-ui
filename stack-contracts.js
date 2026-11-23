/**
 * The Stack — Task Contracts & Evidence Gates (Zero-Spend, No Postgres)
 * In-memory types and validation adapted from Agent HQ patterns.
 * Works with D1 assignments + Git-backed hub state.
 */

// ============================================================================
// TASK CONTRACT (injected at dispatch, lives for run duration)
// ============================================================================
class TaskContract {
  constructor({ taskId, instanceId, durableRunId, sessionKey, agentSlug, workflow, taskType, status, outcomes, evidenceGates, routing }) {
    this.taskId = taskId;
    this.instanceId = instanceId;
    this.durableRunId = durableRunId;
    this.sessionKey = sessionKey;
    this.agentSlug = agentSlug;
    this.workflow = workflow;
    this.taskType = taskType;
    this.status = status;
    this.outcomes = outcomes;           // { outcome: { toStatus, isProtected } }
    this.evidenceGates = evidenceGates; // [{ field, requirementType, matchField, severity, message }]
    this.routing = routing;             // { agentId, runtime }
    this.createdAt = new Date().toISOString();
    this.evidence = {};                 // populated during run
  }

  // Check if an outcome is valid from current status
  canTransition(outcome) {
    return !!this.outcomes[outcome];
  }

  // Get target status for an outcome
  getTargetStatus(outcome) {
    return this.outcomes[outcome]?.toStatus;
  }

  // Validate evidence gates for an outcome
  validateGates(outcome) {
    const gates = this.evidenceGates.filter(g => g.outcome === outcome);
    const results = { blocked: [], warnings: [], passed: [] };
    for (const gate of gates) {
      const value = this.evidence[gate.field];
      const passed = this.checkGate(gate, value);
      if (passed) {
        results.passed.push(gate.field);
      } else if (gate.severity === 'block') {
        results.blocked.push({ field: gate.field, message: gate.message || `Missing required evidence: ${gate.field}` });
      } else {
        results.warnings.push({ field: gate.field, message: gate.message || `Recommended evidence missing: ${gate.field}` });
      }
    }
    return results;
  }

  checkGate(gate, value) {
    if (gate.requirementType === 'required') {
      return value !== undefined && value !== null && value !== '';
    }
    if (gate.requirementType === 'match') {
      return value === gate.matchField;
    }
    if (gate.requirementType === 'from_status') {
      return this.status === gate.matchField;
    }
    return true;
  }

  // Record evidence during run
  recordEvidence(field, value) {
    this.evidence[field] = value;
    this.evidence[field + '_at'] = new Date().toISOString();
  }

  // Serialize for persistence (D1, Git, memory)
  toJSON() {
    return {
      taskId: this.taskId,
      instanceId: this.instanceId,
      durableRunId: this.durableRunId,
      sessionKey: this.sessionKey,
      agentSlug: this.agentSlug,
      workflow: this.workflow,
      taskType: this.taskType,
      status: this.status,
      outcomes: this.outcomes,
      evidenceGates: this.evidenceGates,
      routing: this.routing,
      evidence: this.evidence,
      createdAt: this.createdAt,
    };
  }

  static fromJSON(json) {
    const c = new TaskContract(json);
    c.evidence = json.evidence || {};
    return c;
  }
}

// ============================================================================
// EVIDENCE GATE TYPES (adapted from Agent HQ workflow_task_transition_requirements)
// ============================================================================
const EVIDENCE_GATE_TYPES = {
  required: 'required',    // must have value
  match: 'match',          // must equal matchField
  from_status: 'from_status' // must be in specific status
};

const GATE_SEVERITY = {
  block: 'block',  // blocks transition
  warn: 'warn'     // warning only
};

// Common evidence fields used across The Stack
const STANDARD_EVIDENCE_FIELDS = {
  commit_sha: { type: 'required', severity: 'block', message: 'Commit SHA required for code changes' },
  branch_url: { type: 'required', severity: 'block', message: 'Branch URL required for review' },
  test_receipt: { type: 'required', severity: 'block', message: 'Test receipt (command output, CI run URL) required' },
  review_url: { type: 'required', severity: 'block', message: 'Review URL required for review outcome' },
  deploy_url: { type: 'required', severity: 'block', message: 'Deploy URL required for release outcome' },
  live_check: { type: 'required', severity: 'block', message: 'Live target verification required' },
  implementation_evidence: { type: 'required', severity: 'block', message: 'Implementation evidence required' },
  session_id: { type: 'required', severity: 'warn', message: 'Session ID recommended for traceability' },
  assignment_id: { type: 'required', severity: 'warn', message: 'Assignment ID recommended' },
};

// ============================================================================
// RUN INSTANCE (in-memory, no Postgres)
// ============================================================================
class RunInstance {
  constructor({ instanceId, durableRunId, taskId, agentSlug, contract, status = 'dispatched' }) {
    this.instanceId = instanceId;
    this.durableRunId = durableRunId;
    this.taskId = taskId;
    this.agentSlug = agentSlug;
    this.contract = contract;
    this.status = status; // dispatched, running, completed, failed, stale
    this.startedAt = new Date().toISOString();
    this.lastHeartbeatAt = this.startedAt;
    this.checkins = [];
    this.outcome = null;
  }

  recordCheckin({ stage, summary, meaningfulOutput }) {
    this.checkins.push({
      stage,
      summary,
      meaningfulOutput,
      at: new Date().toISOString()
    });
    this.lastHeartbeatAt = new Date().toISOString();
  }

  recordOutcome(outcome, summary, evidence) {
    this.outcome = { outcome, summary, evidence, at: new Date().toISOString() };
    this.status = 'completed';
  }

  markStale() {
    this.status = 'stale';
  }

  isStale(maxAgeMs = 5 * 60 * 1000) { // 5 minutes default
    return Date.now() - new Date(this.lastHeartbeatAt).getTime() > maxAgeMs;
  }

  toJSON() {
    return {
      instanceId: this.instanceId,
      durableRunId: this.durableRunId,
      taskId: this.taskId,
      agentSlug: this.agentSlug,
      contract: this.contract?.toJSON?.() || this.contract,
      status: this.status,
      startedAt: this.startedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      checkins: this.checkins,
      outcome: this.outcome
    };
  }
}

// ============================================================================
// RECONCILER (finds eligible work)
// ============================================================================
class Reconciler {
  constructor({ assignments, workflows, heartbeats }) {
    this.assignments = assignments || [];
    this.workflows = workflows || {};
    this.heartbeats = heartbeats || {};
  }

  // Find assignments eligible for dispatch
  findEligible() {
    const eligible = [];
    for (const assignment of this.assignments) {
      if (this.isEligible(assignment)) {
        eligible.push(assignment);
      }
    }
    return eligible;
  }

  isEligible(assignment) {
    // Must be in a status that has routing rules
    const workflow = this.workflows[assignment.workflow];
    if (!workflow) return false;

    const routingRules = workflow.routingRules || [];
    const rule = routingRules.find(r =>
      r.taskType === assignment.taskType &&
      r.status === assignment.status &&
      (r.agentId === assignment.agentId || !r.agentId)
    );
    if (!rule) return false;

    // Must not have active run
    if (assignment.activeRun && !this.isRunStale(assignment.activeRun)) {
      return false;
    }

    // Check lease/fencing (Trigger.dev pattern)
    if (assignment.leaseUntil && new Date(assignment.leaseUntil) > new Date()) {
      return false;
    }

    return true;
  }

  isRunStale(run) {
    if (!run.lastHeartbeatAt) return true;
    return Date.now() - new Date(run.lastHeartbeatAt).getTime() > 5 * 60 * 1000;
  }

  // Build task contract for dispatch
  buildContract(assignment, agent) {
    const workflow = this.workflows[assignment.workflow];
    const outcomes = {};
    const evidenceGates = [];

    if (workflow) {
      for (const [outcome, config] of Object.entries(workflow.transitions || {})) {
        outcomes[outcome] = { toStatus: config.toStatus, isProtected: config.isProtected };
      }
      for (const gate of workflow.evidenceGates || []) {
        if (gate.taskType === assignment.taskType && gate.outcome) {
          evidenceGates.push(gate);
        }
      }
    }

    return new TaskContract({
      taskId: assignment.id,
      instanceId: `inst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      durableRunId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionKey: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentSlug: agent.id,
      workflow: assignment.workflow,
      taskType: assignment.taskType,
      status: assignment.status,
      outcomes,
      evidenceGates,
      routing: { agentId: agent.id, runtime: agent.runtime }
    });
  }
}

// ============================================================================
// DISPATCHER (resolves route, launches run)
// ============================================================================
class Dispatcher {
  constructor({ bff, reconciler }) {
    this.bff = bff;
    this.reconciler = reconciler;
    this.activeRuns = new Map(); // instanceId -> RunInstance
  }

  async dispatch(assignment, agent) {
    const contract = this.reconciler.buildContract(assignment, agent);
    const instance = new RunInstance({
      instanceId: contract.instanceId,
      durableRunId: contract.durableRunId,
      taskId: contract.taskId,
      agentSlug: contract.agentSlug,
      contract
    });

    this.activeRuns.set(instance.instanceId, instance);

    // Build dispatch payload for runtime
    const payload = {
      instanceId: instance.instanceId,
      durableRunId: instance.durableRunId,
      sessionKey: contract.sessionKey,
      taskId: contract.taskId,
      agentSlug: contract.agentSlug,
      contract: contract.toJSON(),
      bffUrl: this.bff.baseUrl,
      bffHeaders: { 'x-stack-pin': this.bff.pin }
    };

    // Dispatch based on runtime
    switch (agent.runtime) {
      case 'openclaw':
        return this.dispatchOpenClaw(agent, payload);
      case 'claude-code':
        return this.dispatchClaudeCode(agent, payload);
      case 'codex':
        return this.dispatchCodex(agent, payload);
      case 'hermes':
        return this.dispatchHermes(agent, payload);
      case 'webhook':
        return this.dispatchWebhook(agent, payload);
      default:
        throw new Error(`Unknown runtime: ${agent.runtime}`);
    }
  }

  async dispatchOpenClaw(agent, payload) {
    // OpenClaw gateway session dispatch
    // Returns { success, sessionId, message }
    return { success: true, runtime: 'openclaw', payload };
  }

  async dispatchClaudeCode(agent, payload) {
    // Claude Code CLI dispatch via local process
    return { success: true, runtime: 'claude-code', payload };
  }

  async dispatchCodex(agent, payload) {
    return { success: true, runtime: 'codex', payload };
  }

  async dispatchHermes(agent, payload) {
    return { success: true, runtime: 'hermes', payload };
  }

  async dispatchWebhook(agent, payload) {
    const webhookUrl = agent.webhookUrl;
    if (!webhookUrl) throw new Error('Webhook URL not configured');
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return { success: res.ok, runtime: 'webhook', status: res.status };
  }

  getRun(instanceId) {
    return this.activeRuns.get(instanceId);
  }

  removeRun(instanceId) {
    this.activeRuns.delete(instanceId);
  }

  getStaleRuns(maxAgeMs = 5 * 60 * 1000) {
    const stale = [];
    for (const [id, run] of this.activeRuns) {
      if (run.isStale(maxAgeMs)) stale.push(run);
    }
    return stale;
  }
}

// ============================================================================
// WATCHDOG (stale-run recovery)
// ============================================================================
class Watchdog {
  constructor({ dispatcher, bff, assignments }) {
    this.dispatcher = dispatcher;
    this.bff = bff;
    this.assignments = assignments;
  }

  async checkAndRecover() {
    const staleRuns = this.dispatcher.getStaleRuns();
    const recovered = [];

    for (const run of staleRuns) {
      const assignment = this.assignments.find(a => a.id === run.taskId);
      if (!assignment) continue;

      // Recovery options based on run state
      if (run.status === 'dispatched') {
        // Never started - re-dispatch
        await this.recoverDispatch(assignment, run);
        recovered.push({ instanceId: run.instanceId, action: 're-dispatched' });
      } else if (run.status === 'running') {
        // Was running but went stale - request check-in
        await this.requestCheckin(run);
        recovered.push({ instanceId: run.instanceId, action: 'checkin_requested' });
      } else if (run.status === 'failed') {
        // Failed - check retry ceiling
        await this.handleFailedRun(assignment, run);
        recovered.push({ instanceId: run.instanceId, action: 'failed_handled' });
      }

      run.markStale();
    }

    return recovered;
  }

  async recoverDispatch(assignment, staleRun) {
    // Re-dispatch with new instance but same durable run ID
    const agent = this.findAgent(assignment.agentId);
    if (agent) {
      await this.dispatcher.dispatch(assignment, agent);
    }
  }

  async requestCheckin(run) {
    // Send check-in request via BFF to agent
    await this.bff.post('/api/agent/checkin', {
      instanceId: run.instanceId,
      durableRunId: run.durableRunId,
      action: 'checkin_required',
      message: 'Run appears stale. Please check in or outcome will be marked failed.'
    });
  }

  async handleFailedRun(assignment, run) {
    const attempt = (run.checkins.length || 0) + 1;
    const maxAttempts = 3;

    if (attempt <= maxAttempts) {
      // Re-dispatch with attempt tracking
      const agent = this.findAgent(assignment.agentId);
      if (agent) {
        await this.dispatcher.dispatch(assignment, agent);
      }
    } else {
      // Exceeded ceiling - mark task failed
      await this.bff.patch(`/api/assignments/${assignment.id}`, {
        status: 'failed',
        failureReason: `Exceeded ${maxAttempts} retry ceiling`
      });
    }
  }

  findAgent(agentId) {
    // Would look up from agent registry
    return null;
  }
}

// ============================================================================
// WORKFLOW CONFIG (in-memory, mirrors Agent HQ schema)
// ============================================================================
const DEFAULT_WORKFLOWS = {
  dev: {
    name: 'Development Workflow',
    statuses: ['backlog', 'ready', 'in_progress', 'review', 'verified', 'done'],
    transitions: {
      start: { from: 'ready', to: 'in_progress', isProtected: false },
      submit_review: { from: 'in_progress', to: 'review', isProtected: true },
      approve: { from: 'review', to: 'verified', isProtected: true },
      complete: { from: 'verified', to: 'done', isProtected: false },
      rework: { from: 'review', to: 'in_progress', isProtected: false }
    },
    evidenceGates: [
      { taskType: 'code', outcome: 'submit_review', field: 'commit_sha', requirementType: 'required', severity: 'block' },
      { taskType: 'code', outcome: 'submit_review', field: 'branch_url', requirementType: 'required', severity: 'block' },
      { taskType: 'code', outcome: 'submit_review', field: 'test_receipt', requirementType: 'required', severity: 'block' },
      { taskType: 'code', outcome: 'approve', field: 'review_url', requirementType: 'required', severity: 'block' },
      { taskType: 'code', outcome: 'complete', field: 'deploy_url', requirementType: 'required', severity: 'block' },
      { taskType: 'code', outcome: 'complete', field: 'live_check', requirementType: 'required', severity: 'block' }
    ],
    routingRules: [
      { taskType: 'code', status: 'ready', agentId: 'cursor', priority: 1 },
      { taskType: 'review', status: 'review', agentId: 'claude', priority: 1 },
      { taskType: 'architecture', status: 'ready', agentId: 'claude', priority: 1 },
      { taskType: 'research', status: 'ready', agentId: 'gemini', priority: 1 }
    ]
  }
};

// ============================================================================
// ATTENTION QUEUE (sticky "Needs Attention" - AI Maestro pattern)
// ============================================================================
class AttentionQueue {
  constructor({ assignments, runs, heartbeats, needsSeth }) {
    this.assignments = assignments || [];
    this.runs = runs || [];
    this.heartbeats = heartbeats || {};
    this.needsSeth = needsSeth || [];
  }

  getItems() {
    const items = [];

    // 1. Stale runs (Watchdog)
    for (const run of this.runs) {
      if (run.isStale && run.isStale()) {
        items.push({
          id: `stale-${run.instanceId}`,
          type: 'stale_run',
          title: `Stale run: ${run.taskId}`,
          detail: `No heartbeat for ${Math.round((Date.now() - new Date(run.lastHeartbeatAt).getTime()) / 60000)} min`,
          severity: 'red',
          agent: run.agentSlug,
          action: 'Re-dispatch or mark failed',
          ref: run.instanceId
        });
      }
    }

    // 2. Blocked assignments (evidence gates failed)
    for (const assignment of this.assignments) {
      if (assignment.blockedReason) {
        items.push({
          id: `blocked-${assignment.id}`,
          type: 'blocked_assignment',
          title: `Blocked: ${assignment.title}`,
          detail: assignment.blockedReason,
          severity: 'red',
          agent: assignment.agentId,
          action: 'Provide missing evidence',
          ref: assignment.id
        });
      }
    }

    // 3. Needs Seth decisions
    for (const need of this.needsSeth) {
      items.push({
        id: `need-${need.id}`,
        type: 'needs_seth',
        title: `Decision: ${need.title}`,
        detail: need.detail || need.action,
        severity: 'amber',
        agent: 'Seth',
        action: 'Decide and unblock',
        ref: need.id
      });
    }

    // 4. Stale heartbeats (agents checked in but not executing)
    for (const [agent, hb] of Object.entries(this.heartbeats)) {
      if (hb.last_authenticated_checkin_at && !hb.last_execution_verified_at) {
        const ageMin = Math.round((Date.now() - new Date(hb.last_authenticated_checkin_at).getTime()) / 60000);
        if (ageMin > 60) { // > 1 hour checked in but no execution
          items.push({
            id: `idle-${agent}`,
            type: 'idle_agent',
            title: `${agent} checked in but not executing`,
            detail: `Checked in ${ageMin} min ago · no execution verified`,
            severity: 'amber',
            agent,
            action: 'Dispatch work or investigate',
            ref: agent
          });
        }
      }
    }

    // 5. Quota warnings
    // (handled in usage view)

    return items.sort((a, b) => {
      const sevOrder = { red: 0, amber: 1, green: 2 };
      return (sevOrder[a.severity] || 99) - (sevOrder[b.severity] || 99);
    });
  }

  getCount() {
    return this.getItems().length;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TaskContract,
    RunInstance,
    Reconciler,
    Dispatcher,
    Watchdog,
    AttentionQueue,
    DEFAULT_WORKFLOWS,
    STANDARD_EVIDENCE_FIELDS,
    EVIDENCE_GATE_TYPES,
    GATE_SEVERITY
  };
}

// Browser global
if (typeof window !== 'undefined') {
  window.StackContracts = {
    TaskContract,
    RunInstance,
    Reconciler,
    Dispatcher,
    Watchdog,
    AttentionQueue,
    DEFAULT_WORKFLOWS,
    STANDARD_EVIDENCE_FIELDS
  };
}