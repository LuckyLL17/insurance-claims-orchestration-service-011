import { EvidenceRecord } from './types';
import { newId, stableHash, iso } from './ids';

export class EvidenceLedger {
  add(input: { kind: string; source: string; content: unknown; receivedAt?: string; supersedes?: string }, current: EvidenceRecord[]): EvidenceRecord {
    const prior = input.supersedes ? current.find((record) => record.id === input.supersedes) : undefined;
    if (input.supersedes && !prior) throw new Error(`cannot supersede unknown evidence ${input.supersedes}`);
    const siblings = current.filter((record) => record.kind === input.kind);
    return { id: newId('evidence'), kind: input.kind, source: input.source, hash: stableHash(input.content), version: (siblings.at(-1)?.version ?? 0) + 1, receivedAt: iso(input.receivedAt), reviewed: false, supersedes: input.supersedes };
  }

  review(id: string, accepted: boolean, current: EvidenceRecord[]): EvidenceRecord {
    const record = current.find((item) => item.id === id);
    if (!record) throw new Error(`unknown evidence ${id}`);
    return { ...record, reviewed: true, accepted };
  }

  currentByKind(records: EvidenceRecord[]): Map<string, EvidenceRecord> {
    const map = new Map<string, EvidenceRecord>();
    for (const record of records) {
      const existing = map.get(record.kind);
      if (!existing || record.version > existing.version) map.set(record.kind, record);
    }
    return map;
  }
}
