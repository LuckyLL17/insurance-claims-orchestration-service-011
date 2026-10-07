import { stableHash } from './ids';

/**
 * 会计科目（简化版财险科目表）
 * - loss_reserve    未决赔款准备金（负债，贷方为正）
 * - claims_payable  应付赔款（负债，已授权未支付，贷方为正）
 * - incurred_loss   已发生损失/赔付支出（费用，借方为正）
 * - cash            资金（资产，借方为正）
 * - recoverable     应收追偿款/待追回（资产，借方为正）
 */
export type JournalAccount = 'loss_reserve' | 'claims_payable' | 'incurred_loss' | 'cash' | 'recoverable';

export type JournalEntryKind =
  | 'initial-estimate'
  | 'reserve-adjustment'
  | 'liability-confirmation'
  | 'payment-authorized'
  | 'payment-settled'
  | 'payment-reversed'
  | 'payment-recovered'
  | 'closure-release'
  | 'rejection-release';

export interface JournalLine {
  account: JournalAccount;
  direction: 'debit' | 'credit';
  amountMinor: number;
  coverage?: string;
  category?: string;
}

export interface JournalEntry {
  id: string;
  claimId: string;
  seq: number;
  /** 该分录所属的准备金版本号 */
  version: number;
  kind: JournalEntryKind;
  reason: string;
  sourceEventId: string;
  occurredAt: string;
  actor: string;
  lines: JournalLine[];
  /** 借方合计 == 贷方合计 */
  totalMinor: number;
}

export interface JournalDraft {
  claimId: string;
  version: number;
  kind: JournalEntryKind;
  reason: string;
  sourceEventId: string;
  occurredAt: string;
  actor: string;
  lines: JournalLine[];
}

/**
 * 复式记账账本。每条分录必须借贷平衡；按 (claimId, sourceEventId, kind) 幂等，
 * 重复入账返回已有分录。分录 ID 由来源事件确定性生成，重放结果与实时处理一致。
 */
export class JournalLedger {
  private entries: JournalEntry[] = [];
  private readonly byKey = new Map<string, JournalEntry>();

  static keyOf(claimId: string, sourceEventId: string, kind: JournalEntryKind): string {
    return `${claimId}:${sourceEventId}:${kind}`;
  }

  post(draft: JournalDraft): JournalEntry {
    const key = JournalLedger.keyOf(draft.claimId, draft.sourceEventId, draft.kind);
    const prior = this.byKey.get(key);
    if (prior) return prior;
    if (draft.lines.length === 0) throw new Error('journal entry requires at least one line');
    let debit = 0;
    let credit = 0;
    for (const line of draft.lines) {
      if (!Number.isInteger(line.amountMinor) || line.amountMinor <= 0) throw new Error(`journal line amount must be a positive integer, got ${line.amountMinor}`);
      if (line.direction === 'debit') debit += line.amountMinor;
      else credit += line.amountMinor;
    }
    if (debit !== credit) throw new Error(`unbalanced journal entry: debits ${debit} != credits ${credit}`);
    const entry: JournalEntry = {
      id: `je_${stableHash(key).slice(0, 16)}`,
      claimId: draft.claimId,
      seq: this.entries.length + 1,
      version: draft.version,
      kind: draft.kind,
      reason: draft.reason,
      sourceEventId: draft.sourceEventId,
      occurredAt: draft.occurredAt,
      actor: draft.actor,
      lines: draft.lines.map((line) => ({ ...line })),
      totalMinor: debit,
    };
    this.entries.push(entry);
    this.byKey.set(key, entry);
    return entry;
  }

  list(): JournalEntry[] {
    return [...this.entries].sort((a, b) => a.seq - b.seq);
  }

  get(entryId: string): JournalEntry | undefined {
    return this.entries.find((entry) => entry.id === entryId);
  }

  /** 某科目余额：借方为正、贷方为负 */
  balance(account: JournalAccount): number {
    return this.entries.reduce((sum, entry) => sum + entry.lines.filter((line) => line.account === account).reduce((acc, line) => acc + (line.direction === 'debit' ? line.amountMinor : -line.amountMinor), 0), 0);
  }
}
