import { FeedbackClient, BoundFeedbackClient } from './client.js';
import type { FeedbackConfig, FeedbackOptions, FeedbackResult } from './types.js';

export { FeedbackClient, BoundFeedbackClient };
export type { FeedbackConfig, FeedbackOptions, FeedbackResult } from './types.js';

let instance: FeedbackClient | null = null;

const SessionSightFeedback = {
  init(config: FeedbackConfig): void {
    if (instance) {
      console.warn('[SessionSight Feedback] Already initialized. Call destroy() first.');
      return;
    }
    instance = new FeedbackClient(config);
  },

  async submit(feedbackTypeId: string, options?: FeedbackOptions): Promise<FeedbackResult> {
    if (!instance) {
      console.warn('[SessionSight Feedback] Not initialized. Call init() first.');
      return { success: false, error: 'Not initialized' };
    }
    return instance.submit(feedbackTypeId, options);
  },

  /**
   * Per-request helper that auto-attaches `sessionId` (from `ss_sid`)
   * from the request's cookies to submit() calls.
   */
  forRequest(req: unknown): BoundFeedbackClient | null {
    if (!instance) {
      console.warn('[SessionSight Feedback] Not initialized. Call init() first.');
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

export default SessionSightFeedback;
