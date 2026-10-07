import { IncomingMessage, ServerResponse } from 'node:http';
import { ClaimService } from '../application/claim-service';
import { PaymentService } from '../application/payment-service';
import { ReserveService } from '../application/reserve-service';
import { RiskService } from '../application/risk-service';
import { TaskService } from '../application/task-service';
import { ReplayService } from '../application/replay-service';
import { RuleEngine } from '../domain/rules';

export interface AppContext { claims: ClaimService; payments: PaymentService; reserves: ReserveService; risks: RiskService; tasks: TaskService; replay: ReplayService; rules: RuleEngine; }
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value, (_k, v) => v instanceof Set ? [...v] : v)); };
const body = async (req: IncomingMessage): Promise<any> => { let data = ''; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : {}; };
const parts = (url: string) => url.split('?')[0].split('/').filter(Boolean);
const query = (url: string): URLSearchParams => new URL(url, 'http://local').searchParams;
const intParam = (params: URLSearchParams, name: string): number | undefined => { const v = params.get(name); if (v === null) return undefined; const n = Number(v); if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`); return n; };

export async function route(req: IncomingMessage, res: ServerResponse, app: AppContext): Promise<void> {
  try {
    const method = req.method ?? 'GET'; const path = parts(req.url ?? '/'); const input = method === 'POST' ? await body(req) : {};
    if (method === 'GET' && path[0] === 'health') return json(res, 200, { ok: true, service: 'insurance-claims-orchestration', now: new Date().toISOString() });

    // 全局准备金期间汇总（跨案件）
    if (method === 'GET' && path[0] === 'reserves' && path[1] === 'period-summary') {
      const q = query(req.url ?? '/');
      return json(res, 200, app.reserves.periodSummary(undefined, q.get('from') ?? undefined, q.get('to') ?? undefined));
    }

    if (method === 'POST' && path[0] === 'claims' && path.length === 1) return json(res, 201, app.claims.create({ ...input, loss: { ...input.loss, gross: Number(input.loss.gross) } }, 'api', req.headers['idempotency-key'] as string));
    if (path[0] !== 'claims' || !path[1]) return json(res, 404, { error: 'route not found' });
    const id = path[1];
    if (method === 'GET' && path.length === 2) return json(res, 200, app.claims.get(id));
    if (method === 'POST' && path[2] === 'evidence' && path[4] === 'review') return json(res, 200, app.claims.reviewEvidence(id, path[3], Boolean(input.accepted), 'api', req.headers['idempotency-key'] as string));
    if (method === 'POST' && path[2] === 'evidence') return json(res, 201, app.claims.addEvidence(id, input, 'api', req.headers['idempotency-key'] as string));
    if (method === 'POST' && path[2] === 'events') return json(res, 200, app.claims.addEvent(id, input.type, input.payload, input.actor ?? 'api', input.idempotencyKey, input.occurredAt));
    if (method === 'POST' && path[2] === 'risk') return json(res, 200, app.risks.assess(id, 'api'));
    if (method === 'GET' && path[2] === 'risk') return json(res, 200, { relatedClaims: app.risks.related(id), state: app.claims.get(id) });
    if (method === 'POST' && path[2] === 'payments') return json(res, 200, app.payments.settle(id, input, 'api'));
    if (method === 'POST' && path[2] === 'reversals') return json(res, 200, app.payments.reverse(id, input, 'api'));
    if (method === 'POST' && path[2] === 'tasks') return json(res, 201, app.tasks.create(id, input.kind));
    if (method === 'GET' && path[2] === 'tasks') return json(res, 200, app.tasks.list(id));
    if (method === 'POST' && path[2] === 'replay') return json(res, 200, app.replay.execute(id, input.until));

    /* ---------- 案件准备金与财务分录子系统 ---------- */
    const actor = (input.actor as string | undefined) ?? 'api';
    const key = req.headers['idempotency-key'] as string | undefined;
    const currency = (input.currency as string) ?? 'CNY';

    if (method === 'GET' && path[2] === 'reserve' && path.length === 3) return json(res, 200, app.reserves.view(id));
    if (method === 'GET' && path[2] === 'reserve' && path[3] === 'evolution') {
      const q = query(req.url ?? '/');
      return json(res, 200, app.reserves.evolution(id, intParam(q, 'from'), intParam(q, 'to')));
    }
    if (method === 'GET' && path[2] === 'reserve' && path[3] === 'period-summary') {
      const q = query(req.url ?? '/');
      return json(res, 200, app.reserves.periodSummary(id, q.get('from') ?? undefined, q.get('to') ?? undefined));
    }
    if (method === 'GET' && path[2] === 'reserve' && path[3] === 'verify') return json(res, 200, app.reserves.verifyConsistency(id));
    if (method === 'GET' && path[2] === 'journal' && path[4] === 'audit') return json(res, 200, app.reserves.entryAudit(id, path[3]));

    if (method === 'POST' && path[2] === 'reserve' && path[3] === 'estimates') return json(res, 201, app.reserves.estimate(id, currency, input.lines, actor, input.reasonNote, key));
    if (method === 'POST' && path[2] === 'reserve' && path[3] === 'adjustments') return json(res, 201, app.reserves.adjust(id, currency, input.lines, actor, String(input.reasonNote ?? ''), key));
    if (method === 'POST' && path[2] === 'reserve' && path[3] === 'confirmations') return json(res, 201, app.reserves.confirmLiability(id, currency, input.lines, actor, input.reasonNote, key));
    if (method === 'POST' && path[2] === 'reserve' && path[3] === 'authorizations') return json(res, 201, app.reserves.authorize(id, { currency, authorizationId: input.authorizationId, lines: input.lines, reasonNote: input.reasonNote }, actor, key));
    if (method === 'POST' && path[2] === 'reserve' && path[3] === 'settlements') return json(res, 201, app.reserves.settle(id, { currency, sourceId: input.sourceId, stage: input.stage ?? 'settled', authorizationId: input.authorizationId, lines: input.lines, reasonNote: input.reasonNote }, actor));
    if (method === 'POST' && path[2] === 'reserve' && path[3] === 'reversals') return json(res, 201, app.reserves.reverseSettlement(id, { currency, sourceId: input.sourceId, lines: input.lines, reasonNote: input.reasonNote }, actor));
    if (method === 'POST' && path[2] === 'reserve' && path[3] === 'authorization-cancellations') return json(res, 201, app.reserves.cancelAuthorization(id, { currency, authorizationId: input.authorizationId, lines: input.lines, reasonNote: input.reasonNote }, actor, key));
    if (method === 'POST' && path[2] === 'reserve' && path[3] === 'recoveries' && path.length === 4) return json(res, 201, app.reserves.recordRecovery(id, { currency, lines: input.lines, reasonNote: input.reasonNote }, actor, key));
    if (method === 'POST' && path[2] === 'reserve' && path[3] === 'recoveries' && path[4] === 'realizations') return json(res, 201, app.reserves.realizeRecovery(id, { currency, recoverySourceId: input.recoverySourceId, lines: input.lines, reasonNote: input.reasonNote }, actor));
    if (method === 'POST' && path[2] === 'reserve' && path[3] === 'close') return json(res, 200, app.reserves.close(id, currency, actor, input.reasonNote, key));
    if (method === 'POST' && path[2] === 'reserve' && path[3] === 'reopen') return json(res, 200, app.reserves.reopen(id, currency, actor, input.reasonNote, key));

    return json(res, 404, { error: 'route not found' });
  } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : 'unknown error' }); }
}
