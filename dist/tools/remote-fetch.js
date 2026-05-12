import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
export async function fetchUploadSource(url, opts) {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), opts.timeoutMs);
    const fetchImpl = opts.fetchImpl ?? fetch;
    const lookupAddresses = opts.lookupAddresses ?? lookupHostname;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    try {
        let currentUrl = new URL(url);
        let res;
        for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
            await validateRemoteUrl(currentUrl, lookupAddresses);
            res = await fetchImpl(currentUrl, { signal: ac.signal, redirect: 'manual' });
            if (!isRedirect(res.status))
                break;
            const location = res.headers.get('location');
            if (!location)
                throw new Error(`Could not fetch ${opts.label}: redirect missing Location header`);
            currentUrl = new URL(location, currentUrl);
            res = undefined;
        }
        if (!res)
            throw new Error(`Could not fetch ${opts.label}: too many redirects`);
        if (isRedirect(res.status))
            throw new Error(`Could not fetch ${opts.label}: too many redirects`);
        if (!res.ok)
            throw new Error(`Could not fetch ${opts.label}: HTTP ${res.status}`);
        const contentType = res.headers.get('content-type') ?? opts.fallbackContentType;
        assertAllowedContentType(contentType, opts.allowedContentTypes, opts.label);
        return {
            buffer: await readBoundedBuffer(res, maxBytes, opts.label),
            contentType,
            filename: filenameFromUrl(currentUrl, opts.fallbackFilename),
        };
    }
    catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Timed out fetching ${opts.label} after ${opts.timeoutMs}ms`);
        }
        throw err;
    }
    finally {
        clearTimeout(timeout);
    }
}
export async function validateRemoteUrl(url, lookupAddresses = lookupHostname) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Refusing to fetch URL with unsupported scheme: ${url.protocol}`);
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
        throw new Error(`Refusing to fetch local hostname: ${url.hostname}`);
    }
    const addresses = isIP(hostname) ? [hostname] : await lookupAddresses(hostname);
    if (addresses.length === 0)
        throw new Error(`Could not resolve hostname: ${url.hostname}`);
    for (const address of addresses) {
        if (isBlockedIp(address)) {
            throw new Error(`Refusing to fetch private or local address: ${address}`);
        }
    }
}
async function lookupHostname(hostname) {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
}
function isRedirect(status) {
    return status >= 300 && status < 400;
}
function assertAllowedContentType(contentType, allowed, label) {
    if (!allowed || allowed.length === 0)
        return;
    const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
    if (!normalized || normalized === 'application/octet-stream')
        return;
    const ok = allowed.some((entry) => {
        const allowedType = entry.toLowerCase();
        return normalized.startsWith(allowedType);
    });
    if (!ok)
        throw new Error(`Could not fetch ${label}: unsupported content-type ${contentType}`);
}
async function readBoundedBuffer(res, maxBytes, label) {
    const contentLength = res.headers.get('content-length');
    if (contentLength !== null) {
        const size = Number(contentLength);
        if (Number.isFinite(size) && size > maxBytes) {
            throw new Error(`Could not fetch ${label}: response is larger than ${maxBytes} bytes`);
        }
    }
    if (!res.body)
        return Buffer.alloc(0);
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) {
            throw new Error(`Could not fetch ${label}: response is larger than ${maxBytes} bytes`);
        }
        chunks.push(buf);
    }
    return Buffer.concat(chunks, total);
}
function filenameFromUrl(url, fallback) {
    const last = url.pathname.split('/').filter(Boolean).pop();
    if (!last)
        return fallback;
    try {
        return decodeURIComponent(last);
    }
    catch {
        return last;
    }
}
function isBlockedIp(address) {
    const version = isIP(address);
    if (version === 4)
        return isBlockedIpv4(address);
    if (version === 6)
        return isBlockedIpv6(address);
    return true;
}
function isBlockedIpv4(address) {
    const parts = address.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
        return true;
    const [a, b] = parts;
    return (a === 0 ||
        a === 10 ||
        a === 127 ||
        a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0) ||
        (a === 198 && (b === 18 || b === 19)));
}
function isBlockedIpv6(address) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.match(/(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mappedIpv4 && isBlockedIpv4(mappedIpv4))
        return true;
    return (normalized === '::' ||
        normalized === '::1' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb') ||
        normalized.startsWith('ff'));
}
//# sourceMappingURL=remote-fetch.js.map