import { ClaimService } from './claim-service';
import { EventStore } from './event-store';
import { ReserveProjector } from '../domain/reserve-projector';

export class ReplayService {
  private readonly projector = new ReserveProjector();
  constructor(private readonly events: EventStore, private readonly claims: ClaimService) {}

  execute(claimId: string, until?: number) {
    const events = this.events.list(claimId).filter((event) => until === undefined || event.sequence <= until);
    return { claimId, eventCount: events.length, state: this.claims.replay(claimId, events), reserve: this.projector.fold(claimId, events), events };
  }

  /** 区间重放：从某事件序号之后开始重放，用于核查乱序补发后的收敛。 */
  executeRange(claimId: string, fromSequence?: number, toSequence?: number) {
    const events = this.events.list(claimId).filter((event) => (fromSequence === undefined || event.sequence >= fromSequence) && (toSequence === undefined || event.sequence <= toSequence));
    return { claimId, eventCount: events.length, reserve: this.projector.fold(claimId, events), events };
  }
}
