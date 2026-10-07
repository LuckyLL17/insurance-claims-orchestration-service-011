import { createHash } from 'node:crypto';
import { DomainEvent } from './types';
import {
  ClaimClosedPayload,
  JournalEntry,
  JournalLine,
  JournalLineBucket,
  PaymentReversedReservePayload,
  RecoveryRecordedPayload,
  RecoveryRealizedPayload,
  ReserveAuthorizedPayload,
  ReserveBlock,
  ReserveCell,
  ReserveAdjustedPayload,
  ReserveConfirmedPayload,
  ReserveEstimatedPayload,
  ReserveMovement,
  ReserveReasonCode,
  ReserveTotals,
  ReserveVersion,
  ReserveView,
} from './reserve';

/**
 * 科目表（简化版保险法定/GAAP 通用科目）：
 * - EXP_LOSS_INCURRED 已发生损失（费用，借）
 * - RES_OUTSTANDING   未决赔款准备金（负债，贷）
 * - PAY_CLAIMS        应付赔付款（负债，贷）
 * - CASH              现金/银行存款（资产，贷出/借入）
 * - RECOVERABLE       应收代位追偿款及残值（资产，借）
 * - RECOVERY_INCOME   追偿及残值收入（收入，贷）
 * - RES_RELEASED      准备金转回/冲销（费用抵减，贷）
 */
export const ACCOUNTS = {
  EXP_LOSS_INCURRED: '2103.已发生损失',
  RES_OUTSTANDING: '2201.未决赔款准备金',
  PAY_CLAIMS: '2202.应付赔付款',
  CASH: '1100.银行存款',
  RECOVERABLE: '1301.应收代位追偿款',
  RECOVERY_INCOME: '4102.追偿及残值收入',
  RES_RELEASED: '2209.准备金转回',
} as const;

export const reserveRelevantEvents = new Set<string>([
  'reserve.estimated',
  'reserve.adjusted',
  'reserve.confirmed',
  'payment.authorized',
  'payment.settled',
  'payment.reversed',
  'payment.recovered',
  'recovery.recorded',
  'claim.closed',
  'claim.reopened',
]);

type Bucket = JournalLineBucket['bucket'];

interface FoldState {
  cells: Map<string, ReserveCell>;
  entries: JournalEntry[];
  versions: ReserveVersion[];
  accounts: Map<string, number>;
  processed: Set<string>;
  closed: boolean;
  currency: string;
}

export const entryIdFor = (eventId: string): string => `je_${createHash('sha256').update(eventId).digest('hex').slice(0, 16)}`;
const cellKey = (currency: string, coverage: string, feeCategory: string) => `${currency}|${coverage}|${feeCategory}`;

export interface ReserveBalanceCheck {
  /** 每张凭证借方合计 == 贷方合计。 */
  entriesBalanced: boolean;
  /** 全局试算平衡：所有 T 账户余额合计为 0（借正贷负）。 */
  trialBalanceZero: boolean;
  /** 从凭证行独立重算的单元格与折叠单元格完全一致。 */
  cellsRecomputable: boolean;
  violations: string[];
  recomputedCells: ReserveCell[];
}

/** 直接从凭证行（而非折叠状态）重新累加出全部单元格余额——审计/重算的独立路径。 */
export function recomputeCellsFromEntries(entries: JournalEntry[]): ReserveCell[] {
  // 桶的科目方向：incurred（费用）、recoverable/recovered（资产/收回）为借增；
  // outstanding/payable（负债）、paid（现金支出发生额）、released（转回）为贷增。
  const debitPositiveBuckets: ReadonlySet<string> = new Set(['incurred', 'recoverable', 'recovered']);
  const map = new Map<string, ReserveCell>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (!line.bucket) continue;
      const key = cellKey(entry.currency, line.bucket.coverage, line.bucket.feeCategory);
      const cell = map.get(key) ?? emptyCell(entry.currency, line.bucket.coverage, line.bucket.feeCategory);
      const raw = line.debitMinor - line.creditMinor;
      const delta = debitPositiveBuckets.has(line.bucket.bucket) ? raw : -raw;
      applyBucket(cell, line.bucket.bucket, delta);
      map.set(key, cell);
    }
  }
  return [...map.values()];
}

