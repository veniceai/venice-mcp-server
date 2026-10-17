import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const sourceUrl = new URL('../src/tools/remote-fetch.ts', import.meta.url).href

// Each probe runs in a subprocess so an uncaught HTTP callback error is a test
// failure, and mutations of http.request cannot affect another test's transport.
const probe = String.raw`
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
const [mode, sourceUrl] = process.argv.slice(1);
const { fetchUploadSource } = await import(sourceUrl);
const sockets = new Set();
const unfinished = [];
const requests = [];
let transports = 0;
let lookups = 0;
const server = http.createServer((req, res) => {
  requests.push(req.url);
  assert.equal(req.headers.host, 'public-fixture.example');
  if (req.url === '/final') {
    // The final response cannot finish until redirect cleanup closes the old
    // connection. A final-only abort would time out instead of passing this test.
    void Promise.all(unfinished.map(item => item.closedPromise)).then(() => {
      res.writeHead(200, { 'content-type': 'image/png', connection: 'close' });
      res.end('image');
    });
    return;
  }
  // Deliberately never call end() for these responses. Record close events now,
  // and assert them before teardown can destroy any fixture-side sockets.
  const pending = { closed: false, closedPromise: once(req.socket, 'close') };
  req.socket.once('close', () => { pending.closed = true; });
  unfinished.push(pending);
  if (mode === '700') {
    req.socket.write('HTTP/1.1 700 Odd\r\nContent-Type: image/png\r\nContent-Length: 100\r\n\r\nx');
    return;
  }
  if (mode === 'invalid-header') {
    req.socket.write('HTTP/1.1 200 OK\r\nX-Test: a\u0001b\r\nContent-Length: 100\r\n\r\nx');
    return;
  }
  if (mode.startsWith('redirect-')) {
    const target = {
      'redirect-private': 'http://127.0.0.1/private',
      'redirect-dns-private': 'http://private-fixture.example/private',
      'redirect-invalid': 'http://[',
      'redirect-scheme': 'file:///private',
      'redirect-loop': '/first',
    }[mode] ?? '/final';
    const status = Number(mode.slice('redirect-'.length)) || 302;
    res.writeHead(status, mode === 'redirect-missing' ? {} : { location: target });
    res.write('ignored');
    return;
  }
  const status = Number(mode) || 200;
  const headers = { 'content-type': 'image/png' };
  if (mode === 'declared-oversize') headers['content-length'] = '999999';
  if (mode === 'truncated') headers['content-length'] = '10';
  // Callback-only 304 coverage does not require the later redirect-classification fix.
  if (status >= 300 && status < 400 && status !== 304) headers.location = '/final';
  res.writeHead(status, headers);
  res.flushHeaders();
  if (mode === 'stream-oversize') res.write('01234567890');
  else if (status !== 204 && status !== 304) res.write('x');
  if (mode === 'truncated') setImmediate(() => req.socket.end());
});
server.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const originalRequest = http.request.bind(http);
http.request = (options, callback) => {
  transports++;
  assert.equal(options.hostname, 'public-fixture.example');
  // Exercise the production pinned lookup in both Node callback shapes. Only
  // after validation do we remap the socket destination to the local fixture.
  options.lookup(options.hostname, { all: true }, (err, records) => {
    assert.equal(err, null);
    assert.deepEqual(records, [{ address: '93.184.216.34', family: 4 }]);
  });
  options.lookup(options.hostname, {}, (err, address, family) => {
    assert.equal(err, null);
    assert.equal(address, '93.184.216.34');
    assert.equal(family, 4);
  });
  return originalRequest({
    ...options, hostname: '127.0.0.1', port: server.address().port, lookup: undefined,
  }, callback);
};
let result;
let error;
let closeDeadline;
try {
  try {
    result = await fetchUploadSource('http://public-fixture.example/first', {
      label: 'fixture', fallbackContentType: 'image/png', fallbackFilename: 'image.png',
      timeoutMs: mode === 'timeout' ? 100 : 2000, maxBytes: 10,
      lookupAddresses: async hostname => {
        lookups++;
        return hostname === 'private-fixture.example' ? ['10.0.0.1'] : ['93.184.216.34'];
      },
    });
  } catch (err) {
    error = { name: err.name, message: err.message };
  }
  assert.ok(unfinished.length > 0);
  await Promise.race([
    Promise.all(unfinished.map(item => item.closedPromise)),
    new Promise((_, reject) => {
      closeDeadline = setTimeout(() => reject(new Error('unfinished socket still open after upload settled')), 500);
    }),
  ]);
  assert.ok(unfinished.every(item => item.closed));
  console.log(JSON.stringify({
    error, bytes: result?.buffer.length, requests, transports, lookups,
    unfinished: unfinished.length, closed: unfinished.filter(item => item.closed).length,
  }));
} finally {
  clearTimeout(closeDeadline);
  http.request = originalRequest;
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
`

interface ProbeResult {
  error?: { name: string; message: string }
  bytes?: number
  requests: string[]
  transports: number
  lookups: number
  unfinished: number
  closed: number
}

async function runProbe(mode: string): Promise<ProbeResult> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e', probe, mode, sourceUrl,
  ], { cwd: new URL('..', import.meta.url), timeout: 5000 })
  assert.equal(stderr, '')
  const result: ProbeResult = JSON.parse(stdout)
  assert.equal(result.closed, result.unfinished)
  return result
}

describe('upload HTTP callback errors', () => {
  for (const status of [204, 205]) {
    it(`handles ${status} with a null body and closes the unfinished socket`, async () => {
      const result = await runProbe(String(status))
      assert.equal(result.error, undefined)
      assert.equal(result.bytes, 0)
      assert.equal(result.closed, 1)
    })
  }

  it('handles a null-body 304 without crashing the production callback', async () => {
    const result = await runProbe('304')
    // Redirect classification is unchanged in this commit; construction must still be safe.
    assert.equal(result.error?.name, 'Error')
    assert.match(result.error?.message ?? '', /redirect missing Location/)
    assert.equal(result.transports, 1)
    assert.equal(result.closed, 1)
  })

  it('rejects raw HTTP 700 inside the production callback without crashing', async () => {
    const result = await runProbe('700')
    assert.equal(result.error?.name, 'RangeError')
    assert.match(result.error?.message ?? '', /200 to 599/)
    assert.equal(result.closed, 1)
  })

  it('closes every unfinished socket on invalid-header', async () => {
    const result = await runProbe('invalid-header')
    assert.match(result.error?.message ?? '', /Parse Error/)
    assert.equal(result.bytes, undefined)
    assert.equal(result.transports, 1)
    assert.equal(result.closed, result.transports)
  })
})
