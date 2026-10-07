import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';
import { ACCOUNTS } from '../src/domain/reserve-projector';

function openClaim(app: ReturnType<typeof buildApp>, gross = 18000) {
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent', participants: [{ kind: 'vehicle', id: 'car-9' }], loss: { currency: 'CNY', gross } }, 'test');
  // 通过理算审批，使 approvedMinor 可用于支付（与既有支付上限保护保持一致）
  app.claims.addEvent(claim.id, 'adjustment.approved', { approvedMinor: Math.round(gross * 100), requiredEvidence: [] }, 'adjuster', `appr:${claim.id}`);
  return claim;
}

const C = 'collision';
const LABOR = 'labor';
const PARTS = 'parts';

test('reserve lifecycle: estimate -> adjust -> confirm -> authorize -> settle keeps balanced entries and recomputable cells', () => {
  const app = buildApp();
  const claim = openClaim(app);

  // 1) 初始估损：按责任险种 × 费用类别拆分（1000 元工时 + 2000 元配件，单位：分）
  let v = app.reserves.estimate(claim.id, 'CNY', [{ coverage: C, feeCategory: LABOR, amountMinor: 100000 }, { coverage: C, feeCategory: PARTS, amountMinor: 200000 }], 'adjuster', 'initial loss survey');
  assert.equal(v.cells.length, 2);
  assert.equal(v.totals[0].incurredMinor, 300000);
  assert.equal(v.totals[0].outstandingMinor, 300000);

  // 2) 人工调整：工时 +500（补件后维修厂加价），记录原因
  v = app.reserves.adjust(claim.id, 'CNY', [{ coverage: C, feeCategory: LABOR, amountMinor: 50000 }], 'adjuster', 'repair shop revised quote after teardown');
  assert.equal(v.totals[0].incurredMinor, 350000);
  assert.equal(v.totals[0].outstandingMinor, 350000);

  // 3) 责任确认：目标工时 1600、配件 1900（配件下调 100）
  v = app.reserves.confirmLiability(claim.id, 'CNY', [{ coverage: C, feeCategory: LABOR, amountMinor: 160000 }, { coverage: C, feeCategory: PARTS, amountMinor: 190000 }], 'manager', 'liability established');
  assert.equal(v.totals[0].incurredMinor, 350000); // 总额不变（+100 / -100）

  // 4) 赔付授权 3400：未决 -> 应付
  v = app.reserves.authorize(claim.id, { currency: 'CNY', authorizationId: 'AUTH-1', lines: [{ coverage: C, feeCategory: LABOR, amountMinor: 150000 }, { coverage: C, feeCategory: PARTS, amountMinor: 190000 }] }, 'manager');
  assert.equal(v.totals[0].outstandingMinor, 10000);
  assert.equal(v.totals[0].payableMinor, 340000);

  // 5) 支付（核销授权）
  v = app.reserves.settle(claim.id, { currency: 'CNY', sourceId: 'PAY-1', stage: 'settled', authorizationId: 'AUTH-1', lines: [{ coverage: C, feeCategory: LABOR, amountMinor: 150000 }, { coverage: C, feeCategory: PARTS, amountMinor: 190000 }] }, 'cashier');
  const t = v.totals[0];
  assert.equal(t.payableMinor, 0);
  assert.equal(t.paidMinor, 340000);
  assert.equal(t.outstandingMinor, 10000);

  // 恒等式：incurred = outstanding + payable + paid - recovered + released（无追回/释放）
  assert.equal(t.incurredMinor, t.outstandingMinor + t.payableMinor + t.paidMinor - t.recoveredMinor + t.releasedMinor);

  // 每张凭证借贷平衡、试算平衡、凭证行独立重算与折叠一致
  const check = app.reserves.verifyConsistency(claim.id);
  assert.equal(check.equal, true, check.balance.violations.join('; '));
  assert.equal(check.balance.entriesBalanced, true);
  assert.equal(check.balance.trialBalanceZero, true);
  assert.equal(check.balance.cellsRecomputable, true);

  // 已发生损失费用科目余额 3500；银行存款 -3400；未决准备金负债 -100
  assert.equal(check.live.accountBalances[ACCOUNTS.EXP_LOSS_INCURRED], 350000);
  assert.equal(check.live.accountBalances[ACCOUNTS.CASH], -340000);
  assert.equal(check.live.accountBalances[ACCOUNTS.RES_OUTSTANDING], -10000);
});

