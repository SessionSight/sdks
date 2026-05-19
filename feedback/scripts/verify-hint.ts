/**
 * Build-time + publish-time verifier for this SDK's integration hint.
 * Wired into `prebuild` and `prepublishOnly` so a stale hint can't ship.
 */
import { integrationHint } from '../src/integration-hint.js';
import { verifyHint } from '@sessionsight/sdk-shared/integration-hint-verifier';

await verifyHint(integrationHint);
// eslint-disable-next-line no-console
console.log('[feedback] integration hint verified');
