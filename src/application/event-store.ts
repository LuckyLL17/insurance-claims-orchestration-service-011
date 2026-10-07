import { ClaimEventType, DomainEvent } from '../domain/types';
import { newId, iso } from '../domain/ids';

export class EventStore {
  private events = new Map<string, DomainEvent[]>();
  private idempotency = new Map<string, DomainEvent>();
  append<T>(aggregateId: string, type: ClaimEventType, payload: T, actor: string, idempotencyKey?: string, occurredAt?: string): DomainEvent<T> {
    if (idempotencyKey) { const prior = this.idempotency.get(`${aggregateId}:${idempotencyKey}`); if (prior) return prior as DomainEvent<T>; }
    const list = this.events.get(aggregateId) ?? [];
    const event: DomainEvent<T> = { id: newId('event'), aggregateId, type, payload, actor, occurredAt: iso(occurredAt), sequence: list.length + 1, idempotencyKey };
    list.push(event); this.events.set(aggregateId, list);
    if (idempotencyKey) this.idempotency.set(`${aggregateId}:${idempotencyKey}`, event);
    return event;
  }
  list(aggregateId: string): DomainEvent[] { return [...(this.events.get(aggregateId) ?? [])].sort((a, b) => a.sequence - b.sequence); }
  aggregateIds(): string[] { return [...this.events.keys()]; }
  replace(aggregateId: string, events: DomainEvent[]): void { this.events.set(aggregateId, events.map((event, index) => ({ ...event, sequence: index + 1 }))); }
}
