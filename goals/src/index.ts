import { GoalsClient, BoundGoalsClient } from './client.js';
import type { GoalsConfig, IncrementOptions, GoalOptions, GoalResult } from './types.js';

export { GoalsClient, BoundGoalsClient };
export type { GoalsConfig, IncrementOptions, GoalOptions, GoalResult } from './types.js';

let instance: GoalsClient | null = null;

const SessionSightGoals = {
  init(config: GoalsConfig): void {
    if (instance) {
      console.warn('[SessionSight Goals] Already initialized. Call destroy() first.');
      return;
    }
    instance = new GoalsClient(config);
  },

  async increment(goalId: string, options?: IncrementOptions): Promise<GoalResult> {
    if (!instance) {
      console.warn('[SessionSight Goals] Not initialized. Call init() first.');
      return { success: false, error: 'Not initialized' };
    }
    return instance.increment(goalId, options);
  },

  async decrement(goalId: string, options?: GoalOptions): Promise<GoalResult> {
    if (!instance) {
      console.warn('[SessionSight Goals] Not initialized. Call init() first.');
      return { success: false, error: 'Not initialized' };
    }
    return instance.decrement(goalId, options);
  },

  /**
   * Per-request helper that auto-attaches `sessionId` (from `ss_sid`)
   * from the request's cookies to every call.
   */
  forRequest(req: unknown): BoundGoalsClient | null {
    if (!instance) {
      console.warn('[SessionSight Goals] Not initialized. Call init() first.');
      return null;
    }
    return instance.forRequest(req);
  },

  destroy(): void {
    if (instance) {
      instance.destroy();
      instance = null;
    }
  },
};

export default SessionSightGoals;