/** 综合校验：凭证逐张借贷平衡 + 总账试算平衡 + 凭证行重算单元格与折叠一致。 */
export function verifyReserveBalances(view: ReserveView): ReserveBalanceCheck {
  const violations: string[] = [];
  let entriesBalanced = true;
  for (const entry of view.entries) {
    const debit = entry.lines.reduce((s, l) => s + l.debitMinor, 0);
    const credit = entry.lines.reduce((s, l) => s + l.creditMinor, 0);
    if (debit !== credit) { entriesBalanced = false; violations.push(`entry ${entry.id} unbalanced: debit=${debit} credit=${credit}`); }
  }
  const trialBalanceZero = Object.values(view.accountBalances).reduce((s, v) => s + v, 0) === 0;
  if (!trialBalanceZero) violations.push(`trial balance not zero: ${JSON.stringify(view.accountBalances)}`);

  const recomputed = recomputeCellsFromEntries(view.entries).sort((a, b) => cellKey(a.currency, a.coverage, a.feeCategory).localeCompare(cellKey(b.currency, b.coverage, b.feeCategory)));
  const folded = [...view.cells].sort((a, b) => cellKey(a.currency, a.coverage, a.feeCategory).localeCompare(cellKey(b.currency, b.coverage, b.feeCategory)));
  let cellsRecomputable = recomputed.length === folded.length;
  if (cellsRecomputable) {
    for (let i = 0; i < folded.length; i++) {
      const a = folded[i]; const b = recomputed[i];
      const sameKey = cellKey(a.currency, a.coverage, a.feeCategory) === cellKey(b.currency, b.coverage, b.feeCategory);
      const sameAmounts = a.incurredMinor === b.incurredMinor && a.outstandingMinor === b.outstandingMinor && a.payableMinor === b.payableMinor && a.paidMinor === b.paidMinor && a.recoverableMinor === b.recoverableMinor && a.recoveredMinor === b.recoveredMinor && a.releasedMinor === b.releasedMinor;
      if (!sameKey || !sameAmounts) { cellsRecomputable = false; violations.push(`cell mismatch folded=${JSON.stringify(a)} recomputed=${JSON.stringify(b)}`); }
    }
  }
  return { entriesBalanced, trialBalanceZero, cellsRecomputable, violations, recomputedCells: recomputed };
}

function emptyCell(currency: string, coverage: string, feeCategory: string): ReserveCell {
  return { coverage, feeCategory, currency, incurredMinor: 0, outstandingMinor: 0, payableMinor: 0, paidMinor: 0, recoverableMinor: 0, recoveredMinor: 0, releasedMinor: 0, lastReason: 'initial_estimate' };
}

function applyBucket(cell: ReserveCell, bucket: Bucket, delta: number): void {
  switch (bucket) {
    case 'incurred': cell.incurredMinor += delta; break;
    case 'outstanding': cell.outstandingMinor += delta; break;
    case 'payable': cell.payableMinor += delta; break;
    case 'paid': cell.paidMinor += delta; break;
    case 'recoverable': cell.recoverableMinor += delta; break;
    case 'recovered': cell.recoveredMinor += delta; break;
    case 'released': cell.releasedMinor += delta; break;
  }
}

/** 借贷工具：signed>0 借负贷正的便捷封装，全部以最小货币单位整数处理。 */
class EntryBuilder {
  readonly lines: JournalLine[] = [];
  readonly movements: ReserveMovement[] = [];
  constructor(private readonly entryId: string) {}

