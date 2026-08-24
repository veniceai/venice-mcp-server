export declare function isAuthorizedBearerHeader(header: string | undefined, expectedToken: string | undefined): boolean;
export declare function isLoopbackHost(host: string): boolean;
export declare function validateHttpAuthConfig(host: string, authToken: string | undefined, allowUnauthenticated?: boolean): void;
export declare function isValidSessionId(sessionId: string): boolean;
/**
 * Run the server over Streamable HTTP for hosted deployments
 * (Smithery, internal Cloud Run, etc.). Sessionful.
 */
export declare function runHttp(opts?: {
    port?: number;
    host?: string;
}): Promise<void>;
//# sourceMappingURL=http.d.ts.map