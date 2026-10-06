import { ClaimService } from './claim-service';
import { TaskBoard } from '../domain/task';
export class TaskService {
  constructor(private readonly claims: ClaimService, private readonly tasks: TaskBoard) {}
  create(claimId: string, kind: 'survey' | 'document_review' | 'fraud_review') { this.claims.get(claimId); return this.tasks.create(claimId, kind); }
  lease(claimId: string, taskId: string, owner: string, ttlMs: number) { const task = this.tasks.lease(taskId, owner, ttlMs); if (task.claimId !== claimId) throw new Error('task does not belong to claim'); return task; }
  submit(claimId: string, taskId: string, owner: string, version: number, result: unknown, actor: string) { const task = this.tasks.submit(taskId, owner, version, result); if (task.claimId !== claimId) throw new Error('task does not belong to claim'); if (task.kind === 'survey') this.claims.addEvent(claimId, 'survey.completed', { taskId, result }, actor, `survey:${taskId}:${task.version}`); return task; }
  list(claimId: string) { return this.tasks.listClaim(claimId); }
}
