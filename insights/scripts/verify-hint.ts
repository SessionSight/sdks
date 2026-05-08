/**
 * Build-time + publish-time verifier for this SDK's integration hint.
 * Wired into `prebuild` and `prepublishOnly` so a stale hint can't ship.
 *
 * The shared verifier runs structural checks; the import alone catches
 * structural drift (rename/removal of any referenced SDK export).
 */
import { integrationHint } from '../src/integration-hint.js';
import { verifyHint } from '@sessionsight/backend-shared/integration-hint-verifier';

await verifyHint(integrationHint);
// eslint-disable-next-line no-console
console.log('[insights] integration hint verified');
