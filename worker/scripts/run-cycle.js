import { runOnce } from '../src/run-loop.js';

runOnce().then((r) => {
  console.log(JSON.stringify({ ok: true, results: r }, null, 2));
  process.exit(0);
}).catch((e) => {
  console.error('runOnce failed:', e);
  process.exit(1);
});
