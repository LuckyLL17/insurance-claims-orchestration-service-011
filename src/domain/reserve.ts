import { DomainEvent } from './types';
import { JournalEntry, JournalLedger, JournalLine } from './journal';

/** 费用类别：indemnity 赔款本身，其余为各类理赔费用 */
export type ReserveCategory = 'indemnity' | 'survey_fee' | 'legal_fee' | 'defense_cost' | 'salvage' | (string & {});

export interface ReserveMovement {
  version: number;
  coverage: string;
  category: string;
  reason: string;
  sourceEventId: string;
  occurredAt: string;
  incurredDeltaMinor: number;
  authorizedDeltaMinor: number;
  paidDeltaMinor: number;
  recoverableDeltaMinor: number;
}

export interface ReserveLineState {
  coverage: string;
  category: string;
  /** 已发生损失（累计估损） */
  incurredMinor: number;
  /** 已授权未支付 */
  authorizedMinor: number;
  /** 已支付（净额，冲正会扣减） */
  paidMinor: number;
  /** 待追回 */
  recoverableMinor: number;
  /** 未决赔款 = 已发生损失 - 已支付 */
  outstandingMinor: number;
}

export interface ReserveTotals {
  incurredMinor: number;
  authorizedMinor: number;
  outstandingMinor: number;
  paidMinor: number;
  recoverableMinor: number;
}

export interface ReserveVersion {
  version: number;
  claimId: string;
  reason: string;
  /** 业务来源事件（如初始估损对应报案事件） */
  sourceEventId: string;
  sourceEventType: string;
  sourceSequence: number;
  /** 触发本次版本生成的事件（乱序/派生场景下与来源事件不同） */
  triggerEventId: string;
  triggerSequence: number;
  occurredAt: string;
  actor: string;
  movements: ReserveMovement[];
  lines: ReserveLineState[];
  totals: ReserveTotals;
  entryIds: string[];
  warnings: string[];
}

export interface ReserveProjection {
  claimId: string;
  closed: boolean;
  versions: ReserveVersion[];
  movements: ReserveMovement[];
  entries: JournalEntry[];
  lines: ReserveLineState[];
  totals: ReserveTotals;
}

interface LineMut {
  coverage: string;
  category: string;
  incurred: number;
  authorized: number;
  paid: number;
  recoverable: number;
}

interface Allocation {
  coverage: string;
  category: string;
  amount: number;
}

const lineKey = (coverage: string, category: string) => `${coverage}::${category}`;

/**
 * 准备金投影器：把案件事件流折叠为准备金版本链、逐笔变动和会计分录。
 * 纯函数式重放——实时处理与历史重放走同一条代码路径，余额必然一致。
 * 投影对异常事件保持防御（记录 warning 并钳制），保证任何事件流都可重算。
 */
export function projectReserves(claimId: string, events: DomainEvent[]): ReserveProjection {
  const projector = new ReserveProjector(claimId);
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) projector.apply(event);
  return projector.result();
}

class ReserveProjector {
  private readonly processed = new Set<string>();
  private readonly lines = new Map<string, LineMut>();
  private readonly versions: ReserveVersion[] = [];
  private readonly movements: ReserveMovement[] = [];
  private readonly ledger = new JournalLedger();
  private reportEvent?: DomainEvent;
  private report?: { loss: { currency: string; gross: number; deductible?: number; liabilityShare?: number; cap?: number } };
  private policy?: { coverages: string[]; deductibleMinor: number; limitMinor: number };
  private established = false;
  private closed = false;

  // 每个事件处理期间暂存版本内容
  private stageMovements: ReserveMovement[] = [];
  private stageEntries: JournalEntry[] = [];
  private stageWarnings: string[] = [];

  constructor(private readonly claimId: string) {}

