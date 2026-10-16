function parseVersion(version: string): {
  readonly core: readonly bigint[];
  readonly prerelease: readonly string[] | null;
} {
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) throw new TypeError("invalid semantic release version");
  const core = [match[1], match[2], match[3]].map((part) => BigInt(part!));
  return {
    core,
    prerelease: match[4] === undefined ? null : match[4].split("."),
  };
}

function compareIdentifier(left: string, right: string): -1 | 0 | 1 {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Compares the release versions accepted by the release-candidate schema. */
export function compareReleaseVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const x = a.core[index]!;
    const y = b.core[index]!;
    if (x !== y) return x < y ? -1 : 1;
  }

  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease === null ? 1 : -1;
  }
  const limit = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < limit; index += 1) {
    const result = compareIdentifier(a.prerelease[index]!, b.prerelease[index]!);
    if (result !== 0) return result;
  }
  return a.prerelease.length < b.prerelease.length
    ? -1
    : a.prerelease.length > b.prerelease.length
      ? 1
      : 0;
}
