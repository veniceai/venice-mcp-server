import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_FETCH = fetch;
export async function fetchUploadSource(url, opts) {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), opts.timeoutMs);
    const fetchImpl = opts.fetchImpl ?? fetch;
    const useInjectedFetch = opts.fetchImpl !== undefined || fetchImpl !== DEFAULT_FETCH;
    const lookupAddresses = opts.lookupAddresses ?? lookupHostname;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    try {
        let currentUrl = new URL(url);
        let res;
        for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
            res = await fetchRemoteUrl(currentUrl, ac.signal, lookupAddresses, useInjectedFetch ? fetchImpl : undefined, opts.pinnedFetchImpl);
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
        const headerContentType = res.headers.get('content-type');
        const contentType = headerContentType ?? opts.fallbackContentType;
        const buffer = await readBoundedBuffer(res, maxBytes, opts.label);
        assertAllowedContentType(contentType, opts.allowedContentTypes, opts.label, buffer, headerContentType === null);
        return {
            buffer,
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
    await resolveValidRemoteAddresses(url, lookupAddresses);
}
async function resolveValidRemoteAddresses(url, lookupAddresses = lookupHostname) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Refusing to fetch URL with unsupported scheme: ${url.protocol}`);
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
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
    return addresses;
}
async function fetchRemoteUrl(url, signal, lookupAddresses, injectedFetch, pinnedFetchImpl) {
    if (injectedFetch) {
        await validateRemoteUrl(url, lookupAddresses);
        return injectedFetch(url, { signal, redirect: 'manual' });
    }
    return fetchPinnedRemoteUrl(url, signal, lookupAddresses, pinnedFetchImpl);
}
async function fetchPinnedRemoteUrl(url, signal, lookupAddresses, pinnedFetchImpl = requestPinnedAddress) {
    const addresses = await resolveValidRemoteAddresses(url, lookupAddresses);
    let lastError;
    for (const address of addresses) {
        try {
            return await pinnedFetchImpl(url, address, signal);
        }
        catch (err) {
            if (signal.aborted)
                throw err;
            lastError = err;
        }
    }
    throw lastError instanceof Error ? lastError : new Error(`Could not fetch ${url.hostname}`);
}
async function requestPinnedAddress(url, address, signal) {
    const client = url.protocol === 'https:' ? https : http;
    const family = isIP(address);
    if (family !== 4 && family !== 6)
        throw new Error(`Refusing to fetch invalid resolved address: ${address}`);
    const options = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { Host: url.host },
        signal,
        lookup: ((_hostname, options, callback) => {
            // Node ≥22 passes { all: true } to custom lookup functions; the callback
            // then expects an array of { address, family } objects rather than the
            // legacy (address, family) positional form.
            if (options.all) {
                ;
                callback(null, [{ address, family }]);
            }
            else {
                callback(null, address, family);
            }
        }),
    };
    if (url.protocol === 'https:')
        options.servername = url.hostname;
    return new Promise((resolve, reject) => {
        const req = client.request(options, (res) => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
                if (Array.isArray(value)) {
                    for (const item of value)
                        headers.append(key, item);
                }
                else if (value !== undefined) {
                    headers.set(key, value);
                }
            }
            resolve(new Response(Readable.toWeb(res), {
                status: res.statusCode ?? 500,
                statusText: res.statusMessage,
                headers,
            }));
        });
        req.on('error', reject);
        req.end();
    });
}
async function lookupHostname(hostname) {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
}
function isRedirect(status) {
    return status >= 300 && status < 400;
}
function assertAllowedContentType(contentType, allowed, label, buffer, usedFallbackContentType) {
    if (!allowed || allowed.length === 0)
        return;
    const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
    if (normalized === 'application/octet-stream' && allowed.some((entry) => entry.toLowerCase() === 'application/octet-stream'))
        return;
    if ((!normalized || normalized === 'application/octet-stream' || usedFallbackContentType) && isAllowedByMagicBytes(buffer, allowed))
        return;
    const ok = allowed.some((entry) => {
        const allowedType = entry.toLowerCase();
        return normalized.startsWith(allowedType);
    });
    if (!ok)
        throw new Error(`Could not fetch ${label}: unsupported content-type ${contentType}`);
    if (usedFallbackContentType)
        throw new Error(`Could not fetch ${label}: missing content-type did not match allowed file signatures`);
    if (normalized === 'application/octet-stream')
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
function isAllowedByMagicBytes(buffer, allowed) {
    return allowed.some((entry) => {
        const allowedType = entry.toLowerCase();
        if (allowedType.startsWith('image/'))
            return isImage(buffer);
        if (allowedType.startsWith('audio/'))
            return isAudio(buffer);
        if (allowedType.startsWith('video/'))
            return isVideo(buffer);
        if (allowedType === 'application/pdf')
            return startsWithAscii(buffer, '%PDF-');
        if (allowedType === 'application/epub+zip')
            return isZip(buffer);
        if (allowedType.startsWith('application/vnd.openxmlformats-officedocument.'))
            return isZip(buffer);
        if (allowedType.startsWith('application/vnd.ms-') || allowedType === 'application/msword')
            return isOle(buffer);
        return false;
    });
}
function isImage(buffer) {
    return (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
        buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) ||
        startsWithAscii(buffer, 'GIF8') ||
        (startsWithAscii(buffer, 'RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WEBP'));
}
function isAudio(buffer) {
    return (startsWithAscii(buffer, 'ID3') ||
        (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) ||
        (startsWithAscii(buffer, 'RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WAVE') ||
        startsWithAscii(buffer, 'OggS') ||
        startsWithAscii(buffer, 'fLaC') ||
        isMp4Family(buffer));
}
function isVideo(buffer) {
    return isMp4Family(buffer) || buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}
function isMp4Family(buffer) {
    return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
}
function isZip(buffer) {
    return buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}
function isOle(buffer) {
    return buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}
function startsWithAscii(buffer, value) {
    return buffer.subarray(0, value.length).toString('ascii') === value;
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
    const normalized = address.toLowerCase().split('%')[0];
    const groups = expandIpv6Groups(normalized);
    if (groups && isLocalUseNat64Prefix(groups))
        return true;
    const embeddedIpv4 = ipv4FromMappedOrEmbedded(normalized, groups);
    if (embeddedIpv4 && isBlockedIpv4(embeddedIpv4))
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
/** Decode IPv4-mapped, IPv4-compatible, and NAT64 well-known embeddings, including hex form. */
function ipv4FromMappedOrEmbedded(address, groups = expandIpv6Groups(address)) {
    const dotted = address.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (dotted)
        return dotted;
    if (!groups)
        return undefined;
    const isMapped = groups[0] === 0 &&
        groups[1] === 0 &&
        groups[2] === 0 &&
        groups[3] === 0 &&
        groups[4] === 0 &&
        groups[5] === 0xffff;
    const isCompatible = groups[0] === 0 &&
        groups[1] === 0 &&
        groups[2] === 0 &&
        groups[3] === 0 &&
        groups[4] === 0 &&
        groups[5] === 0;
    const isNat64WellKnown = groups[0] === 0x64 &&
        groups[1] === 0xff9b &&
        groups[2] === 0 &&
        groups[3] === 0 &&
        groups[4] === 0 &&
        groups[5] === 0;
    if (!isMapped && !isCompatible && !isNat64WellKnown)
        return undefined;
    return `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`;
}
/** RFC 8215 local-use IPv4/IPv6 translation prefix 64:ff9b:1::/48. */
function isLocalUseNat64Prefix(groups) {
    return groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 0x1;
}
function expandIpv6Groups(address) {
    let hex = address;
    const dotted = address.match(/:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) {
        const parts = dotted[1].split('.').map((part) => Number(part));
        if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
            return undefined;
        }
        const hi = ((parts[0] << 8) | parts[1]).toString(16);
        const lo = ((parts[2] << 8) | parts[3]).toString(16);
        hex = `${address.slice(0, -dotted[1].length)}${hi}:${lo}`;
    }
    const [head, tail] = hex.split('::');
    const parse = (part) => part ? part.split(':').filter(Boolean).map((group) => Number.parseInt(group, 16)) : [];
    if (tail === undefined) {
        const groups = parse(head);
        return groups.length === 8 && groups.every(Number.isInteger) ? groups : undefined;
    }
    const left = parse(head);
    const right = parse(tail);
    const missing = 8 - left.length - right.length;
    if (missing < 0 || left.some((n) => !Number.isInteger(n)) || right.some((n) => !Number.isInteger(n))) {
        return undefined;
    }
    return [...left, ...Array(missing).fill(0), ...right];
}
//# sourceMappingURL=remote-fetch.js.map