  apply(event: DomainEvent): void {
    if (this.processed.has(event.id)) return; // 重复事件幂等跳过
    this.processed.add(event.id);
    const payload = event.payload as any;
    switch (event.type) {
      case 'claim.reported':
        this.report = { loss: payload.loss };
        this.reportEvent = event;
        break;
      case 'policy.snapshot.created':
        this.policy = payload.policy;
        this.establishInitial(event);
        break;
      case 'reserve.adjusted':
        this.adjust(event, payload);
        break;
      case 'liability.confirmed':
        this.confirmLiability(event, payload);
        break;
      case 'payment.authorized':
        this.authorize(event, payload);
        break;
      case 'payment.settled':
        this.settle(event, payload);
        break;
      case 'payment.reversed':
        this.reverse(event, payload);
        break;
      case 'payment.recovered':
        this.recover(event, payload);
        break;
      case 'claim.closed':
        this.releaseAll(event, 'closure-release', 'claim-closed');
        break;
      case 'claim.rejected':
        this.releaseAll(event, 'rejection-release', 'claim-rejected');
        break;
      case 'claim.reopened':
        this.closed = false;
        this.commit(event, 'claim-reopened', event);
        break;
      default:
        break; // 非财务事件不产生准备金版本
    }
  }

  result(): ReserveProjection {
    return {
      claimId: this.claimId,
      closed: this.closed,
      versions: [...this.versions],
      movements: [...this.movements],
      entries: this.ledger.list(),
      lines: this.snapshotLines(),
      totals: this.totals(),
    };
  }

  // ---------- 各生命周期阶段 ----------

  /** 初始估损：报案损失按保单责任险种拆分建立未决准备金（业务来源为报案事件，由保单快照事件触发） */
  private establishInitial(trigger: DomainEvent): void {
    if (!this.report || !this.policy || this.established) return;
    this.established = true;
    const source = this.reportEvent ?? trigger;
    const loss = this.report.loss;
    const safeMinor = (value: number | undefined) => Math.max(0, Math.round((value ?? 0) * 100));
    const share = loss.liabilityShare ?? 1;
    const deductibleMinor = loss.deductible !== undefined ? safeMinor(loss.deductible) : this.policy.deductibleMinor;
    const capMinor = Math.min(loss.cap !== undefined ? safeMinor(loss.cap) : Number.POSITIVE_INFINITY, this.policy.limitMinor);
    const estimate = Math.max(0, Math.min(Math.round(safeMinor(loss.gross) * share) - deductibleMinor, capMinor));
    if (estimate <= 0) return;
    const coverages = this.policy.coverages.length ? this.policy.coverages : ['unallocated'];
    const base = Math.floor(estimate / coverages.length);
    const lines: JournalLine[] = [];
    coverages.forEach((coverage, index) => {
      const amount = base + (index === 0 ? estimate - base * coverages.length : 0);
      if (amount <= 0) return;
      this.line(coverage, 'indemnity').incurred += amount;
      this.stage('initial-estimate', coverage, 'indemnity', amount, 0, 0, 0);
      lines.push({ account: 'incurred_loss', direction: 'debit', amountMinor: amount, coverage, category: 'indemnity' });
      lines.push({ account: 'loss_reserve', direction: 'credit', amountMinor: amount, coverage, category: 'indemnity' });
    });
    this.post(source, trigger, 'initial-estimate', 'initial-estimate', lines);
    this.commit(trigger, 'initial-estimate', source);
  }

