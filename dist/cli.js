#!/usr/bin/env node
/**
 * Entry-point. Default mode is stdio (for Claude Desktop / Cursor / LM Studio).
 * Pass --http to run as a Streamable-HTTP server (for Smithery / Cloud Run).
 */
import { runStdio } from './transports/stdio.js';
import { runHttp } from './transports/http.js';
async function main() {
    const args = process.argv.slice(2);
    const httpMode = args.includes('--http') || process.env.VENICE_MCP_HTTP === '1';
    if (httpMode) {
        const portIdx = args.indexOf('--port');
        const port = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.PORT ?? 3333);
        await runHttp({ port });
    }
    else {
        await runStdio();
    }
}
main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[venice-mcp] fatal:', err);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map