# NodeCTL Unified Console Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement these tasks in order.

**Goal:** Add a native-shell NodeCTL workspace with the existing MMWX login and publish it to this repository.

**Architecture:** An optional reverse proxy authenticates every request against MMWX and signs a server-only, short-lived NodeCTL JWT. A same-origin browser module mounts in the existing sidebar and content area. Both upstream databases remain independent.

**Tech Stack:** Node.js 22.13+ built-ins, read-only SQLite, browser ES modules, Docker Compose, node:test, optional Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-nodectl-unified.md`

## Constraints

No production secrets in Git; no direct business-database writes; current administrator validation on every management request; same-origin mutations; unchanged subscription payloads and old installers; no production cutover as a side effect of publishing.

### Task 1: Authentication and adapter

Files: `integration/auth.mjs`, `integration/upstream.mjs`, `integration/nodectl.mjs`, `tests/integration.test.mjs`.

- [ ] Write and run failing authorization, JWT, SQLite and metadata-preservation tests.
- [ ] Implement the native API adapter and rerun focused tests.

### Task 2: Gateway and workspace

Files: `integration/server.mjs`, `integration/main.mjs`, `ui/nodectl/extension.mjs`, `ui/nodectl/native-import.mjs`, `ui/nodectl/style.css`.

- [ ] Test CSRF, fixed routing, HTML injection, unchanged subscriptions and Agent routes.
- [ ] Implement proxy, sidebar workspace, protocol controls and additive import.
- [ ] Check revoked sessions and upstream failures fail closed.

### Task 3: Deployment and browser verification

Files: both Compose examples, both Dockerfiles, `docs/nodectl-unified.md`, `tests/browser-unified.mjs`, README.

- [ ] Add explicit new-install and existing-service variants with rollback instructions.
- [ ] Run node tests and headless browser fixtures.
- [ ] Validate Compose, shell syntax, generated files, diff and secret-free artifacts.

### Task 4: Publish

- [ ] Review changes against the spec and fresh test evidence.
- [ ] Commit and push to the existing main branch without force.
- [ ] Verify remote commit and distinguish publication from production deployment.
