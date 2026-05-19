import type { SplitTestConfigResponse, Assignment } from './types.js';
import { hasLocalStorage } from '@sessionsight/sdk-shared';

export { getOrCreateVisitorId } from '@sessionsight/sdk-shared';

const CONFIG_PREFIX = 'ss-split-config:';
const ASSIGNMENTS_PREFIX = 'ss-split-assignments:';

interface CachedConfig {
  data: SplitTestConfigResponse;
  fetchedAt: number;
}

// `hasLocalStorage()` is invoked per call (not memoized at module load).
// SSR-then-hydrate paths must re-evaluate, otherwise an SSR import would
// permanently see `false` even after the browser bundle takes over.

// ── Config Cache ────────────────────────────────────────────────────

export function getCachedConfig(propertyId: string): CachedConfig | null {
  if (typeof window === 'undefined' || !hasLocalStorage()) return null;
  try {
    const raw = localStorage.getItem(CONFIG_PREFIX + propertyId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setCachedConfig(propertyId: string, data: SplitTestConfigResponse): void {
  if (typeof window === 'undefined' || !hasLocalStorage()) return;
  try {
    const cached: CachedConfig = { data, fetchedAt: Date.now() };
    localStorage.setItem(CONFIG_PREFIX + propertyId, JSON.stringify(cached));
  } catch {
    // Storage full or unavailable
  }
}

// ── Assignment Cache ────────────────────────────────────────────────

export function getCachedAssignments(propertyId: string, visitorId: string): Record<string, Assignment> | null {
  if (typeof window === 'undefined' || !hasLocalStorage()) return null;
  try {
    const raw = localStorage.getItem(ASSIGNMENTS_PREFIX + propertyId + ':' + visitorId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setCachedAssignments(
  propertyId: string,
  visitorId: string,
  assignments: Record<string, Assignment>,
): void {
  if (typeof window === 'undefined' || !hasLocalStorage()) return;
  try {
    localStorage.setItem(
      ASSIGNMENTS_PREFIX + propertyId + ':' + visitorId,
      JSON.stringify(assignments),
    );
  } catch {
    // Storage full or unavailable
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────

export function clearCache(propertyId: string): void {
  if (typeof window === 'undefined' || !hasLocalStorage()) return;
  try {
    // Remove all keys with our prefix for this property
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith(CONFIG_PREFIX + propertyId) || key.startsWith(ASSIGNMENTS_PREFIX + propertyId))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // Ignore
  }
}
