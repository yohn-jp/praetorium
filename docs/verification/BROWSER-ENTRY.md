# T14 browser-entry acceptance

`tests/e2e/browser-entry.test.mjs` is the fixed-runner acceptance for the real Gateway, Instance Access, repository UI, and connected Scriptorium runtime. It does not start a mock application or treat the local Gateway security probe as acceptance. The fixed verifier supplies only `HOME`, `PATH`, `PRAETORIUM_T14_INVENTORY_PATH`, `PRAETORIUM_T14_CATEGORY`, and `PRAETORIUM_T14_RESULT_PATH`.

The gate requires an explicitly owned, disposable, non-production environment with stable HTTPS Gateway and instance origins, an installed test GitHub App, a repository the authenticated user can maintain, a stopped configured instance, a real browser executable, and a GitHub-only Playwright storage-state file. The browser state must contain GitHub-domain cookies only and no origin storage; Platform sessions are created by the actual OAuth callback. The instance hostname must be the configured `ins_<ULID>` host under its owned DNS suffix.

Set `resources.browser-entry.reference` in the fixed-runner inventory to the absolute path of an owner-only JSON file. That file has exactly these top-level fields:

```text
schemaVersion: 1
inventory: { inventoryId, ownerIdentity, environmentName, expiresAt }
gateway: { origin, expectedUserId }
repository: { id, fullName }
instance: { id, origin, applicationHeading }
browser: { executablePath, githubStorageStatePath }
producer: { revision, tree, artifactDigest }
writeProbe: { path, body }
selection: { releasePolicy, releaseId, moduleIds, resourceProfileId }
timeouts: { loginSeconds, wakeSeconds, configurationSeconds, redeploySeconds }
```

Use numeric GitHub repository IDs, exact origins without URL paths, the actual producer app heading, a private storage-state file containing only GitHub authentication, and the pinned producer revision/tree/digest recorded by the migration ledger. The configured selection must be supported by the connected producer and differ from the currently deployed module set. `writeProbe.path` must be the actual disposable producer's side-effecting API or MCP write route and `body` its bounded JSON request. The test sends it once while the dashboard reports the instance stopped, requires Instance Access to answer `503 INSTANCE_STARTING` with `Retry-After: 5`, and disables redirects. The disposable environment owner is responsible for selecting a probe whose effect is safe if a concurrently started instance wins the race.

The test follows the actual GitHub OAuth redirect/callback and checks `/api/session`, host-only session and CSRF cookies, current App/repository access, one-use handoff and replay rejection, direct stopped-origin bookmark wake, stable application origin, and refresh CSRF/cookie rotation. It exercises UI preview, configuration build while the current app remains reachable, deployment digest/module selection, same-image redeploy, and UI re-entry. It requires all S01–S05 producer capabilities to be `available` and the configured artifact digest to match `docs/migration/PRODUCER-STATUS.json`; a source-only adapter, fixture, static token, or local candidate is not accepted.

The test exits zero only after every assertion succeeds. On a missing prerequisite it exits nonzero and writes the fixed-runner's strict result sidecar at `$HOME/runner-result.json` as `BLOCKED` with one of the bounded reason codes. An acceptance assertion exits nonzero as `FAILED`. A nonzero process without a valid sidecar remains `NOT_CHECKED`/failure under the fixed runner; no skip is converted to success. Current producer evidence still classifies S01–S05 as missing, so this browser category cannot be marked verified until the actual producer handoff and owned test environment are supplied.
