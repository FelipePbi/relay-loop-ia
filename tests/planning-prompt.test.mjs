/**
 * The planning prompt, against the registry it has to agree with.
 *
 * The prompt tells the Tech Lead which deterministic actions exist and then
 * says nothing outside the list runs. That makes it a SECOND copy of the
 * registry, and the copy drifted: `validate-ui` was added to
 * `deterministic-actions.mjs` and the prompt went on listing ten names, so the
 * planner could not name a gate that existed and the orchestrator could run.
 *
 * The list is derived now. This is what keeps it derived.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DETERMINISTIC_ACTION_NAMES } from '../lib/deterministic-actions.mjs';
import { buildPlanningPrompt } from '../workers/tech-lead.mjs';

const JOB = Object.freeze({
  jobId: '014-r2-tech_lead-planning',
  goal: '014',
  round: 2,
  worktree: '.ai-worktrees/plan-after-goal-014',
  migrationAcceptedBaseline: '108f88d4463498fc7fed0096955b0a241bcff71b',
});

test('the prompt names every action the registry permits', () => {
  const prompt = buildPlanningPrompt(JOB);

  for (const action of DETERMINISTIC_ACTION_NAMES) {
    assert.ok(
      prompt.includes(action),
      `the planner is never told "${action}" exists, so it can never name it`,
    );
  }
});

test('the prompt names no action the registry does not permit', () => {
  const prompt = buildPlanningPrompt(JOB);

  // The inverse drift: a name the prompt still advertises after the registry
  // dropped it produces a plan that fails validation at dispatch.
  for (const invented of ["'e2e-tests'", "'visual-regression'", "'deploy'"]) {
    assert.ok(!prompt.includes(invented), `prompt advertises ${invented}, which does not exist`);
  }
});

test('a Goal touching the frontend is told to place the rendered gate', () => {
  const prompt = buildPlanningPrompt(JOB);

  assert.match(prompt, /apps\/frontend/, "the frontend condition is not stated");
  assert.match(prompt, /validate-ui/, "the action to place is not named");
  assert.match(prompt, /depois de validate-core/, "the ordering constraint is not stated");
  // The gate serves the built app; placed before the build it would serve a
  // stale tree. The prompt has to say why, not just what.
  assert.match(prompt, /build servido/, "the reason for the ordering is not given");
});

test('the prompt refuses to let visual fidelity be claimed as proven', () => {
  const prompt = buildPlanningPrompt(JOB);

  // The gate measures; it does not judge whether a screen matches the approved
  // direction. A planner that writes that criterion as machine-verifiable sets
  // up a review that approves on trust.
  assert.match(prompt, /fidelidade visual/);
  assert.match(prompt, /conferência humana/);
});
