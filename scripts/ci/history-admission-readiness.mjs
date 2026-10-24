function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Compare quota status against the API server's canonicalized live spec quantities. */
export function quotaStatusMatchesLiveSpec(resourceQuota) {
  const specHard = resourceQuota?.spec?.hard;
  const statusHard = resourceQuota?.status?.hard;
  if (!isRecord(specHard) || Object.keys(specHard).length === 0 || !isRecord(statusHard)) {
    return false;
  }

  const sortedEntries = (value) =>
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(sortedEntries(specHard)) === JSON.stringify(sortedEntries(statusHard));
}
