import { EventStore } from './event-store';
import { ClaimService } from './claim-service';
import { PaymentLedger } from '../domain/payment-ledger';
import { DomainEvent } from '../domain/types';
import {
  ClaimClosedPayload,
  JournalEntry,
  JournalEntryAudit,
  PaymentReversedReservePayload,
  PeriodSummaryRow,
  RecoveryRecordedPayload,
  RecoveryRealizedPayload,
  ReserveAuthorizedPayload,
  ReserveBlock,
  ReserveCell,
  ReserveLineInput,
  ReserveReasonCode,
  ReserveView,
} from '../domain/reserve';
import { ReserveProjector, verifyReserveBalances, ReserveBalanceCheck } from '../domain/reserve-projector';

interface LineRequest { coverage: string; feeCategory: string; amountMinor: number }

export class ReserveService {
  private readonly projector = new ReserveProjector();

  constructor(
    private readonly events: EventStore,
    private readonly claims: ClaimService,
    private readonly payments: PaymentLedger,
  ) {}

  /* ---------------- 查询（全部来自事件流实时重算） ---------------- */

  view(claimId: string): ReserveView { this.claims.get(claimId); return this.projector.fold(claimId, this.events.list(claimId)); }

  /** 案件准备金演进：每个影响准备金的事件形成一个不可变版本。 */
  evolution(claimId: string, fromSequence?: number, toSequence?: number) {
    const view = this.view(claimId);
    return {
      claimId,
      currency: view.currency,
      closed: view.closed,
      current: view.totals,
      versions: view.versions.filter((v) => (fromSequence === undefined || v.eventSequence >= fromSequence) && (toSequence === undefined || v.eventSequence <= toSequence)),
    };
  }

