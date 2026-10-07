import { ClaimService } from './claim-service';
import { PaymentLedger } from '../domain/payment-ledger';
import { PaymentReversedReservePayload, ReserveBlock } from '../domain/reserve';

export class PaymentService {
  constructor(private readonly claims: ClaimService, private readonly ledger: PaymentLedger) {}

  /**
   * 赔付支付。
   * - 不带 reserve 拆分时：沿用旧路径（仅支付账本 + payment.settled，无准备金凭证）。
   * - 带 reserve 拆分时：按 stage（settled=核销授权 / authorized=支付即授权）生成准备金分录；
   *   拆分明细之和必须等于支付金额。
   */
  settle(claimId: string, input: { amount: number; currency: string; sourceId: string; reserve?: Omit<ReserveBlock, 'currency'> & { stage?: 'authorized' | 'settled' } }, actor: string) {
    const claim = this.claims.get(claimId); if (claim.status === 'rejected') throw new Error('rejected claim cannot be paid');
    const alreadyPaid = this.ledger.balance(claim.payments); const amountMinor = Math.round(input.amount * 100);
    if (alreadyPaid + amountMinor > claim.approvedMinor) throw new Error('payment exceeds approved amount');

    let reserve: ReserveBlock | undefined;
    if (input.reserve?.lines?.length) {
      reserve = { currency: input.currency, stage: input.reserve.stage ?? 'authorized', lines: input.reserve.lines, reasonNote: input.reserve.reasonNote, authorizationId: input.reserve.authorizationId };
      const allocated = reserve.lines.reduce((sum, line) => sum + Math.abs(line.amountMinor), 0);
      if (allocated !== amountMinor) throw new Error(`reserve allocation ${allocated} must equal payment amount ${amountMinor}`);
    }
    const payment = this.ledger.post(claim.payments, { ...input, kind: 'settlement' });
    return this.claims.addEvent(claimId, 'payment.settled', reserve ? { payment, reserve } : { payment }, actor, `payment:${input.sourceId}`);
  }

  /**
   * 支付冲正。带 reserve 拆分时生成红冲分录（案件重开/资金追回）；不带时沿用旧路径。
   */
  reverse(claimId: string, input: { amount: number; currency: string; sourceId: string; reserve?: Omit<PaymentReversedReservePayload, 'currency' | 'originalSourceId'> }, actor: string) {
    const claim = this.claims.get(claimId);
    let reserve: PaymentReversedReservePayload | undefined;
    if (input.reserve?.lines?.length) {
      reserve = { stage: input.reserve.stage ?? 'settled', currency: input.currency, lines: input.reserve.lines, originalSourceId: input.sourceId, reasonNote: input.reserve.reasonNote };
      const allocated = reserve.lines.reduce((sum, line) => sum + Math.abs(line.amountMinor), 0);
      if (allocated !== Math.round(input.amount * 100)) throw new Error('reserve allocation must equal reversal amount');
    }
    const payment = this.ledger.post(claim.payments, { ...input, kind: 'reversal' });
    return this.claims.addEvent(claimId, 'payment.reversed', reserve ? { payment, reserve } : { payment }, actor, `reversal:${input.sourceId}`);
  }
}
