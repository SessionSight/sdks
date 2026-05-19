import SplitTesting from './index.js';
import type { IntegrationHint } from '@sessionsight/sdk-shared/integration-hint-verifier';

/**
 * Browser-side split-testing SDK integration hint surfaced by the MCP server
 * when an agent creates a split test the user wires into a frontend
 * (variation pickers in pricing pages, hero copy, button text). Reference
 * live SDK exports so renames break the build.
 */
export const integrationHint: IntegrationHint = {
  sdkPackage: '@sessionsight/split-testing',
  install: 'npm install @sessionsight/split-testing',
  initFn: () => SplitTesting.init({
    publicApiKey: 'YOUR_PUBLIC_KEY',
    propertyId: 'YOUR_PROPERTY_ID',
  }),
  usageFn: () => SplitTesting.get('YOUR_TEST_KEY', 'control'),
  docsUrl: 'https://sessionsight.com/docs/split-testing',
};

export default integrationHint;
