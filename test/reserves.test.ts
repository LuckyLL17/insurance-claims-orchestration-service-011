import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';
import { JournalEntry } from '../src/domain/journal';

const report = (gross = 18000) => ({
  policyId: 'P-100',
  lossAt: '2026-08-01T08:00:00Z',
  reportedAt: '2026-08-01T09:00:00Z',
  channel: 'mobile',
  participants: [{ kind: 'vehicle' as const, id: 'car-1' }],
  loss: { currency: 'CNY', gross },
});

const accountBalance = (entries: JournalEntry[], account: string) =>
  entries.reduce((sum, entry) => sum + entry.lines.filter((line) => line.account === account).reduce((acc, line) => acc + (line.direction === 'debit' ? line.amountMinor : -line.amountMinor), 0), 0);

const assertBalanced = (entries: JournalEntry[]) => {
  for (const entry of entries) {
    const debit = entry.lines.filter((line) => line.direction === 'debit').reduce((sum, line) => sum + line.amountMinor, 0);
    const credit = entry.lines.filter((line) => line.direction === 'credit').reduce((sum, line) => sum + line.amountMinor, 0);
    assert.equal(debit, credit, `entry ${entry.id} (${entry.kind}) must balance`);
    assert.equal(entry.totalMinor, debit);
  }
};

