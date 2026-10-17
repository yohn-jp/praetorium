# T14 partial GitHub App access probe

Status: **PARTIAL / BLOCKED FOR FIXED `github-access` ACCEPTANCE**. The fixed
`github-access` runner remains absent, so `scripts/verify-integration.mjs`
continues to report that category as **BLOCKED / NOT_CHECKED**. This opt-in
partial probe cannot make the category VERIFIED.

## What the probe can establish

`tests/integration/github-access.partial.test.mjs` uses the built production
`@praetorium/github` package and explicitly owned live Gateway, Control Plane,
GitHub App, users, and private repositories. With valid owner inputs it checks
the current GitHub user IDs and repository permissions, then sends both
pre-authorized users through Gateway entry for one numeric repository ID and
confirms that the Control Plane binding resolves to the same instance. The
probe requires that instance to have no current or desired artifact, so the
entry route returns at its configuration-required boundary before requesting a
runtime start.

It verifies the production access provider allows the writer and reader to
read, denies reader mutation, and denies mutation for an unbound sibling repo.
It also calls the production installation-token issuer for one-repository
Contents read and write tokens, verifies the write token cannot reach a second
private repo from the same installation, and performs a bounded push, read,
read-only push denial, sibling-repository push denial, branch cleanup, and
revocation of the newly issued tokens. Only refs generated under the
`praetorium-t14` prefixes are removed.

This is **not** expiry-backed credential renewal or runtime broker acceptance.
The test does not create runtime identities, lease proofs, producer
assignments, or mutation receipts consumed by a producer. It issues fresh
installation tokens directly through the production provider and revokes those
tokens at the end. The T14 fixed category must stay blocked until the producer
runtime identity/lease protocol and an actual expiration-based renewal path
can be exercised together with this real App/user/repository flow.

## Owner inputs and effects

The runner reads only `PRAETORIUM_T14_GITHUB_ACCESS_CONFIG`; it does not inspect
ambient `GH_TOKEN`, `GITHUB_TOKEN`, or other credentials. The config and
inventory must be regular files owned by the current user, opened without
following symlinks, and bounded to 64 KiB. The config must have mode `0600` or
stricter; the inventory must not be group or other writable. The earlier of
their expiry timestamps bounds every new outbound API or Git operation. Once
expired, the probe stops issuing requests; cleanup of confirmed owned refs and
revocation of issued tokens remains allowed. The config's strict JSON schema is:

```json
{
  "schemaVersion": 1,
  "inventoryPath": "/private/path/t14-inventory.json",
  "ownerIdentity": "named-environment-owner",
  "environment": {
    "name": "named-t14-environment",
    "expiresAt": "2030-01-01T00:00:00Z",
    "cleanupProcedure": "retire this disposable environment after the run",
    "privateDisposable": true,
    "production": false,
    "resourceReference": "same value as inventory resources.github-access.reference"
  },
  "gateway": {
    "origin": "https://owned-gateway.example.invalid",
    "writer": {
      "expectedUserId": "10001",
      "sessionCookie": "__Host-praetorium_session=...; __Host-praetorium_csrf=...",
      "csrfToken": "...",
      "accessToken": "..."
    },
    "reader": {
      "expectedUserId": "10002",
      "sessionCookie": "__Host-praetorium_session=...; __Host-praetorium_csrf=...",
      "csrfToken": "...",
      "accessToken": "..."
    }
  },
  "controlPlane": {
    "origin": "https://owned-control-plane.example.invalid",
    "gatewayAuth": "..."
  },
  "github": {
    "appId": 12345,
    "installationId": 67890,
    "privateKeyPem": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
    "repository": { "id": 70001, "owner": "owned-org", "name": "t14-access" },
    "unrelatedRepository": { "id": 70002, "owner": "owned-org", "name": "t14-sibling" }
  }
}
```

The inventory must declare `github-access` available, disposable, nonproduction,
and owned by `ownerIdentity`; its resource reference must match the config.
Both repositories must be private, owned by the explicitly disposable test
environment, and visible in the same active App installation. The target must
already have an active CP binding with no current or desired artifact and a
positive runtime epoch. The
sibling must have no CP binding. The writer must have current push permission
on both repositories; the reader must have read but no push permission on the
target. The test does not provision App installations, users, OAuth grants, or
keys. It never cleans up the existing CP binding; the owner’s disposable
environment cleanup procedure handles its lifetime.

The runner reads the CP binding and GitHub permissions before any remote write.
It then exercises Gateway entry and issues/revokes short-lived credentials.
Git writes use a unique run-specific branch and an atomic empty-ref lease; the
runner only deletes branches for which its push command reported success.
Cleanup verifies the branch still points to the exact commit created by this
run and uses Git's exact-hash lease when deleting it. A negative read-only or
sibling push is accepted only after Git reports a completed, explicit GitHub
authorization refusal and a later read sees no ref. A timeout or other
ambiguous push remains a failure even when that read currently sees no ref,
because the original remote write could finish later. Ambiguous or otherwise
unreconciled outcomes do not authorize deletion. The failure report preserves
sanitized repository IDs/names, refs, and expected commit hashes for owner
recovery after local temp metadata is removed. Cleanup failures also report the
generated ref names; the runner never deletes pre-existing or concurrently
changed refs.

Run only after building the workspace and preparing the private config:

```sh
PRAETORIUM_T14_GITHUB_ACCESS_CONFIG=/private/path/github-access.json \
  node --test tests/integration/github-access.partial.test.mjs
```

Without owner inputs, Node reports a skipped test with a `BLOCKED` reason and
performs no network calls. A successful partial run is evidence only for the
scope above; it is not a T14 category acceptance result.