test('reserve versions are immutable and traceable back to source events and reasons', () => {
  const app = buildApp();
  const claim = openClaim(app);
  app.reserves.estimate(claim.id, 'CNY', [{ coverage: C, feeCategory: LABOR, amountMinor: 100000 }], 'adjuster', 'v1');
  app.reserves.adjust(claim.id, 'CNY', [{ coverage: C, feeCategory: LABOR, amountMinor: 20000 }], 'adjuster', 'v2 reason');
  const evo = app.reserves.evolution(claim.id);
  assert.equal(evo.versions.length, 2);
  assert.equal(evo.versions[0].reason, 'initial_estimate');
  assert.equal(evo.versions[1].reason, 'manual_adjustment');
  assert.equal(evo.versions[1].reasonNote, 'v2 reason');
  // 版本快照：首版本 1000，次版本 1200
  assert.equal(evo.versions[0].cells[0].incurredMinor, 100000);
  assert.equal(evo.versions[1].cells[0].incurredMinor, 120000);
  // 每个版本都能定位到来源事件
  for (const version of evo.versions) assert.ok(version.eventId && version.eventSequence > 0);
});

test('duplicate commands are idempotent: same idempotency key returns same state without double posting', () => {
  const app = buildApp();
  const claim = openClaim(app);
  const first = app.reserves.estimate(claim.id, 'CNY', [{ coverage: C, feeCategory: LABOR, amountMinor: 100000 }], 'adjuster', 'dup', 'key-est-1');
  assert.equal(first.entries.length, 1);
  // 同一幂等键重复投递：短路返回当前视图，不产生第二个事件/凭证
  const again = app.reserves.estimate(claim.id, 'CNY', [{ coverage: C, feeCategory: LABOR, amountMinor: 100000 }], 'adjuster', 'dup', 'key-est-1');
  assert.equal(again.entries.length, 1);
  assert.equal(again.totals[0].incurredMinor, 100000);
  // 不同幂等键的重复首估（真重放攻击）仍被业务校验拒绝
  assert.throws(() => app.reserves.estimate(claim.id, 'CNY', [{ coverage: C, feeCategory: LABOR, amountMinor: 100000 }], 'adjuster', 'dup', 'key-est-2'), /already estimated/);
});

test('projector ignores duplicate event ids and derives stable entry ids', () => {
  const app = buildApp();
  const claim = openClaim(app);
  app.reserves.estimate(claim.id, 'CNY', [{ coverage: C, feeCategory: LABOR, amountMinor: 100000 }], 'adjuster', 'x', 'stable-key');
  const events = app.replay.execute(claim.id).events;
  const reserveEvents = events.filter((e) => e.type === 'reserve.estimated');
  assert.equal(reserveEvents.length, 1);

  // 手动构造事件流：重复 + 乱序（estimate 事件复制两份并打乱顺序），折叠结果必须相同
  const dup = reserveEvents[0];
  const noisy = [
    ...events.filter((e) => e.id !== dup.id),
    { ...dup, sequence: 99 },
    { ...dup, sequence: 1 },
  ];
  const projector = new (require('../src/domain/reserve-projector').ReserveProjector)();
  const view = projector.fold(claim.id, noisy);
  assert.equal(view.entries.length, 1); // 重复事件不产生重复凭证
  assert.equal(view.totals[0].incurredMinor, 100000);

  // 乱序重放 vs 实时
  const live = app.reserves.view(claim.id);
  assert.equal(JSON.stringify(live.cells), JSON.stringify(view.cells));
});

test('out-of-order historical replay yields identical balances to real-time processing', () => {
  const app = buildApp();
  const claim = openClaim(app);
  app.reserves.estimate(claim.id, 'CNY', [{ coverage: C, feeCategory: PARTS, amountMinor: 500000 }], 'adjuster', 'init');
  app.reserves.adjust(claim.id, 'CNY', [{ coverage: C, feeCategory: PARTS, amountMinor: -50000 }], 'adjuster', 'negotiated discount');
  app.reserves.authorize(claim.id, { currency: 'CNY', authorizationId: 'A2', lines: [{ coverage: C, feeCategory: PARTS, amountMinor: 400000 }] }, 'manager');
  app.reserves.settle(claim.id, { currency: 'CNY', sourceId: 'P2', stage: 'settled', authorizationId: 'A2', lines: [{ coverage: C, feeCategory: PARTS, amountMinor: 400000 }] }, 'cashier');

  const result = app.reserves.verifyConsistency(claim.id);
  assert.equal(result.equal, true);
  // 全量重放（ReplayService）与实时余额一致
  const replayed = app.replay.execute(claim.id);
  assert.equal(JSON.stringify(replayed.reserve.totals), JSON.stringify(result.live.totals));
  // 区间重放：截至授权后，应付 4000
  const partial = app.replay.execute(claim.id, replayed.events.find((e) => e.type === 'payment.authorized')!.sequence);
  assert.equal(partial.reserve.totals[0].payableMinor, 400000);
  assert.equal(partial.reserve.totals[0].paidMinor, 0);
});

