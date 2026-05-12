/**
 * Build a configured MCP server with Venice tools, resources, and prompts.
 * Pure factory — does not bind any transport. Transports live in src/transports/.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeniceClient } from './venice-client.js';
import { loadConfig } from './config.js';
import { buildTools } from './tools/index.js';
import { buildResources } from './resources.js';
import { buildPrompts } from './prompts.js';
export function buildServer(opts = {}) {
    const cfg = opts.config ?? loadConfig();
    const client = opts.client ?? new VeniceClient(cfg);
    const server = new McpServer({ name: cfg.serverName, version: cfg.serverVersion }, {
        capabilities: {
            tools: {},
            resources: {},
            prompts: {},
            logging: {},
        },
        instructions: [
            'Venice MCP exposes uncensored, privacy-respecting AI inference (LLM, image, video, TTS, ASR, music) via Venice.ai.',
            'Auth: set VENICE_API_KEY in env, OR forward x402 X-PAYMENT challenges from the client.',
            'See https://docs.venice.ai/mcp for full reference.',
        ].join(' '),
    });
    // Tools — cast to any to bypass deep ZodRawShape inference in the SDK.
    // We rely on Zod for runtime validation; TS-side typing is widened.
    const srv = server;
    for (const t of buildTools(client, cfg)) {
        srv.registerTool(t.name, {
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
        }, async (args) => t.handler(args));
    }
    // Resources
    for (const r of buildResources(client)) {
        srv.registerResource(r.uri.replace(/^venice:\/\//, ''), r.uri, {
            title: r.name,
            description: r.description,
            mimeType: r.mimeType,
        }, async () => ({ contents: [await r.read()] }));
    }
    // Prompts
    for (const p of buildPrompts()) {
        srv.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: p.argsSchema }, async (args) => p.build(args));
    }
    return server;
}
export { loadConfig } from './config.js';
export { VeniceClient } from './venice-client.js';
//# sourceMappingURL=server.js.map