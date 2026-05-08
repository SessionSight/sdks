import type { GoalOptions, GoalResult } from '@sessionsight/sdk-shared';

export interface GoalsConfig {
  secretApiKey: string;
  propertyId: string;
  apiUrl?: string;
}

export type IncrementOptions = GoalOptions;

export type { GoalOptions, GoalResult };
