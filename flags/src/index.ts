import { FeatureFlagClient, BoundFeatureFlagClient } from './client.js';
import type { FeatureFlagConfig, FlagEvaluationContext, FlagListResult } from './types.js';

export { FeatureFlagClient, BoundFeatureFlagClient };
export type { FeatureFlagConfig, FlagEvaluationContext, EvaluatedFlag, EvaluatedFlags } from './types.js';

let instance: FeatureFlagClient | null = null;

const FeatureFlags = {
  async init(config: FeatureFlagConfig, context?: FlagEvaluationContext): Promise<void> {
    if (instance) {
      console.warn('[SessionSight Flags] Already initialized. Call destroy() first.');
      return;
    }
    instance = new FeatureFlagClient(config);
    await instance.init(context);
  },

  getBooleanFlag(key: string, defaultValue: boolean): boolean {
    if (!instance) {
      console.warn('[SessionSight Flags] Not initialized. Call init() first.');
      return defaultValue;
    }
    return instance.getBooleanFlag(key, defaultValue);
  },

  getStringFlag(key: string, defaultValue: string): string {
    if (!instance) {
      console.warn('[SessionSight Flags] Not initialized. Call init() first.');
      return defaultValue;
    }
    return instance.getStringFlag(key, defaultValue);
  },

  async refresh(context?: FlagEvaluationContext): Promise<void> {
    if (!instance) {
      console.warn('[SessionSight Flags] Not initialized. Call init() first.');
      return;
    }
    await instance.refresh(context);
  },

  /**
   * Per-request helper that auto-merges `visitorId` (ss_vid) and `sessionId`
   * (ss_sid) from the request's cookies into the evaluation context on
   * init/refresh.
   */
  forRequest(req: unknown): BoundFeatureFlagClient | null {
    if (!instance) {
      console.warn('[SessionSight Flags] Not initialized. Call init() first.');
      return null;
    }
    return instance.forRequest(req);
  },

  isInitialized(): boolean {
    return instance?.isInitialized() ?? false;
  },

  async getFlags(): Promise<FlagListResult> {
    if (!instance) {
      console.warn('[SessionSight Flags] Not initialized. Call init() first.');
      return { flags: [] };
    }
    return instance.getFlags();
  },

  destroy(): void {
    if (instance) {
      instance.destroy();
      instance = null;
    }
  },
};

export default FeatureFlags;
