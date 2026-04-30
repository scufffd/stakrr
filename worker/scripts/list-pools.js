import { listPools } from '../src/registry.js';

const pools = listPools({ status: 'all' });
console.log(JSON.stringify({ count: pools.length, pools }, null, 2));
