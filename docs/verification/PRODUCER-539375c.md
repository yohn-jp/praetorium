# Read-only producer preflight: 539375c

The fresh detached snapshot `/tmp/praetorium-producer-audit-539375` is clean at
`539375c925754c6ec6f5c445051a32b7293a0724`, tree
`62b9351539579a17cbd7f00127c1ab218d29c51b`. Remote main matched this checkpoint.
Arcadia remains `b96a03a8734bfff2e5b965e6966007c45a2c7dc9`. No producer
branch, worktree or source file was changed.

Relative to `271d7b28`, the production delta adds owner-cookie recent-activity
persistence and cross-device resume UI. `packages/api/src/recent-activity-store.ts`,
GET/PUT `/api/projects/:projectId/recent-activity`, and Core's
`registeredRepositoryIdentity(projectId)` protect private work-continuation data.
They do not supply hosted AccessGrant/JWKS, assignment/instance/epoch enforcement,
renewable repository Git credentials, or status/quiesce/resume control. S01–S04
remain missing/BLOCKED; the existing producer coordinator retains ownership of the
handoffs in [SCRIPTORIUM-CONTRACT.md](../architecture/SCRIPTORIUM-CONTRACT.md).
P12's migration evidence still records pending root verification.

S05 has stronger component evidence in the producer's
`docs/verification/P13-BROWSER-RECOVERY.md`: the real local Core recovery run used
source `f3ef4d34b5e603885ec2cbf204446b6becef3071`, tree
`41c3027768948392b8f9a43815c86fa680d636f3`, linux/amd64 manifest
`sha256:79d59260c436dfa98b9e250eba9ee616058a756b7d62935b71d5dd5740b7f0b0`,
image ID `b33526e4325684b8cf068ec1a442c4c71d9801ac395c75f71053ca598ed9af45`.
It reports stable-origin Chromium IndexedDB retention, replacement of `/data`,
Core replay/publication, external-follow and conflict preservation. Root inspected
this report and the exact f3ef..539 diff: only docs and a migration acceptance test
changed; production image inputs are unchanged. This is useful evidence for those
Core paths, rather than an unrelated older image.

The image remained local; no exact-539 image build, published locator, hosted
assignment/composition binding or Praetorium conformance run is recorded. S05
therefore remains incomplete, and the accepted Platform `artifactDigest` remains
null. The component digest above must not be promoted to a Platform composition.
No registry absence is inferred from historical unauthenticated HTTP 401 replies.
