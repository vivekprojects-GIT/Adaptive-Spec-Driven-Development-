/**
 * Reporter — turns a finished run into (a) a trace graph the UI can draw and (b) a Markdown report.
 *
 * The trace graph is the "everything is traceable" promise made concrete: five node types
 * (requirement → source test → agent → artifact → guardrail) and typed links between them, so any
 * node in the UI can answer "where did this come from" and "what checked it".
 */

export function buildTrace(run) {
  const { discovery, ws, nodes, validation } = run;
  const graphNodes = [];
  const links = [];
  const push = (node) => { graphNodes.push(node); return node.id; };

  for (const requirement of discovery.requirements || []) {
    push({ id: `req:${requirement.id}`, type: 'requirement', label: requirement.id, detail: requirement.text, status: 'unknown' });
  }

  for (const agentNode of nodes) {
    push({
      id: `agent:${agentNode.nodeId}`,
      type: 'agent',
      label: agentNode.name,
      detail: `${agentNode.capability} · ${agentNode.source}`,
      status: agentNode.status,
      ms: agentNode.ms,
    });
  }

  for (const artifact of ws.generated) {
    push({
      id: `art:${artifact.path}`,
      type: 'artifact',
      label: artifact.path,
      detail: `${artifact.kind} · ${artifact.lines} lines · ${artifact.bytes} bytes`,
      status: 'produced',
    });
    if (artifact.producedBy) links.push({ from: `agent:${artifact.producedBy}`, to: `art:${artifact.path}`, kind: 'produced' });
  }

  const rows = ws.traceability?.rows || [];
  for (const row of rows) {
    const testId = `test:${row.testId}`;
    push({
      id: testId,
      type: 'sourceTest',
      label: row.sourceTest,
      detail: `${row.sourceFile} · ${row.steps} step(s), ${row.assertions} assertion(s)`,
      status: row.status,
    });
    if (row.requirementId) links.push({ from: `req:${row.requirementId}`, to: testId, kind: 'covered-by' });
    for (const path of row.artifacts) links.push({ from: testId, to: `art:${path}`, kind: 'migrated-into' });
  }

  for (const result of validation?.results || []) {
    const guardId = `guard:${result.guardrailId}`;
    push({ id: guardId, type: 'guardrail', label: result.name, detail: result.evidence, status: result.status });
    // A guardrail verifies the whole generated set; link it to the artifacts it actually read.
    const targets = ws.generated.filter((a) => a.kind === 'code' || a.kind === 'data');
    for (const artifact of targets.slice(0, 40)) links.push({ from: guardId, to: `art:${artifact.path}`, kind: 'verified' });
  }

  // Requirement status is derived from the tests beneath it.
  for (const node of graphNodes.filter((n) => n.type === 'requirement')) {
    const reqId = node.label;
    const children = rows.filter((r) => r.requirementId === reqId);
    node.status = !children.length ? 'orphan' : children.every((c) => c.status === 'migrated') ? 'migrated' : 'partial';
  }

  return {
    nodes: graphNodes,
    links,
    counts: {
      requirements: graphNodes.filter((n) => n.type === 'requirement').length,
      sourceTests: graphNodes.filter((n) => n.type === 'sourceTest').length,
      agents: graphNodes.filter((n) => n.type === 'agent').length,
      artifacts: graphNodes.filter((n) => n.type === 'artifact').length,
      guardrails: graphNodes.filter((n) => n.type === 'guardrail').length,
      links: links.length,
    },
  };
}

