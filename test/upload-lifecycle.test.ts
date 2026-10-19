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
const [mode, sourceUrl, toolJson] = process.argv.slice(1);
const tool = JSON.parse(toolJson);
const { fetchUploadSource } = await import(sourceUrl);
const sourceHostname = tool ? '93.184.216.34' : 'public-fixture.example';
const sockets = new Set();
const unfinished = [];
const requests = [];
const uploads = [];
let transports = 0;
let lookups = 0;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/')) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'content-type': req.headers['content-type'] },
      }).formData();
      const files = [];
      for (const [field, value] of form) {
        if (typeof value !== 'string') {
          files.push({ field, name: value.name, type: value.type, text: await value.text() });
        }
      }
      uploads.push({ method: req.method, path: req.url, files });
      if (req.url === '/v1/image/upscale') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end('image');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: 'fixture result' }));
      }
    });
    return;
  }
  requests.push(req.url);
  assert.equal(req.headers.host, sourceHostname);
  if (req.url === '/final') {
    // The final response cannot finish until redirect cleanup closes the old
    // connection. A final-only abort would time out instead of passing this test.
    void Promise.all(unfinished.map(item => item.closedPromise)).then(() => {
      res.writeHead(200, { 'content-type': 'image/png', connection: 'close' });
      res.end('image');
    });
    return;
  }
  // Record close events before teardown can destroy fixture-side sockets.
  // Only the 200 cases below end their responses; the others stay unfinished.
  const pending = { closed: false, closedPromise: once(req.socket, 'close') };
  req.socket.once('close', () => { pending.closed = true; });
  unfinished.push(pending);
  if (mode === 'empty-200' || mode === 'nonempty-200') {
    res.writeHead(200, { 'content-type': tool.contentType, connection: 'close' });
    res.end(mode === 'empty-200' ? '' : 'fixture input');
    return;
  }
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
  const headers = { 'content-type': tool?.contentType ?? 'image/png' };
  if (mode === 'declared-oversize') headers['content-length'] = '999999';
  if (mode === 'truncated') headers['content-length'] = '10';
  // A Location on a non-redirect must never be followed, including 304.
  if (status >= 300 && status < 400) headers.location = '/final';
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
  assert.equal(options.hostname, sourceHostname);
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
let toolResult;
let error;
let closeDeadline;
try {
  try {
    if (tool) {
      const { buildTools } = await import(new URL('./index.ts', sourceUrl));
      const { loadConfig } = await import(new URL('../config.ts', sourceUrl));
      const { VeniceClient } = await import(new URL('../venice-client.ts', sourceUrl));
      const cfg = { ...loadConfig({}), baseUrl: 'http://127.0.0.1:' + server.address().port, timeoutMs: 2000 };
      const handler = buildTools(new VeniceClient(cfg), cfg).find(item => item.name === tool.name).handler;
      toolResult = await handler({
        ...tool.args, [tool.label]: 'http://' + sourceHostname + '/' + tool.filename,
      });
    } else {
      result = await fetchUploadSource('http://public-fixture.example/first', {
        label: 'fixture', fallbackContentType: 'image/png', fallbackFilename: 'image.png',
        timeoutMs: mode === 'timeout' ? 100 : 2000, maxBytes: 10,
        lookupAddresses: async hostname => {
          lookups++;
          return hostname === 'private-fixture.example' ? ['10.0.0.1'] : ['93.184.216.34'];
        },
      });
    }
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
    error, bytes: result?.buffer.length, toolResult, uploads, requests, transports, lookups,
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
  toolResult?: { isError?: boolean; content: Array<{ type: string; text?: string }> }
  uploads: Array<{
    method: string
    path: string
    files: Array<{ field: string; name: string; type: string; text: string }>
  }>
  requests: string[]
  transports: number
  lookups: number
  unfinished: number
  closed: number
}

const uploadTools = [
  {
    name: 'venice_image_upscale', label: 'image_url', contentType: 'image/png', filename: 'image.png',
    path: '/v1/image/upscale', field: 'image', args: {},
  },
  {
    name: 'venice_asr', label: 'audio_url', contentType: 'audio/wav', filename: 'audio.wav',
    path: '/v1/audio/transcriptions', field: 'file', args: {},
  },
  {
    name: 'venice_voice_clone', label: 'sample_url', contentType: 'audio/mpeg', filename: 'sample.mp3',
    path: '/v1/audio/voices', field: 'file', args: { action: 'create' },
  },
  {
    name: 'venice_text_parser', label: 'url', contentType: 'application/pdf', filename: 'document.pdf',
    path: '/v1/augment/text-parser', field: 'file', args: {},
  },
]

async function runProbe(mode: string, tool?: typeof uploadTools[number]): Promise<ProbeResult> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e', probe, mode, sourceUrl, JSON.stringify(tool ?? null),
  ], { cwd: new URL('..', import.meta.url), timeout: 5000 })
  assert.equal(stderr, '')
  const result: ProbeResult = JSON.parse(stdout)
  assert.equal(result.closed, result.unfinished)
  return result
}

describe('upload HTTP callback errors', () => {
  for (const status of [204, 205]) {
    it(`rejects empty ${status} and closes the unfinished socket without crashing`, async () => {
      const result = await runProbe(String(status))
      assert.deepEqual(result.error, { name: 'Error', message: 'Could not fetch fixture: empty response body' })
      assert.equal(result.bytes, undefined)
      assert.equal(result.closed, 1)
    })
  }

  it('rejects a null-body 304 without crashing or following its Location', async () => {
    const result = await runProbe('304')
    assert.equal(result.error?.name, 'Error')
    assert.match(result.error?.message ?? '', /HTTP 304/)
    assert.deepEqual(result.requests, ['/first'])
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

describe('upload tool input validation', () => {
  for (const tool of uploadTools) {
    for (const mode of ['empty-200', '204', '205']) {
      it(`${tool.name} rejects ${mode} with compatible MIME before uploading`, async () => {
        const result = await runProbe(mode, tool)
        assert.equal(result.error, undefined)
        assert.ok(result.toolResult)
        assert.equal(result.toolResult.isError, true)
        assert.deepEqual(result.toolResult.content, [
          { type: 'text', text: `Error: Could not fetch ${tool.label}: empty response body` },
        ])
        assert.deepEqual(result.uploads, [])
        assert.deepEqual(result.requests, [`/${tool.filename}`])
        assert.equal(result.transports, 1)
        assert.equal(result.closed, 1)
      })
    }

    it(`${tool.name} still uploads a nonempty 200 body`, async () => {
      const result = await runProbe('nonempty-200', tool)
      assert.equal(result.error, undefined)
      assert.ok(result.toolResult)
      assert.notEqual(result.toolResult.isError, true)
      assert.deepEqual(result.uploads, [{
        method: 'POST', path: tool.path,
        files: [{ field: tool.field, name: tool.filename, type: tool.contentType, text: 'fixture input' }],
      }])
      assert.equal(result.transports, 1)
      assert.equal(result.closed, 1)
    })
  }
})
