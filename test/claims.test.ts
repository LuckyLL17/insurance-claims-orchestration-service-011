import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';

test('creates a claim with a historical policy snapshot and replays it', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'mobile', participants: [{ kind: 'vehicle', id: 'car-1' }], loss: { currency: 'CNY', gross: 18000 } }, 'test', 'claim-key');
  assert.equal(claim.policy?.version, 2);
  const evidence = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'a' } }, 'test');
  const reviewed = app.claims.reviewEvidence(evidence.id, evidence.evidence[0].id, true, 'adjuster');
  assert.equal(reviewed.evidence[0].accepted, true);
  assert.equal(app.replay.execute(claim.id).state.version, reviewed.version);
});

test('prevents payment over approved amount and accepts idempotent risk assessment', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent', participants: [{ kind: 'vehicle', id: 'car-2' }, { kind: 'repair_shop', id: 'shop-1' }], loss: { currency: 'CNY', gross: 18000 } }, 'test');
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: 'photo' }, 'test');
  const assessed = app.risks.assess(claim.id, 'risk');
  assert.equal(assessed.riskScore, 0);
  assert.throws(() => app.payments.settle(claim.id, { amount: 1, currency: 'CNY', sourceId: 'p-1' }, 'pay'), /exceeds approved/);
});

test('rejects stale task submissions after lease version changes', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent', participants: [], loss: { currency: 'CNY', gross: 3000 } }, 'test');
  const task = app.tasks.create(claim.id, 'survey'); const lease = app.tasks.lease(claim.id, task.id, 'adjuster-a', 60_000);
  assert.throws(() => app.tasks.submit(claim.id, task.id, 'adjuster-a', lease.version - 1, {}, 'adjuster-a'), /stale/);
});
