/**
 * Requirements Interview — the readiness gate that sits between "spec typed in" and "fulfilment".
 *
 * The platform refuses to guess. It reads the spec, works out what it still does not know, and
 * asks the developer. Only when every blocking question is answered does the project become
 * `ready`, at which point Discovery → Factory → Guardrails → Compose → Run can proceed.
 *
 * Rule-based by default; if an API key is configured, the LLM adds project-specific questions on
 * top of (never instead of) the deterministic ones.
 */
import { detectTechnology } from '../registry/technologies.js';
import { parseRequirements } from './discovery.js';
import { collectDataFiles } from './parsers.js';
import { assist, llmAvailable } from '../lib/llm.js';
import { getSettings } from '../lib/settings.js';
import { id } from '../lib/util.js';

const CHECKS = [
  {
    key: 'source-stack',
    weight: 18,
    required: true,
    test: (ctx) => ctx.source.id !== 'unknown',
    question: (ctx) => ({
      question: 'Which framework and language is the source suite written in?',
      why: ctx.spec.sourceStack
        ? `"${ctx.spec.sourceStack}" did not match any known technology profile, and the wrong parser would silently produce an empty model.`
        : 'Nothing can be parsed until the source technology is known.',
      kind: 'choice',
      options: ['Selenium WebDriver (Java)', 'Selenium WebDriver (Python)', 'Cypress', 'JUnit', 'Legacy REST API collection (Postman / RestAssured)', 'Other — I will type it'],
      field: 'sourceStack',
      severity: 'blocker',
    }),
  },
  {
    key: 'target-stack',
    weight: 18,
    required: true,
    test: (ctx) => ctx.target.id !== 'unknown',
    question: (ctx) => ({
      question: 'What exactly is the target framework, including language?',
      why: ctx.spec.targetStack
        ? `"${ctx.spec.targetStack}" is ambiguous — Playwright alone does not say TypeScript or Python, and the emitters differ completely.`
        : 'The emitter cannot be selected without a target framework.',
      kind: 'choice',
      options: ['Playwright (TypeScript)', 'Playwright (Python)', 'Playwright API testing (TypeScript)', 'PyTest', 'Other — I will type it'],
      field: 'targetStack',
      severity: 'blocker',
    }),
  },
  {
    key: 'artifacts',
    weight: 20,
    required: true,
    test: (ctx) => ctx.spec.artifacts?.length > 0,
    question: () => ({
      question: 'Paste or upload at least one source file (a test class, a spec, or a collection export).',
      why: 'With no artifacts the run can only produce scaffolding. Everything downstream — assertion parity, data preservation, traceability — is computed from real source content.',
      kind: 'action',
      options: [],
      field: 'artifacts',
      severity: 'blocker',
    }),
  },
  {
    key: 'requirements',
    weight: 12,
    required: true,
    test: (ctx) => ctx.requirements.length > 0,
    question: () => ({
      question: 'List the requirements this suite is supposed to cover — one per line, IDs welcome (e.g. "REQ-001 User can log in").',
      why: 'Requirement traceability is a guardrail. With no requirements there is nothing to trace to, and the migration cannot be proven complete.',
      kind: 'text',
      field: 'requirements',
      severity: 'blocker',
    }),
  },
  {
    key: 'parseable',
    weight: 12,
    required: true,
    test: (ctx) => ctx.parsedTests > 0 || !ctx.spec.artifacts?.length,
    question: (ctx) => ({
      question: 'The supplied artifacts parsed to 0 test cases. Are these the right files, or does the suite use a custom base class / annotation?',
      why: `${ctx.spec.artifacts.length} artifact(s) were supplied but no test method was recognised for ${ctx.source.label}. Migrating from an empty model would look like a success and deliver nothing.`,
      kind: 'text',
      field: 'notes',
      severity: 'blocker',
    }),
  },
  {
    key: 'data-policy',
    weight: 6,
    required: false,
    test: (ctx) => ctx.dataFiles.length === 0 || Boolean(ctx.answers['data-policy']),
    question: (ctx) => ({
      question: `Found ${ctx.dataFiles.length} fixture file(s). How should test data be handled?`,
      why: 'Data loss is a blocker-level risk, and the answer changes which guardrail parameters are set.',
      kind: 'choice',
      options: ['Convert to JSON fixtures and keep every record', 'Keep the original format, copy as-is', 'Anonymise values while preserving record count', 'Leave data behind — tests will use new fixtures'],
      field: 'dataPolicy',
      severity: 'major',
    }),
  },
  {
    key: 'pom',
    weight: 5,
    required: false,
    test: (ctx) => ctx.kind !== 'ui-test' || Boolean(ctx.answers.pom),
    question: () => ({
      question: 'Should the generated UI suite use Page Objects, or inline locators in the specs?',
      why: 'This changes the file layout the generator emits, and it is cheaper to decide now than to restructure afterwards.',
      kind: 'choice',
      options: ['Page Objects (recommended for suites over ~20 tests)', 'Inline locators in each spec', 'Match whatever the source suite does'],
      field: 'pom',
      severity: 'minor',
    }),
  },
  {
    key: 'waits',
    weight: 5,
    required: false,
    test: (ctx) => !ctx.hasExplicitWaits || Boolean(ctx.answers.waits),
    question: () => ({
      question: 'The source uses explicit sleeps. Convert them to Playwright auto-waiting, or keep the fixed delays?',
      why: 'Playwright auto-waits; copying Thread.sleep across preserves behaviour but keeps the flakiness and the runtime.',
      kind: 'choice',
      options: ['Convert to auto-waiting (drop fixed sleeps)', 'Keep fixed sleeps for now', 'Convert, but leave a TODO comment at each site'],
      field: 'waits',
      severity: 'minor',
    }),
  },
  {
    key: 'secrets',
    weight: 4,
    required: false,
    test: (ctx) => !ctx.hasSecrets || Boolean(ctx.answers.secrets),
    question: () => ({
      question: 'Hardcoded credentials appear in the source. Where should they live in the target?',
      why: 'A blocker guardrail fails the run if secrets are copied into generated code.',
      kind: 'choice',
      options: ['Environment variables (process.env)', 'A .env file committed to .gitignore', 'A secrets manager — emit a TODO placeholder'],
      field: 'secrets',
      severity: 'major',
    }),
  },
  {
    key: 'unmapped-policy',
    weight: 5,
    required: false,
    test: (ctx) => ctx.unmapped === 0 || Boolean(ctx.answers['unmapped-policy']),
    question: (ctx) => ({
      question: `${ctx.unmapped} source construct(s) have no target equivalent. What should the run do with them?`,
      why: 'Silently dropping them is exactly the failure mode the Unsupported Feature guardrail exists to prevent.',
      kind: 'choice',
      options: ['Emit a failing placeholder test so it cannot be missed', 'Emit a skipped test with a TODO', 'List them in the report only'],
      field: 'unmappedPolicy',
      severity: 'major',
    }),
  },
  {
    key: 'definition-of-done',
    weight: 5,
    required: false,
    test: (ctx) => Boolean(ctx.answers['definition-of-done'] || ctx.spec.constraints),
    question: () => ({
      question: 'What has to be true for this migration to count as done?',
      why: 'This becomes the acceptance line in the run report, and it is the difference between "the run finished" and "the work is finished".',
      kind: 'choice',
      options: ['Every source test has a generated counterpart that compiles', 'The above, plus every requirement traced', 'The above, plus zero unmapped constructs', 'Custom — I will describe it'],
      field: 'definitionOfDone',
      severity: 'minor',
    }),
  },
];

