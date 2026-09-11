/**
 * Plan-first — how ASDD builds software from requirements.
 *
 * Requirements go in. The control plane proposes the whole plan in one go: the phases (brief →
 * PRD → UX when there is a user interface → architecture → epics & stories → implementation), who
 * does each — the user's ASDD persona for the role where the library has one, ASDD's own agent
 * otherwise — and the guardrails that hold every phase to the one before it. The user approves that
 * plan once; the orchestrator then runs every phase in order, each reading the documents written
 * before it, and stops only when a guardrail set to stop fails or a step needs a person.
 */
import { id } from '../lib/util.js';

export const PLAN_DOCS = {
  brief: 'docs/product-brief.md',
  prd: 'docs/prd.md',
  ux: 'docs/ux-design.md',
  architecture: 'docs/architecture.md',
  stories: 'docs/epics-and-stories.md',
};

/** Story IDs the stories phase is told to use (S1.1, S2.3 …) — what implementation is checked against. */
export const STORY_ID = /\bS\d+\.\d+\b/g;

/** Requirements that mention a user interface get a UX phase before the architecture. */
export const UI_WORDS = /\b(ui|ux|user interface|screens?|pages?|front-?end|web ?app|website|mobile|dashboard|forms?|buttons?)\b/i;

const CORE_INPUTS = ['requirements', 'constraints'];
const WITH_PLAN = ['requirements', 'constraints', 'planDocs'];

export const PLAN_PHASES = {
  'plan.brief': {
    role: 'analyst',
    title: 'Product brief',
    output: PLAN_DOCS.brief,
    inputs: CORE_INPUTS,
    summary: 'States the problem, the users, the goals and the scope — from the requirements alone.',
    task:
      'Write the product brief for what these requirements describe: the problem, who the users are, the goals and how success will be measured, what is in and out of scope, and the assumptions and open questions. ' +
      'Base it only on the requirements, constraints and clarifications given — do not invent features. ' +
      `Write it as ${PLAN_DOCS.brief}.`,
  },
  'plan.prd': {
    role: 'pm',
    title: 'PRD',
    output: PLAN_DOCS.prd,
    inputs: WITH_PLAN,
    summary: 'Turns the brief into numbered requirements, each with acceptance criteria.',
    task:
      'From the product brief and the requirements, write the PRD: the functional requirements, keeping every requirement ID exactly as given in the input (REQ-001 …) and giving each one acceptance criteria; the non-functional requirements; and what is out of scope. ' +
      'Every requirement in the input must appear, by its ID. ' +
      `Write it as ${PLAN_DOCS.prd}.`,
  },
  'plan.ux': {
    role: 'ux-designer',
    title: 'UX design',
    output: PLAN_DOCS.ux,
    inputs: WITH_PLAN,
    summary: 'Designs the users’ journeys and screens before the architecture is decided.',
    task:
      "From the PRD, write the UX design: the users' main journeys, each screen and what it contains, the states each screen can be in (empty, loading, error), and accessibility needs. Name the requirement IDs each screen serves. " +
      `Write it as ${PLAN_DOCS.ux}.`,
  },
  'plan.architecture': {
    role: 'architect',
    title: 'Architecture',
    output: PLAN_DOCS.architecture,
    inputs: WITH_PLAN,
    summary: 'Decides the components, data, interfaces, technology and folder structure — every requirement mapped to a component.',
    task:
      'From the PRD (and the UX design, if there is one), write the architecture: the components and what each is responsible for, the data model, the interfaces between the parts, the technology choices with their reasons, and the folder structure the code will follow. ' +
      'Map every functional requirement ID to the component that implements it. Respect any technology the constraints fix. ' +
      `Write it as ${PLAN_DOCS.architecture}.`,
  },
  'plan.stories': {
    role: 'pm',
    title: 'Epics & stories',
    output: PLAN_DOCS.stories,
    inputs: WITH_PLAN,
    summary: 'Breaks the work into epics and ordered stories, each covering requirement IDs.',
    task:
      'From the PRD and the architecture, write the epics and stories. Group the work into epics. Give every story an ID of the form S<epic>.<number> (S1.1, S1.2, S2.1 …), a one-sentence user story, acceptance criteria, and the requirement IDs it covers. ' +
      'Every requirement ID in the PRD must be covered by at least one story. Order the stories so each can be built on the ones before it. ' +
      `Write it as ${PLAN_DOCS.stories}.`,
  },
  'build.implement': {
    role: 'dev',
    title: 'Implementation',
    output: 'the code and tests the architecture defines',
    inputs: [...WITH_PLAN, 'artifacts'],
    summary: 'Implements the stories in order, following the architecture, with tests.',
    task:
      `Implement the stories in ${PLAN_DOCS.stories} in order, following ${PLAN_DOCS.architecture} exactly — its components, folder structure and technology. ` +
      'For each story write the code and its tests at the paths the architecture defines, and put a comment naming the story ID (for example "// Story S1.2") at the top of every file it touches. ' +
      'If a story cannot be implemented from what the documents say, do not guess: leave it out and say in your notes what is missing.',
  },
};

