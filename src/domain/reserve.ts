/**
 * 案件准备金与财务分录子系统领域类型。
 *
 * 设计原则：
 * - 准备金按「责任险种 coverage × 费用类别 feeCategory × 币种」拆分为单元格（ReserveCell）。
 * - 每个单元格区分：已发生损失（incurred，含 IBNR 未决）、未决赔款准备金（outstanding）、
 *   已授权应付（payable）、已支付（paid）、待追回（recoverable）、已追回（recovered）、
 *   结案冲销释放（released）。
 * - 每个业务事件派生出唯一一张借贷平衡的会计凭证（JournalEntry），凭证/分录 ID 由来源
 *   事件确定性派生，因此重复投递、乱序重放都不会产生重复分录。
 * - 所有单元格变动都是带符号增量，投影器对事件流做纯折叠：实时处理与历史重放走同一份代码。
 */
import type { DomainEvent } from './types';

/** 准备金变动的业务原因（每次增减都必须落库一个原因码与文字说明）。 */
export type ReserveReasonCode =
  | 'initial_estimate'        // 初始估损
  | 'manual_adjustment'       // 人工调整（增量/减量）
  | 'liability_confirmed'     // 责任确认
  | 'payment_authorization'   // 赔付授权
  | 'payment_settlement'      // 赔付支付
  | 'payment_reversal'        // 支付冲正（案件重开）
  | 'authorization_cancelled' // 授权撤销
  | 'expected_recovery'       // 计提待追回（代位追偿/残值）
  | 'recovery_realized'       // 追回实现（现金收回）
  | 'claim_close_release'     // 结案释放剩余准备金
  | 'claim_reopen'            // 案件重开（重建准备金）
  | 'reopen_rebook';          // 重开后重新入账

/** 准备金桶位：一笔单元格余额由这些桶组成。 */
export interface ReserveCell {
  coverage: string;
  feeCategory: string;
  currency: string;
  /** 已发生损失累计（毛额，借方方向，包含已决+未决+IBNR）。 */
  incurredMinor: number;
  /** 未决赔款准备金（case reserve + IBNR）。 */
  outstandingMinor: number;
  /** 已授权尚未支付的应付赔款。 */
  payableMinor: number;
  /** 累计已支付赔款。 */
  paidMinor: number;
  /** 待追回金额（应收代位追偿/残值）。 */
  recoverableMinor: number;
  /** 累计已实现追回金额。 */
  recoveredMinor: number;
  /** 结案时冲销/释放的准备金累计。 */
  releasedMinor: number;
  /** 最近一次变动的业务原因。 */
  lastReason: ReserveReasonCode;
}

/** 一条分录行所归属的桶位（用于从凭证可重算单元格余额，非桶位科目为 undefined）。 */
export interface JournalLineBucket {
  coverage: string;
  feeCategory: string;
  /** incurred | outstanding | payable | paid | recoverable | recovered | released */
  bucket: 'incurred' | 'outstanding' | 'payable' | 'paid' | 'recoverable' | 'recovered' | 'released';
}

export interface JournalLine {
  /** 确定性 ID：{entryId}:L{序号}。 */
  id: string;
  account: string;
  /** 借方金额（最小货币单位，非负）。 */
  debitMinor: number;
  /** 贷方金额（最小货币单位，非负）。 */
  creditMinor: number;
  memo: string;
  bucket?: JournalLineBucket;
}

export interface JournalEntry {
  /** 确定性 ID：由来源事件派生，je_{eventId 短哈希}。 */
  id: string;
  claimId: string;
  currency: string;
  /** 凭证日期（业务发生时间，用于期间汇总）。 */
  postedAt: string;
  /** 来源事件。 */
  sourceEventId: string;
  sourceSequence: number;
  sourceType: string;
  reason: ReserveReasonCode;
  reasonNote?: string;
  actor: string;
  lines: JournalLine[];
  /** 冲正/被冲正关联。 */
  reversesEntryId?: string;
  reversalEntryIds: string[];
}

