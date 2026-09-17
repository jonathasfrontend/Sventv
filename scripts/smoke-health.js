'use strict';
// Smoke test: monta o app e checa GET /api/health sem depender de unlisten.
const app = require('../src/app');

let done = false;
const finish = (code, msg) => {
  if (done) return;
  done = true;
  console.log(msg);
  process.exit(code);
};

setTimeout(() => finish(3, 'SMOKE_TIMEOUT'), 60000);

const server = app.listen(0, async () => {
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await res.json();
    console.log(`HEALTH_STATUS ${res.status}`);
    console.log(`HEALTH_BODY ${JSON.stringify(body)}`);
    if (res.status === 200 && body.status === 'healthy') {
      finish(0, 'SMOKE_OK');
    } else {
      finish(1, 'HEALTH_FAIL');
    }
  } catch (err) {
    finish(2, 'SMOKE_ERR ' + err.message);
  } finally {
    server.close();
  }
});