import { ClaimState, RuleSnapshot } from './types';
import { newId } from './ids';

export interface RuleDefinition { id: string; version: string; priority: number; enabled: boolean; evaluate: (claim: ClaimState) => string | undefined; }
export interface RuleDecision { approvedMinor: number; requiredEvidence: string[]; signals: { code: string; score: number; explanation: string }[]; reasons: string[]; }

export class RuleEngine {
  private versions = new Map<string, RuleDefinition[]>();
  private activeVersion = '2026.10';

  constructor() {
    this.versions.set('2026.10', [
      { id: 'coverage-present', version: '2026.10', priority: 10, enabled: true, evaluate: (c) => c.policy?.coverages.length ? undefined : 'policy has no active coverage' },
      { id: 'large-loss-review', version: '2026.10', priority: 20, enabled: true, evaluate: (c) => c.loss.gross >= 100000 ? 'large loss requires human review' : undefined },
      { id: 'missing-evidence', version: '2026.10', priority: 30, enabled: true, evaluate: (c) => c.evidence.some((e) => e.reviewed && e.accepted) ? undefined : 'at least one accepted evidence item is required' },
    ]);
  }

  publish(version: string, definitions: RuleDefinition[]): void {
    if (!/^\d{4}\.\d+$/.test(version)) throw new Error('rule version must look like YYYY.N');
    if (this.versions.has(version)) throw new Error(`rule version already exists: ${version}`);
    this.versions.set(version, definitions.map((rule) => ({ ...rule, version })));
    this.activeVersion = version;
  }

  freeze(): RuleSnapshot { return { version: this.activeVersion, frozenAt: new Date().toISOString(), ruleIds: (this.versions.get(this.activeVersion) ?? []).map((r) => r.id) }; }
  get(version: string): RuleDefinition[] { const rules = this.versions.get(version); if (!rules) throw new Error(`unknown rule version ${version}`); return rules.filter((rule) => rule.enabled).sort((a, b) => a.priority - b.priority); }

  evaluate(claim: ClaimState, snapshot: RuleSnapshot): RuleDecision {
    const rules = this.get(snapshot.version);
    const reasons = rules.flatMap((rule) => { const reason = rule.evaluate(claim); return reason ? [`${rule.id}: ${reason}`] : []; });
    const requiredEvidence = claim.loss.gross >= 100000 ? ['loss-photo', 'repair-estimate', 'police-report'] : ['loss-photo', 'repair-estimate'];
    const signals = claim.loss.gross >= 100000 ? [{ code: 'LARGE_LOSS', score: 25, explanation: 'gross loss exceeds manual review threshold' }] : [];
    const approvedMinor = Math.max(0, Math.min(Math.round(claim.loss.gross * 100) - (claim.policy?.deductibleMinor ?? 0), claim.policy?.limitMinor ?? 0));
    return { approvedMinor, requiredEvidence, signals, reasons };
  }

  createRule(id: string, priority: number, message: string): RuleDefinition { return { id: id || newId('rule'), version: this.activeVersion, priority, enabled: true, evaluate: () => message || undefined }; }
}
