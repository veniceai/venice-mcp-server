// eslint-disable-next-line @typescript-eslint/no-require-imports
import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from '../server.js';
export function isAuthorizedBearerHeader(header, expectedToken) {
    if (!expectedToken)
        return true;
    if (!header?.startsWith('Bearer '))
        return false;
    return header.slice('Bearer '.length) === expectedToken;
}
/**
 * Run the server over Streamable HTTP for hosted deployments
 * (Smithery, internal Cloud Run, etc.). Sessionful.
 */
export async function runHttp(opts = {}) {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    const sessions = new Map();
    app.get('/healthz', (_req, res) => res.json({ ok: true, name: '@veniceai/mcp-server' }));
    app.all('/mcp', async (req, res) => {
        try {
            const authToken = process.env.VENICE_MCP_AUTH_TOKEN;
            if (!isAuthorizedBearerHeader(req.header('authorization'), authToken)) {
                res.setHeader('WWW-Authenticate', 'Bearer');
                res.status(401).json({ error: 'unauthorized' });
                return;
            }
            const sessionHeader = req.header('mcp-session-id');
            let transport = sessionHeader ? sessions.get(sessionHeader) : undefined;
            if (!transport) {
                const sessionId = sessionHeader ?? randomUUID();
                const newTransport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => sessionId,
                    onsessioninitialized: (sid) => {
                        sessions.set(sid, newTransport);
                    },
                    enableJsonResponse: true,
                });
                newTransport.onclose = () => {
                    sessions.delete(sessionId);
                };
                const server = buildServer();
                await server.connect(newTransport);
                transport = newTransport;
            }
            await transport.handleRequest(req, res, req.body);
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[venice-mcp] /mcp error', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'internal' });
            }
        }
    });
    const port = opts.port ?? Number(process.env.PORT ?? 3333);
    // Default to loopback-only for safety. Opt in to all-interfaces via VENICE_MCP_HOST=0.0.0.0
    // (useful for Docker containers and intentional LAN exposure).
    const host = opts.host ?? process.env.VENICE_MCP_HOST ?? '127.0.0.1';
    await new Promise((resolve, reject) => {
        const listener = app.listen(port, host);
        listener.once('listening', () => resolve());
        listener.once('error', reject);
    });
    // eslint-disable-next-line no-console
    console.error(`[venice-mcp] listening on http://${host}:${port}/mcp`);
    if (host === '0.0.0.0') {
        // eslint-disable-next-line no-console
        console.error(`[venice-mcp] WARNING: bound to 0.0.0.0 — server is reachable from any network interface. Use VENICE_MCP_AUTH_TOKEN or a trusted authenticated proxy before exposing it.`);
    }
}
//# sourceMappingURL=http.js.map