  /** 人工调整：按险种×费用类别逐笔增减，必须携带业务原因 */
  private adjust(event: DomainEvent, payload: { moves?: { coverage: string; category: string; deltaMinor: number }[]; reason?: string }): void {
    const reason = payload.reason ?? 'manual-adjustment';
    const lines: JournalLine[] = [];
    for (const move of payload.moves ?? []) {
      if (!move || typeof move.coverage !== 'string' || !move.coverage || typeof move.category !== 'string' || !move.category || !Number.isInteger(move.deltaMinor) || move.deltaMinor === 0) {
        this.stageWarnings.push(`invalid adjustment move skipped: ${JSON.stringify(move)}`);
        continue;
      }
      const line = this.line(move.coverage, move.category);
      const nextIncurred = line.incurred + move.deltaMinor;
      if (nextIncurred < 0 || nextIncurred < line.paid) {
        this.stageWarnings.push(`adjustment rejected for ${move.coverage}/${move.category}: outstanding would become negative`);
        continue;
      }
      line.incurred = nextIncurred;
      this.stage(reason, move.coverage, move.category, move.deltaMinor, 0, 0, 0);
      const amount = Math.abs(move.deltaMinor);
      if (move.deltaMinor > 0) {
        lines.push({ account: 'incurred_loss', direction: 'debit', amountMinor: amount, coverage: move.coverage, category: move.category });
        lines.push({ account: 'loss_reserve', direction: 'credit', amountMinor: amount, coverage: move.coverage, category: move.category });
      } else {
        lines.push({ account: 'loss_reserve', direction: 'debit', amountMinor: amount, coverage: move.coverage, category: move.category });
        lines.push({ account: 'incurred_loss', direction: 'credit', amountMinor: amount, coverage: move.coverage, category: move.category });
      }
      this.clampAuthorized(line, lines);
    }
    this.post(event, event, 'reserve-adjustment', reason, lines);
    this.commit(event, reason, event);
  }

  /** 责任确认：按确认比例把各类费用下的未决责任在险种间重新分摊（总额不变） */
  private confirmLiability(event: DomainEvent, payload: { shares?: { coverage: string; share: number }[]; reason?: string }): void {
    const reason = payload.reason ?? 'liability-confirmation';
    const shares = (payload.shares ?? []).filter((share) => share && typeof share.coverage === 'string' && share.coverage && Number.isFinite(share.share) && share.share >= 0);
    const total = shares.reduce((sum, share) => sum + share.share, 0);
    if (!shares.length || Math.abs(total - 1) > 1e-6) {
      this.stageWarnings.push(`liability shares must be non-empty and sum to 1, got ${total}`);
      this.commit(event, reason, event);
      return;
    }
    const lines: JournalLine[] = [];
    const categories = [...new Set([...this.lines.values()].map((line) => line.category))].sort();
    for (const category of categories) {
      const inCategory = [...this.lines.values()].filter((line) => line.category === category);
      const totalOutstanding = inCategory.reduce((sum, line) => sum + (line.incurred - line.paid), 0);
      if (totalOutstanding <= 0 && inCategory.length === 0) continue;
      const targets = new Map<string, number>();
      let assigned = 0;
      shares.forEach((share, index) => {
        const amount = index === shares.length - 1 ? totalOutstanding - assigned : Math.round(totalOutstanding * share.share);
        assigned += amount;
        targets.set(share.coverage, (targets.get(share.coverage) ?? 0) + amount);
      });
      const coverages = new Set([...inCategory.map((line) => line.coverage), ...targets.keys()]);
      for (const coverage of [...coverages].sort()) {
        const line = this.line(coverage, category);
        const newIncurred = line.paid + (targets.get(coverage) ?? 0);
        const delta = newIncurred - line.incurred;
        if (delta === 0) continue;
        line.incurred = newIncurred;
        this.stage(reason, coverage, category, delta, 0, 0, 0);
        const amount = Math.abs(delta);
        if (delta > 0) {
          lines.push({ account: 'incurred_loss', direction: 'debit', amountMinor: amount, coverage, category });
          lines.push({ account: 'loss_reserve', direction: 'credit', amountMinor: amount, coverage, category });
        } else {
          lines.push({ account: 'loss_reserve', direction: 'debit', amountMinor: amount, coverage, category });
          lines.push({ account: 'incurred_loss', direction: 'credit', amountMinor: amount, coverage, category });
        }
        this.clampAuthorized(line, lines);
      }
    }
    this.post(event, event, 'liability-confirmation', reason, lines);
    this.commit(event, reason, event);
  }

