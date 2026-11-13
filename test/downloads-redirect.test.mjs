// Real-http tests for the downloader's redirect handling in httpByteSource
// (mock ByteSource tests in page.test.mjs never exercise redirects). A local
// node:http server plays the origin + CDN: this stays offline (no real HF
// traffic) while testing actual wire behavior — status codes, Range headers,
// Location hops, and the SSRF refusal of private redirect targets.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';

async function withServer(handler) {
  const server = createServer(handler);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((res) => server.close(res)) };
}

function readBody(stream) {
  return new Promise((res, rej) => {
    const parts = [];
    stream.on('data', (c) => parts.push(c));
    stream.on('end', () => res(Buffer.concat(parts).toString('utf8')));
    stream.on('error', rej);
  });
}

test('httpByteSource: follows 302 → 200 (CDN redirect)', async () => {
  const { createHttpByteSource } = await import('../lib/page/downloads.js');
  // The local mock origin is loopback, which the strict SSRF guard rightly
  // refuses for redirect hops — tests opt in via allowRedirectHost, which can
  // only widen the guard for the loopback test server.
  const src = createHttpByteSource({ allowRedirectHost: (h) => h === '127.0.0.1' });
  const hits = [];
  await withServer((req, resp) => {
    hits.push(req.url);
    if (req.url === '/resolve/file.bin') {
      resp.writeHead(302, { Location: '/cdn/file.bin' });
      resp.end();
    } else {
      resp.writeHead(200, { 'content-length': 5 });
      resp.end('hello');
    }
  }).then(async ({ base, close }) => {
    try {
      const r = await src.respond(`${base}/resolve/file.bin`);
      assert.equal(r.status, 200);
      assert.equal(r.totalBytes, 5);
      assert.equal(await readBody(r.stream), 'hello');
      assert.deepEqual(hits, ['/resolve/file.bin', '/cdn/file.bin']);
    } finally {
      await close();
    }
  });
});

test('httpByteSource: follows 302 → 206 and preserves the Range header across hops', async () => {
  const { createHttpByteSource } = await import('../lib/page/downloads.js');
  const src = createHttpByteSource({ allowRedirectHost: (h) => h === '127.0.0.1' });
  const ranges = [];
  await withServer((req, resp) => {
    ranges.push(req.headers['range'] ?? null);
    if (req.url === '/origin.bin') {
      resp.writeHead(302, { Location: '/cdn.bin' });
      resp.end();
    } else {
      resp.writeHead(206, { 'content-range': 'bytes 500-749/1000', 'content-length': 250 });
      resp.end('x'.repeat(250));
    }
  }).then(async ({ base, close }) => {
    try {
      const r = await src.respond(`${base}/origin.bin`, 500);
      assert.equal(r.status, 206);
      assert.equal(r.totalBytes, 1000, 'total parsed from the final Content-Range');
      await readBody(r.stream);
      assert.deepEqual(ranges, ['bytes=500-', 'bytes=500-'], 'Range sent on the initial request and re-sent unchanged to the redirect target');
    } finally {
      await close();
    }
  });
});

test('httpByteSource: follows a multi-hop 302 chain (3 redirects)', async () => {
  const { createHttpByteSource } = await import('../lib/page/downloads.js');
  const src = createHttpByteSource({ allowRedirectHost: (h) => h === '127.0.0.1' });
  const hits = [];
  await withServer((req, resp) => {
    hits.push(req.url);
    const next = { '/a': '/b', '/b': '/c', '/c': '/d' }[req.url];
    if (next) {
      resp.writeHead(302, { Location: next });
      resp.end();
    } else {
      resp.writeHead(200, { 'content-length': 2 });
      resp.end('ok');
    }
  }).then(async ({ base, close }) => {
    try {
      const r = await src.respond(`${base}/a`);
      assert.equal(r.status, 200);
      assert.equal(await readBody(r.stream), 'ok');
      assert.deepEqual(hits, ['/a', '/b', '/c', '/d']);
    } finally {
      await close();
    }
  });
});

test('httpByteSource: refuses a redirect to a private address (SSRF)', async () => {
  const { createHttpByteSource } = await import('../lib/page/downloads.js');
  const src = createHttpByteSource(); // strict guard
  for (const target of ['http://10.0.0.9/secret', 'http://192.168.1.5/x', 'http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:1/x']) {
    await withServer((req, resp) => {
      resp.writeHead(302, { Location: target });
      resp.end();
    }).then(async ({ base, close }) => {
      try {
        await assert.rejects(
          () => src.respond(`${base}/start`),
          /SSRF|private\/loopback/,
          `redirect to ${target} must be refused`,
        );
      } finally {
        await close();
      }
    });
  }
});

test('httpByteSource: gives up after more than 5 redirects', async () => {
  const { createHttpByteSource } = await import('../lib/page/downloads.js');
  const src = createHttpByteSource({ allowRedirectHost: (h) => h === '127.0.0.1' });
  await withServer((req, resp) => {
    // Infinite loop: every hop redirects to itself.
    resp.writeHead(302, { Location: req.url });
    resp.end();
  }).then(async ({ base, close }) => {
    try {
      await assert.rejects(() => src.respond(`${base}/loop`), /more than 5 redirects/);
    } finally {
      await close();
    }
  });
});
