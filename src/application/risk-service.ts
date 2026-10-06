import { ClaimService } from './claim-service';
import { RiskGraph } from '../domain/risk';
export class RiskService {
  constructor(private readonly claims: ClaimService, private readonly graph: RiskGraph) {}
  assess(claimId: string, actor: string) {
    const claim = this.claims.get(claimId); const signals = this.graph.link(claimId, claim.participants); const score = Math.min(100, signals.reduce((sum, signal) => sum + signal.score, 0) + (claim.loss.gross >= 100000 ? 25 : 0));
    return this.claims.addEvent(claimId, 'risk.assessed', { score, signals }, actor, `risk:${claimId}:${claim.version}`);
  }
  related(claimId: string) { return this.graph.neighborhood(claimId); }
}
