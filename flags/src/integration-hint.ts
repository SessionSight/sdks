import FeatureFlags from './index.js';
import type { IntegrationHint } from '@sessionsight/sdk-shared/integration-hint-verifier';

/**
 * Server-side feature-flag SDK integration hint surfaced by the MCP server
 * when an agent creates a flag the user wires into a backend handler.
 * Reference live SDK exports so renames break the build.
 */
export const integrationHint: IntegrationHint = {
  sdkPackage: '@sessionsight/flags',
  install: 'npm install @sessionsight/flags',
  initFn: () => FeatureFlags.init({
    secretApiKey: 'YOUR_SECRET_KEY',
    propertyId: 'YOUR_PROPERTY_ID',
    environment: 'production',
  }),
  usageFn: () => FeatureFlags.getBooleanFlag('YOUR_FLAG_KEY', false),
  docsUrl: 'https://sessionsight.com/docs/build/sdks/flags-sdk/setup',
};

export default integrationHint;
