import { ClaimService } from './claim-service';
import { PaymentLedger } from '../domain/payment-ledger';
export class PaymentService {
  constructor(private readonly claims: ClaimService, private readonly ledger: PaymentLedger) {}
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
}
