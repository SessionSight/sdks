import type { GoalOptions, GoalResult } from '@sessionsight/sdk-shared';

export interface GoalsConfig {
  secretApiKey: string;
  propertyId: string;
  apiUrl?: string;
  /**
   * When true, transport-level failures are also logged via `console.warn`.
   * Off by default so the SDK stays silent in production; the same info
   * is always available on the returned `GoalResult.error` string.
   */
  debug?: boolean;
}

// `IncrementOptions` is intentionally an alias for `GoalOptions`. There
// is no `DecrementOptions` because decrements take the same shape; the
// alias just gives `increment(goalId, options)` a self-documenting name
// at call sites without forcing two identical types.
export type IncrementOptions = GoalOptions;

export type { GoalOptions, GoalResult };