  /** 赔付授权：未决准备金重分类为应付赔款（未决总额不变） */
  private authorize(event: DomainEvent, payload: { payment?: { amount: { minor: number } }; coverage?: string; category?: string }): void {
    const amount = Math.abs(payload.payment?.amount.minor ?? 0);
    if (amount <= 0) return;
    const allocations = payload.coverage
      ? this.allocateTo(this.line(payload.coverage, payload.category ?? 'indemnity'), amount, (line) => line.incurred - line.paid)
      : this.allocate(amount, (line) => line.incurred - line.paid);
    const allocated = allocations.reduce((sum, item) => sum + item.amount, 0);
    if (allocated < amount) this.stageWarnings.push(`authorization ${amount} exceeds outstanding, clamped to ${allocated}`);
    const lines: JournalLine[] = [];
    for (const item of allocations) {
      this.line(item.coverage, item.category).authorized += item.amount;
      this.stage('payment-authorized', item.coverage, item.category, 0, item.amount, 0, 0);
      lines.push({ account: 'loss_reserve', direction: 'debit', amountMinor: item.amount, coverage: item.coverage, category: item.category });
      lines.push({ account: 'claims_payable', direction: 'credit', amountMinor: item.amount, coverage: item.coverage, category: item.category });
    }
    this.post(event, event, 'payment-authorized', 'payment-authorized', lines);
    this.commit(event, 'payment-authorized', event);
  }

  /** 赔付支付：先冲减已授权应付，再冲减未决准备金，贷记资金 */
  private settle(event: DomainEvent, payload: { payment?: { amount: { minor: number } } }): void {
    const amount = Math.abs(payload.payment?.amount.minor ?? 0);
    if (amount <= 0) return;
    const fromAuthorized = this.allocate(amount, (line) => line.authorized);
    const consumed = fromAuthorized.reduce((sum, item) => sum + item.amount, 0);
    const fromReserve = this.allocate(amount - consumed, (line) => line.incurred - line.paid);
    const paid = consumed + fromReserve.reduce((sum, item) => sum + item.amount, 0);
    if (paid < amount) this.stageWarnings.push(`settlement ${amount} exceeds outstanding, clamped to ${paid}`);
    const lines: JournalLine[] = [];
    for (const item of fromAuthorized) {
      const line = this.line(item.coverage, item.category);
      line.authorized -= item.amount;
      line.paid += item.amount;
      this.stage('payment-settled', item.coverage, item.category, 0, -item.amount, item.amount, 0);
    }
    for (const item of fromReserve) {
      this.line(item.coverage, item.category).paid += item.amount;
      this.stage('payment-settled', item.coverage, item.category, 0, 0, item.amount, 0);
    }
    if (consumed > 0) lines.push({ account: 'claims_payable', direction: 'debit', amountMinor: consumed });
    if (paid - consumed > 0) lines.push({ account: 'loss_reserve', direction: 'debit', amountMinor: paid - consumed });
    if (paid > 0) lines.push({ account: 'cash', direction: 'credit', amountMinor: paid });
    this.post(event, event, 'payment-settled', 'payment-settled', lines);
    this.commit(event, 'payment-settled', event);
  }

