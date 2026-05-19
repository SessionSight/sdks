import { SplitTestingClient, BoundSplitTestingClient } from './client.js';
import type { SplitTestConfig, GetOptions } from './types.js';

export { SplitTestingClient, BoundSplitTestingClient };
export type { SplitTestConfig, GetOptions, AssignedVariation, Assignment, SplitTestConfigResponse } from './types.js';

let instance: SplitTestingClient | null = null;

const SplitTesting = {
  async init(config: SplitTestConfig): Promise<void> {
    if (instance) {
      console.warn('[SessionSight SplitTesting] Already initialized. Call destroy() first.');
      return;
    }
    instance = new SplitTestingClient(config);
    await instance.init();
  },

  get(testKey: string, defaultValue: any, options?: GetOptions): any {
    if (!instance) {
      console.warn('[SessionSight SplitTesting] Not initialized. Call init() first.');
      return defaultValue;
    }
    return instance.get(testKey, defaultValue, options);
  },

  setAttributes(attrs: Record<string, string | number | boolean>): void {
    if (!instance) {
      console.warn('[SessionSight SplitTesting] Not initialized. Call init() first.');
      return;
    }
    instance.setAttributes(attrs);
  },

  getAssignments(): Record<string, number> {
    if (!instance) {
      console.warn('[SessionSight SplitTesting] Not initialized. Call init() first.');
      return {};
    }
    return instance.getAssignments();
  },

  async refresh(): Promise<void> {
    if (!instance) {
      console.warn('[SessionSight SplitTesting] Not initialized. Call init() first.');
      return;
    }
    await instance.refresh();
  },

  clearCache(): void {
    if (!instance) {
      console.warn('[SessionSight SplitTesting] Not initialized. Call init() first.');
      return;
    }
    instance.clearCache();
  },

  /**
   * Per-request helper (SSR / Node). In the browser, ss_sid is read from
   * `document.cookie` automatically on each exposure flush. This helper is
   * only needed on the server, where cookies live on the inbound request.
   */
  forRequest(req: unknown): BoundSplitTestingClient | null {
    if (!instance) {
      console.warn('[SessionSight SplitTesting] Not initialized. Call init() first.');
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

export default SplitTesting;
