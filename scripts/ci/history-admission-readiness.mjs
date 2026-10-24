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

/** Render CI admission manifests and fail closed if a deployment placeholder remains. */
export function renderTestManifestDocuments(documents, replacements = {}) {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new TypeError("admission test manifests must be a non-empty document list");
  }
  const rendered = documents.map((document) => {
    let serialized = JSON.stringify(document);
    for (const [name, value] of Object.entries(replacements)) {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || typeof value !== "string" || value.length === 0) {
        throw new TypeError(`invalid admission test replacement ${name}`);
      }
      serialized = serialized.replaceAll(`@@${name}@@`, value);
    }
    return JSON.parse(serialized);
  });
  const unresolved = JSON.stringify(rendered).match(/@@[A-Z0-9_]+@@/gu);
  if (unresolved) {
    throw new Error(
      `unresolved admission test placeholders: ${[...new Set(unresolved)].join(", ")}`,
    );
  }
  return rendered;
}
