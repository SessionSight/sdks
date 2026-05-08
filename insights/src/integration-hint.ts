import SessionSight from './index.js';
import type { IntegrationHint } from '@sessionsight/backend-shared/integration-hint-verifier';

/**
 * Browser-side SDK integration hint surfaced by the MCP server when an
 * agent creates a goal, property, or other entity that the user wires into
 * a frontend. The function expressions reference live SDK exports so any
 * rename/removal of `SessionSight.init` or `SessionSight.goals.increment`
 * fails this file at build time. The MCP layer renders these via
 * `Function.prototype.toString()` so the user-facing snippet stays human
 * readable.
 */
export const integrationHint: IntegrationHint = {
  sdkPackage: '@sessionsight/insights',
  install: 'npm install @sessionsight/insights',
  initFn: () => SessionSight.init({ publicApiKey: 'YOUR_PUBLIC_KEY', propertyId: 'YOUR_PROPERTY_ID' }),
  usageFn: () => SessionSight.goals.increment('YOUR_GOAL_ID'),
  docsUrl: 'https://sessionsight.com/docs/insights',
};

export default integrationHint;
