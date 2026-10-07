import { ClaimService } from './claim-service';
import { EventStore } from './event-store';
import { projectReserves, ReserveProjection, ReserveTotals, ReserveVersion } from '../domain/reserve';
import { iso } from '../domain/ids';

export interface ReserveMoveInput { coverage: string; category: string; deltaMinor: number; }
export interface LiabilityShareInput { coverage: string; share: number; }

export interface PeriodActivity {
  incurredDeltaMinor: number;
  authorizedDeltaMinor: number;
  paidDeltaMinor: number;
  recoverableDeltaMinor: number;
  movementCount: number;
  entryCount: number;
}

export interface PeriodSummary {
  from: string;
  to: string;
  claims: ClaimPeriodSummary[];
  totals: PeriodActivity & { opening: ReserveTotals; closing: ReserveTotals };
}

export interface ClaimPeriodSummary {
  claimId: string;
  opening: ReserveTotals;
  activity: PeriodActivity & {
    byReason: { reason: string; incurredDeltaMinor: number; paidDeltaMinor: number; recoverableDeltaMinor: number; movementCount: number }[];
  };
  closing: ReserveTotals;
}

const ZERO: ReserveTotals = { incurredMinor: 0, authorizedMinor: 0, outstandingMinor: 0, paidMinor: 0, recoverableMinor: 0 };

/**
 * 准备金与财务分录用例。所有读模型都由事件流实时折叠得到，
 * 因此历史重放（replayAt）与实时处理天然一致。
 */
export class ReserveService {
  constructor(private readonly claims: ClaimService, private readonly events: EventStore) {}

  // ---------- 命令 ----------

  /** 人工调整准备金：按险种×费用类别增减，必须给出业务原因 */
  adjust(claimId: string, input: { moves: ReserveMoveInput[]; reason: string }, actor: string, key?: string): ReserveProjection {
    this.claims.get(claimId);
    if (!input.reason || !input.reason.trim()) throw new Error('adjustment reason is required');
    if (!Array.isArray(input.moves) || input.moves.length === 0) throw new Error('at least one adjustment move is required');
    for (const move of input.moves) {
      if (!move.coverage || !move.category) throw new Error('adjustment move requires coverage and category');
      if (!Number.isInteger(move.deltaMinor) || move.deltaMinor === 0) throw new Error('adjustment deltaMinor must be a non-zero integer');
    }
    const projection = this.project(claimId);
    for (const move of input.moves) {
      const line = projection.lines.find((item) => item.coverage === move.coverage && item.category === move.category);
      const incurred = (line?.incurredMinor ?? 0) + move.deltaMinor;
      const paid = line?.paidMinor ?? 0;
      if (incurred < 0 || incurred < paid) throw new Error(`adjustment would make reserve negative for ${move.coverage}/${move.category}`);
    }
    this.claims.addEvent(claimId, 'reserve.adjusted', { moves: input.moves, reason: input.reason.trim() }, actor, key);
    return this.project(claimId);
  }

  /** 责任确认：按确认比例在险种间重新分摊未决责任 */
  confirmLiability(claimId: string, input: { shares: LiabilityShareInput[]; reason: string }, actor: string, key?: string): ReserveProjection {
    this.claims.get(claimId);
    if (!input.reason || !input.reason.trim()) throw new Error('liability confirmation reason is required');
    if (!Array.isArray(input.shares) || input.shares.length === 0) throw new Error('at least one liability share is required');
    for (const share of input.shares) {
      if (!share.coverage) throw new Error('liability share requires coverage');
      if (!Number.isFinite(share.share) || share.share < 0 || share.share > 1) throw new Error('liability share must be within [0, 1]');
    }
    const total = input.shares.reduce((sum, share) => sum + share.share, 0);
    if (Math.abs(total - 1) > 1e-6) throw new Error(`liability shares must sum to 1, got ${total}`);
    this.claims.addEvent(claimId, 'liability.confirmed', { shares: input.shares, reason: input.reason.trim() }, actor, key);
    return this.project(claimId);
  }

  // ---------- 查询 ----------

  /** 当前准备金台账（险种×费用类别明细 + 四类金额合计） */
  current(claimId: string): ReserveProjection {
    this.assertExists(claimId);
    return this.project(claimId);
  }

  /** 准备金演进：每次增减形成一个版本，携带业务原因与来源事件 */
  evolution(claimId: string): ReserveVersion[] {
    this.assertExists(claimId);
    return this.project(claimId).versions;
  }

  /** 全部分录 */
  journal(claimId: string) {
    this.assertExists(claimId);
    return this.project(claimId).entries;
  }

  /** 单笔分录审计链：分录 → 来源事件 → 准备金变动 → 版本前后快照 */
  entryAudit(claimId: string, entryId: string) {
    const claim = this.claims.get(claimId);
    const projection = this.project(claimId);
    const entry = projection.entries.find((item) => item.id === entryId);
    if (!entry) throw new Error(`unknown journal entry ${entryId}`);
    const sourceEvent = this.events.list(claimId).find((event) => event.id === entry.sourceEventId);
    const version = projection.versions.find((item) => item.version === entry.version) ?? null;
    const previousVersion = projection.versions.find((item) => item.version === entry.version - 1) ?? null;
    return {
      entry,
      sourceEvent: sourceEvent ? { id: sourceEvent.id, type: sourceEvent.type, sequence: sourceEvent.sequence, occurredAt: sourceEvent.occurredAt, actor: sourceEvent.actor } : null,
      movements: version?.movements ?? [],
      version,
      previousVersion,
      claimAudit: claim.audit.filter((item) => item.eventId === entry.sourceEventId),
    };
  }

