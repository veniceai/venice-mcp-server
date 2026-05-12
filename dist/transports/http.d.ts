export declare function isAuthorizedBearerHeader(header: string | undefined, expectedToken: string | undefined): boolean;
/**
 * Run the server over Streamable HTTP for hosted deployments
 * (Smithery, internal Cloud Run, etc.). Sessionful.
 */
export declare function runHttp(opts?: {
    port?: number;
    host?: string;
}): Promise<void>;
//# sourceMappingURL=http.d.ts.map