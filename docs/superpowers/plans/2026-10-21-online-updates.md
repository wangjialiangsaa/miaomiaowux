# Administrator Online Updates Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, following the already approved scope. Do not spawn agents or change branches. Steps use checkbox syntax for tracking.

**Goal:** Install signed gateway releases from the authenticated administrator dashboard, preserving business data and automatically rolling back unhealthy releases.

**Architecture:** A non-root web gateway forwards three fixed update actions to a separate Unix-socket updater. Only that updater has Docker access; it validates signed GitHub bundles and recreates only the fixed gateway service. Persistent transaction phases and old-image backups support rollback and restart recovery.

**Tech Stack:** Node.js built-ins, Ed25519/SHA-256, SQLite backup, Docker Compose, native DOM, GitHub Actions.

**Spec:** docs/superpowers/specs/2026-10-21-online-updates.md

## Global Constraints

- Updates initially cover only the integration gateway and injected UI, not MMWX, NodeCTL, agents, or the updater itself.
- The gateway never receives Docker access. Browser requests never supply commands, URLs, paths, projects or services.
- Use native administrator authentication, exact-origin CSRF checks and explicit version/hash confirmation.
- Keep existing nodes, subscriptions, credentials, databases, agents, 500 ms traffic display, Caddy, DNS, firewall and SSH unchanged.
- Deploy only to JP, alias hcm-greencloud, 45.149.156.216; audit sanitized outcomes and preserve recovery material.

### Task 1: Release verification and transactions

**Files:** Create updater/release.mjs, updater/manager.mjs, tests/updates.test.mjs.

**Interfaces:** verifyManifest(bytes, signature, publicKey, architecture) returns validated manifest; createUpdateManager({source, runner, stateDirectory}) returns status(), check(), apply({version, manifestSha256}), recover(). Runner supplies current(), preflight(), backup(), download(), load(), deploy(), healthy() and restore().

- [ ] Write tests using `generateKeyPairSync('ed25519')`, `sign(null, bytes, privateKey)` and a fake runner that records calls.
- [ ] Run `node --test tests/updates.test.mjs`; confirm missing-module failure.
- [ ] Implement strict signed-manifest validation, HTTPS bounded release downloads, local check caching and serial durable transaction state.
- [ ] Assert tampered/unsigned/wrong-architecture manifests fail, repeated apply returns conflict, health failure restores old image, and crash recovery blocks unsafe updates.
- [ ] Run the focused suite and inspect every failure before proceeding.

### Task 2: Restricted runtime and gateway IPC

**Files:** Create updater/docker.mjs, updater/server.mjs, updater/main.mjs, updater/Dockerfile, updater/compose.gateway.yml, updater/compose.updater.yml, updater/config.example.json, integration/updates.mjs. Modify integration/server.mjs, integration/main.mjs, integration/Dockerfile. Extend tests/integration.test.mjs and tests/updates.test.mjs.

**Interfaces:** createDockerRunner(config) implements Task 1's runner. createUpdaterServer(manager) serves GET /v1/status and POST /v1/check,/v1/apply only. updateRequest(socketPath, action, body) is the sole gateway IPC client.

- [ ] Add failing tests for unknown actions/fields, IPC response bounds, absent socket, native admin and CSRF restrictions.
- [ ] Implement fixed no-shell Docker commands, disk reserve, SQLite/image/config snapshots, immutable image deployment, health checks, private persistence, daemon file lock and optional Compose deployment.
- [ ] Add gateway health version metadata and three update routes through existing administrator guards; unconfigured status must be explicit and safe.
- [ ] Run Node tests, generated-script checks and shell syntax checks.

### Task 3: Administrator update dialog

**Files:** Create ui/nodectl/updates.mjs. Modify ui/nodectl/extension.mjs, ui/nodectl/style.css, tests/browser-unified.mjs and tests/unified-fixtures.mjs.

**Interfaces:** createUpdateDialog({api, element, onUnauthorized}) returns a dialog controller with close(), suspend(), resume(). It receives only the existing authenticated API helper.

- [ ] Add fixture cases for checking, explicit version/hash confirmation, notes-as-text, polling/reconnect, hidden/closed/logout cleanup, unavailable updater and successful refresh.
- [ ] Implement the accessible admin-only dialog and integrate cleanup with existing authentication lifecycle.
- [ ] Run fixture browser tests and all existing protocol-folding, mobile and traffic checks.

### Task 4: Publication and JP acceptance

**Files:** Create scripts/release-gateway.mjs, .github/workflows/gateway-release.yml, updater/release-signing.pub, docs/online-updates.md. Update docs/nodectl-unified.md and append parent operations.log.

**Interfaces:** Release workflow exports two architecture archives and signs manifest with GATEWAY_RELEASE_SIGNING_KEY. Optional updater Compose consumes root-controlled config and gateway Compose definitions, private state and a restricted shared socket directory.

- [ ] Validate release script with fixture signing key; never include private keys or credentials in artifacts.
- [ ] Verify fresh JP disk/CPU/memory, pinned host identity, engine/container IDs, authenticated management and all original subscription hashes.
- [ ] Publish reviewed changes and release through authorized GitHub credentials; bootstrap only the updater and gateway on JP after recording approved scope/recovery.
- [ ] Trigger an actual signed update through the authenticated dashboard; verify health, version and all original data/subscriptions, plus unchanged unrelated service identities.
- [ ] Run final local/production acceptance, record audit, remove temporary credential/signing helpers and report actual deployed outcome.