  /** 期间汇总：期初余额 + 期间活动 = 期末余额，可按案件或全组合 */
  summary(options: { claimId?: string; from?: string; to?: string }): PeriodSummary {
    const from = options.from ? iso(options.from) : '0001-01-01T00:00:00.000Z';
    const to = options.to ? iso(options.to) : '9999-12-31T23:59:59.999Z';
    if (from > to) throw new Error('summary from must not be after to');
    if (options.claimId) this.assertExists(options.claimId);
    const claimIds = options.claimId ? [options.claimId] : this.events.aggregateIds();
    const claims = claimIds.map((claimId) => this.summaryFor(claimId, from, to));
    const sumTotals = (pick: (summary: ClaimPeriodSummary) => ReserveTotals): ReserveTotals => claims.reduce((acc, summary) => ({
      incurredMinor: acc.incurredMinor + pick(summary).incurredMinor,
      authorizedMinor: acc.authorizedMinor + pick(summary).authorizedMinor,
      outstandingMinor: acc.outstandingMinor + pick(summary).outstandingMinor,
      paidMinor: acc.paidMinor + pick(summary).paidMinor,
      recoverableMinor: acc.recoverableMinor + pick(summary).recoverableMinor,
    }), { ...ZERO });
    return {
      from,
      to,
      claims,
      totals: {
        opening: sumTotals((summary) => summary.opening),
        closing: sumTotals((summary) => summary.closing),
        incurredDeltaMinor: claims.reduce((sum, summary) => sum + summary.activity.incurredDeltaMinor, 0),
        authorizedDeltaMinor: claims.reduce((sum, summary) => sum + summary.activity.authorizedDeltaMinor, 0),
        paidDeltaMinor: claims.reduce((sum, summary) => sum + summary.activity.paidDeltaMinor, 0),
        recoverableDeltaMinor: claims.reduce((sum, summary) => sum + summary.activity.recoverableDeltaMinor, 0),
        movementCount: claims.reduce((sum, summary) => sum + summary.activity.movementCount, 0),
        entryCount: claims.reduce((sum, summary) => sum + summary.activity.entryCount, 0),
      },
    };
  }

  /** 历史重放：只折叠 sequence <= until 的事件，余额必须与实时演进中的对应版本一致 */
  replayAt(claimId: string, until: number): ReserveProjection {
    this.assertExists(claimId);
    return projectReserves(claimId, this.events.list(claimId).filter((event) => event.sequence <= until));
  }

  private project(claimId: string): ReserveProjection {
    return projectReserves(claimId, this.events.list(claimId));
  }

  private assertExists(claimId: string): void {
    if (this.events.list(claimId).length === 0) throw new Error(`unknown claim ${claimId}`);
  }

  private summaryFor(claimId: string, from: string, to: string): ClaimPeriodSummary {
    const projection = this.project(claimId);
    // 期初/期末按版本的业务时间（occurredAt）归集：期初 = 期间前最后一个版本的余额
    const before = projection.versions.filter((version) => version.occurredAt < from);
    const opening = before.length ? before[before.length - 1].totals : { ...ZERO };
    const through = projection.versions.filter((version) => version.occurredAt <= to);
    const closing = through.length ? through[through.length - 1].totals : { ...ZERO };
    const inPeriod = projection.versions.filter((version) => version.occurredAt >= from && version.occurredAt <= to);
    const movements = inPeriod.flatMap((version) => version.movements);
    const entryCount = inPeriod.reduce((sum, version) => sum + version.entryIds.length, 0);
    const byReason = new Map<string, { reason: string; incurredDeltaMinor: number; paidDeltaMinor: number; recoverableDeltaMinor: number; movementCount: number }>();
    for (const movement of movements) {
      const bucket = byReason.get(movement.reason) ?? { reason: movement.reason, incurredDeltaMinor: 0, paidDeltaMinor: 0, recoverableDeltaMinor: 0, movementCount: 0 };
      bucket.incurredDeltaMinor += movement.incurredDeltaMinor;
      bucket.paidDeltaMinor += movement.paidDeltaMinor;
      bucket.recoverableDeltaMinor += movement.recoverableDeltaMinor;
      bucket.movementCount += 1;
      byReason.set(movement.reason, bucket);
    }
    return {
      claimId,
      opening,
      activity: {
        incurredDeltaMinor: closing.incurredMinor - opening.incurredMinor,
        authorizedDeltaMinor: closing.authorizedMinor - opening.authorizedMinor,
        paidDeltaMinor: closing.paidMinor - opening.paidMinor,
        recoverableDeltaMinor: closing.recoverableMinor - opening.recoverableMinor,
        movementCount: movements.length,
        entryCount,
        byReason: [...byReason.values()].sort((a, b) => a.reason.localeCompare(b.reason)),
      },
      closing,
    };
  }
}
