import { createServer } from 'node:http';
import { route, AppContext } from './router';
export function startServer(app: AppContext, port = Number(process.env.PORT ?? 4100)) { const server = createServer((req, res) => void route(req, res, app)); return new Promise<ReturnType<typeof createServer>>((resolve) => server.listen(port, () => { console.log(`insurance claims service listening on http://localhost:${port}`); resolve(server); })); }
