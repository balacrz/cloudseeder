// lib/pipeline/toposort.js
import { log } from '../utils/logger.js';

/**
 * Sort pipeline steps topologically by their `dependsOn` field.
 * Ties are broken by the original JSON order (smallest index wins).
 *
 * @param {Array}  steps - pipeline step objects
 * @returns {Array} steps in dependency order
 */
export function topoSortSteps(steps) {
  const indeg = new Array(steps.length).fill(0);
  const adj = steps.map(() => []);

  for (let i = 0; i < steps.length; i++) {
    const deps = steps[i].dependsOn || [];
    if (!deps.length) continue;
    for (let j = 0; j < steps.length; j++) {
      if (i === j) continue;
      const outObj = steps[j].object;
      if (deps.includes(outObj)) {
        adj[j].push(i);
        indeg[i]++;
      }
    }
  }

  const q = [];
  for (let i = 0; i < steps.length; i++) {
    if (indeg[i] === 0) q.push(i);
  }

  const order = [];
  while (q.length) {
    const u = q.sort((a, b) => a - b).shift();
    order.push(u);
    for (const v of adj[u]) {
      indeg[v]--;
      if (indeg[v] === 0) q.push(v);
    }
  }

  if (order.length !== steps.length) {
    log.warn('System', 'dependsOn produced a cycle; using original order.');
    return steps;
  }
  return order.map((idx) => steps[idx]);
}