  /** 单笔分录审计链：凭证 → 来源事件 → 版本 → 冲正/被冲正凭证。 */
  entryAudit(claimId: string, entryId: string): JournalEntryAudit {
    const eventList = this.events.list(claimId);
    const view = this.projector.fold(claimId, eventList);
    const entry = view.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`unknown journal entry ${entryId}`);
    const sourceEvent = eventList.find((e) => e.id === entry.sourceEventId);
    if (!sourceEvent) throw new Error(`entry ${entryId} missing source event`);
    const version = view.versions.find((v) => v.eventId === entry.sourceEventId);
    const findEntry = (id?: string) => view.entries.find((e) => e.id === id);
    const withEvent = (e?: JournalEntry) => (e ? { entry: e, sourceEvent: eventList.find((ev) => ev.id === e.sourceEventId) } : undefined);
    return {
      entry,
      sourceEvent,
      version,
      reverses: withEvent(findEntry(entry.reversesEntryId)),
      reversals: entry.reversalEntryIds.map((id) => withEvent(findEntry(id))!).filter(Boolean),
    };
  }

  /** 按凭证 postedAt 落在期间内的变动做汇总（按 coverage × feeCategory × 币种）。 */
  periodSummary(claimId: string | undefined, from?: string, to?: string): { from?: string; to?: string; rows: PeriodSummaryRow[] } {
    const claimIds = claimId ? [claimId] : this.events.aggregateIds();
    const fromMs = from ? new Date(from).getTime() : undefined;
    const toMs = to ? new Date(to).getTime() : undefined;
    const rows = new Map<string, PeriodSummaryRow & { claims: Set<string> }>();

    const bump = (currency: string, coverage: string, feeCategory: string, bucket: string, delta: number, id: string) => {
      const key = `${currency}|${coverage}|${feeCategory}`;
      let row = rows.get(key);
      if (!row) {
        row = { coverage, feeCategory, currency, claimCount: 0, incurredMinor: 0, outstandingMinor: 0, payableMinor: 0, paidMinor: 0, recoverableMinor: 0, recoveredMinor: 0, releasedMinor: 0, netIncurredMinor: 0, claims: new Set<string>() };
        rows.set(key, row);
      }

      if (bucket === 'incurred') row.incurredMinor += delta;
      if (bucket === 'outstanding') row.outstandingMinor += delta;
      if (bucket === 'payable') row.payableMinor += delta;
      if (bucket === 'paid') row.paidMinor += delta;
      if (bucket === 'recoverable') row.recoverableMinor += delta;
      if (bucket === 'recovered') row.recoveredMinor += delta;
      if (bucket === 'released') row.releasedMinor += delta;
      row.claims.add(id);
    };

    for (const id of claimIds) {
      const view = this.projector.fold(id, this.events.list(id));
      for (const entry of view.entries) {
        const t = new Date(entry.postedAt).getTime();
        if (fromMs !== undefined && t < fromMs) continue;
        if (toMs !== undefined && t > toMs) continue;
        for (const line of entry.lines) {
          if (!line.bucket) continue;
          const debitPositive = line.bucket.bucket === 'incurred' || line.bucket.bucket === 'recoverable' || line.bucket.bucket === 'recovered';
          const delta = debitPositive ? line.debitMinor - line.creditMinor : line.creditMinor - line.debitMinor;
          bump(entry.currency, line.bucket.coverage, line.bucket.feeCategory, line.bucket.bucket, delta, id);
        }
      }
    }
    const finalRows = [...rows.values()].map(({ claims, ...row }) => ({ ...row, claimCount: claims.size, netIncurredMinor: row.incurredMinor - row.recoveredMinor }));
    return { from, to, rows: finalRows };
  }

  /** 历史重放余额必须与实时一致：实时视图 vs 指定事件子集重算 vs 凭证行独立重算。 */
  verifyConsistency(claimId: string): { live: ReserveView; replay: ReserveView; equal: boolean; balance: ReserveBalanceCheck } {
    const eventList = this.events.list(claimId);
    const live = this.projector.fold(claimId, eventList);
    // 乱序喂入（逆序），投影器仍按 sequence 折叠，结果必须一致。
    const shuffled = [...eventList].reverse();
    const replay = this.projector.fold(claimId, shuffled);
    const balance = verifyReserveBalances(live);
    const equal = JSON.stringify(live.cells) === JSON.stringify(replay.cells) && JSON.stringify(live.totals) === JSON.stringify(replay.totals) && balance.cellsRecomputable && balance.entriesBalanced && balance.trialBalanceZero;
    return { live, replay, equal, balance };
  }

  /* ---------------- 命令（写事件，所有金额先校验再落事件） ---------------- */

  /** 初始估损：仅允许每个单元格首估一次（重复首估请走调整）。 */
  estimate(claimId: string, currency: string, lines: LineRequest[], actor: string, reasonNote?: string, key?: string) {
    const idemKey = key ?? `reserve:estimate:${claimId}`;
    if (this.replayed(claimId, idemKey)) return this.view(claimId);
    this.assertClaim(claimId);
    const view = this.view(claimId);
    const normalized = this.normalizeLines(lines);
    for (const line of normalized) {
      if (line.amountMinor <= 0) throw new Error(`initial estimate for ${line.coverage}/${line.feeCategory} must be positive`);
      if (this.cell(view, currency, line.coverage, line.feeCategory)) throw new Error(`reserve cell ${line.coverage}/${line.feeCategory} already estimated; use adjustment`);
    }
    return this.appendReserveDelta(claimId, 'reserve.estimated', currency, normalized, 'initial_estimate', actor, reasonNote, idemKey);
  }

  /** 人工调整：按带符号增量增减已发生损失/未决准备金，必须记录业务原因。 */
  adjust(claimId: string, currency: string, lines: LineRequest[], actor: string, reasonNote: string, key?: string) {
    if (!reasonNote) throw new Error('adjustment requires a business reason note');
    const idemKey = key ?? `reserve:adjust:${claimId}:${this.fingerprint(this.peekLines(lines))}:${reasonNote}`;
    if (this.replayed(claimId, idemKey)) return this.view(claimId);
    const view = this.view(claimId);
    const normalized = this.normalizeLines(lines);
    for (const line of normalized) {
      const cell = this.requireCell(view, currency, line.coverage, line.feeCategory);
      if (cell.incurredMinor + line.amountMinor < 0) throw new Error(`adjustment would drive incurred negative for ${line.coverage}/${line.feeCategory}`);
      if (cell.outstandingMinor + line.amountMinor < 0) throw new Error(`adjustment would drive outstanding below zero for ${line.coverage}/${line.feeCategory}`);
      // 未决准备金不得低于已授权应付（已授权的钱不能被调没）。
      if (cell.outstandingMinor + line.amountMinor < cell.payableMinor) throw new Error(`adjustment would drive outstanding below payable for ${line.coverage}/${line.feeCategory}`);
    }
    return this.appendReserveDelta(claimId, 'reserve.adjusted', currency, normalized, 'manual_adjustment', actor, reasonNote, idemKey);
  }

  /** 责任确认：把单元格已发生损失目标值重设为 lines（仅允许与当前不同的方向收敛），差额落入未决准备金。 */
  confirmLiability(claimId: string, currency: string, lines: LineRequest[], actor: string, reasonNote?: string, key?: string) {
    const idemKey = key ?? `reserve:confirm:${claimId}:${this.fingerprint(this.peekLines(lines))}`;
    if (this.replayed(claimId, idemKey)) return this.view(claimId);
    const view = this.view(claimId);
    const normalized = this.normalizeLines(lines);
    const deltas: LineRequest[] = [];
    for (const line of normalized) {
      if (line.amountMinor < 0) throw new Error(`confirmed liability cannot be negative for ${line.coverage}/${line.feeCategory}`);
      const cell = this.requireCell(view, currency, line.coverage, line.feeCategory);
      if (line.amountMinor < cell.paidMinor) throw new Error(`confirmed liability below paid amount for ${line.coverage}/${line.feeCategory}`);
      const delta = line.amountMinor - cell.incurredMinor;
      if (delta !== 0) deltas.push({ coverage: line.coverage, feeCategory: line.feeCategory, amountMinor: delta });
    }
    return this.appendReserveDelta(claimId, 'reserve.confirmed', currency, deltas, 'liability_confirmed', actor, reasonNote, idemKey);
  }

  /** 赔付授权：未决准备金 → 应付赔付款。 */
  authorize(claimId: string, input: { currency: string; authorizationId: string; lines: LineRequest[]; reasonNote?: string }, actor: string, key?: string) {
    const idemKey = key ?? `reserve:authorize:${claimId}:${input.authorizationId}`;
    if (this.replayed(claimId, idemKey)) return this.view(claimId);
    if (!input.authorizationId) throw new Error('authorizationId is required');
    const view = this.assertOpen(claimId);
    const lines = this.normalizeLines(input.lines);
    for (const line of lines) {
      if (line.amountMinor <= 0) throw new Error(`authorization amount must be positive for ${line.coverage}/${line.feeCategory}`);
      const cell = this.requireCell(view, input.currency, line.coverage, line.feeCategory);
      if (line.amountMinor > cell.outstandingMinor) throw new Error(`authorization ${input.authorizationId} exceeds outstanding reserve for ${line.coverage}/${line.feeCategory}`);
    }
    const payload: ReserveAuthorizedPayload = { currency: input.currency, authorizationId: input.authorizationId, lines, reasonNote: input.reasonNote };
    this.events.append(claimId, 'payment.authorized', payload, actor, idemKey);
    return this.view(claimId);
  }

  /**
   * 赔付支付：
   * - stage=settled：核销已有授权（要求应付余额足够）；
   * - stage=authorized：支付即授权（直接从未决准备金出）。
   * 同时在支付账本登记 PaymentEntry（沿用既有赔付上限保护）。
   */
  settle(claimId: string, input: { currency: string; sourceId: string; stage: 'authorized' | 'settled'; authorizationId?: string; lines: LineRequest[]; reasonNote?: string }, actor: string) {
    const idemKey = `payment:${input.sourceId}`;
    if (this.replayed(claimId, idemKey)) return this.view(claimId);
    const claim = this.claims.get(claimId);
    if (claim.status === 'rejected') throw new Error('rejected claim cannot be paid');
    if (claim.status === 'closed') throw new Error('closed claim cannot be paid; reopen first');
    const view = this.view(claimId);
    const lines = this.normalizeLines(input.lines);
    const total = lines.reduce((s, l) => s + Math.abs(l.amountMinor), 0);
    for (const line of lines) {
      if (line.amountMinor <= 0) throw new Error(`settlement amount must be positive for ${line.coverage}/${line.feeCategory}`);
      const cell = this.requireCell(view, input.currency, line.coverage, line.feeCategory);
      if (input.stage === 'settled') {
        if (line.amountMinor > cell.payableMinor) throw new Error(`settlement ${input.sourceId} exceeds payable for ${line.coverage}/${line.feeCategory}`);
      } else if (line.amountMinor > cell.outstandingMinor) {
        throw new Error(`settlement ${input.sourceId} exceeds outstanding reserve for ${line.coverage}/${line.feeCategory}`);
      }
    }
    const payment = this.payments.post(claim.payments, { kind: 'settlement', amount: total / 100, currency: input.currency, sourceId: input.sourceId });
    const reserve: ReserveBlock = { currency: input.currency, stage: input.stage, lines, reasonNote: input.reasonNote, authorizationId: input.authorizationId };
    this.events.append(claimId, 'payment.settled', { payment, reserve }, actor, idemKey);
    return this.view(claimId);
  }

  /** 冲正已支付赔款：资金冲回（paid→payable），案件回到可处理状态。 */
  reverseSettlement(claimId: string, input: { currency: string; sourceId: string; lines: LineRequest[]; reasonNote?: string }, actor: string) {
    const idemKey = `reversal:${input.sourceId}`;
    if (this.replayed(claimId, idemKey)) return this.view(claimId);
    const view = this.assertOpenOrReopen(claimId);
    const lines = this.normalizeLines(input.lines);
    for (const line of lines) {
      if (line.amountMinor <= 0) throw new Error(`reversal amount must be positive for ${line.coverage}/${line.feeCategory}`);
      const cell = this.requireCell(view, input.currency, line.coverage, line.feeCategory);
      if (line.amountMinor > cell.paidMinor) throw new Error(`reversal exceeds paid amount for ${line.coverage}/${line.feeCategory}`);
    }
    const claim = this.claims.get(claimId);
    const payment = this.payments.post(claim.payments, { kind: 'reversal', amount: lines.reduce((s, l) => s + l.amountMinor, 0) / 100, currency: input.currency, sourceId: input.sourceId });
    const reserve: PaymentReversedReservePayload = { stage: 'settled', currency: input.currency, lines, originalSourceId: input.sourceId, reasonNote: input.reasonNote };
    this.events.append(claimId, 'payment.reversed', { payment, reserve }, actor, idemKey);
    return this.view(claimId);
  }

  /** 撤销赔付授权（未实际支付）：红冲应付，未决准备金转回。 */
  cancelAuthorization(claimId: string, input: { currency: string; authorizationId: string; lines: LineRequest[]; reasonNote?: string }, actor: string, key?: string) {
    const idemKey = key ?? `reserve:cancel-auth:${claimId}:${input.authorizationId}`;
    if (this.replayed(claimId, idemKey)) return this.view(claimId);
    const view = this.view(claimId);
    const lines = this.normalizeLines(input.lines);
    for (const line of lines) {
      if (line.amountMinor <= 0) throw new Error(`cancel amount must be positive for ${line.coverage}/${line.feeCategory}`);
      const cell = this.requireCell(view, input.currency, line.coverage, line.feeCategory);
      if (line.amountMinor > cell.payableMinor) throw new Error(`cancel exceeds payable for ${line.coverage}/${line.feeCategory}`);
    }
    const reserve: PaymentReversedReservePayload = { stage: 'authorized', currency: input.currency, lines, originalSourceId: input.authorizationId, reasonNote: input.reasonNote };
    this.events.append(claimId, 'payment.reversed', { reserve }, actor, idemKey);
    return this.view(claimId);
  }

  /** 计提待追回（代位追偿/残值）：不影响已发生损失与未决，仅确认或有资产。 */
  recordRecovery(claimId: string, input: { currency: string; lines: LineRequest[]; reasonNote?: string }, actor: string, key?: string) {
    const idemKey = key ?? `reserve:recovery-expected:${claimId}:${this.fingerprint(this.peekLines(input.lines))}`;
    if (this.replayed(claimId, idemKey)) return this.view(claimId);
    this.assertOpen(claimId);
    const lines = this.normalizeLines(input.lines);
    for (const line of lines) if (line.amountMinor <= 0) throw new Error(`expected recovery must be positive for ${line.coverage}/${line.feeCategory}`);
    const payload: RecoveryRecordedPayload = { currency: input.currency, lines, reasonNote: input.reasonNote };
    this.events.append(claimId, 'recovery.recorded', payload, actor, idemKey);
    return this.view(claimId);
  }

  /** 追回实现：现金收回，结转应收。 */
  realizeRecovery(claimId: string, input: { currency: string; recoverySourceId: string; lines: LineRequest[]; reasonNote?: string }, actor: string) {
    const idemKey = `recovery:${input.recoverySourceId}`;
    if (this.replayed(claimId, idemKey)) return this.view(claimId);
    if (!input.recoverySourceId) throw new Error('recoverySourceId is required');
    const view = this.view(claimId);
    const lines = this.normalizeLines(input.lines);
    for (const line of lines) {
      if (line.amountMinor <= 0) throw new Error(`realized recovery must be positive for ${line.coverage}/${line.feeCategory}`);
      const cell = this.requireCell(view, input.currency, line.coverage, line.feeCategory);
      if (line.amountMinor > cell.recoverableMinor) throw new Error(`realized recovery exceeds recoverable for ${line.coverage}/${line.feeCategory}`);
    }
    const claim = this.claims.get(claimId);
    // 支付账本登记一笔 recovery（负向占用），保持与既有追回语义一致。
    const payment = this.payments.post(claim.payments, { kind: 'recovery', amount: lines.reduce((s, l) => s + l.amountMinor, 0) / 100, currency: input.currency, sourceId: input.recoverySourceId });
    const recovery: RecoveryRealizedPayload = { currency: input.currency, lines, recoverySourceId: input.recoverySourceId, reasonNote: input.reasonNote };
    this.events.append(claimId, 'payment.recovered', { recovery, payment }, actor, idemKey);
    return this.view(claimId);
  }

  /** 结案：剩余未决赔款准备金（必须先无应付余额）全部冲销释放。 */
  close(claimId: string, currency: string, actor: string, reasonNote?: string, key?: string) {
    const idemKey = key ?? `reserve:close:${claimId}`;
    if (this.replayed(claimId, idemKey)) return this.view(claimId);
    const view = this.view(claimId);
    if (view.closed) throw new Error('claim already closed');
    const releases: ReserveLineInput[] = [];
    for (const cell of view.cells) {
      if (cell.currency !== currency) continue;
      if (cell.payableMinor > 0) throw new Error(`cannot close with payable outstanding for ${cell.coverage}/${cell.feeCategory}`);
      if (cell.outstandingMinor > 0) releases.push({ coverage: cell.coverage, feeCategory: cell.feeCategory, amountMinor: cell.outstandingMinor });
    }
    const payload: ClaimClosedPayload = { currency, reasonNote, releases };
    this.events.append(claimId, 'claim.closed', payload, actor, idemKey);
    return this.view(claimId);
  }

  /** 案件重开：把结案时释放的准备金重新计提（与结案分录反向），案件恢复处理。 */
  reopen(claimId: string, currency: string, actor: string, reasonNote?: string, key?: string) {
    const idemKey = key ?? `reserve:reopen:${claimId}`;
    if (this.replayed(claimId, idemKey)) return this.view(claimId);
    const view = this.view(claimId);
    if (!view.closed) throw new Error('claim is not closed');
    const rebooks = view.cells.filter((c) => c.currency === currency && c.releasedMinor > 0).map((c) => ({ coverage: c.coverage, feeCategory: c.feeCategory, amountMinor: c.releasedMinor }));
    if (!rebooks.length) {
      // 无释放可回转时仅重开案件状态，不产生凭证。
      this.events.append(claimId, 'claim.reopened', { currency, reasonNote }, actor, idemKey);
      return this.view(claimId);
    }
    const payload = { currency, reasonNote, lines: rebooks };
    this.events.append(claimId, 'claim.reopened', payload, actor, idemKey);
    return this.view(claimId);
  }

  /* ---------------- 内部工具 ---------------- */

  private appendReserveDelta(claimId: string, type: 'reserve.estimated' | 'reserve.adjusted' | 'reserve.confirmed', currency: string, deltas: LineRequest[], reason: ReserveReasonCode, actor: string, reasonNote: string | undefined, key: string) {
    const payload = { currency, lines: deltas, reason, reasonNote };
    this.events.append(claimId, type, payload, actor, key);
    return this.view(claimId);
  }

  /** 幂等键已命中（同一命令重复投递）：不校验、不追加，直接返回当前视图。 */
  private replayed(claimId: string, key: string): boolean { return Boolean(this.events.findByIdempotency(claimId, key)); }
  /** 幂等键指纹在 normalize 之前使用，仅做键派生。 */
  private peekLines(lines: LineRequest[]): LineRequest[] { return Array.isArray(lines) ? lines : []; }

  private normalizeLines(lines: LineRequest[]): LineRequest[] {
    if (!Array.isArray(lines) || lines.length === 0) throw new Error('reserve lines are required');
    const seen = new Set<string>();
    return lines.map((line) => {
      if (!line.coverage || !line.feeCategory) throw new Error('coverage and feeCategory are required');
      if (!Number.isInteger(line.amountMinor)) throw new Error(`amountMinor must be an integer (minor unit) for ${line.coverage}/${line.feeCategory}`);
      const k = `${line.coverage}|${line.feeCategory}`;
      if (seen.has(k)) throw new Error(`duplicate reserve line ${k} in one command; merge them first`);
      seen.add(k);
      return { coverage: line.coverage, feeCategory: line.feeCategory, amountMinor: line.amountMinor };
    });
  }

  private fingerprint(lines: LineRequest[]): string { return lines.map((l) => `${l.coverage}:${l.feeCategory}:${l.amountMinor}`).join('|'); }
  private cell(view: ReserveView, currency: string, coverage: string, feeCategory: string): ReserveCell | undefined { return view.cells.find((c) => c.currency === currency && c.coverage === coverage && c.feeCategory === feeCategory); }
  private requireCell(view: ReserveView, currency: string, coverage: string, feeCategory: string): ReserveCell { const cell = this.cell(view, currency, coverage, feeCategory); if (!cell) throw new Error(`unknown reserve cell ${coverage}/${feeCategory}; estimate it first`); return cell; }
  private assertClaim(claimId: string): void { this.claims.get(claimId); }
  private assertOpen(claimId: string): ReserveView { const view = this.view(claimId); if (view.closed) throw new Error('claim is closed; reopen before reserve changes'); return view; }
  private assertOpenOrReopen(claimId: string): ReserveView { return this.view(claimId); }
}
