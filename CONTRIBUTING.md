# Contributing

Read AGENTS.md and the canonical architecture and migration plan. Changes need focused behavior tests, local build/type checks and evidence appropriate to the affected production path. Do not add CI workflows or automatically apply infrastructure. Mark fixtures and unavailable external gates honestly. Provider-specific implementation belongs in plugins; domain and application packages depend on neutral ports.
