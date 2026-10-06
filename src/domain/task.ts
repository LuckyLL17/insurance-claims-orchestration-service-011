import { newId, iso } from './ids';
export interface InvestigationTask { id: string; claimId: string; kind: 'survey' | 'document_review' | 'fraud_review'; status: 'queued' | 'leased' | 'submitted' | 'expired'; version: number; leaseOwner?: string; leaseUntil?: string; result?: unknown; createdAt: string; }
export class TaskBoard {
  private tasks = new Map<string, InvestigationTask>();
  create(claimId: string, kind: InvestigationTask['kind']): InvestigationTask { const task = { id: newId('task'), claimId, kind, status: 'queued' as const, version: 1, createdAt: iso() }; this.tasks.set(task.id, task); return structuredClone(task); }
  get(id: string): InvestigationTask { const task = this.tasks.get(id); if (!task) throw new Error(`unknown task ${id}`); return task; }
  lease(id: string, owner: string, ttlMs: number): InvestigationTask { const task = this.get(id); if (task.status === 'leased' && task.leaseUntil && new Date(task.leaseUntil) > new Date()) throw new Error('task is already leased'); const updated = { ...task, status: 'leased' as const, version: task.version + 1, leaseOwner: owner, leaseUntil: new Date(Date.now() + ttlMs).toISOString() }; this.tasks.set(id, updated); return structuredClone(updated); }
  submit(id: string, owner: string, version: number, result: unknown): InvestigationTask { const task = this.get(id); if (task.status !== 'leased' || task.leaseOwner !== owner || task.version !== version) throw new Error('task lease is stale or owned by another investigator'); if (!task.leaseUntil || new Date(task.leaseUntil) <= new Date()) throw new Error('task lease expired'); const updated = { ...task, status: 'submitted' as const, version: task.version + 1, result }; this.tasks.set(id, updated); return structuredClone(updated); }
  listClaim(claimId: string): InvestigationTask[] { return [...this.tasks.values()].filter((task) => task.claimId === claimId).map((task) => structuredClone(task)); }
}
