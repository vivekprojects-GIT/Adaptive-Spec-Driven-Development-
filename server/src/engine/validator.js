/**
 * Validator — every guardrail verdict is COMPUTED from the artifacts the run produced.
 *
 * Invariant #3: a check that cannot be evaluated returns `warn`, never `pass`. "We could not tell"
 * and "it is fine" are different answers and the report keeps them different.
 */

import { assist, llmAvailable } from '../lib/llm.js';

const CODE_KINDS = new Set(['code', 'config']);

function generatedCode(ws) {
  return ws.generated.filter((a) => CODE_KINDS.has(a.kind));
}

function countAssertionsIn(text, language) {
  if (language === 'python') return (text.match(/^\s*(assert\b|expect\()/gm) || []).length;
  return (text.match(/\bexpect\s*\(/g) || []).length;
}

function countTestsIn(text, language) {
  if (language === 'python') return (text.match(/^\s*def\s+test_/gm) || []).length;
  return (text.match(/\btest(?:\.skip)?\s*\(\s*['"`]/g) || []).length;
}

const CHECKS = {
  assertionParity({ discovery, ws, params }) {
    const expected = discovery.entities.assertions;
    if (!expected) return { status: 'warn', evidence: 'The source had no detectable assertions, so parity cannot be proven.' };
    const actual = generatedCode(ws)
      .filter((a) => !a.path.includes('_unmapped'))
      .reduce((sum, a) => sum + countAssertionsIn(a.content, a.language), 0);
    const tolerance = params.tolerance ?? 0;
    const status = actual + tolerance >= expected ? 'pass' : 'fail';
    return {
      status,
      evidence: `${expected} assertion(s) in the source, ${actual} in the generated output${tolerance ? ` (tolerance ${tolerance})` : ''}.`,
      metrics: { expected, actual },
    };
  },

  testCaseParity({ discovery, ws, params }) {
    const expected = discovery.entities.tests;
    if (!expected) return { status: 'warn', evidence: 'No source test cases were detected, so parity cannot be proven.' };
    const actual = generatedCode(ws)
      .filter((a) => !a.path.includes('_unmapped'))
      .reduce((sum, a) => sum + countTestsIn(a.content, a.language), 0);
    const status = actual + (params.tolerance ?? 0) >= expected ? 'pass' : 'fail';
    return {
      status,
      evidence: `${expected} source test case(s), ${actual} generated test(s).`,
      metrics: { expected, actual },
    };
  },

  dataParity({ discovery, ws }) {
    if (!discovery.entities.dataFiles) return { status: 'warn', evidence: 'No fixture files were present in the spec.' };
    const parity = ws.dataParity;
    if (!parity) return { status: 'warn', evidence: 'Fixtures exist but no data migration agent ran, so nothing verified the record counts.' };
    const status = parity.recordsIn === parity.recordsOut ? 'pass' : 'fail';
    return {
      status,
      evidence: `${parity.recordsIn} record(s) in, ${parity.recordsOut} record(s) out.`,
      metrics: parity,
    };
  },

  requirementCoverage({ discovery, ws, params }) {
    const total = discovery.requirements.length;
    if (!total) return { status: 'warn', evidence: 'The spec listed no requirements, so nothing can be traced.' };
    const trace = ws.traceability;
    if (!trace) return { status: 'warn', evidence: 'No traceability agent ran, so coverage was not computed.' };
    const min = params.minCoverage ?? 1;
    const ratio = trace.coveredRequirements / total;
    const status = ratio >= min ? 'pass' : trace.coveredRequirements > 0 ? 'fail' : 'fail';
    return {
      status,
      evidence: `${trace.coveredRequirements}/${total} requirement(s) reach a generated test. Orphans: ${trace.orphanRequirements.map((r) => r.id).join(', ') || 'none'}.`,
      metrics: { covered: trace.coveredRequirements, total, ratio: Number(ratio.toFixed(2)) },
    };
  },

  unmappedConstructs({ ws, params }) {
    const unmapped = ws.sourceModel?.unmapped || [];
    if (!unmapped.length) return { status: 'pass', evidence: 'No unmappable source constructs were found.' };
    const surfaced = ws.generated.some((a) => a.path.includes('_unmapped')) || Boolean(ws.commandMap?.some((r) => r.status === 'unmapped'));
    const max = params.maxUnmapped ?? 0;
    if (unmapped.length > max && !surfaced) {
      return { status: 'fail', evidence: `${unmapped.length} construct(s) have no target equivalent and nothing in the output records them.`, metrics: { unmapped: unmapped.length } };
    }
    return {
      status: 'warn',
      evidence: `${unmapped.length} construct(s) have no target equivalent; they are surfaced for a human: ${unmapped.map((u) => u.construct).join(', ')}.`,
      metrics: { unmapped: unmapped.length },
    };
  },

  structureSound({ ws }) {
    const report = ws.structureReport;
    if (!report) return { status: 'warn', evidence: 'No structure validator ran, so the generated code was never checked.' };
    if (report.blockers > 0) {
      return { status: 'fail', evidence: `${report.blockers} structural blocker(s): ${report.findings.filter((f) => f.severity === 'blocker').map((f) => `${f.file} — ${f.issue}`).join('; ')}`, metrics: report };
    }
    if (report.majors > 0) return { status: 'warn', evidence: `${report.majors} major structural finding(s).`, metrics: report };
    return { status: 'pass', evidence: `${report.filesChecked} file(s) structurally sound (${report.minors} minor note(s)).`, metrics: report };
  },

  noPii({ ws }) {
    const patterns = [
      { label: 'email address', re: /[\w.+-]+@(?!example\.(?:com|org))[\w-]+\.[\w.]{2,}/ },
      { label: 'card-like number', re: /\b(?:\d[ -]*?){13,16}\b/ },
      { label: 'national id', re: /\b\d{3}-\d{2}-\d{4}\b/ },
    ];
    const hits = [];
    for (const artifact of ws.generated) {
      for (const pattern of patterns) {
        const match = artifact.content.match(pattern.re);
        if (match) hits.push(`${artifact.path}: ${pattern.label} (${match[0].slice(0, 8)}…)`);
      }
    }
    return hits.length
      ? { status: 'fail', evidence: `PII found in generated output — ${hits.join('; ')}`, metrics: { hits: hits.length } }
      : { status: 'pass', evidence: `${ws.generated.length} generated artifact(s) scanned; no PII patterns matched.` };
  },

  noSecrets({ ws }) {
    const re = /(password|passwd|pwd|api[_-]?key|secret|token)\s*[=:]\s*['"][^'"]{3,}['"]/i;
    const hits = ws.generated.filter((a) => re.test(a.content) && !/process\.env|os\.environ/.test(a.content)).map((a) => a.path);
    return hits.length
      ? { status: 'fail', evidence: `Hardcoded credentials in: ${hits.join(', ')}.`, metrics: { hits: hits.length } }
      : { status: 'pass', evidence: 'No hardcoded credentials in generated output; secrets read from the environment.' };
  },

  coverageThreshold({ discovery, ws, params }) {
    const total = discovery.entities.tests;
    if (!total) return { status: 'warn', evidence: 'No source tests detected, so coverage is undefined.' };
    const trace = ws.traceability;
    const migrated = trace ? trace.rows.filter((r) => r.status === 'migrated').length : null;
    if (migrated === null) return { status: 'warn', evidence: 'No traceability agent ran, so migrated share is unknown.' };
    const ratio = migrated / total;
    const threshold = params.threshold ?? 0.9;
    return {
      status: ratio >= threshold ? 'pass' : 'fail',
      evidence: `${migrated}/${total} source test(s) migrated (${Math.round(ratio * 100)}%), threshold ${Math.round(threshold * 100)}%.`,
      metrics: { migrated, total, ratio: Number(ratio.toFixed(2)), threshold },
    };
  },

  apiContractParity({ ws }) {
    const requests = ws.sourceModel?.requests || [];
    if (!requests.length) return { status: 'warn', evidence: 'No API requests were detected in the source.' };
    const body = generatedCode(ws).map((a) => a.content).join('\n');
    const missing = requests.filter((req) => !body.includes(req.url));
    const wrongStatus = requests.filter((req) => body.includes(req.url) && !body.includes(`toBe(${req.expectedStatus})`));
    if (missing.length) {
      return { status: 'fail', evidence: `${missing.length}/${requests.length} request(s) missing from the generated suite: ${missing.slice(0, 5).map((r) => `${r.method} ${r.url}`).join(', ')}.`, metrics: { missing: missing.length, total: requests.length } };
    }
    if (wrongStatus.length) {
      return { status: 'warn', evidence: `${wrongStatus.length} request(s) present but their expected status was not asserted verbatim.`, metrics: { wrongStatus: wrongStatus.length } };
    }
    return { status: 'pass', evidence: `All ${requests.length} request contract(s) (method, path, expected status) preserved.` };
  },

  authCoverage({ ws }) {
    const schemes = ws.sourceModel?.auth || [];
    if (!schemes.length) return { status: 'warn', evidence: 'No auth scheme was detected in the source suite.' };
    const authFile = ws.generated.find((a) => a.path.startsWith('auth/'));
    if (!authFile) return { status: 'fail', evidence: `Source uses ${schemes.map((s) => s.scheme).join(', ')} but no auth setup was generated.` };
    const uncovered = schemes.filter((s) => !new RegExp(s.scheme, 'i').test(authFile.content) && !/setHTTPCredentials|Authorization/.test(authFile.content));
    return uncovered.length
      ? { status: 'fail', evidence: `Auth scheme(s) not handled: ${uncovered.map((s) => s.scheme).join(', ')}.` }
      : { status: 'pass', evidence: `Auth setup covers: ${schemes.map((s) => s.scheme).join(', ')}.` };
  },

  noPlaceholderOutput({ ws }) {
    const count = ws.placeholders || 0;
    return count
      ? { status: 'warn', evidence: `${count} generated agent(s) ran on the fallback adapter and produced placeholders, not finished work.`, metrics: { placeholders: count } }
      : { status: 'pass', evidence: 'Every agent in the graph had a real implementation.' };
  },

  manualSignOff({ guardrail }) {
    return {
      status: 'warn',
      evidence: `"${guardrail.name}" has no automated check — it requires a human sign-off before this run can be called done.`,
    };
  },

  /**
   * A rule a human wrote in plain English. With a model configured it is genuinely evaluated
   * against the artifacts in scope; without one it returns `warn` and asks for a sign-off,
   * because "we could not check this" must never render as green.
   */
  async customRule({ guardrail, ws, run }) {
    const rule = guardrail.rule || guardrail.description || guardrail.name;
    const scope = scopeArtifacts(guardrail, ws, run);

    if (!scope.artifacts.length) {
      return {
        status: 'warn',
        evidence: `Nothing in scope to check — ${scope.label} produced no artifacts.`,
      };
    }

    if (!llmAvailable()) {
      return {
        status: 'warn',
        evidence: `No model configured, so this rule was not evaluated. ${scope.artifacts.length} artifact(s) from ${scope.label} need a human sign-off against: "${rule}"`,
      };
    }

    const digest = scope.artifacts
      .map((a) => `--- ${a.path}\n${a.content.slice(0, 5000)}`)
      .join('\n\n')
      .slice(0, 40000);

    const response = await assist({
      task: 'rationale',
      maxTokens: 1200,
      system:
        'You are a migration guardrail. Judge ONLY the rule you are given against the artifacts provided. ' +
        'Answer "pass" only if the artifacts demonstrably satisfy the rule. Answer "fail" if they demonstrably violate it. ' +
        'Answer "warn" if the artifacts do not contain enough information to decide. Quote the specific evidence you used. ' +
        'Respond as {"status":"pass|fail|warn","evidence":"one or two sentences quoting what you saw"}',
      prompt: `RULE: ${rule}\n\nSOURCE FACTS: ${JSON.stringify(sourceFacts(ws))}\n\nARTIFACTS (${scope.label}):\n${digest}`,
    });

    if (!response || response.__error) {
      return { status: 'warn', evidence: `Rule could not be evaluated: ${response?.__error || 'model unavailable'}.` };
    }
    const status = ['pass', 'fail', 'warn'].includes(response.status) ? response.status : 'warn';
    return {
      status,
      evidence: `${response.evidence || 'The model returned no evidence.'} (judged by ${response.__model} over ${scope.artifacts.length} artifact(s) from ${scope.label})`,
    };
  },
};

/** Resolves a guardrail's `appliesTo` to the artifacts it should read. */
function scopeArtifacts(guardrail, ws, run) {
  const target = guardrail.appliesTo;
  if (!target || target === 'workflow') {
    return { label: 'the whole workflow', artifacts: ws.generated };
  }
  const nodes = (run?.nodes || []).filter((node) => node.agentId === target || node.nodeId === target);
  if (!nodes.length) return { label: `agent "${target}" (not in this graph)`, artifacts: [] };
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  return {
    label: nodes.map((node) => node.name).join(', '),
    artifacts: ws.generated.filter((artifact) => nodeIds.has(artifact.producedBy)),
  };
}

/** Counts a rule-evaluating model can check against, so it is not judging from prose alone. */
function sourceFacts(ws) {
  const model = ws.sourceModel;
  if (!model) return { sourceModel: 'not available' };
  return {
    suites: model.totals?.suites,
    tests: model.totals?.tests,
    assertions: model.totals?.assertions,
    dataRecords: model.totals?.dataRecords,
    requests: model.totals?.requests,
    unmapped: (model.unmapped || []).map((u) => u.construct),
  };
}

export async function runGuardrails(guardrails, context) {
  const results = [];
  for (const guardrail of guardrails) {
    const check = CHECKS[guardrail.check];
    const started = Date.now();
    let result;
    if (!check) {
      result = { status: 'warn', evidence: `No implementation registered for check "${guardrail.check}"; the verdict is unknown, not passing.` };
    } else {
      try {
        result = await check({ ...context, params: guardrail.params || {}, guardrail });
      } catch (err) {
        result = { status: 'warn', evidence: `Check threw: ${err.message}` };
      }
    }
    results.push({
      guardrailId: guardrail.guardrailId || guardrail.id,
      name: guardrail.name,
      severity: guardrail.severity,
      risks: guardrail.risks,
      check: guardrail.check,
      params: guardrail.params,
      appliesTo: guardrail.appliesTo || 'workflow',
      onFailure: guardrail.onFailure || 'flag',
      rule: guardrail.rule || null,
      ...result,
      ms: Date.now() - started,
    });
  }
  return results;
}

/** A failed guardrail whose author asked for the run to stop. */
export function shouldHalt(results) {
  return results.find((result) => result.status === 'fail' && result.onFailure === 'stop') || null;
}

export function verdictOf(results) {
  const blockingFail = results.some((r) => r.status === 'fail' && r.severity === 'blocker');
  const anyFail = results.some((r) => r.status === 'fail');
  if (blockingFail) return 'blocked';
  if (anyFail) return 'failed-checks';
  if (results.some((r) => r.status === 'warn')) return 'passed-with-warnings';
  return 'passed';
}

export const AVAILABLE_CHECKS = Object.keys(CHECKS);