test('reversal of settlement rebooks payable, reduces paid, and links the audit chain', () => {
  const app = buildApp();
  const claim = openClaim(app);
  app.reserves.estimate(claim.id, 'CNY', [{ coverage: C, feeCategory: PARTS, amountMinor: 300000 }], 'adjuster', 'init');
  app.reserves.authorize(claim.id, { currency: 'CNY', authorizationId: 'A3', lines: [{ coverage: C, feeCategory: PARTS, amountMinor: 300000 }] }, 'manager');
  app.reserves.settle(claim.id, { currency: 'CNY', sourceId: 'P3', stage: 'settled', authorizationId: 'A3', lines: [{ coverage: C, feeCategory: PARTS, amountMinor: 300000 }] }, 'cashier');

  const rev = app.reserves.reverseSettlement(claim.id, { currency: 'CNY', sourceId: 'P3', lines: [{ coverage: C, feeCategory: PARTS, amountMinor: 300000 }], reasonNote: 'bank rejected transfer, claim reopened' }, 'cashier');
  assert.equal(rev.totals[0].paidMinor, 0);
  assert.equal(rev.totals[0].payableMinor, 300000);
  assert.equal(app.claims.get(claim.id).status, 'reopened');

  // 审计链：冲正凭证指向原支付凭证，原凭证的 reversalEntryIds 包含冲正凭证
  const reversalEntry = rev.entries.find((e) => e.reason === 'payment_reversal')!;
  const audit = app.reserves.entryAudit(claim.id, reversalEntry.id);
  assert.ok(audit.reverses);
  assert.equal(audit.reverses!.entry.reason, 'payment_settlement');
  assert.ok(audit.reverses!.sourceEvent);
  const originalAudit = app.reserves.entryAudit(claim.id, audit.reverses!.entry.id);
  assert.deepEqual(originalAudit.reversals.map((r) => r.entry.id), [reversalEntry.id]);

  const check = app.reserves.verifyConsistency(claim.id);
  assert.equal(check.equal, true, check.balance.violations.join('; '));
});

test('claim close releases remaining reserve; reopen rebooks it with reversing entries', () => {
  const app = buildApp();
  const claim = openClaim(app);
  app.reserves.estimate(claim.id, 'CNY', [{ coverage: C, feeCategory: PARTS, amountMinor: 300000 }], 'adjuster', 'init');
  app.reserves.authorize(claim.id, { currency: 'CNY', authorizationId: 'A4', lines: [{ coverage: C, feeCategory: PARTS, amountMinor: 200000 }] }, 'manager');
  app.reserves.settle(claim.id, { currency: 'CNY', sourceId: 'P4', stage: 'settled', authorizationId: 'A4', lines: [{ coverage: C, feeCategory: PARTS, amountMinor: 200000 }] }, 'cashier');

  const closed = app.reserves.close(claim.id, 'CNY', 'manager', 'all documents finalized');
  assert.equal(closed.closed, true);
  assert.equal(closed.totals[0].outstandingMinor, 0);
  assert.equal(closed.totals[0].releasedMinor, 100000);
  assert.equal(app.claims.get(claim.id).status, 'closed');
  // 结案后不允许再授权/支付
  assert.throws(() => app.reserves.authorize(claim.id, { currency: 'CNY', authorizationId: 'X', lines: [] }, 'm'), /closed/);

  // 结案后允许新的冲正事件（乱序到达的银行退票）：先重开
  const reopened = app.reserves.reopen(claim.id, 'CNY', 'manager', 'late bank rejection arrived');
  assert.equal(reopened.closed, false);
  assert.equal(reopened.totals[0].releasedMinor, 0);
  assert.equal(reopened.totals[0].outstandingMinor, 100000);
  assert.equal(app.claims.get(claim.id).status, 'reopened');

  const check = app.reserves.verifyConsistency(claim.id);
  assert.equal(check.equal, true, check.balance.violations.join('; '));
});