  /** 加一条分录行；bucket 非空时同时登记单元格带符号增量。 */
  line(account: string, debitMinor: number, creditMinor: number, memo: string, bucket?: { coverage: string; feeCategory: string; bucket: Bucket; signedDelta: number }): void {
    this.lines.push({ id: `${this.entryId}:L${this.lines.length + 1}`, account, debitMinor, creditMinor, memo, bucket: bucket ? { coverage: bucket.coverage, feeCategory: bucket.feeCategory, bucket: bucket.bucket } : undefined });
    if (bucket && bucket.signedDelta !== 0) this.movements.push({ coverage: bucket.coverage, feeCategory: bucket.feeCategory, bucket: bucket.bucket, deltaMinor: bucket.signedDelta });
  }

  /** 已发生损失/未决准备金成对变动（estimate/adjust/confirm），delta 带符号。 */
  lossReservePair(coverage: string, feeCategory: string, delta: number, reason: ReserveReasonCode): void {
    if (delta === 0) return;
    const b = { coverage, feeCategory, bucket: undefined as Bucket | undefined, signedDelta: 0 };
    if (delta > 0) {
      this.line(ACCOUNTS.EXP_LOSS_INCURRED, delta, 0, `${reason}: 已发生损失 +${delta}`, { ...b, bucket: 'incurred', signedDelta: delta });
      this.line(ACCOUNTS.RES_OUTSTANDING, 0, delta, `${reason}: 未决赔款准备金 +${delta}`, { ...b, bucket: 'outstanding', signedDelta: delta });
    } else {
      const amt = -delta;
      this.line(ACCOUNTS.RES_OUTSTANDING, amt, 0, `${reason}: 未决赔款准备金 -${amt}`, { ...b, bucket: 'outstanding', signedDelta: delta });
      this.line(ACCOUNTS.EXP_LOSS_INCURRED, 0, amt, `${reason}: 已发生损失 -${amt}`, { ...b, bucket: 'incurred', signedDelta: delta });
    }
  }
}