function buildContext(spec, answers = {}) {
  const artifacts = spec.artifacts || [];
  const source = detectTechnology(spec.sourceStack, artifacts, 'source');
  const target = detectTechnology(spec.targetStack, artifacts, 'target');
  const requirements = parseRequirements(spec.requirements);
  const dataFiles = collectDataFiles(artifacts);
  const bodies = artifacts.map((a) => a.content || '').join('\n');

  // Cheap pre-parse: enough to know whether the artifacts look like tests at all.
  const parsedTests =
    (bodies.match(/@Test/g) || []).length +
    (bodies.match(/\bit\s*\(/g) || []).length +
    (bodies.match(/def\s+test_/g) || []).length +
    (bodies.match(/"request"\s*:/g) || []).length;

  return {
    spec,
    answers,
    source,
    target,
    requirements,
    dataFiles,
    parsedTests,
    kind: source.kind,
    hasExplicitWaits: /Thread\.sleep|cy\.wait\(\s*\d|time\.sleep/.test(bodies),
    hasSecrets: /(password|api[_-]?key|secret|token)\s*[=:]\s*["'][^"']{3,}["']/i.test(bodies),
    unmapped: (bodies.match(/JavascriptExecutor|Robot|Actions\s+\w+|cy\.task\(/g) || []).length,
  };
}

/**
 * @returns {{ readiness:number, ready:boolean, questions:Array, answered:Array, satisfied:Array, blockingCount:number }}
 */
export async function assessSpec(spec, answers = {}, { withLlm = true } = {}) {
  const ctx = buildContext(spec, answers);
  const questions = [];
  const satisfied = [];
  let score = 0;
  const total = CHECKS.reduce((sum, check) => sum + check.weight, 0);

  for (const check of CHECKS) {
    const passes = check.test(ctx);
    const answered = Boolean(answers[check.key]);
    if (passes || answered) {
      score += check.weight;
      satisfied.push({ key: check.key, viaAnswer: !passes && answered });
      if (passes) continue;
    }
    const q = check.question(ctx);
    questions.push({
      id: check.key,
      required: check.required,
      weight: check.weight,
      answer: answers[check.key] || '',
      answered,
      origin: 'rules',
      ...q,
    });
  }

  const result = {
    readiness: Math.round((score / total) * 100),
    questions,
    satisfied,
    blockingCount: questions.filter((q) => q.required && !q.answered).length,
    context: {
      source: ctx.source.label,
      target: ctx.target.label,
      requirements: ctx.requirements.length,
      artifacts: (spec.artifacts || []).length,
      parsedTests: ctx.parsedTests,
      dataFiles: ctx.dataFiles.length,
    },
    llm: { used: false, detail: 'Rule engine only.' },
  };

  if (withLlm && llmAvailable()) {
    const extra = await askLlmForQuestions(ctx, result);
    if (extra?.__error) {
      result.llm = { used: false, detail: extra.__error };
    } else if (extra?.questions?.length) {
      const cap = getSettings().maxQuestions;
      for (const q of extra.questions.slice(0, Math.max(0, cap - result.questions.length))) {
        result.questions.push({
          id: `llm-${id('q')}`,
          required: false,
          weight: 0,
          answer: answers[q.id] || '',
          answered: false,
          origin: 'llm',
          kind: q.options?.length ? 'choice' : 'text',
          options: q.options || [],
          field: 'notes',
          severity: q.severity || 'minor',
          question: q.question,
          why: q.why || 'Raised by the model from the specifics of this spec.',
        });
      }
      result.llm = { used: true, detail: `${extra.questions.length} extra question(s) from ${extra.__model}.` };
    } else {
      result.llm = { used: true, detail: 'Model had no further questions.' };
    }
  }

  result.ready = result.blockingCount === 0 && result.readiness >= 70;
  return result;
}

async function askLlmForQuestions(ctx, ruleResult) {
  const sample = (ctx.spec.artifacts || [])
    .slice(0, 3)
    .map((a) => `--- ${a.path}\n${(a.content || '').slice(0, 1500)}`)
    .join('\n\n');

  return assist({
    task: 'interview',
    system:
      'You review migration specs and ask only the questions a senior engineer would need answered before starting. Never ask something already answered by the spec. Never ask more than 4 questions.',
    prompt: `Source stack: ${ctx.spec.sourceStack}
Target stack: ${ctx.spec.targetStack}
Requirements:
${ctx.spec.requirements || '(none)'}
Constraints: ${ctx.spec.constraints || '(none)'}
Questions the rule engine is already asking: ${ruleResult.questions.map((q) => q.question).join(' | ') || '(none)'}

Artifact sample:
${sample || '(no artifacts)'}

Return {"questions":[{"question":"...","why":"...","options":["..."],"severity":"blocker|major|minor"}]}`,
    maxTokens: 1200,
  });
}

/** Folds interview answers back into the spec so downstream stages act on them. */
export function applyAnswers(spec, answers = {}) {
  const next = { ...spec };
  const set = (field, value) => {
    if (!value || String(value).startsWith('Other')) return;
    if (field === 'requirements') next.requirements = [next.requirements, value].filter(Boolean).join('\n');
    else if (field === 'notes') next.constraints = [next.constraints, value].filter(Boolean).join('\n');
    else next[field] = value;
  };

  for (const check of CHECKS) {
    const answer = answers[check.key];
    if (!answer) continue;
    const field = check.question(buildContext(spec, answers)).field;
    if (field === 'artifacts') continue;
    set(field, answer);
  }

  next.clarifications = { ...(spec.clarifications || {}), ...answers };
  return next;
}

export const INTERVIEW_CHECKS = CHECKS.map((c) => ({ key: c.key, weight: c.weight, required: c.required }));
