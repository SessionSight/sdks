/**
 * djb2 hash producing 0-9999 for fine-grained traffic allocation.
 * Same algorithm family as the flag-evaluation service.
 *
 * The `% 10000` modulo introduces a tiny bias because 2^32 isn't an exact
 * multiple of 10000: ~7296 of the 4.29e9 hash values fall into the
 * "extra" bucket band, so low-half buckets are favored by ~0.00017%.
 * Negligible at any traffic volume that produces meaningful split-test
 * results, and well below other sources of variance.
 */
export function splitTestHash(seed: string, visitorId: string): number {
  const str = `${seed}:${visitorId}`;
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash % 10000;
}

/**
 * Given a hash bucket, traffic allocation, and variation weights,
 * determine which variation the visitor gets.
 */
export function assignVariation(
  hashValue: number,
  trafficAllocation: number,
  variations: Array<{ key: string; weight: number }>,
): { variationIndex: number; inTest: boolean } {
  // trafficAllocation is 0-100, scale to 0-10000
  const trafficThreshold = trafficAllocation * 100;

  if (hashValue >= trafficThreshold) {
    // Outside traffic allocation: gets control (index 0), not tracked
    return { variationIndex: 0, inTest: false };
  }

  // Bucket within traffic allocation
  const totalWeight = variations.reduce((s, v) => s + v.weight, 0);
  if (totalWeight === 0) return { variationIndex: 0, inTest: true };

  let cumulative = 0;
  for (let i = 0; i < variations.length; i++) {
    cumulative += (variations[i]!.weight / totalWeight) * trafficThreshold;
    if (hashValue < cumulative) {
      return { variationIndex: i, inTest: true };
    }
  }

  return { variationIndex: variations.length - 1, inTest: true };
}
