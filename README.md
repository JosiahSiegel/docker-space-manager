# Space Manager

A Docker Desktop extension focused on **virtual disk** bloat. The official Disk usage extension already cleans up data inside Docker; this extension targets the gap where Docker Desktop's WSL2 `.vhdx` files keep growing even after Docker reclaims internal space.

## What it does

- **Virtual disk report** — finds every Docker Desktop WSL2 VHDX under `%LOCALAPPDATA%\Docker\wsl`, shows on-disk size, flags the largest.
- **One-click compaction (Windows / WSL2)** — UAC handoff: stops Docker Desktop and WSL, runs `diskpart compact vdisk` per VHDX, writes a result file with reclaimed bytes per disk.
- **Prepare reclaim** — guarded one-click prep that frees blocks inside the engine so compaction has more to reclaim (stopped containers, unused images, build cache, `fstrim`). Treated explicitly as supporting steps to the virtual disk workflow.
- **Docker usage context** — `docker system df` breakdown shown as supporting context, not the main surface.
- **Container hotspots** — optional: pick a running container, scan common cache/temp directories with `du -sb` (falls back to `du -sk` for stripped-down images).

Every destructive action shows two badges before you run it:

- Red **Deletes Docker data** vs green **No data deleted**.
- Orange **Stops running containers** vs green **Running containers unaffected**.

Compaction shuts Docker Desktop and WSL down for ~30–120 seconds. Running containers stop temporarily and restart when Docker Desktop relaunches — do not run on a production host without a maintenance window.

## Architecture

- `ui/` — React + MUI frontend. Default tab is **Reclaim**, with **Details** and **Advanced** behind tabs.
- `backend/` — Go service inside the engine VM. Shells out to `docker` via the mounted Docker socket.
- `host/windows/` — shipped host binaries:
  - `dsm-host.cmd` — entrypoint invoked by `ddClient.extension.host.cli.exec`.
  - `compact.ps1` — virtual disk status JSON; elevated mode performs compaction.

## Platform support

| OS / engine | List VHDX | Compact VHDX | Prep (prune + fstrim) | Docker context + hotspots |
| --- | --- | --- | --- | --- |
| Windows + Docker Desktop (WSL2) | yes | yes | yes | yes |
| Windows + Docker Desktop (Hyper-V) | partial — disks may live outside `%LOCALAPPDATA%\Docker\wsl` | no | yes | yes |
| macOS Docker Desktop | no VHDX | no | yes — `fstrim` shrinks the Docker VM disk | yes |
| Linux Docker Desktop | no VHDX | no | yes — `fstrim` shrinks the Docker VM disk | yes |
| Linux native Docker (no Desktop) | no VM | no | no-op — `fstrim --pid=host` would target the actual host filesystem | yes |

The Reclaim tab disables the compaction buttons when no VHDX files are detected. On non-Windows hosts the Advanced tab still works for `docker system prune` style cleanup, and the Docker context tables stay populated.

## Build and install

```powershell
docker build -t local/docker-space-manager:latest .
docker extension install local/docker-space-manager:latest -f
```

If you have not enabled non-marketplace extensions, toggle **Settings → Extensions → Allow only extensions distributed through the Docker Marketplace** off first.

For iterative development:

```powershell
docker build -t local/docker-space-manager:latest .
docker extension update local/docker-space-manager:latest -f
```

## Command reference

The extension only runs commands the user has explicitly confirmed via the UI.

| Source | Command | Notes |
| --- | --- | --- |
| Backend | `docker system df --format "{{json .}}"` | Drives the Docker context view. |
| Backend | `docker ps -a --size --format "{{json .}}"` | Container list for hotspots. |
| Backend | `docker exec <id> sh -c "du -sb \"$p\" \|\| du -sk \"$p\""` | Hotspot scan; tolerates partial failures. |
| Backend | `docker container prune -f` | Stopped containers only. |
| Backend | `docker builder prune -f [-a]` | Unused build cache. `-a` removes all unused, not just dangling. |
| Backend | `docker volume prune -f` | Anonymous unused volumes only. Named volumes are always preserved. |
| Backend | `docker image prune -a -f` | Images not used by any container. |
| Backend | `docker run --rm --privileged --pid=host alpine sh -c "fstrim -av"` | Trims freed blocks in the Docker engine VM so the VHDX has room to shrink. |
| Host | `wsl.exe --shutdown` | Required so `diskpart` can attach the VHDX. |
| Host | `diskpart /s <script>` with `select vdisk` / `attach vdisk readonly` / `compact vdisk` / `detach vdisk` | The actual compaction step. Runs elevated. |

## Safety

- Every destructive action prompts for confirmation with the exact command that will run, plus explicit data-loss and runtime-impact labels.
- Compaction is a UAC handoff (PowerShell `Start-Process -Verb RunAs`). The extension cannot survive `wsl --shutdown`, so the script runs out-of-process and writes a result file at `%TEMP%\dsm-compact-result.json`.
- `docker volume prune` is invoked without `-a`, so named volumes (typically used for databases) are never touched. Only anonymous unused volumes are removed.

## Status

v0 — Windows/WSL2 is the primary supported configuration for the virtual-disk reclaim flow. The preparation and Docker context tabs work on any Docker Desktop platform; on native Linux Docker, only the Docker context and Advanced prunes are useful.
