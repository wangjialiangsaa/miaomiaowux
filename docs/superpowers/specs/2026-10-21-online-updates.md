# Administrator online updates

## Approved scope

Administrators can check and install integration/gateway releases from the existing NodeCTL management workspace. No GitHub visit, SSH command, separate login, or unattended update is required. Current/latest versions, release notes, bounded progress, failure details, and a refresh action are visible. Updates initially cover only this repository's integration gateway and injected UI, not the MMWX engine, NodeCTL engine, agents, or the updater itself.

Existing nodes, credentials, subscription URLs and responses, databases, agents, traffic WebSockets and the 500 ms display interval must remain intact. JP (45.149.156.216, inventory alias hcm-greencloud) is the only deployment target. Keep Caddy, DNS, firewall, SSH settings, and password login unchanged.

## Trust and isolation

Reuse native administrator authentication and the gateway's exact-origin/JSON/custom-header CSRF checks. The gateway remains non-root with a read-only root filesystem and never receives the Docker socket. An optional, separately deployed updater owns Docker access and communicates only over a group-restricted Unix socket. It exposes status, check and apply; it accepts no commands, paths, repository choices, download URLs, Compose projects or service names from requests.

The updater runs a fixed, root-controlled Compose definition for the gateway only. Its configuration, Compose files and engine mounts are read-only. Private state and backups are mode 0700/0600. An OS file lock permits only one daemon per state directory, and one update job at a time is accepted. Docker access is host-root-equivalent; this updater is deliberately a trusted control-plane component, not a general-purpose web executor.

## Release protocol

Use stable tags gateway-vMAJOR.MINOR.PATCH in wangjialiangsaa/miaomiaowux. A GitHub Actions release includes linux/amd64 and linux/arm64 gzip-compressed Docker image archives, a bounded JSON manifest and an Ed25519 signature of the exact manifest bytes. The pinned public key ships with the updater; the private key exists only as a GitHub Actions secret. Schema/protocol, version/tag/repository, architecture, source commit, image identity, size, SHA-256 and image labels are checked before execution. Downgrades, prereleases, unsigned or modified releases and mismatched confirmation hashes are rejected. Redirects are HTTPS-only and restricted to GitHub release hosts.

Status reads local state only. Check is explicit and rate limited. Apply requires both the displayed version and manifest hash. The browser cannot choose an arbitrary release or override deployment configuration. Release notes render as text, never HTML.

## Deployment transaction

Persist phase changes atomically before side effects. Preflight checks disk reserve, current gateway identity, engine identities and availability. Save consistent read-only SQLite snapshots, the MMWX key, selected deployment configuration and the previous gateway image. Download and verify the signed image, load it, verify exact image ID and labels, then recreate only the gateway using its immutable image ID. Check gateway version/revision, original engines and their identities. Health failure recreates the old image; no automatic database restoration is attempted because updates do not write business databases. Retain the latest three transaction backups and do not prune unrelated Docker images.

On daemon restart, an interrupted deployment rolls back before accepting another update. A failed rollback blocks future applies and reports that administrator intervention is required. A pre-deployment interruption becomes a safe failed job. Never report success until health checks finish.

## Interface and acceptance

An admin-only 系统更新 dialog in NodeCTL management displays current/latest version, release notes and job progress, and requires explicit confirmation. Poll updater state every two seconds only while the dialog is open and the page visible. Continue polling through a brief gateway restart; stop on close, logout or hidden page. Refresh is offered after success. Unconfigured installations show a disabled explanation without affecting ordinary management.

Tests cover cryptographic/protocol rejection, restricted commands/IPC, administrator and CSRF enforcement, duplicate applies, backup/deployment/health failures, rollback and interrupted-job recovery. Browser fixtures cover lifecycle, unavailable/reconnecting states, keyboard/mobile and existing traffic functionality. Production acceptance compares original business records and all five subscription response hashes and proves unrelated services were not recreated.
