import SessionSight from './index.js';

interface QueueEntry {
  p: string[];
  a: unknown[];
  rs?: (value: unknown) => void;
  rj?: (reason: unknown) => void;
}

const w = window as unknown as { _ssq?: QueueEntry[] };
const queue = Array.isArray(w._ssq) ? w._ssq : null;

(window as any).SessionSight = SessionSight;
delete w._ssq;

if (queue) {
  for (const { p: path, a: args, rs: resolve, rj: reject } of queue) {
    try {
      const parent: any = path.length > 1
        ? path.slice(0, -1).reduce((obj: any, key: string) => (obj == null ? obj : obj[key]), SessionSight)
        : SessionSight;
      const fn: any = path.length > 0
        ? path.reduce((obj: any, key: string) => (obj == null ? obj : obj[key]), SessionSight)
        : null;
      if (typeof fn !== 'function') {
        reject?.(new Error(`SessionSight: '${path.join('.')}' is not a function`));
        continue;
      }
      const result = fn.apply(parent, args);
      resolve?.(result);
    } catch (err) {
      reject?.(err);
    }
  }
}
