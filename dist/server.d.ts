/**
 * Build a configured MCP server with Venice tools, resources, and prompts.
 * Pure factory — does not bind any transport. Transports live in src/transports/.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VeniceClient } from './venice-client.js';
import { type Config } from './config.js';
export interface BuildOptions {
    config?: Config;
    /** Inject an alternate client for tests. */
    client?: VeniceClient;
}
export declare function buildServer(opts?: BuildOptions): McpServer;
export { loadConfig } from './config.js';
export { VeniceClient } from './venice-client.js';
//# sourceMappingURL=server.d.ts.map