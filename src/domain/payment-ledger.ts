import { PaymentEntry } from './types';
import { asMinor, newId, iso } from './ids';

export class PaymentLedger {
  post(entries: PaymentEntry[], input: { kind: PaymentEntry['kind']; amount: number; currency: string; sourceId: string }): PaymentEntry {
    if (entries.some((entry) => entry.sourceId === input.sourceId && entry.kind === input.kind)) throw new Error(`duplicate payment source ${input.sourceId}`);
    const amount = asMinor(input.amount);
    if (amount === 0) throw new Error('payment amount must be positive');
    return { id: newId('payment'), kind: input.kind, amount: { currency: input.currency, minor: input.kind === 'reversal' || input.kind === 'recovery' ? -amount : amount }, sourceId: input.sourceId, status: 'posted', createdAt: iso() };
  }

  balance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }
  settlementBalance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.kind === 'settlement' && entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }
}