test('full lifecycle produces traceable reserve versions and balanced entries', () => {
  const app = buildApp();
  const claim = app.claims.create(report(), 'test');

  // 初始估损：18000 CNY - 500 免赔 = 17500 CNY，按 3 个责任险种拆分
  const initial = app.reserves.current(claim.id);
  assert.equal(initial.totals.incurredMinor, 1_750_000);
  assert.equal(initial.totals.outstandingMinor, 1_750_000);
  assert.equal(initial.totals.paidMinor, 0);
  assert.equal(initial.totals.recoverableMinor, 0);
  assert.equal(initial.lines.length, 3);
  assert.equal(initial.lines.find((line) => line.coverage === 'collision')?.incurredMinor, 583_334);
  assert.equal(initial.lines.find((line) => line.coverage === 'theft')?.incurredMinor, 583_333);
  assert.equal(initial.lines.find((line) => line.coverage === 'rental')?.incurredMinor, 583_333);
  assert.ok(initial.lines.every((line) => line.category === 'indemnity'));

  // 人工调整：碰撞险上调 1000 CNY，新增查勘费 200 CNY
  app.reserves.adjust(claim.id, { reason: '查勘后上调车损并确认查勘费', moves: [
    { coverage: 'collision', category: 'indemnity', deltaMinor: 100_000 },
    { coverage: 'collision', category: 'survey_fee', deltaMinor: 20_000 },
  ] }, 'adjuster');
  // 人工调整：租赁险下调
  app.reserves.adjust(claim.id, { reason: '核减租赁费用', moves: [{ coverage: 'rental', category: 'indemnity', deltaMinor: -83_333 }] }, 'adjuster');
  let current = app.reserves.current(claim.id);
  assert.equal(current.totals.incurredMinor, 1_786_667);
  assert.equal(current.lines.find((line) => line.coverage === 'collision' && line.category === 'survey_fee')?.incurredMinor, 20_000);

  // 责任确认：碰撞 60%、盗窃 40%，租赁险责任清零，已发生损失总额不变
  app.reserves.confirmLiability(claim.id, { reason: '交警责任认定书', shares: [{ coverage: 'collision', share: 0.6 }, { coverage: 'theft', share: 0.4 }] }, 'adjuster');
  current = app.reserves.current(claim.id);
  assert.equal(current.totals.incurredMinor, 1_786_667);
  assert.equal(current.lines.find((line) => line.coverage === 'collision' && line.category === 'indemnity')?.incurredMinor, 1_060_000);
  assert.equal(current.lines.find((line) => line.coverage === 'theft' && line.category === 'indemnity')?.incurredMinor, 706_667);
  assert.equal(current.lines.find((line) => line.coverage === 'rental' && line.category === 'indemnity')?.incurredMinor, 0);
  assert.equal(current.lines.find((line) => line.coverage === 'theft' && line.category === 'survey_fee')?.incurredMinor, 8_000);

  // 赔付授权：5000 CNY，未决总额不变，授权额增加
  app.payments.authorize(claim.id, { amount: 5000, currency: 'CNY', sourceId: 'auth-1' }, 'approver');
  current = app.reserves.current(claim.id);
  assert.equal(current.totals.authorizedMinor, 500_000);
  assert.equal(current.totals.outstandingMinor, 1_786_667);

  // 赔付支付：3000 CNY，先冲减已授权部分
  app.claims.addEvent(claim.id, 'adjustment.approved', { approvedMinor: 2_000_000, requiredEvidence: [] }, 'adjuster');
  app.payments.settle(claim.id, { amount: 3000, currency: 'CNY', sourceId: 'pay-1' }, 'cashier');
  current = app.reserves.current(claim.id);
  assert.equal(current.totals.paidMinor, 300_000);
  assert.equal(current.totals.authorizedMinor, 200_000);
  assert.equal(current.totals.outstandingMinor, 1_486_667);

  // 结案：释放全部未决准备金，已发生损失收敛为已支付
  app.claims.close(claim.id, 'adjuster');
  current = app.reserves.current(claim.id);
  assert.equal(current.closed, true);
  assert.equal(current.totals.outstandingMinor, 0);
  assert.equal(current.totals.authorizedMinor, 0);
  assert.equal(current.totals.incurredMinor, 300_000);
  assert.equal(current.totals.paidMinor, 300_000);
  assert.equal(app.claims.get(claim.id).status, 'settled');

  // 每个生命周期阶段都有版本与分录，分录借贷平衡
  const evolution = app.reserves.evolution(claim.id);
  assert.deepEqual(evolution.map((version) => version.reason), ['initial-estimate', '查勘后上调车损并确认查勘费', '核减租赁费用', '交警责任认定书', 'payment-authorized', 'payment-settled', 'claim-closed']);
  assert.ok(evolution.every((version, index) => version.version === index + 1 && version.sourceEventId));
  const entries = app.reserves.journal(claim.id);
  assert.equal(entries.length, 7);
  assertBalanced(entries);
  assert.equal(accountBalance(entries, 'loss_reserve'), 0);
  assert.equal(accountBalance(entries, 'claims_payable'), 0);
  assert.equal(accountBalance(entries, 'incurred_loss'), 300_000);
  assert.equal(accountBalance(entries, 'cash'), -300_000);

  // 历史重放与实时演进一致
  for (const version of evolution) {
    assert.deepEqual(app.reserves.replayAt(claim.id, version.triggerSequence).totals, version.totals, `replay at version ${version.version}`);
  }
});

test('duplicate and replayed events keep entries idempotent', () => {
  const app = buildApp();
  const claim = app.claims.create(report(), 'test');
  const before = app.reserves.current(claim.id);

  // 相同幂等键的调整只入账一次
  app.reserves.adjust(claim.id, { reason: '上调', moves: [{ coverage: 'collision', category: 'indemnity', deltaMinor: 50_000 }] }, 'adjuster', 'adjust-key-1');
  app.reserves.adjust(claim.id, { reason: '上调', moves: [{ coverage: 'collision', category: 'indemnity', deltaMinor: 50_000 }] }, 'adjuster', 'adjust-key-1');
  let current = app.reserves.current(claim.id);
  assert.equal(current.totals.incurredMinor, before.totals.incurredMinor + 50_000);
  assert.equal(current.versions.length, 2);
  assert.equal(current.entries.length, 2);

  // 事件流中出现重复事件（同一 event id）时投影幂等去重
  const events = app.events.list(claim.id);
  app.events.replace(claim.id, [...events, ...events]);
  current = app.reserves.current(claim.id);
  assert.equal(current.totals.incurredMinor, before.totals.incurredMinor + 50_000);
  assert.equal(current.versions.length, 2);
  assert.equal(current.entries.length, 2);
  assertBalanced(current.entries);
});

