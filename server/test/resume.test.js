/**
 * Picking up from a human decision instead of starting over: continuing a halted run past its stop,
 * and re-running from the agent a person changed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runDiscovery } from '../src/engine/discovery.js';
import { proposeAgents } from '../src/engine/agentFactory.js';
import { customGuardrailProposal } from '../src/engine/guardrailDesigner.js';
import { composeWorkflow } from '../src/engine/workflowComposer.js';
import {
  createRun,
  executeRun,
  recordApproval,
  getRun,
  prepareContinue,
  prepareRerun,
  planRerun,
  workflowOutOfDate,
} from '../src/engine/orchestrator.js';
import { exampleSpec } from '../src/templates.js';
import { id } from '../src/lib/util.js';

/** The Selenium sample, with a guardrail that stops the run right after the analyzer. */
function haltingProject() {
  const project = { id: id('prj'), name: 'resume', spec: exampleSpec('selenium-to-playwright'), interview: { answers: {}, ready: true } };
  project.discovery = runDiscovery(project.spec);
  const agents = proposeAgents(project.discovery).proposals.map((p) => ({ ...p, decision: 'accepted' }));
  const stopper = customGuardrailProposal({
    name: 'Nothing may pass the analyzer unmigrated',
    rule: 'Every source test must already have a generated counterpart.',
    severity: 'blocker',
    appliesTo: 'agent.selenium-java-analyzer',
    onFailure: 'stop',
    check: 'testCaseParity',
  });
  project.proposals = { agents, guardrails: [stopper] };
  project.graph = composeWorkflow(agents);
  return { project, stopper };
}

const starts = (run, name) => run.events.filter((e) => e.type === 'node:start' && e.agent === name).length;
const conflict = (pattern) => (err) => err.status === 409 && pattern.test(err.message);

test('a halted run cannot be approved as it stands, and continuing carries it on from the stop', async () => {
  const { project, stopper } = haltingProject();
  const halted = await executeRun(createRun(project).id, project);
  assert.equal(halted.status, 'halted');
  const analyzer = halted.nodes[0];
  const skipped = halted.nodes.filter((n) => n.status === 'skipped').map((n) => n.name);
  assert.ok(skipped.length > 0, 'the stop left agents unrun');

  assert.throws(() => recordApproval(halted.id, { state: 'approved' }), conflict(/cannot be approved as it stands/));

  prepareContinue(halted.id, project, { note: 'Parity cannot pass before generation; expected.', by: 'Vivek' });
  const run = await executeRun(halted.id, project, { resume: true });

  assert.equal(run.id, halted.id, 'the same run carries on — no new run');
  assert.equal(starts(run, analyzer.name), 1, 'what already ran is not run again');
  for (const name of skipped) assert.equal(starts(run, name), 1, `${name} ran after the continue`);
  assert.ok(!run.nodes.some((n) => n.status === 'skipped' || n.status === 'pending'), 'nothing is left unrun');
  assert.ok(run.ws.generated.some((a) => a.producedBy === analyzer.nodeId), "the analyzer's output was kept");
  assert.ok(run.ws.generated.some((a) => a.path.endsWith('.spec.ts')), "the generator worked from the analyzer's kept source model");

  const stop = run.validation.results.find((r) => r.guardrailId === stopper.guardrailId);
  assert.equal(stop.status, 'fail', 'overriding the stop does not rewrite the evidence');
  assert.equal(stop.overridden.by, 'Vivek');
  assert.notEqual(run.validation.verdict, 'blocked', 'it no longer blocks');
  assert.notEqual(run.validation.verdict, 'passed', 'but an override never reads as clean');
  assert.equal(run.approval.state, 'pending', 'it comes back for a final decision');
  assert.match(run.approval.reason, /Continued past "Nothing may pass the analyzer unmigrated" by Vivek/);
  assert.ok(run.events.some((e) => e.type === 'run:continued'), 'the override is on the timeline');
  assert.match(run.report, /stop overridden by Vivek/, 'and in the report');

  recordApproval(run.id, { state: 'approved', note: 'Accepted with the override.', by: 'Vivek' });
  assert.deepEqual(getRun(run.id).decisions.map((d) => d.type), ['continued', 'approved']);
});

