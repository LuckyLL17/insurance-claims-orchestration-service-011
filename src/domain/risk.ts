import { Participant, RiskSignal } from './types';

export interface RiskNode { key: string; kind: Participant['kind']; claims: Set<string>; }
export class RiskGraph {
  private nodes = new Map<string, RiskNode>();
  private claimParticipants = new Map<string, Participant[]>();

  link(claimId: string, participants: Participant[]): RiskSignal[] {
    this.claimParticipants.set(claimId, participants.map((p) => ({ ...p })));
    const signals: RiskSignal[] = [];
    for (const participant of participants) {
      const key = `${participant.kind}:${participant.id}`;
      const node = this.nodes.get(key) ?? { key, kind: participant.kind, claims: new Set<string>() };
      const priorClaims = [...node.claims].filter((id) => id !== claimId);
      node.claims.add(claimId);
      this.nodes.set(key, node);
      if (priorClaims.length > 0) signals.push({ code: `SHARED_${participant.kind.toUpperCase()}`, score: Math.min(40, priorClaims.length * 10), explanation: `${participant.kind} is linked to ${priorClaims.length} other claim(s)`, participants: [participant.id, ...priorClaims] });
    }
    return signals;
  }

  neighborhood(claimId: string): string[] {
    const related = new Set<string>();
    for (const participant of this.claimParticipants.get(claimId) ?? []) {
      const node = this.nodes.get(`${participant.kind}:${participant.id}`);
      for (const id of node?.claims ?? []) if (id !== claimId) related.add(id);
    }
    return [...related];
  }
}
