import { createHash, randomUUID } from 'node:crypto';

export function newId(prefix: string): string { return `${prefix}_${randomUUID()}`; }
export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function asMinor(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('amount must be a non-negative finite number');
  return Math.round(value * 100);
}
export function iso(value?: string): string {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date.toISOString();
}
