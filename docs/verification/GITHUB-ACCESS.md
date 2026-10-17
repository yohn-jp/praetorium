# T14 GitHub access acceptance

`tests/integration/github-access.test.mjs` is the fixed T14 category runner. It has two stages: it invokes the separately reviewed real-App partial probe and requires its live acceptance test to execute (a skipped probe is not success), then tests the current Control Plane runtime-identity route and Gateway Git credential broker against a separately assigned private runtime repository. The live stage proves read/write scope, an actor-authorized publish receipt, a real Git push/fetch, expiry rejection for both the issued installation token and stale runtime identity, and fresh identity/token issuance. It never reports the category `VERIFIED` while Scriptorium's actual renewal client contract is missing.

## Owner inputs

The fixed verifier passes only the absolute inventory path, category, isolated `HOME`, and result path to the runner. It strips ambient configuration. For a resource explicitly marked `available` in the inventory, the runner reads two adjacent files derived from that absolute inventory filename:

- `<inventory-path>.github-access.json`
- `<inventory-path>.github-access-runtime.json`

Both files must be regular files owned by the current UID, mode `0600` or stricter, bounded to 64 KiB, and unchanged while read. The inventory must satisfy the fixed runner schema; its `github-access` resource must name the same owner, be disposable/non-production, and have a reference matching both private files. The runtime resource must also be private, disposable, non-production, and separate from the partial probe's target and sibling repositories. Effective expiry is the earliest expiry in the inventory and both files. It must be at least 65 minutes and 5 seconds away before any network call, to cover the maximum installation-token lifetime plus a five-minute cleanup margin.

The primary file has this exact schema:

- `schemaVersion: 1`, absolute `inventoryPath`, and `ownerIdentity` exactly matching `inventory.owner.identity`.
- `environment`: a name, expiry, cleanup procedure, `privateDisposable: true`, `production: false`, and `resourceReference` exactly matching `inventory.resources["github-access"].reference`.
- `gateway`: exact HTTPS `origin`; distinct `writer` and `reader` objects. Each contains `expectedUserId`, current `sessionCookie`, matching `csrfToken`, and that user's GitHub OAuth access token. User cookies are Praetorium session credentials; the `accessToken` is a GitHub user token used to verify current GitHub authorization. They are different credential types.
- `controlPlane`: exact HTTPS `origin` and the Control Plane Gateway service credential (`CONTROL_PLANE_GATEWAY_AUTH`).
- `github`: `appId`, `installationId`, PEM `privateKeyPem`, and numeric-ID `repository` and `unrelatedRepository` records, each with `owner` and `name`. These are the partial probe's private target and sibling scope-test repositories; the sibling must not already have a Praetorium instance binding.

The runtime file has this exact schema:

- `schemaVersion: 1`, the same absolute `inventoryPath` and `ownerIdentity`.
- `environment`: expiry no later than the primary file's expiry and the same `resourceReference`.
- `runtimeRepository`: a separate private test repository in the same GitHub App installation, with numeric ID, owner, and name.
- `runtime`: the existing active binding tuple `runtimeId`, `instanceId`, `repositoryId`, `installationId`, `runtimeEpoch`, `leaseId`, `workerId`, and `clusterId`. The runtime repository ID and installation ID must match the tuple and App installation.
- `provisionerAuth`: the Control Plane `PROVISIONER_AUTH_TOKEN`, distinct from `CONTROL_PLANE_GATEWAY_AUTH`, the App private key, and both GitHub user tokens.

Do not put these credentials in shell arguments, source control, an image, or the inventory itself. The inventory and owner files must be created and held by the owner of the explicitly disposable test environment. The test does not provision accounts, grant repository access, or infer ownership from a hostname.

## External effects and cleanup

With valid owner inputs, the runner makes live requests to the configured GitHub, Gateway, and Control Plane origins. It checks the owner deadline immediately before outbound HTTP and Git operations. Cleanup of a run-owned ref remains allowed after expiry only with the exact ref and expected-commit force-with-lease; its follow-up absence check uses that same exact cleanup identity. The partial probe checks both users, verifies repository authorization and numeric repository-to-instance binding, performs real Git operations against its target/sibling repos, and removes only exact run-owned refs and its individually issued test tokens. The runtime stage creates a unique `refs/heads/praetorium-t14-broker/<uuid>` ref, verifies its exact commit through a read-scoped credential, then deletes it with an exact force-with-lease and verifies absence.

Before attempting the runtime ref push, the runner writes an owner-only NDJSON recovery artifact named `praetorium-t14-github-recovery-<uuid>.ndjson` beside the inventory. Its `PENDING` record contains only repository ID/name, ref, and expected/observed commit hashes. After exact deletion and observed absence, the runner appends a matching `CLEANED` record. If a push, process, or cleanup outcome is uncertain, it leaves the record `PENDING` and does not guess or delete; reconcile only that repository/ref as the environment owner. When the reused partial probe exits with a preserved recovery tuple, the fixed runner validates and writes only that known tuple to the same owner directory; it never copies child output, exception text, credentials, endpoint URLs, or arbitrary paths into the artifact. A partial cleanup failure that names run-generated refs but has no commit hash is recorded with `expectedCommit: null` so the owner can inspect the exact ref before cleanup.

The broker stage verifies both read and write installation tokens can access the bound runtime repository but cannot access the unrelated sibling repository. It then waits for the real App installation token to expire (at most 60 minutes and 5 seconds), verifies GitHub rejects it, verifies Gateway rejects the stale runtime identity, and obtains a fresh identity and scoped token that fetches the private repository. The fixed runner allows up to 66 minutes and 40 seconds for the category. No broker credential retirement, runtime stop, PVC deletion, or D1 cleanup is attempted; the owner cleanup procedure must preserve active-writer/checkpoint evidence and remove only the explicitly disposable resources after the run.

## Acceptance limit and current blocker

These calls verify Praetorium's present broker APIs and their expiry behavior. They do not prove that a producer runtime consumes the broker, renews its credential automatically, or retries Git operations. Scriptorium S03 currently has no assignment-bound renewable `GitCredentialProvider` contract or executable consumer. The runner therefore writes a fixed public `PRODUCER_CONTRACT_MISSING` outcome and exits nonzero even if every available Praetorium-side assertion passes. It does not infer producer support from a status row, shim, static token, fixture, or direct broker call. Once the producer publishes the actual versioned contract, the acceptance must additionally invoke that real producer artifact and prove its own post-expiry renewal before this category can pass.

Without a valid owned inventory and both owner files, the runner exits nonzero as `BLOCKED` before any network request. Fixed outcomes use only public reason codes; credentials, URLs, filesystem paths, and arbitrary exception text are not copied into the verifier report.