function buildEntry(event: DomainEvent): { entry?: Omit<JournalEntry, 'reversesEntryId' | 'reversalEntryIds'>; movements: ReserveMovement[]; reason: ReserveReasonCode; note?: string; currency?: string } | undefined {
  const p = event.payload as any;
  const entryId = entryIdFor(event.id);
  const reasonNote: string | undefined = p?.reasonNote;
  const builder = new EntryBuilder(entryId);

  const reasonFromEstimate = (): ReserveReasonCode => (p?.reason ?? (event.type === 'reserve.estimated' ? 'initial_estimate' : event.type === 'reserve.confirmed' ? 'liability_confirmed' : 'manual_adjustment'));

  switch (event.type) {
    case 'reserve.estimated':
    case 'reserve.adjusted':
    case 'reserve.confirmed': {
      const payload = p as ReserveEstimatedPayload | ReserveAdjustedPayload | ReserveConfirmedPayload;
      if (!payload?.lines) return undefined;
      const reason = reasonFromEstimate();
      for (const line of payload.lines) builder.lossReservePair(line.coverage, line.feeCategory, line.amountMinor, reason);
      return finish(event, entryId, builder, payload.currency, reason, reasonNote);
    }
    case 'payment.authorized': {
      const payload = p as ReserveAuthorizedPayload;
      if (!payload?.lines) return undefined;
      for (const line of payload.lines) {
        const a = Math.abs(line.amountMinor);
        if (a === 0) continue;
        builder.line(ACCOUNTS.RES_OUTSTANDING, a, 0, `授权 ${payload.authorizationId}: 未决准备金转出`, { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'outstanding', signedDelta: -a });
        builder.line(ACCOUNTS.PAY_CLAIMS, 0, a, `授权 ${payload.authorizationId}: 计提应付赔付款`, { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'payable', signedDelta: a });
      }
      return finish(event, entryId, builder, payload.currency, 'payment_authorization', reasonNote);
    }
    case 'payment.settled': {
      const block = p?.reserve as ReserveBlock | undefined;
      if (!block?.lines) return undefined;
      if (block.stage === 'authorized') {
        for (const line of block.lines) {
          const a = Math.abs(line.amountMinor);
          if (a === 0) continue;
          builder.line(ACCOUNTS.RES_OUTSTANDING, a, 0, '支付即授权: 未决准备金转出', { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'outstanding', signedDelta: -a });
          builder.line(ACCOUNTS.PAY_CLAIMS, 0, a, '支付即授权: 计提应付赔付款', { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'payable', signedDelta: a });
        }
      }
      for (const line of block.lines) {
        const a = Math.abs(line.amountMinor);
        if (a === 0) continue;
        builder.line(ACCOUNTS.PAY_CLAIMS, a, 0, '赔付支付: 结清应付赔付款', { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'payable', signedDelta: -a });
        builder.line(ACCOUNTS.CASH, 0, a, '赔付支付: 银行存款支出', { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'paid', signedDelta: a });
      }
      return finish(event, entryId, builder, block.currency, 'payment_settlement', block.reasonNote);
    }
    case 'payment.reversed': {
      const block = p?.reserve as PaymentReversedReservePayload | undefined;
      if (!block?.lines) return undefined;
      if (block.stage === 'authorized') {
        for (const line of block.lines) {
          const a = Math.abs(line.amountMinor);
          if (a === 0) continue;
          builder.line(ACCOUNTS.PAY_CLAIMS, a, 0, `冲正授权 ${block.originalSourceId}: 红冲应付`, { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'payable', signedDelta: -a });
          builder.line(ACCOUNTS.RES_OUTSTANDING, 0, a, `冲正授权 ${block.originalSourceId}: 未决准备金转回`, { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'outstanding', signedDelta: a });
        }
        return finish(event, entryId, builder, block.currency, 'authorization_cancelled', block.reasonNote);
      }
      for (const line of block.lines) {
        const a = Math.abs(line.amountMinor);
        if (a === 0) continue;
        builder.line(ACCOUNTS.CASH, a, 0, `冲正支付 ${block.originalSourceId}: 资金追回/挂应收`, { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'paid', signedDelta: -a });
        builder.line(ACCOUNTS.PAY_CLAIMS, 0, a, `冲正支付 ${block.originalSourceId}: 应付赔付款重新计提`, { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'payable', signedDelta: a });
      }
      return finish(event, entryId, builder, block.currency, 'payment_reversal', block.reasonNote);
    }
    case 'payment.recovered': {
      const payload = p?.recovery as RecoveryRealizedPayload | undefined;
      if (!payload?.lines) return undefined;
      for (const line of payload.lines) {
        const a = Math.abs(line.amountMinor);
        if (a === 0) continue;
        builder.line(ACCOUNTS.CASH, a, 0, `追回实现 ${payload.recoverySourceId}: 银行存款收入`, { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'recovered', signedDelta: a });
        builder.line(ACCOUNTS.RECOVERABLE, 0, a, `追回实现 ${payload.recoverySourceId}: 结转应收代位追偿款`, { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'recoverable', signedDelta: -a });
      }
      return finish(event, entryId, builder, payload.currency, 'recovery_realized', payload.reasonNote);
    }
    case 'recovery.recorded': {
      const payload = p as RecoveryRecordedPayload;
      if (!payload?.lines) return undefined;
      for (const line of payload.lines) {
        const a = Math.abs(line.amountMinor);
        if (a === 0) continue;
        builder.line(ACCOUNTS.RECOVERABLE, a, 0, '计提待追回: 应收代位追偿款/残值', { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'recoverable', signedDelta: a });
        builder.line(ACCOUNTS.RECOVERY_INCOME, 0, a, '计提待追回: 追偿及残值收入');
      }
      return finish(event, entryId, builder, payload.currency, 'expected_recovery', payload.reasonNote);
    }
    case 'claim.closed': {
      const payload = p as ClaimClosedPayload;
      for (const line of payload?.releases ?? []) {
        const a = Math.abs(line.amountMinor);
        if (a === 0) continue;
        builder.line(ACCOUNTS.RES_OUTSTANDING, a, 0, '结案: 剩余未决赔款准备金冲销', { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'outstanding', signedDelta: -a });
        builder.line(ACCOUNTS.RES_RELEASED, 0, a, '结案: 准备金转回', { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'released', signedDelta: a });
      }
      return finish(event, entryId, builder, payload?.currency ?? 'CNY', 'claim_close_release', payload?.reasonNote);
    }
    case 'claim.reopened': {
      if (!p?.lines) return undefined;
      for (const line of p.lines) {
        const a = Math.abs(line.amountMinor);
        if (a === 0) continue;
        builder.line(ACCOUNTS.RES_RELEASED, a, 0, '重开: 转回结案释放', { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'released', signedDelta: -a });
        builder.line(ACCOUNTS.RES_OUTSTANDING, 0, a, '重开: 未决赔款准备金重新计提', { coverage: line.coverage, feeCategory: line.feeCategory, bucket: 'outstanding', signedDelta: a });
      }
      return finish(event, entryId, builder, p.currency ?? 'CNY', 'claim_reopen', reasonNote);
    }
    default:
      return undefined;
  }
}

