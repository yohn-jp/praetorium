import { canonicalSourceProof } from "@praetorium/contracts";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Platform-owned input; never supplied by the browser or by Producer output. */
export interface VerifiedSourceIdentity {
  schemaVersion: 1;
  githubReleaseId: number;
  sourceRepository: "yohn-jp/scriptorium";
  sourceTag: string;
  sourceRevision: string;
  sourceTree: string;
}

export function assertSourceIdentityOutput(expected: VerifiedSourceIdentity, output: unknown): void {
  if (canonicalSourceProof(expected) !== canonicalSourceProof(output))
    throw new Error("Source identity verification failed");
}

/** The named context has no root .dockerignore. Producer exclusions are nested
 * under checkout/ and cannot filter its Git data or tracked source files. */
export async function prepareSourceMetadataContext(
  source: string, destination: string, identity: VerifiedSourceIdentity,
): Promise<void> {
  await mkdir(destination,{mode:0o700});
  await cp(source,path.join(destination,"checkout"),{
    recursive:true,preserveTimestamps:true,verbatimSymlinks:true,
  });
  await writeFile(path.join(destination,"identity.json"),JSON.stringify(identity),{mode:0o600});
  await writeFile(path.join(destination,"verify.mjs"),sourceIdentityVerifier,{mode:0o600});
}

/** Compatibility adapter for published Producers whose clean-source contract
 * still requires Git. Execute exclusively inside BuildKit, before and after
 * generation. Preserve their own clean-revision checks as well. */
export const sourceIdentityVerifier = `
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const identity = JSON.parse(readFileSync('/tmp/praetorium-source-input/identity.json', 'utf8'));
const git = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', env: {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
  }});
  if (result.status !== 0) throw new Error('Source identity verification failed: Git checkout unavailable');
  return result.stdout.trim();
};
if (git(['rev-parse', 'HEAD']) !== identity.sourceRevision ||
    git(['rev-parse', 'HEAD^{tree}']) !== identity.sourceTree ||
    git(['status', '--porcelain', '--untracked-files=all']) !== '')
  throw new Error('Source identity verification failed: revision, tree or clean checkout mismatch');
if (process.argv[2] === 'export')
  writeFileSync('/tmp/praetorium-source-proof/source-identity.json', JSON.stringify(identity));
`;
