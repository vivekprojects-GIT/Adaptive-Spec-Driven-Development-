/**
 * The approvals inbox — everything, everywhere, that is waiting on a human.
 *
 * The platform gates on people by design: proposals need accepting, blocking questions need
 * answering, halted runs need review, finished runs need signing off. That is only honest if a
 * person can SEE what is waiting without opening every project to check, so this aggregates every
 * outstanding decision into one list, each item pointing at the exact screen that resolves it.
 */
import { Router } from 'express';
import { collection } from '../lib/store.js';
import { listRuns } from '../engine/orchestrator.js';

const projects = collection('projects');
const router = Router();

const RANK = { blocker: 3, major: 2, info: 1 };

/** Checks that cannot be evaluated automatically and therefore need a person to say yes. */
const SIGN_OFF_CHECKS = new Set(['manualSignOff', 'customRule']);

export function pendingApprovals() {
  const items = [];
  const allRuns = listRuns();

  for (const project of projects.all()) {
    const runs = allRuns
      .filter((run) => run.projectId === project.id)
      .sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));

    // 1. Questions the platform asked and nobody has answered.
    if (project.interview?.blockingCount > 0) {
      items.push({
        id: `interview:${project.id}`,
        kind: 'interview',
        severity: 'blocker',
        projectId: project.id,
        projectName: project.name,
        stage: 'interview',
        title: `${project.interview.blockingCount} question(s) block this project`,
        detail: (project.interview.questions || []).filter((q) => q.required && !q.answered).map((q) => q.question)[0] || 'Answer the blocking questions to continue.',
        count: project.interview.blockingCount,
        since: project.interview.assessedAt || project.updatedAt,
        action: 'Answer them',
      });
    }

    // 2. Proposals sitting undecided — nothing runs until a human accepts or rejects.
    for (const kind of ['agents', 'guardrails']) {
      const undecided = (project.proposals?.[kind] || []).filter((p) => p.decision === 'proposed');
      if (!undecided.length) continue;
      items.push({
        id: `${kind}:${project.id}`,
        kind: kind === 'agents' ? 'agent-proposals' : 'guardrail-proposals',
        severity: 'major',
        projectId: project.id,
        projectName: project.name,
        stage: kind,
        title: `${undecided.length} ${kind === 'agents' ? 'agent' : 'guardrail'} proposal(s) awaiting your decision`,
        detail: undecided.map((p) => p.name).slice(0, 3).join(', ') + (undecided.length > 3 ? `, +${undecided.length - 3} more` : ''),
        count: undecided.length,
        since: project.updatedAt,
        action: 'Review them',
      });
    }

    for (const run of runs) {
      // A step handed to the user's coding assistant. Nothing moves until its work comes back.
      if (run.status === 'waiting') {
        const node = (run.nodes || []).find((n) => n.status === 'waiting');
        items.push({
          id: `assistant:${run.id}`,
          kind: 'assistant-task',
          severity: 'major',
          projectId: project.id,
          projectName: project.name,
          runId: run.id,
          stage: 'run',
          title: `Waiting on your coding assistant: "${node?.name || 'an agent step'}"`,
          detail: 'In VS Code, ask Copilot to carry on (/asdd-run). It does this step with your files and hands the work back; the run then continues.',
          count: 1,
          since: node?.handoff?.at || run.startedAt,
          action: 'Open the run',
        });
        continue;
      }

      // 3. A run that halted mid-way because a guardrail said stop.
      if (run.status === 'halted' && run.approval?.state === 'pending') {
        items.push({
          id: `halted:${run.id}`,
          kind: 'halted-run',
          severity: 'blocker',
          projectId: project.id,
          projectName: project.name,
          runId: run.id,
          stage: 'run',
          title: 'A run was halted and needs review',
          detail: run.approval.reason,
          count: 1,
          since: run.finishedAt || run.startedAt,
          action: 'Continue it or send it back',
        });
        continue;
      }

      // 4. A finished run nobody has accepted or sent back.
      if (run.approval?.state === 'pending') {
        const results = run.validation?.results || [];
        const failed = results.filter((r) => r.status === 'fail');
        items.push({
          id: `approval:${run.id}`,
          kind: 'run-approval',
          severity: failed.length ? 'blocker' : 'major',
          projectId: project.id,
          projectName: project.name,
          runId: run.id,
          stage: 'run',
          title: `Run finished ${run.validation?.verdict || run.status} — approve it or send it back`,
          detail: failed.length
            ? `${failed.length} guardrail(s) failed: ${failed.map((r) => r.name).join(', ')}`
            : `${results.filter((r) => r.status === 'pass').length} guardrail(s) passed, ${results.filter((r) => r.status === 'warn').length} warned.`,
          count: 1,
          since: run.finishedAt || run.startedAt,
          action: 'Approve or request changes',
        });

        // 5. Individual checks that could not be evaluated and explicitly asked for a person.
        const signOffs = results.filter((r) => r.status === 'warn' && SIGN_OFF_CHECKS.has(r.check));
        if (signOffs.length) {
          items.push({
            id: `signoff:${run.id}`,
            kind: 'sign-off',
            severity: 'major',
            projectId: project.id,
            projectName: project.name,
            runId: run.id,
            stage: 'run',
            title: `${signOffs.length} guardrail(s) need a human sign-off`,
            detail: signOffs.map((r) => r.name).join(', '),
            count: signOffs.length,
            since: run.finishedAt || run.startedAt,
            action: 'Read the evidence',
          });
        }
      }
    }
  }

  return items.sort((a, b) => RANK[b.severity] - RANK[a.severity] || (b.since > a.since ? 1 : -1));
}

router.get('/', (req, res) => {
  const items = pendingApprovals();
  res.json({
    total: items.reduce((sum, item) => sum + item.count, 0),
    blocking: items.filter((item) => item.severity === 'blocker').length,
    byProject: items.reduce((map, item) => {
      map[item.projectId] = (map[item.projectId] || 0) + item.count;
      return map;
    }, {}),
    items,
  });
});

export default router;