test('expected recovery and realized recovery are tracked separately and balance the books', () => {
  const app = buildApp();
  const claim = openClaim(app);
  app.reserves.estimate(claim.id, 'CNY', [{ coverage: C, feeCategory: PARTS, amountMinor: 500000 }], 'adjuster', 'init');
  app.reserves.authorize(claim.id, { currency: 'CNY', authorizationId: 'A5', lines: [{ coverage: C, feeCategory: PARTS, amountMinor: 500000 }] }, 'manager');
  app.reserves.settle(claim.id, { currency: 'CNY', sourceId: 'P5', stage: 'settled', authorizationId: 'A5', lines: [{ coverage: C, feeCategory: PARTS, amountMinor: 500000 }] }, 'cashier');

  // 计提待追回（代位追偿）300
  let v = app.reserves.recordRecovery(claim.id, { currency: 'CNY', lines: [{ coverage: C, feeCategory: PARTS, amountMinor: 300000 }], reasonNote: 'subrogation against liable third party' }, 'legal');
  assert.equal(v.totals[0].recoverableMinor, 300000);
  assert.equal(v.totals[0].incurredMinor, 500000); // 已发生损失不受预计追回影响

  // 实现追回 300：现金收回
  v = app.reserves.realizeRecovery(claim.id, { currency: 'CNY', recoverySourceId: 'REC-1', lines: [{ coverage: C, feeCategory: PARTS, amountMinor: 300000 }] }, 'legal');
  assert.equal(v.totals[0].recoverableMinor, 0);
  assert.equal(v.totals[0].recoveredMinor, 300000);
  assert.equal(v.totals[0].netIncurredMinor, 200000); // 净已发生 = 500 - 300

  // 不能超额追回
  assert.throws(() => app.reserves.realizeRecovery(claim.id, { currency: 'CNY', recoverySourceId: 'REC-2', lines: [{ coverage: C, feeCategory: PARTS, amountMinor: 100 }] }, 'legal'), /exceeds recoverable/);

  const check = app.reserves.verifyConsistency(claim.id);
  assert.equal(check.equal, true, check.balance.violations.join('; '));
});

test('business guardrails: no over-authorization, no negative adjustments beyond reserve, close blocked with payable', () => {
  const app = buildApp();
  const claim = openClaim(app);
  app.reserves.estimate(claim.id, 'CNY', [{ coverage: C, feeCategory: LABOR, amountMinor: 100000 }], 'adjuster', 'init');
  assert.throws(() => app.reserves.authorize(claim.id, { currency: 'CNY', authorizationId: 'BIG', lines: [{ coverage: C, feeCategory: LABOR, amountMinor: 100001 }] }, 'm'), /exceeds outstanding/);
  assert.throws(() => app.reserves.adjust(claim.id, 'CNY', [{ coverage: C, feeCategory: LABOR, amountMinor: -100001 }], 'm', 'too much'), /negative|below zero/);
  app.reserves.authorize(claim.id, { currency: 'CNY', authorizationId: 'A6', lines: [{ coverage: C, feeCategory: LABOR, amountMinor: 100000 }] }, 'm');
  assert.throws(() => app.reserves.close(claim.id, 'CNY', 'm'), /payable outstanding/);
  // 未估损的单元格不能直接调整
  assert.throws(() => app.reserves.adjust(claim.id, 'CNY', [{ coverage: 'theft', feeCategory: LABOR, amountMinor: 100 }], 'm', 'x'), /unknown reserve cell/);
});

test('period summary aggregates movements by coverage and fee category within a window', () => {
  const app = buildApp();
  const claim = openClaim(app);
  app.reserves.estimate(claim.id, 'CNY', [{ coverage: C, feeCategory: LABOR, amountMinor: 100000 }, { coverage: C, feeCategory: PARTS, amountMinor: 200000 }], 'adjuster', 'init');

  const all = app.reserves.periodSummary(claim.id);
  const row = all.rows.find((r) => r.feeCategory === LABOR)!;
  assert.equal(row.incurredMinor, 100000);
  assert.equal(row.outstandingMinor, 100000);
  assert.equal(row.claimCount, 1);

  // 窗口早于案件事件：无数据
  const empty = app.reserves.periodSummary(claim.id, '2020-01-01T00:00:00Z', '2020-12-31T00:00:00Z');
  assert.equal(empty.rows.length, 0);

  // 跨案件汇总
  const claim2 = openClaim(app, 5000);
  app.reserves.estimate(claim2.id, 'CNY', [{ coverage: C, feeCategory: LABOR, amountMinor: 50000 }], 'adjuster', 'init');
  const globalRows = app.reserves.periodSummary(undefined).rows;
  const labor = globalRows.find((r) => r.coverage === C && r.feeCategory === LABOR)!;
  assert.equal(labor.incurredMinor, 150000);
  assert.equal(labor.claimCount, 2);
});

test('settlement without prior authorization (pay-as-authorize) works end to end', () => {
  const app = buildApp();
  const claim = openClaim(app);
  app.reserves.estimate(claim.id, 'CNY', [{ coverage: C, feeCategory: PARTS, amountMinor: 80000 }], 'adjuster', 'init');
  const v = app.reserves.settle(claim.id, { currency: 'CNY', sourceId: 'P7', stage: 'authorized', lines: [{ coverage: C, feeCategory: PARTS, amountMinor: 80000 }] }, 'cashier');
  assert.equal(v.totals[0].paidMinor, 80000);
  assert.equal(v.totals[0].outstandingMinor, 0);
  assert.equal(v.totals[0].payableMinor, 0);
  const check = app.reserves.verifyConsistency(claim.id);
  assert.equal(check.equal, true, check.balance.violations.join('; '));
});