  /** 赔付冲正：已支付转为待追回，同时恢复未决准备金 */
  private reverse(event: DomainEvent, payload: { payment?: { amount: { minor: number } } }): void {
    const amount = Math.abs(payload.payment?.amount.minor ?? 0);
    if (amount <= 0) return;
    const allocations = this.allocate(amount, (line) => line.paid);
    const reversed = allocations.reduce((sum, item) => sum + item.amount, 0);
    if (reversed < amount) this.stageWarnings.push(`reversal ${amount} exceeds paid, clamped to ${reversed}`);
    const lines: JournalLine[] = [];
    for (const item of allocations) {
      const line = this.line(item.coverage, item.category);
      line.paid -= item.amount;
      line.recoverable += item.amount;
      this.stage('payment-reversed', item.coverage, item.category, 0, 0, -item.amount, item.amount);
      lines.push({ account: 'recoverable', direction: 'debit', amountMinor: item.amount, coverage: item.coverage, category: item.category });
      lines.push({ account: 'loss_reserve', direction: 'credit', amountMinor: item.amount, coverage: item.coverage, category: item.category });
    }
    this.post(event, event, 'payment-reversed', 'payment-reversed', lines);
    this.commit(event, 'payment-reversed', event);
  }

  /** 追回入账：待追回核销，资金回流 */
  private recover(event: DomainEvent, payload: { payment?: { amount: { minor: number } } }): void {
    const amount = Math.abs(payload.payment?.amount.minor ?? 0);
    if (amount <= 0) return;
    const allocations = this.allocate(amount, (line) => line.recoverable);
    const recovered = allocations.reduce((sum, item) => sum + item.amount, 0);
    if (recovered < amount) this.stageWarnings.push(`recovery ${amount} exceeds recoverable, clamped to ${recovered}`);
    const lines: JournalLine[] = [];
    for (const item of allocations) {
      this.line(item.coverage, item.category).recoverable -= item.amount;
      this.stage('payment-recovered', item.coverage, item.category, 0, 0, 0, -item.amount);
      lines.push({ account: 'recoverable', direction: 'credit', amountMinor: item.amount, coverage: item.coverage, category: item.category });
    }
    if (recovered > 0) lines.push({ account: 'cash', direction: 'debit', amountMinor: recovered });
    this.post(event, event, 'payment-recovered', 'payment-recovered', lines);
    this.commit(event, 'payment-recovered', event);
  }

  /** 结案/拒赔：释放全部未决准备金，已发生损失收敛为已支付 */
  private releaseAll(event: DomainEvent, kind: 'closure-release' | 'rejection-release', reason: string): void {
    this.closed = true;
    const lines: JournalLine[] = [];
    for (const line of this.sortedLines()) {
      const outstanding = line.incurred - line.paid;
      if (outstanding <= 0 && line.authorized <= 0) continue;
      if (line.authorized > 0) {
        lines.push({ account: 'claims_payable', direction: 'debit', amountMinor: line.authorized, coverage: line.coverage, category: line.category });
      }
      if (outstanding - line.authorized > 0) {
        lines.push({ account: 'loss_reserve', direction: 'debit', amountMinor: outstanding - line.authorized, coverage: line.coverage, category: line.category });
      }
      if (outstanding > 0) {
        lines.push({ account: 'incurred_loss', direction: 'credit', amountMinor: outstanding, coverage: line.coverage, category: line.category });
        this.stage(reason, line.coverage, line.category, -outstanding, -line.authorized, 0, 0);
        line.incurred -= outstanding;
        line.authorized = 0;
      }
    }
    this.post(event, event, kind, reason, lines);
    this.commit(event, reason, event);
  }

  // ---------- 内部工具 ----------

  private line(coverage: string, category: string): LineMut {
    const key = lineKey(coverage, category);
    let line = this.lines.get(key);
    if (!line) {
      line = { coverage, category, incurred: 0, authorized: 0, paid: 0, recoverable: 0 };
      this.lines.set(key, line);
    }
    return line;
  }

  private sortedLines(): LineMut[] {
    return [...this.lines.values()].sort((a, b) => lineKey(a.coverage, a.category).localeCompare(lineKey(b.coverage, b.category)));
  }

