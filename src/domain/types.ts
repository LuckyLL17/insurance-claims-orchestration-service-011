export type ClaimStatus =
  | 'reported'
  | 'investigating'
  | 'awaiting_documents'
  | 'ready_for_adjustment'
  | 'partially_paid'
  | 'settled'
  | 'reopened'
  | 'rejected';

export type ClaimEventType =
  | 'claim.reported'
  | 'policy.snapshot.created'
  | 'evidence.added'
  | 'evidence.reviewed'
  | 'survey.assigned'
  | 'survey.completed'
  | 'documents.requested'
  | 'documents.received'
  | 'risk.assessed'
  | 'adjustment.approved'
  | 'payment.authorized'
  | 'payment.settled'
  | 'payment.reversed'
  | 'claim.reopened'
  | 'claim.rejected';

export interface Participant { kind: 'person' | 'vehicle' | 'device' | 'repair_shop' | 'account'; id: string; role?: string; }
export interface MonetaryAmount { currency: string; minor: number; }
export interface LossEstimate { currency: string; gross: number; deductible?: number; liabilityShare?: number; cap?: number; }
export interface PolicyVersion { policyId: string; version: number; effectiveFrom: string; effectiveTo?: string; coverages: string[]; deductibleMinor: number; limitMinor: number; }
export interface EvidenceRecord { id: string; kind: string; hash: string; version: number; receivedAt: string; reviewed: boolean; accepted?: boolean; source: string; supersedes?: string; }
export interface PaymentEntry { id: string; kind: 'authorization' | 'settlement' | 'reversal' | 'recovery'; amount: MonetaryAmount; sourceId: string; status: 'pending' | 'posted' | 'voided'; createdAt: string; }
export interface RuleSnapshot { version: string; frozenAt: string; ruleIds: string[]; }
export interface RiskSignal { code: string; score: number; explanation: string; participants: string[]; }
export interface AuditEntry { sequence: number; eventId: string; type: ClaimEventType; occurredAt: string; actor: string; summary: string; }

export interface ClaimState {
  id: string;
  policyId: string;
  status: ClaimStatus;
  lossAt: string;
  reportedAt: string;
  channel: string;
  participants: Participant[];
  loss: LossEstimate;
  policy?: PolicyVersion;
  ruleSnapshot?: RuleSnapshot;
  evidence: EvidenceRecord[];
  requiredEvidence: Set<string>;
  completedSurveys: string[];
  pendingDocuments: string[];
  riskSignals: RiskSignal[];
  riskScore: number;
  payments: PaymentEntry[];
  approvedMinor: number;
  audit: AuditEntry[];
  processedEventIds: Set<string>;
  version: number;
}

export interface DomainEvent<T = unknown> {
  id: string;
  aggregateId: string;
  type: ClaimEventType;
  occurredAt: string;
  sequence: number;
  actor: string;
  idempotencyKey?: string;
  payload: T;
}

export interface ClaimReportedPayload {
  policyId: string; lossAt: string; reportedAt: string; channel: string;
  participants: Participant[]; loss: LossEstimate;
}
