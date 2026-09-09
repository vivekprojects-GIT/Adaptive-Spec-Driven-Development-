/**
 * Observability — the log feed and the dashboard aggregates.
 *
 * The dashboard exists to answer "where did it fail", so it ranks failures rather than just
 * counting successes: which guardrails fail most, which agents fail most, which requirements never
 * reach an artifact, and which capability gaps are still blocking projects.
 */
import { Router } from 'express';
import { collection } from '../lib/store.js';
import { queryLogs, logCounts, clearLogs } from '../lib/logger.js';
import { listRuns } from '../engine/orchestrator.js';
import { listAgents } from '../registry/agents.js';
import { listGuardrails } from '../registry/guardrails.js';

const projects = collection('projects');
const router = Router();

router.get('/logs', (req, res) => {
  res.json({
    counts: logCounts(),
    entries: queryLogs(req.query),
  });
});

router.delete('/logs', (req, res) => {
  clearLogs();
  res.json({ ok: true });
});

router.get('/dashboard', (req, res) => {
  const allProjects = projects.all();
  const allRuns = listRuns();
  const recentRuns = [...allRuns].sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));

  /* --- where things fail ------------------------------------------- */

  const guardrailFailures = new Map();
  const agentFailures = new Map();
  const placeholderAgents = new Map();
  let totalChecks = 0;
  let passedChecks = 0;
  let warnedChecks = 0;
  let failedChecks = 0;

  for (const run of allRuns) {
    for (const result of run.validation?.results || []) {
      totalChecks += 1;
      if (result.status === 'pass') passedChecks += 1;
      else if (result.status === 'warn') warnedChecks += 1;
      else failedChecks += 1;

      if (result.status !== 'pass') {
        const key = result.guardrailId;
        const row = guardrailFailures.get(key) || { guardrailId: key, name: result.name, severity: result.severity, fail: 0, warn: 0, lastEvidence: null, lastRunId: null, lastProjectId: null };
        row[result.status === 'fail' ? 'fail' : 'warn'] += 1;
        row.lastEvidence = result.evidence;
        row.lastRunId = run.id;
        row.lastProjectId = run.projectId;
        guardrailFailures.set(key, row);
      }
    }

    for (const node of run.nodes || []) {
      if (node.status === 'failed') {
        const row = agentFailures.get(node.agentId) || { agentId: node.agentId, name: node.name, capability: node.capability, failures: 0, lastError: null, lastRunId: null, lastProjectId: null };
        row.failures += 1;
        row.lastError = node.error || 'no error message recorded';
        row.lastRunId = run.id;
        row.lastProjectId = run.projectId;
        agentFailures.set(node.agentId, row);
      }
      if (node.metrics?.placeholder) {
        const row = placeholderAgents.get(node.agentId) || { agentId: node.agentId, name: node.name, runs: 0, lastRunId: null, lastProjectId: null };
        row.runs += 1;
        row.lastRunId = run.id;
        row.lastProjectId = run.projectId;
        placeholderAgents.set(node.agentId, row);
      }
    }
  }

  /* --- coverage and gaps ------------------------------------------- */

  const orphanRequirements = [];
  const openGaps = [];
  const blockedProjects = [];

  for (const project of allProjects) {
    const latest = recentRuns.find((run) => run.projectId === project.id);
    for (const orphan of latest?.ws?.traceability?.orphanRequirements || []) {
      orphanRequirements.push({ projectId: project.id, projectName: project.name, runId: latest.id, ...orphan });
    }
    for (const gap of project.discovery?.gaps || []) {
      openGaps.push({ projectId: project.id, projectName: project.name, ...gap });
    }
    // Derived from open questions rather than a persisted flag, so an assessment written by an
    // older build cannot leave a project looking blocked with nothing to answer.
    if (project.interview && project.interview.blockingCount > 0) {
      blockedProjects.push({
        projectId: project.id,
        projectName: project.name,
        readiness: project.interview.readiness,
        blockingCount: project.interview.blockingCount,
        stage: project.stage,
      });
    }
  }

  const byVerdict = {};
  for (const run of allRuns) {
    const verdict = run.validation?.verdict || run.status;
    byVerdict[verdict] = (byVerdict[verdict] || 0) + 1;
  }

  const awaitingApproval = allRuns.filter((run) => run.approval?.state === 'pending').length;

  res.json({
    generatedAt: new Date().toISOString(),
    totals: {
      projects: allProjects.length,
      runs: allRuns.length,
      artifacts: allRuns.reduce((sum, run) => sum + (run.ws?.generated?.length || 0), 0),
      registryAgents: listAgents().length,
      registryGuardrails: listGuardrails().length,
      awaitingApproval,
    },
    checks: { total: totalChecks, pass: passedChecks, warn: warnedChecks, fail: failedChecks },
    byVerdict,
    failures: {
      guardrails: [...guardrailFailures.values()].sort((a, b) => b.fail - a.fail || b.warn - a.warn).slice(0, 12),
      agents: [...agentFailures.values()].sort((a, b) => b.failures - a.failures).slice(0, 12),
      placeholders: [...placeholderAgents.values()].sort((a, b) => b.runs - a.runs).slice(0, 12),
    },
    orphanRequirements: orphanRequirements.slice(0, 25),
    openGaps: openGaps.slice(0, 25),
    blockedProjects,
    recentRuns: recentRuns.slice(0, 12).map((run) => ({
      id: run.id,
      projectId: run.projectId,
      projectName: run.projectName,
      status: run.status,
      verdict: run.validation?.verdict || null,
      approval: run.approval?.state || null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      artifacts: run.ws?.generated?.length || 0,
      failedNodes: (run.nodes || []).filter((node) => node.status === 'failed').map((node) => node.name),
    })),
    recentErrors: queryLogs({ level: 'error', limit: 25 }),
    logCounts: logCounts(),
  });
});

export default router;