/** 一次准备金变动（带符号增量，针对一个单元格）。 */
export interface ReserveMovement {
  coverage: string;
  feeCategory: string;
  bucket: JournalLineBucket['bucket'];
  deltaMinor: number;
}

/** 一次准备金版本（每个影响准备金的事件产生一个不可变版本）。 */
export interface ReserveVersion {
  version: number;
  eventSequence: number;
  eventId: string;
  eventType: string;
  reason: ReserveReasonCode;
  reasonNote?: string;
  actor: string;
  createdAt: string;
  /** 本次版本的带符号变动。 */
  movements: ReserveMovement[];
  /** 变动后单元格快照（全量）。 */
  cells: ReserveCell[];
  /** 本版本生成的凭证 ID（结案无余额释放时可能为空）。 */
  entryId?: string;
}

/** 案件准备金聚合视图。 */
export interface ReserveTotals {
  currency: string;
  incurredMinor: number;
  outstandingMinor: number;
  payableMinor: number;
  paidMinor: number;
  recoverableMinor: number;
  recoveredMinor: number;
  releasedMinor: number;
  /** 净已发生损失 = incurred - recovered。 */
  netIncurredMinor: number;
}

export interface ReserveView {
  claimId: string;
  currency: string;
  closed: boolean;
  cells: ReserveCell[];
  totals: ReserveTotals[];
  entries: JournalEntry[];
  versions: ReserveVersion[];
  /** 所有账户的当前余额（借方为正、贷方为负），用于试算平衡。 */
  accountBalances: Record<string, number>;
}

/** 单条分录审计链节点。 */
export interface JournalEntryAudit {
  entry: JournalEntry;
  sourceEvent: DomainEvent;
  version?: ReserveVersion;
  /** 被本凭证冲正的凭证（含其来源事件）。 */
  reverses?: { entry: JournalEntry; sourceEvent?: DomainEvent };
  /** 冲正本凭证的凭证列表。 */
  reversals: { entry: JournalEntry; sourceEvent?: DomainEvent }[];
}

/** 期间汇总行：按 coverage × feeCategory × 币种汇总。 */
export interface PeriodSummaryRow extends ReserveTotals {
  coverage: string;
  feeCategory: string;
  claimCount: number;
}

/* ---------- 各准备金事件的 payload 契约（命令侧负责校验并构造） ---------- */

export interface ReserveLineInput {
  coverage: string;
  feeCategory: string;
  /** 金额（最小货币单位，整数）。estimate/adjust/confirm 表示目标或增量；authorize/settle 表示本次金额。 */
  amountMinor: number;
}

export interface ReserveEstimatedPayload {
  currency: string;
  lines: ReserveLineInput[];
  reason: ReserveReasonCode;
  reasonNote?: string;
}
export type ReserveAdjustedPayload = ReserveEstimatedPayload;
export type ReserveConfirmedPayload = ReserveEstimatedPayload;

export interface ReserveAuthorizedPayload {
  currency: string;
  lines: ReserveLineInput[];
  reasonNote?: string;
  /** 业务授权单号，用于审计追溯。 */
  authorizationId: string;
}

export interface ReserveBlock {
  currency: string;
  lines: ReserveLineInput[];
  stage: 'authorized' | 'settled';
  reasonNote?: string;
  authorizationId?: string;
}

export interface PaymentReversedReservePayload {
  stage: 'authorized' | 'settled';
  currency: string;
  lines: ReserveLineInput[];
  /** 被冲正的原支付/授权来源 ID。 */
  originalSourceId: string;
  reasonNote?: string;
}

export interface RecoveryRecordedPayload {
  currency: string;
  lines: ReserveLineInput[];
  reasonNote?: string;
}

export interface RecoveryRealizedPayload {
  currency: string;
  lines: ReserveLineInput[];
  recoverySourceId: string;
  reasonNote?: string;
}

export interface ClaimClosedPayload {
  currency: string;
  reasonNote?: string;
  /** 结案时各单元格剩余 outstanding 的释放明细（命令侧根据当前余额计算）。 */
  releases: ReserveLineInput[];
}