/** Risks a plan-first project always carries; the plan guardrails below cover them. */
export const PLAN_RISKS = new Set(['risk.plan-incomplete', 'risk.requirement-dropped', 'risk.story-unbuilt', 'risk.step-not-run', 'risk.architecture-drift']);

/** The persona for a role: exact role first, then a role that ends with it ("lead-architect"). */
export function personaFor(role, personas) {
  return (
    personas.find((persona) => persona.bmad?.role === role) ||
    personas.find((persona) => String(persona.bmad?.role || '').endsWith(role)) ||
    null
  );
}

/** The guardrails that hold each phase to the one before it. Proposed, for the person to approve. */
export function planGuardrails(discovery) {
  const has = (capability) => discovery.capabilities.some((c) => c.id === capability);
  const documents = [PLAN_DOCS.brief, PLAN_DOCS.prd, ...(has('plan.ux') ? [PLAN_DOCS.ux] : []), PLAN_DOCS.architecture, PLAN_DOCS.stories];
  const proposal = (fields) => ({ proposalId: id('gp'), kind: 'guardrail', decision: 'proposed', source: 'asdd', params: {}, rule: null, ...fields });

  return [
    proposal({
      guardrailId: 'guard.plan.requirements-in-prd',
      name: 'Every requirement reaches the PRD',
      risks: ['risk.requirement-dropped'],
      severity: 'major',
      description: `Each requirement ID from your input appears in ${PLAN_DOCS.prd}.`,
      check: 'requirementsInDoc',
      params: { doc: PLAN_DOCS.prd },
      appliesTo: 'agent.plan.prd',
      appliesToLabel: 'PRD',
      onFailure: 'flag',
      rationale: 'A requirement that is not in the PRD is never designed, never storied and never built.',
    }),
    proposal({
      guardrailId: 'guard.plan.architecture-covers-prd',
      name: 'The architecture covers every requirement',
      risks: ['risk.architecture-drift'],
      severity: 'major',
      description: 'Every functional requirement has a component responsible for it.',
      rule: 'The architecture gives every functional requirement in the PRD a component that is responsible for it, and addresses the non-functional requirements.',
      check: 'customRule',
      appliesTo: 'agent.plan.architecture',
      appliesToLabel: 'Architecture',
      onFailure: 'flag',
      rationale: 'Judged against the architecture document — by your model, or by your coding assistant in VS Code.',
    }),
    proposal({
      guardrailId: 'guard.plan.complete',
      name: 'The plan is complete before any code is written',
      risks: ['risk.plan-incomplete'],
      severity: 'blocker',
      description: `${documents.join(', ')} all exist before implementation starts.`,
      check: 'planDocumentsPresent',
      params: { paths: documents },
      appliesTo: 'agent.plan.stories',
      appliesToLabel: 'Epics & stories',
      onFailure: 'stop',
      rationale: 'Implementation on a missing document builds on a guess, so the run stops here and waits for you.',
    }),
    proposal({
      guardrailId: 'guard.plan.requirements-in-stories',
      name: 'Every requirement has a story',
      risks: ['risk.requirement-dropped'],
      severity: 'blocker',
      description: `Each requirement ID appears in ${PLAN_DOCS.stories}.`,
      check: 'requirementsInDoc',
      params: { doc: PLAN_DOCS.stories },
      appliesTo: 'agent.plan.stories',
      appliesToLabel: 'Epics & stories',
      onFailure: 'stop',
      rationale: 'A requirement with no story is never built. The run stops before implementation rather than ship without it.',
    }),
    proposal({
      guardrailId: 'guard.plan.stories-built',
      name: 'Every story is implemented',
      risks: ['risk.story-unbuilt'],
      severity: 'major',
      description: 'Every story ID in the plan is named in the code that was written.',
      check: 'storiesImplemented',
      appliesTo: 'agent.build.implement',
      appliesToLabel: 'Implementation',
      onFailure: 'flag',
      rationale: 'Implementation can finish while quietly skipping stories; this names any it skipped.',
    }),
    proposal({
      guardrailId: 'guard.plan.every-step-ran',
      name: 'Every step really ran',
      risks: ['risk.step-not-run'],
      severity: 'blocker',
      description: 'No phase wrote a placeholder instead of doing the work.',
      check: 'noPlaceholderOutput',
      appliesTo: 'workflow',
      appliesToLabel: 'The whole workflow',
      onFailure: 'flag',
      rationale: 'Without a model a step writes its brief instead of doing the work. This makes that impossible to miss.',
    }),
  ];
}