  /** 瀑布式分摊：按 (险种, 费用类别) 字典序依次填满，保证确定性 */
  private allocate(amount: number, available: (line: LineMut) => number): Allocation[] {
    const allocations: Allocation[] = [];
    let remaining = amount;
    for (const line of this.sortedLines()) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Math.max(0, available(line)));
      if (take > 0) {
        allocations.push({ coverage: line.coverage, category: line.category, amount: take });
        remaining -= take;
      }
    }
    return allocations;
  }

  private allocateTo(line: LineMut, amount: number, available: (line: LineMut) => number): Allocation[] {
    const take = Math.min(amount, Math.max(0, available(line)));
    return take > 0 ? [{ coverage: line.coverage, category: line.category, amount: take }] : [];
  }

  /** 授权额不得超过未决；超出部分回冲应付赔款 */
  private clampAuthorized(line: LineMut, lines: JournalLine[]): void {
    const outstanding = line.incurred - line.paid;
    if (line.authorized <= outstanding) return;
    const excess = line.authorized - outstanding;
    line.authorized = outstanding;
    this.stage('authorization-clamped', line.coverage, line.category, 0, -excess, 0, 0);
    lines.push({ account: 'claims_payable', direction: 'debit', amountMinor: excess, coverage: line.coverage, category: line.category });
    lines.push({ account: 'loss_reserve', direction: 'credit', amountMinor: excess, coverage: line.coverage, category: line.category });
  }

  private stage(reason: string, coverage: string, category: string, incurred: number, authorized: number, paid: number, recoverable: number): void {
    this.stageMovements.push({
      version: this.versions.length + 1,
      coverage,
      category,
      reason,
      sourceEventId: '',
      occurredAt: '',
      incurredDeltaMinor: incurred,
      authorizedDeltaMinor: authorized,
      paidDeltaMinor: paid,
      recoverableDeltaMinor: recoverable,
    });
  }

  private post(source: DomainEvent, trigger: DomainEvent, kind: Parameters<JournalLedger['post']>[0]['kind'], reason: string, lines: JournalLine[]): void {
    if (!lines.length) return;
    this.stageEntries.push(this.ledger.post({ claimId: this.claimId, version: this.versions.length + 1, kind, reason, sourceEventId: source.id, occurredAt: source.occurredAt, actor: source.actor, lines }));
  }

  private commit(trigger: DomainEvent, reason: string, source: DomainEvent): void {
    const version = this.versions.length + 1;
    const movements = this.stageMovements.map((movement) => ({ ...movement, version, sourceEventId: source.id, occurredAt: source.occurredAt }));
    this.versions.push({
      version,
      claimId: this.claimId,
      reason,
      sourceEventId: source.id,
      sourceEventType: source.type,
      sourceSequence: source.sequence,
      triggerEventId: trigger.id,
      triggerSequence: trigger.sequence,
      occurredAt: source.occurredAt,
      actor: source.actor,
      movements,
      lines: this.snapshotLines(),
      totals: this.totals(),
      entryIds: this.stageEntries.map((entry) => entry.id),
      warnings: [...this.stageWarnings],
    });
    this.movements.push(...movements);
    this.stageMovements = [];
    this.stageEntries = [];
    this.stageWarnings = [];
  }

  private snapshotLines(): ReserveLineState[] {
    return this.sortedLines().map((line) => ({
      coverage: line.coverage,
      category: line.category,
      incurredMinor: line.incurred,
      authorizedMinor: line.authorized,
      paidMinor: line.paid,
      recoverableMinor: line.recoverable,
      outstandingMinor: line.incurred - line.paid,
    }));
  }

  private totals(): ReserveTotals {
    const lines = [...this.lines.values()];
    const sum = (pick: (line: LineMut) => number) => lines.reduce((total, line) => total + pick(line), 0);
    return {
      incurredMinor: sum((line) => line.incurred),
      authorizedMinor: sum((line) => line.authorized),
      outstandingMinor: sum((line) => line.incurred - line.paid),
      paidMinor: sum((line) => line.paid),
      recoverableMinor: sum((line) => line.recoverable),
    };
  }
}
