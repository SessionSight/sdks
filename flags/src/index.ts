import { FeatureFlagClient, BoundFeatureFlagClient } from './client.js';
import type { FeatureFlagConfig, FlagEvaluationContext, FlagListResult, FlagLogger } from './types.js';

export { FeatureFlagClient, BoundFeatureFlagClient };
export type { FeatureFlagConfig, FlagEvaluationContext, EvaluatedFlag, EvaluatedFlags, FlagLogger } from './types.js';

let instance: FeatureFlagClient | null = null;
// Track the configured logger separately so warnings emitted before/after
// `init()` (or after `destroy()`) still respect the host's preference.
let activeLogger: FlagLogger = console;

const FeatureFlags = {
  async init(config: FeatureFlagConfig, context?: FlagEvaluationContext): Promise<void> {
    if (instance) {
      activeLogger.warn('[SessionSight Flags] Already initialized. Call destroy() first.');
      return;
    }
    activeLogger = config.logger ?? console;
    instance = new FeatureFlagClient(config);
    await instance.init(context);
  },

  getBooleanFlag(key: string, defaultValue: boolean): boolean {
    if (!instance) {
      activeLogger.warn('[SessionSight Flags] Not initialized. Call init() first.');
      return defaultValue;
    }
    return instance.getBooleanFlag(key, defaultValue);
  },

  getStringFlag(key: string, defaultValue: string): string {
    if (!instance) {
      activeLogger.warn('[SessionSight Flags] Not initialized. Call init() first.');
      return defaultValue;
    }
    return instance.getStringFlag(key, defaultValue);
  },

  async refresh(context?: FlagEvaluationContext): Promise<void> {
    if (!instance) {
      activeLogger.warn('[SessionSight Flags] Not initialized. Call init() first.');
      return;
    }
    await instance.refresh(context);
  },

  /**
   * Per-request helper. Returns a `BoundFeatureFlagClient` that:
   * - auto-merges `visitorId` (ss_vid) and `sessionId` (ss_sid) from the
   *   request's cookies into the evaluation context on `init()`/`refresh()`;
   * - carries its OWN flag cache, so two concurrent requests with
   *   different visitor cookies never see each other's flag values.
   *
   * Always call `init()` (or `refresh()`) on the returned wrapper before
   * reading flags. The shared `FeatureFlags.getBooleanFlag(...)` static
   * uses a process-wide cache that is NOT per-request.
   */
  forRequest(req: unknown): BoundFeatureFlagClient | null {
    if (!instance) {
      activeLogger.warn('[SessionSight Flags] Not initialized. Call init() first.');
      return null;
    }
    return instance.forRequest(req);
  },

  isInitialized(): boolean {
    return instance?.isInitialized() ?? false;
  },

  async getFlags(): Promise<FlagListResult> {
    if (!instance) {
      activeLogger.warn('[SessionSight Flags] Not initialized. Call init() first.');
      return { flags: [] };
    }
    return instance.getFlags();
  },

  destroy(): void {
    if (instance) {
      instance.destroy();
      instance = null;
    }
    activeLogger = console;
  },
};

export default FeatureFlags;