test('out-of-order occurredAt does not change balances and replay stays consistent', () => {
  const app = buildApp();
  const ordered = app.claims.create(report(), 'test');
  app.reserves.adjust(ordered.id, { reason: '上调', moves: [{ coverage: 'theft', category: 'indemnity', deltaMinor: 70_000 }] }, 'adjuster');

  const disordered = app.claims.create(report(), 'test');
  app.claims.addEvent(disordered.id, 'reserve.adjusted', { moves: [{ coverage: 'theft', category: 'indemnity', deltaMinor: 70_000 }], reason: '上调' }, 'adjuster', undefined, '2026-07-01T00:00:00Z');

  assert.deepEqual(app.reserves.current(disordered.id).totals, app.reserves.current(ordered.id).totals);
  assert.deepEqual(app.reserves.current(disordered.id).lines, app.reserves.current(ordered.id).lines);
  for (const version of app.reserves.evolution(disordered.id)) {
    assert.deepEqual(app.reserves.replayAt(disordered.id, version.triggerSequence).totals, version.totals);
  }
});

test('reversal, reopen and recovery keep four buckets and accounts consistent', () => {
  const app = buildApp();
  const claim = app.claims.create(report(), 'test');
  app.claims.addEvent(claim.id, 'adjustment.approved', { approvedMinor: 2_000_000, requiredEvidence: [] }, 'adjuster');
  app.payments.settle(claim.id, { amount: 2000, currency: 'CNY', sourceId: 'pay-1' }, 'cashier');
  let current = app.reserves.current(claim.id);
  assert.equal(current.totals.paidMinor, 200_000);
  assert.equal(current.totals.outstandingMinor, 1_550_000);

  // 冲正：已支付转为待追回，未决准备金恢复
  app.payments.reverse(claim.id, { amount: 2000, currency: 'CNY', sourceId: 'rev-1' }, 'cashier');
  app.claims.addEvent(claim.id, 'claim.reopened', { reason: '受益人异议' }, 'adjuster');
  current = app.reserves.current(claim.id);
  assert.equal(current.totals.paidMinor, 0);
  assert.equal(current.totals.recoverableMinor, 200_000);
  assert.equal(current.totals.outstandingMinor, 1_750_000);
  assert.equal(app.claims.get(claim.id).status, 'reopened');

  // 部分追回
  app.payments.recover(claim.id, { amount: 800, currency: 'CNY', sourceId: 'rec-1' }, 'cashier');
  current = app.reserves.current(claim.id);
  assert.equal(current.totals.recoverableMinor, 120_000);

  const entries = app.reserves.journal(claim.id);
  assertBalanced(entries);
  assert.equal(accountBalance(entries, 'recoverable'), current.totals.recoverableMinor);
  assert.equal(accountBalance(entries, 'cash'), -120_000);
  // loss_reserve 为贷方负债科目：借方正数约定下余额 = -(未决 - 已授权)
  assert.equal(accountBalance(entries, 'loss_reserve'), -(current.totals.outstandingMinor - current.totals.authorizedMinor));
  for (const version of app.reserves.evolution(claim.id)) {
    assert.deepEqual(app.reserves.replayAt(claim.id, version.triggerSequence).totals, version.totals);
  }
});

