import SessionSightGoals from './index.js';
import type { IntegrationHint } from '@sessionsight/sdk-shared/integration-hint-verifier';

/**
 * Server-side SDK integration hint surfaced by the MCP server when an
 * agent creates a goal that the user wires into a backend handler (e.g.,
 * Stripe webhook, queue worker, server action). Reference live SDK
 * exports so renames break the build.
 */
export const integrationHint: IntegrationHint = {
  sdkPackage: '@sessionsight/goals',
  install: 'npm install @sessionsight/goals',
  initFn: () => SessionSightGoals.init({ secretApiKey: 'YOUR_SECRET_KEY', propertyId: 'YOUR_PROPERTY_ID' }),
  usageFn: async (req: unknown) => {
    const bound = SessionSightGoals.forRequest(req);
    if (!bound) return;
    await bound.increment('YOUR_GOAL_ID');
  },
  docsUrl: 'https://sessionsight.com/docs/goals',
};

export default integrationHint;
