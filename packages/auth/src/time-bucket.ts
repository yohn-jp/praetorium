/** Rounds an ISO timestamp down to a fixed-size bucket boundary, for debounced writes. */
export function roundToBucket(now: string, bucketSeconds: number): string {
  const epochSeconds = Math.floor(new Date(now).getTime() / 1000);
  const bucketStart = epochSeconds - (epochSeconds % bucketSeconds);
  return new Date(bucketStart * 1000).toISOString();
}