test('only a halted, undecided run with unchanged inputs can be continued', async () => {
  const { project } = haltingProject();
  project.proposals.guardrails = [];
  const clean = await executeRun(createRun(project).id, project);
  assert.throws(() => prepareContinue(clean.id, project), conflict(/Only a halted run/));

  recordApproval(clean.id, { state: 'approved' });
  assert.throws(() => recordApproval(clean.id, { state: 'changes-requested' }), conflict(/already decided/));

  const { project: changed } = haltingProject();
  const halted = await executeRun(createRun(changed).id, changed);
  changed.spec = { ...changed.spec, requirements: `${changed.spec.requirements}\nREQ-999 A requirement added after the halt` };
  assert.throws(() => prepareContinue(halted.id, changed), conflict(/changed since this run halted/));
});

test('a re-run reuses every unchanged agent before the one asked for, and runs the rest', async () => {
  const { project } = haltingProject();
  project.proposals.guardrails = [];
  const first = await executeRun(createRun(project).id, project);
  const genIndex = first.nodes.findIndex((n) => n.capability.startsWith('target.generate'));
  assert.ok(genIndex > 0, 'something runs before the generator');
  const generator = first.nodes[genIndex];

  const { run: queued, plan } = prepareRerun(first.id, project, { fromNodeId: generator.nodeId, note: 'Regenerate with new page objects.', by: 'Vivek' });
  assert.equal(plan.fromName, generator.name);
  assert.deepEqual(plan.pairs.map((p) => p.next.name), first.nodes.slice(0, genIndex).map((n) => n.name));

  const run = await executeRun(queued.id, project);
  assert.notEqual(run.id, first.id, 'a re-run is a new run; the original stays as it was');
  for (const node of run.nodes.slice(0, genIndex)) {
    assert.equal(node.reusedFrom, first.id);
    assert.equal(starts(run, node.name), 0, `${node.name} was not run again`);
    assert.ok(run.events.some((e) => e.type === 'node:reused' && e.agent === node.name), `${node.name} is shown as reused`);
  }
  for (const node of run.nodes.slice(genIndex)) assert.equal(starts(run, node.name), 1, `${node.name} ran again`);

  const analyzerFiles = first.ws.generated.filter((a) => a.producedBy === first.nodes[0].nodeId).map((a) => a.path);
  assert.ok(analyzerFiles.length > 0);
  for (const path of analyzerFiles) {
    assert.ok(run.ws.generated.some((a) => a.path === path && a.producedBy === run.nodes[0].nodeId), `${path} carried over`);
  }
  assert.ok(run.ws.generated.some((a) => a.path.endsWith('.spec.ts')), 'the generator had the reused source model to work from');
  assert.deepEqual(
    run.ws.generated.map((a) => a.path).sort(),
    first.ws.generated.map((a) => a.path).sort(),
    'the same files as a full run — nothing lost, nothing duplicated',
  );

  const original = getRun(first.id);
  assert.equal(original.supersededBy, run.id);
  assert.equal(original.approval.state, 'changes-requested', 'asking for a re-run is a request for changes');
  assert.deepEqual(original.decisions.map((d) => d.type), ['changes-requested', 'rerun']);
  assert.equal(run.rerunOf.runId, first.id);
  assert.equal(run.approval.state, 'pending', 'the re-run still ends at a human');
  assert.throws(() => prepareRerun(first.id, project), conflict(/already re-run/));
});

