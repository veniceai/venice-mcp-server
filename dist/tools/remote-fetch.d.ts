type FetchImpl = typeof fetch;
type LookupAddresses = (hostname: string) => Promise<string[]>;
export interface FetchUploadSourceOptions {
    label: string;
    fallbackContentType: string;
    fallbackFilename: string;
    timeoutMs: number;
    maxBytes?: number;
    allowedContentTypes?: string[];
    fetchImpl?: FetchImpl;
    lookupAddresses?: LookupAddresses;
}
export interface UploadSource {
    buffer: Buffer;
    contentType: string;
    filename: string;
}
export declare function fetchUploadSource(url: string, opts: FetchUploadSourceOptions): Promise<UploadSource>;
export declare function validateRemoteUrl(url: URL, lookupAddresses?: LookupAddresses): Promise<void>;
export {};
//# sourceMappingURL=remote-fetch.d.ts.map