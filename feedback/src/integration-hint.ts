import SessionSightFeedback from './index.js';
import type { IntegrationHint } from '@sessionsight/backend-shared/integration-hint-verifier';

/**
 * Server-side feedback SDK integration hint surfaced by the MCP server when
 * an agent creates a feedback type the user wires into a backend handler
 * (form submit endpoint, support webhook, NPS trigger). Reference live SDK
 * exports so renames break the build.
 */
export const integrationHint: IntegrationHint = {
  sdkPackage: '@sessionsight/feedback',
  install: 'npm install @sessionsight/feedback',
  initFn: () => SessionSightFeedback.init({
    secretApiKey: 'YOUR_SECRET_KEY',
    propertyId: 'YOUR_PROPERTY_ID',
  }),
  usageFn: async (req: unknown) => {
    const bound = SessionSightFeedback.forRequest(req);
    if (!bound) return;
    await bound.submit('YOUR_FEEDBACK_TYPE_ID', { option: 'YOUR_OPTION_ID', message: 'Great experience' });
  },
  docsUrl: 'https://sessionsight.com/docs/feedback',
};

export default integrationHint;
