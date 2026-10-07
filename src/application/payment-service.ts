import { ClaimService } from './claim-service';
import { PaymentLedger } from '../domain/payment-ledger';
import { PaymentEntry } from '../domain/types';
import { asMinor, newId, iso } from '../domain/ids';

export class PaymentService {
  constructor(private readonly claims: ClaimService, private readonly ledger: PaymentLedger) {}

  /** 赔付授权：生成待支付承诺（pending，不计入已付余额） */
  authorize(claimId: string, input: { amount: number; currency: string; sourceId: string; coverage?: string; category?: string }, actor: string) {
    const claim = this.claims.get(claimId);
    if (claim.status === 'rejected') throw new Error('rejected claim cannot be authorized');
    if (claim.payments.some((entry) => entry.kind === 'authorization' && entry.sourceId === input.sourceId)) throw new Error(`duplicate payment source ${input.sourceId}`);
    const minor = asMinor(input.amount);
    if (minor <= 0) throw new Error('authorization amount must be positive');
    const payment: PaymentEntry = { id: newId('payment'), kind: 'authorization', amount: { currency: input.currency, minor }, sourceId: input.sourceId, status: 'pending', createdAt: iso() };
    return this.claims.addEvent(claimId, 'payment.authorized', { payment, coverage: input.coverage, category: input.category }, actor, `authorize:${input.sourceId}`);
  }

  settle(claimId: string, input: { amount: number; currency: string; sourceId: string }, actor: string) {
    const claim = this.claims.get(claimId); if (claim.status === 'rejected') throw new Error('rejected claim cannot be paid');
    const alreadyPaid = this.ledger.balance(claim.payments); const amountMinor = Math.round(input.amount * 100);
    if (alreadyPaid + amountMinor > claim.approvedMinor) throw new Error('payment exceeds approved amount');
    const payment = this.ledger.post(claim.payments, { ...input, kind: 'settlement' });
    return this.claims.addEvent(claimId, 'payment.settled', { payment }, actor, `payment:${input.sourceId}`);
  }

  reverse(claimId: string, input: { amount: number; currency: string; sourceId: string }, actor: string) {
    const claim = this.claims.get(claimId); const payment = this.ledger.post(claim.payments, { ...input, kind: 'reversal' });
    return this.claims.addEvent(claimId, 'payment.reversed', { payment }, actor, `reversal:${input.sourceId}`);
  }

  /** 追回入账：核销待追回金额 */
  recover(claimId: string, input: { amount: number; currency: string; sourceId: string }, actor: string) {
    const claim = this.claims.get(claimId); const payment = this.ledger.post(claim.payments, { ...input, kind: 'recovery' });
    return this.claims.addEvent(claimId, 'payment.recovered', { payment }, actor, `recovery:${input.sourceId}`);
  }
}
