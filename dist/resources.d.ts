/**
 * MCP resources (read-only) under venice://.
 * Each resource is a function that, given the VeniceClient, returns the body.
 */
import type { VeniceClient } from './venice-client.js';
export interface ResourceDef {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
    read: () => Promise<{
        uri: string;
        mimeType: string;
        text: string;
    }>;
}
export declare function buildResources(client: VeniceClient): ResourceDef[];
//# sourceMappingURL=resources.d.ts.map