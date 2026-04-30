import { runLoop } from '../src/run-loop.js';

runLoop().catch((e) => {
  console.error('runLoop fatal:', e);
  process.exit(1);
});
