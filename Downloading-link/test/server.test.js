const test = require('node:test');
const assert = require('node:assert/strict');
// Force local-disk mode: the suite must never write to the real Blob store.
process.env.BLOB_READ_WRITE_TOKEN = '';

const app = require('../server');

const request = require('node:http');

test('POST /upload accepts a multipart upload and responds with JSON', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  const boundary = '----WebKitFormBoundaryTest123';
  const body = [
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="file"; filename="sample.txt"\r\n',
    'Content-Type: text/plain\r\n\r\n',
    'hello from test\r\n',
    `--${boundary}--\r\n`
  ].join('');

  const response = await new Promise((resolve, reject) => {
    const req = request.request({
      hostname: '127.0.0.1',
      port,
      path: '/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });

  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.name, 'sample.txt');
  assert.ok(parsed.link.includes('/d/'));

  server.close();
});
