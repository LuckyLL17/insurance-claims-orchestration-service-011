import { ClaimService } from './claim-service';
import { EventStore } from './event-store';
export class ReplayService {
  constructor(private readonly events: EventStore, private readonly claims: ClaimService) {}
  execute(claimId: string, until?: number) { const events = this.events.list(claimId).filter((event) => until === undefined || event.sequence <= until); return { claimId, eventCount: events.length, state: this.claims.replay(claimId, events), events }; }
}