function finish(event: DomainEvent, entryId: string, builder: EntryBuilder, currency: string, reason: ReserveReasonCode, note?: string) {
  const entry = builder.lines.length
    ? {
        id: entryId,
        claimId: event.aggregateId,
        currency,
        postedAt: event.occurredAt,
        sourceEventId: event.id,
        sourceSequence: event.sequence,
        sourceType: event.type,
        reason,
        reasonNote: note,
        actor: event.actor,
        lines: builder.lines,
      }
    : undefined;
  return { entry, movements: builder.movements, reason, note, currency };
}

export class ReserveProjector {
  /** 纯折叠：同一事件集无论按何种顺序（sequence/occurredAt/乱序投递）折叠结果一致。 */
  fold(claimId: string, events: DomainEvent[]): ReserveView {
    const state: FoldState = { cells: new Map(), entries: [], versions: [], accounts: new Map(), processed: new Set(), closed: false, currency: 'CNY' };
    for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) this.apply(state, claimId, event);
    this.linkReversals(state, events);
    return this.toView(claimId, state);
  }

  private apply(state: FoldState, claimId: string, event: DomainEvent): void {
    if (state.processed.has(event.id)) return; // 重复事件：不产生重复分录/版本
    state.processed.add(event.id);
    if (event.type === 'claim.closed') state.closed = true;
    if (event.type === 'claim.reopened') state.closed = false;
    if (!reserveRelevantEvents.has(event.type)) return;

    const built = buildEntry(event);
    if (!built) return;
    if (built.currency) state.currency = built.currency;

    // 登记凭证与科目余额
    if (built.entry) {
      const entry: JournalEntry = { ...built.entry, reversesEntryId: undefined, reversalEntryIds: [] };
      state.entries.push(entry);
      for (const line of entry.lines) {
        state.accounts.set(line.account, (state.accounts.get(line.account) ?? 0) + line.debitMinor - line.creditMinor);
      }
    }

    // 登记单元格增量
    for (const movement of built.movements) {
      const key = cellKey(built.currency ?? state.currency, movement.coverage, movement.feeCategory);
      const cell = state.cells.get(key) ?? emptyCell(built.currency ?? state.currency, movement.coverage, movement.feeCategory);
      applyBucket(cell, movement.bucket, movement.deltaMinor);
      cell.lastReason = built.reason;
      state.cells.set(key, cell);
    }

    // 不可变版本（结案即使无释放也留版本痕迹）
    state.versions.push({
      version: state.versions.length + 1,
      eventSequence: event.sequence,
      eventId: event.id,
      eventType: event.type,
      reason: built.reason,
      reasonNote: built.note,
      actor: event.actor,
      createdAt: event.occurredAt,
      movements: built.movements.map((m) => ({ ...m })),
      cells: [...state.cells.values()].map((c) => ({ ...c })),
      entryId: built.entry?.id,
    });
  }

  /**
   * 冲正链两趟确定性挂接：
   * - settled 冲正：payment.reversed.payload.sourceId 与 payment.settled.payload.payment.sourceId 匹配；
   * - authorized 冲正：reserve.originalSourceId 与 payment.authorized.payload.authorizationId 匹配。
   * 仅依赖已折叠事件，与事件到达/处理顺序无关。
   */
  private linkReversals(state: FoldState, events: DomainEvent[]): void {
    const entriesByEvent = new Map<string, JournalEntry>();
    for (const entry of state.entries) entriesByEvent.set(entry.sourceEventId, entry);

    const link = (reversalEventId: string, originalEventId: string | undefined) => {
      if (!originalEventId) return;
      const reversal = entriesByEvent.get(reversalEventId);
      const original = entriesByEvent.get(originalEventId);
      if (!reversal || !original) return;
      reversal.reversesEntryId = original.id;
      original.reversalEntryIds = [...new Set([...original.reversalEntryIds, reversal.id])];
    };

    for (const event of events) {
      if (event.type !== 'payment.reversed') continue;
      const p = event.payload as any;
      const originalSourceId: string | undefined = p?.reserve?.originalSourceId ?? p?.payment?.sourceId;
      if (!originalSourceId) continue;
      if (p?.reserve?.stage === 'authorized') {
        const auth = events.find((e) => e.type === 'payment.authorized' && (e.payload as any)?.authorizationId === originalSourceId);
        link(event.id, auth?.id);
      } else {
        const settled = events.find((e) => e.type === 'payment.settled' && (e.payload as any)?.payment?.sourceId === originalSourceId);
        link(event.id, settled?.id);
      }
    }
  }

  private toView(claimId: string, state: FoldState): ReserveView {
    const cells = [...state.cells.values()].map((c) => ({ ...c }));
    const byCurrency = new Map<string, ReserveCell[]>();
    for (const cell of cells) {
      const list = byCurrency.get(cell.currency) ?? [];
      list.push(cell);
      byCurrency.set(cell.currency, list);
    }
    const totals: ReserveTotals[] = [...byCurrency.entries()].map(([currency, list]) => {
      const sum = (pick: (c: ReserveCell) => number) => list.reduce((s, c) => s + pick(c), 0);
      const incurredMinor = sum((c) => c.incurredMinor);
      const recoveredMinor = sum((c) => c.recoveredMinor);
      return {
        currency,
        incurredMinor,
        outstandingMinor: sum((c) => c.outstandingMinor),
        payableMinor: sum((c) => c.payableMinor),
        paidMinor: sum((c) => c.paidMinor),
        recoverableMinor: sum((c) => c.recoverableMinor),
        recoveredMinor,
        releasedMinor: sum((c) => c.releasedMinor),
        netIncurredMinor: incurredMinor - recoveredMinor,
      };
    });
    return {
      claimId,
      currency: state.currency,
      closed: state.closed,
      cells: cells.sort((a, b) => a.coverage.localeCompare(b.coverage) || a.feeCategory.localeCompare(b.feeCategory)),
      totals,
      entries: state.entries.map((e) => ({ ...e, lines: e.lines.map((l) => ({ ...l })), reversalEntryIds: [...e.reversalEntryIds] })),
      versions: state.versions.map((v) => ({ ...v, movements: v.movements.map((m) => ({ ...m })), cells: v.cells.map((c) => ({ ...c })) })),
      accountBalances: Object.fromEntries(state.accounts.entries()),
    };
  }
}
