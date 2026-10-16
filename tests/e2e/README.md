# T14 browser acceptance

The browser gate is mapped to a fixed runner path in `scripts/verify-integration.mjs`. It remains BLOCKED until production Gateway and Instance Access bundles, an integrated entry route, and an explicitly owned stable test origin are available. The workspace has Playwright and a runnable cached Chromium, but the fixed acceptance runner is not present. Local portal route tests with a fixture service will be reported separately from direct-origin wake, cookie handoff, stable-origin recovery and Scriptorium acceptance.

The e2e runner must use the inventory's owner-attested disposable test origin and cover direct bookmark wake, login and one-use handoff, cookie/CSRF behavior, API retry behavior without replaying writes, and re-entry after a real producer restart. The inventory cannot supply commands or test code.