test('period summary reconciles opening, activity and closing per claim and in aggregate', () => {
  const app = buildApp();
  const claimA = app.claims.create(report(), 'test');
  app.claims.addEvent(claimA.id, 'reserve.adjusted', { moves: [{ coverage: 'collision', category: 'indemnity', deltaMinor: 100_000 }], reason: '八月调整' }, 'adjuster', undefined, '2026-08-15T10:00:00Z');
  app.claims.addEvent(claimA.id, 'reserve.adjusted', { moves: [{ coverage: 'collision', category: 'legal_fee', deltaMinor: 30_000 }], reason: '九月诉讼费' }, 'adjuster', undefined, '2026-09-10T10:00:00Z');
  const claimB = app.claims.create(report(6000), 'test');

  const august = app.reserves.summary({ claimId: claimA.id, from: '2026-08-01T00:00:00Z', to: '2026-08-31T23:59:59Z' });
  assert.equal(august.claims.length, 1);
  assert.equal(august.claims[0].opening.incurredMinor, 0);
  assert.equal(august.claims[0].closing.incurredMinor, 1_850_000);
  assert.equal(august.claims[0].activity.incurredDeltaMinor, 1_850_000);
  assert.deepEqual(august.claims[0].activity.byReason.map((bucket) => bucket.reason).sort(), ['initial-estimate', '八月调整']);

  const september = app.reserves.summary({ claimId: claimA.id, from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' });
  assert.equal(september.claims[0].opening.incurredMinor, 1_850_000);
  assert.equal(september.claims[0].activity.incurredDeltaMinor, 30_000);
  assert.equal(september.claims[0].closing.incurredMinor, 1_880_000);
  assert.equal(september.claims[0].opening.incurredMinor + september.claims[0].activity.incurredDeltaMinor, september.claims[0].closing.incurredMinor);

  // 全组合汇总：B 案件 6000 - 500 免赔 = 5500 CNY
  const all = app.reserves.summary({ from: '2026-08-01T00:00:00Z', to: '2026-12-31T23:59:59Z' });
  assert.equal(all.claims.length, 2);
  assert.equal(all.totals.closing.incurredMinor, 1_880_000 + 550_000);
  assert.equal(all.totals.opening.incurredMinor + all.totals.incurredDeltaMinor, all.totals.closing.incurredMinor);
});

test('journal entry audit chain links entry, source event, movements and versions', () => {
  const app = buildApp();
  const claim = app.claims.create(report(), 'test');
  app.claims.addEvent(claim.id, 'adjustment.approved', { approvedMinor: 2_000_000, requiredEvidence: [] }, 'adjuster');
  app.payments.settle(claim.id, { amount: 1000, currency: 'CNY', sourceId: 'pay-1' }, 'cashier');

  const entries = app.reserves.journal(claim.id);
  const initialAudit = app.reserves.entryAudit(claim.id, entries[0].id);
  assert.equal(initialAudit.entry.kind, 'initial-estimate');
  assert.equal(initialAudit.sourceEvent?.type, 'claim.reported');
  assert.equal(initialAudit.previousVersion, null);
  assert.equal(initialAudit.movements.length, 3);
  assert.ok(initialAudit.claimAudit.some((item) => item.eventId === initialAudit.entry.sourceEventId));

  const settled = entries.find((entry) => entry.kind === 'payment-settled');
  assert.ok(settled);
  const settledAudit = app.reserves.entryAudit(claim.id, settled.id);
  assert.equal(settledAudit.sourceEvent?.type, 'payment.settled');
  assert.ok(settledAudit.movements.some((movement) => movement.paidDeltaMinor === 100_000));
  assert.equal(settledAudit.version?.totals.paidMinor, 100_000);
  assert.equal(settledAudit.previousVersion?.totals.paidMinor, 0);
  assert.ok(settledAudit.version && settledAudit.previousVersion && settledAudit.version.version === settledAudit.previousVersion.version + 1);
  assert.throws(() => app.reserves.entryAudit(claim.id, 'je_missing'), /unknown journal entry/);
});

test('adjustment and liability commands enforce validation and reasons', () => {
  const app = buildApp();
  const claim = app.claims.create(report(), 'test');
  assert.throws(() => app.reserves.adjust(claim.id, { reason: '', moves: [{ coverage: 'collision', category: 'indemnity', deltaMinor: 1 }] }, 'adjuster'), /reason is required/);
  assert.throws(() => app.reserves.adjust(claim.id, { reason: 'x', moves: [] }, 'adjuster'), /at least one/);
  assert.throws(() => app.reserves.adjust(claim.id, { reason: 'x', moves: [{ coverage: 'collision', category: 'indemnity', deltaMinor: 0 }] }, 'adjuster'), /non-zero/);
  assert.throws(() => app.reserves.adjust(claim.id, { reason: 'x', moves: [{ coverage: 'collision', category: 'indemnity', deltaMinor: -999_999_999 }] }, 'adjuster'), /negative/);
  assert.throws(() => app.reserves.confirmLiability(claim.id, { reason: 'x', shares: [{ coverage: 'collision', share: 0.5 }] }, 'adjuster'), /sum to 1/);
  assert.throws(() => app.reserves.confirmLiability(claim.id, { reason: '', shares: [{ coverage: 'collision', share: 1 }] }, 'adjuster'), /reason is required/);
  assert.throws(() => app.payments.authorize(claim.id, { amount: 0, currency: 'CNY', sourceId: 'a-0' }, 'approver'), /positive/);
  assert.throws(() => app.reserves.current('claim_missing'), /unknown claim/);
  // 校验失败不应产生任何版本或分录
  assert.equal(app.reserves.evolution(claim.id).length, 1);
  assert.equal(app.reserves.journal(claim.id).length, 1);
});

test('reopen after closure restarts the reserve cycle with consistent balances', () => {
  const app = buildApp();
  const claim = app.claims.create(report(), 'test');
  app.claims.addEvent(claim.id, 'adjustment.approved', { approvedMinor: 2_000_000, requiredEvidence: [] }, 'adjuster');
  app.payments.settle(claim.id, { amount: 1000, currency: 'CNY', sourceId: 'pay-1' }, 'cashier');
  app.claims.close(claim.id, 'adjuster');
  let current = app.reserves.current(claim.id);
  assert.equal(current.totals.outstandingMinor, 0);
  assert.equal(current.totals.incurredMinor, 100_000);

  // 重开：产生标记版本，随后可重新计提
  app.claims.addEvent(claim.id, 'claim.reopened', { reason: '新增损失项目' }, 'adjuster');
  app.reserves.adjust(claim.id, { reason: '重开后追加估损', moves: [{ coverage: 'collision', category: 'indemnity', deltaMinor: 250_000 }] }, 'adjuster');
  current = app.reserves.current(claim.id);
  assert.equal(current.closed, false);
  assert.equal(current.totals.outstandingMinor, 250_000);
  assert.equal(current.totals.incurredMinor, 350_000);
  assert.equal(current.totals.paidMinor, 100_000);

  // 再次结案：只释放重开后新增的未决部分
  app.claims.close(claim.id, 'adjuster');
  current = app.reserves.current(claim.id);
  assert.equal(current.totals.outstandingMinor, 0);
  assert.equal(current.totals.incurredMinor, 100_000);
  const entries = app.reserves.journal(claim.id);
  assertBalanced(entries);
  assert.equal(accountBalance(entries, 'loss_reserve'), 0);
  assert.equal(accountBalance(entries, 'incurred_loss'), 100_000);
  for (const version of app.reserves.evolution(claim.id)) {
    assert.deepEqual(app.reserves.replayAt(claim.id, version.triggerSequence).totals, version.totals);
  }
});

test('closure is idempotent and rejected claims release reserves', () => {
  const app = buildApp();
  const claim = app.claims.create(report(), 'test');
  app.claims.close(claim.id, 'adjuster');
  const closedOnce = app.reserves.current(claim.id);
  app.claims.close(claim.id, 'adjuster');
  const closedTwice = app.reserves.current(claim.id);
  assert.equal(closedOnce.versions.length, closedTwice.versions.length);
  assert.equal(closedTwice.totals.outstandingMinor, 0);

  const rejected = app.claims.create(report(), 'test');
  app.claims.addEvent(rejected.id, 'claim.rejected', { reason: '不在保险责任范围' }, 'adjuster');
  const projection = app.reserves.current(rejected.id);
  assert.equal(projection.totals.outstandingMinor, 0);
  assert.equal(projection.totals.incurredMinor, 0);
  const release = projection.entries.find((entry) => entry.kind === 'rejection-release');
  assert.ok(release);
  assertBalanced(projection.entries);
});