test('a re-run starts earlier when an earlier agent changed, and from the top when the inputs changed', async () => {
  const { project } = haltingProject();
  project.proposals.guardrails = [];
  const first = await executeRun(createRun(project).id, project);
  const last = first.nodes.at(-1);

  const edited = project.proposals.agents.map((a) =>
    a.agentId === 'agent.selenium-java-analyzer' ? { ...a, inputs: [...(a.inputs || []), 'artifacts:properties'] } : a,
  );
  const editedProject = { ...project, proposals: { ...project.proposals, agents: edited } };
  assert.equal(workflowOutOfDate(editedProject), true, 'an edit is not in the workflow until it is recomposed');
  editedProject.graph = composeWorkflow(edited);
  assert.equal(workflowOutOfDate(editedProject), false);

  const plan = planRerun(first, editedProject, last.nodeId);
  assert.equal(plan.pairs.length, 0);
  assert.equal(plan.fromName, first.nodes[0].name);
  assert.match(plan.reasons.join(' '), /changed since that run, so the re-run starts there rather than at/);

  const newSpec = { ...project, spec: { ...project.spec, constraints: 'Run headless only.' } };
  const fromTop = planRerun(first, newSpec, last.nodeId);
  assert.equal(fromTop.pairs.length, 0);
  assert.match(fromTop.reasons[0], /changed since that run/);

  assert.match(planRerun({ ...first, wsWriters: undefined }, project, last.nodeId).reasons[0], /predates partial re-runs/);
});

test('a re-run keeps an unchanged check and its override instead of stopping the person again', async () => {
  const { project, stopper } = haltingProject();
  const halted = await executeRun(createRun(project).id, project);
  prepareContinue(halted.id, project, { note: 'Expected at the analyzer.', by: 'Vivek' });
  const continued = await executeRun(halted.id, project, { resume: true });
  const generator = continued.nodes.find((n) => n.capability.startsWith('target.generate'));

  const { run: queued } = prepareRerun(continued.id, project, { fromNodeId: generator.nodeId, by: 'Vivek' });
  const run = await executeRun(queued.id, project);

  assert.notEqual(run.status, 'halted', 'the stop a person already overrode does not stop them again');
  assert.equal(starts(run, continued.nodes[0].name), 0, 'the analyzer was reused, not re-run');
  const stop = run.validation.results.find((r) => r.guardrailId === stopper.guardrailId);
  assert.equal(stop.carriedFrom, continued.id, 'the verdict was carried over, not re-evaluated');
  assert.equal(stop.overridden.by, 'Vivek', 'with the override still attributed to the person who made it');
  assert.match(run.approval.reason, new RegExp(`by Vivek \\(in ${continued.id}\\)`));
});

test('a new check that stops a re-run at a reused agent carries nothing over from the agents after it', async () => {
  const { project, stopper } = haltingProject();
  project.proposals.guardrails = [];
  const first = await executeRun(createRun(project).id, project);
  const generator = first.nodes.find((n) => n.capability.startsWith('target.generate'));

  project.proposals.guardrails = [stopper]; // the change: a stricter check than the first run had
  const { run: queued, plan } = prepareRerun(first.id, project, { fromNodeId: generator.nodeId });
  assert.ok(plan.pairs.length > 1, 'several agents were due to be reused');
  const run = await executeRun(queued.id, project);

  assert.equal(run.status, 'halted', 'a new check is evaluated, not carried over');
  assert.equal(run.nodes[0].reusedFrom, first.id, 'the agent it stopped at was reused');
  for (const node of run.nodes.slice(1)) {
    assert.equal(node.status, 'skipped');
    assert.equal(node.reusedFrom, undefined, `${node.name} was never reached, so nothing of it carried over`);
    assert.ok(!run.ws.generated.some((a) => a.producedBy === node.nodeId), `no files from ${node.name}`);
  }
});

test('re-running a halted run starts no later than the first agent that never ran', async () => {
  const { project } = haltingProject();
  const halted = await executeRun(createRun(project).id, project);
  const firstSkipped = halted.nodes.find((n) => n.status === 'skipped');

  const plan = planRerun(halted, project, halted.nodes.at(-1).nodeId);
  assert.equal(plan.fromName, firstSkipped.name);
  assert.match(plan.reasons.join(' '), /did not finish in that run \(skipped\)/);

  const { plan: byDefault } = prepareRerun(halted.id, project, { by: 'Vivek' });
  assert.equal(byDefault.fromName, halted.nodes[0].name, 'by default it re-runs from the agent whose check stopped the run');
});