export function buildMarkdown(project, run) {
  const { discovery, validation, ws, nodes } = run;
  const line = (s = '') => s;
  const out = [];

  out.push(`# Migration report — ${project.name}`);
  out.push('');
  out.push(`- **Run:** \`${run.id}\``);
  out.push(`- **Started:** ${run.startedAt}`);
  out.push(`- **Finished:** ${run.finishedAt || '(unfinished)'}`);
  out.push(`- **Migration:** ${discovery.source.label} → ${discovery.target.label}`);
  out.push(`- **Model:** ${run.modelUsed || 'rule engine (offline)'}`);
  out.push(`- **Verdict:** **${(validation?.verdict || 'unknown').toUpperCase()}**`);
  if (run.rerunOf) {
    out.push(
      `- **Re-run of:** \`${run.rerunOf.runId}\`${run.rerunOf.from ? ` from "${run.rerunOf.from}"` : ''} — ${run.rerunOf.reused.length} agent(s) reused unchanged`,
    );
  }
  out.push('');

  out.push('## 1. What was discovered');
  out.push('');
  out.push(discovery.summary);
  out.push('');
  out.push('| Entity | Count |');
  out.push('|---|---|');
  for (const [key, value] of Object.entries(discovery.entities)) {
    out.push(`| ${key} | ${Array.isArray(value) ? value.join(', ') || '—' : value} |`);
  }
  out.push('');

  if (project.interview?.answers && Object.keys(project.interview.answers).length) {
    out.push('## 2. Clarifications from the developer');
    out.push('');
    out.push('| Question | Answer |');
    out.push('|---|---|');
    for (const question of project.interview.questions || []) {
      const answer = project.interview.answers[question.id];
      if (answer) out.push(`| ${question.question.replace(/\|/g, '\\|')} | ${String(answer).replace(/\|/g, '\\|')} |`);
    }
    out.push('');
  }

  out.push('## 3. Agents that ran');
  out.push('');
  out.push('| # | Agent | Capability | Source | Status | ms |');
  out.push('|---|---|---|---|---|---|');
  nodes.forEach((node, index) => {
    const status = node.reusedFrom ? `${node.status} (reused from \`${node.reusedFrom}\`)` : node.status;
    out.push(`| ${index + 1} | ${node.name} | \`${node.capability}\` | ${node.source} | ${status} | ${node.ms ?? '—'} |`);
  });
  out.push('');

  out.push('## 4. Guardrail verdicts');
  out.push('');
  out.push('| Guardrail | Severity | Status | Evidence |');
  out.push('|---|---|---|---|');
  for (const result of validation?.results || []) {
    const override = result.overridden
      ? ` — stop overridden by ${result.overridden.by}${result.overridden.note ? `: ${String(result.overridden.note).replace(/\|/g, '\\|')}` : ''}`
      : '';
    out.push(`| ${result.name} | ${result.severity} | **${result.status}**${override} | ${String(result.evidence).replace(/\|/g, '\\|')} |`);
  }
  out.push('');

  if (run.decisions?.length) {
    out.push('### Human decisions on this run');
    out.push('');
    for (const decision of run.decisions) {
      const what =
        decision.type === 'continued'
          ? `Continued past "${decision.guardrail}" — ${decision.agents?.length || 0} skipped agent(s) then ran`
          : decision.type === 'rerun'
            ? `Re-run as \`${decision.runId}\` from "${decision.from}"`
            : decision.type === 'approved'
              ? 'Approved'
              : 'Changes requested';
      out.push(`- ${decision.at} — **${what}** by ${decision.by}${decision.note ? `: ${decision.note}` : ''}`);
    }
    out.push('');
  }

  out.push('## 5. Traceability matrix');
  out.push('');
  out.push('| Requirement | Source test | Source file | Assertions | Generated artifact(s) | Status |');
  out.push('|---|---|---|---|---|---|');
  for (const row of ws.traceability?.rows || []) {
    out.push(`| ${row.requirementId || '—'} | ${row.sourceTest} | ${row.sourceFile} | ${row.assertions} | ${row.artifacts.join('<br>') || '—'} | ${row.status} |`);
  }
  out.push('');

  const orphans = ws.traceability?.orphanRequirements || [];
  if (orphans.length) {
    out.push('### Requirements with no migrated test');
    out.push('');
    for (const orphan of orphans) out.push(`- **${orphan.id}** — ${orphan.text}`);
    out.push('');
  }

  if (discovery.gaps?.length) {
    out.push('## 6. Capability gaps');
    out.push('');
    for (const gap of discovery.gaps) {
      out.push(`- **${gap.capability}** — ${gap.reason} _Needs: ${gap.needs}_`);
    }
    out.push('');
  }

  out.push('## 7. Generated artifacts');
  out.push('');
  out.push('| Path | Kind | Lines | Produced by |');
  out.push('|---|---|---|---|');
  for (const artifact of ws.generated) {
    const producer = nodes.find((n) => n.nodeId === artifact.producedBy);
    out.push(`| \`${artifact.path}\` | ${artifact.kind} | ${artifact.lines} | ${producer?.name || '—'} |`);
  }
  out.push('');
  out.push('---');
  out.push(line(`Generated by ASDD (Adaptive Spec Driven Development) — control plane run \`${run.id}\`.`));

  return out.join('\n');
}
