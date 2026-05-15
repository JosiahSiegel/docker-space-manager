# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Docker Desktop extension ("Space Manager") that targets WSL2 `.vhdx` bloat — the gap where Docker Desktop's virtual disk keeps growing even after Docker reclaims its own internal space. The end-to-end Reclaim flow (prune → fstrim → compact VHDX) is Windows/WSL2-only; other platforms get the Docker context and prune UI but no compaction.

## Build / deploy / iterate

The extension is one image that bundles the Go service, the React UI, and the Windows host scripts. There is no `npm run dev` against Docker Desktop — every iteration rebuilds the image and re-installs it.

```powershell
docker build --tag=local/docker-space-manager:latest .
docker extension update -f local/docker-space-manager:latest   # iterating
docker extension install -f local/docker-space-manager:latest  # first install
```

Per-component checks (faster than a full image build when isolating a failure):

- Backend: `cd backend && go vet ./... && go build ./...`
- UI: `cd ui && npm ci && npm run build` (this is `tsc && vite build` — both must pass)
- UI tests: `cd ui && npm test` (Jest, but no tests exist yet)
- Host scripts: `Invoke-ScriptAnalyzer -Path host/windows -Recurse -Severity Warning,Error`

CI (`.github/workflows/ci.yml`) runs these jobs plus a multi-arch image build and a "docker subcommand sanity" check that verifies every `docker` subcommand the backend shells out to actually resolves.

## Three-tier architecture

The extension is split across three runtimes that each have very different capabilities:

1. **UI (`ui/`)** — React 18 + MUI v6 + Vite, served by Docker Desktop. Calls the backend via `dd.extension.vm.service.{get,post}` and the host scripts via `dd.extension.host.cli.exec('dsm-host.cmd', [...])`.
2. **Backend (`backend/main.go`)** — Go + Echo on a unix socket (`/run/guest-services/backend.sock`, exposed via `metadata.json`). Lives inside the Docker engine VM, has the Docker socket mounted, and shells out to `docker` for everything. Never talks to the Windows host directly.
3. **Host scripts (`host/windows/`)** — Shipped via `metadata.json`'s `host.binaries`, executed on the actual Windows host (outside the VM). This is the only tier that can touch `.vhdx` files, run `diskpart`, or call `wsl --shutdown`.

The split matters because **`fstrim` and `diskpart` belong to different tiers**: `fstrim` runs inside the engine VM (backend, via `docker run --pid=host`) to free blocks; `diskpart` runs on the Windows host (`compact.ps1`) to shrink the resulting VHDX. Both are needed for the flow to actually reclaim disk space.

## Compaction flow (the load-bearing path)

The compact button does something unusual: it intentionally tears down its own runtime.

1. UI invokes `dsm-host.cmd compact`, which does `Start-Process powershell -Verb RunAs -Wait` on `compact.ps1 -Mode Compact` (UAC prompt).
2. `compact.ps1` runs `docker desktop stop` (with a `Docker Desktop.exe -Quit` fallback, then force-kill), then `wsl.exe --shutdown`. **This kills the extension VM and the backend.** The PowerShell process survives because it was spawned out-of-process via `RunAs`.
3. For each VHDX it finds under `%LOCALAPPDATA%\Docker\wsl`, it writes a `diskpart` script (`select vdisk` / `attach vdisk readonly` / `compact vdisk` / `detach vdisk`) and runs `diskpart.exe /s`.
4. Results are written to `%TEMP%\dsm-compact-result.json`. Docker Desktop is restarted via the path resolved by `Resolve-DockerDesktopExe`.
5. When the UI comes back, it calls `dsm-host.cmd result` to pull that file and renders the reclaimed-bytes summary.

Implications for any change touching this path:

- A stale `%TEMP%\dsm-compact.lock` will cause the elevated window to exit silently — the script reads the lock, parses the PID, and only reclaims it if that process is gone. Don't add early `exit 1` paths without `Wait-ForExit` or you'll lose the only place the user can see the error.
- `compact.ps1 -Mode Status` is also the read path for "compactable bytes" (it calls `Get-VHD` for `MinimumSize`, then falls back to running an `alpine` container with `df -B1 /` when `Get-VHD` is unavailable). Both modes must return well-formed JSON on stdout — UTF-8, no BOM, no extra writes — because the cmd wrapper pipes stdout straight to the UI's `JSON.parse`.

## Notification trigger (less obvious gotcha)

`ui/src/App.tsx` shows an opt-in Windows notification when compactable space crosses a user threshold. The trigger is gated on three things in localStorage: `dsm.compactNotifyEnabled`, `dsm.compactNotifyLastAt`, `dsm.compactNotifyLastSession`. The "session" key compares against `GET /session` from the backend (which returns the backend's start time as a proxy for Docker Desktop launch), so the rule is "fire at most once per Docker Desktop session AND at most once per 24h." Threshold edits are debounced via `compactNotifyThresholdEditing` to avoid notification spam while typing.

## Naming conventions

The user-facing product is **"Space Manager"** (UI tab title, README heading, notification title, Dockerfile `org.opencontainers.image.title`). The image name and Go module remain `docker-space-manager` / `github.com/docker-space-manager/backend` — leave those alone when aligning user-facing strings.

## Safety posture

The UI requires explicit confirmation for every destructive action and shows the exact command alongside two badges (deletes-data vs no-data, stops-containers vs unaffected). The backend's `fstrim` endpoint is gated on `detectPlatform().isDockerDesktop` because `--pid=host` on native Linux Docker would trim the real host filesystem. `docker volume prune` is invoked without `-a` so named volumes are never touched. Both `prune` and `fstrim` go through `tryStartOperation()` so only one long-running backend operation can be active at a time.
