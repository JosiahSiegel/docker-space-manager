FROM golang:1.24-alpine AS builder
ENV CGO_ENABLED=0
WORKDIR /backend
COPY backend/go.* .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download
COPY backend/. .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags="-s -w" -o bin/service

FROM --platform=$BUILDPLATFORM node:24-alpine AS client-builder
WORKDIR /ui
COPY ui/package.json /ui/package.json
COPY ui/package-lock.json /ui/package-lock.json
RUN --mount=type=cache,target=/usr/src/app/.npm \
    npm set cache /usr/src/app/.npm && \
    npm ci
COPY ui /ui
RUN npm run build

FROM alpine
RUN apk add --no-cache docker-cli
LABEL org.opencontainers.image.title="Space Manager" \
    org.opencontainers.image.description="Report wasted disk space and reclaim it: prune Docker resources, scan containers for cache hotspots, and compact the WSL2 VHDX." \
    org.opencontainers.image.vendor="Josiah Siegel" \
    com.docker.desktop.extension.api.version=">= 0.4.0" \
    com.docker.desktop.extension.icon="https://raw.githubusercontent.com/JosiahSiegel/docker-space-manager/main/docker.svg" \
    com.docker.extension.screenshots='[{"alt":"Reclaim tab with VHDX donut and compact action","url":"https://raw.githubusercontent.com/JosiahSiegel/docker-space-manager/main/screenshots/reclaim.png"}]' \
    com.docker.extension.detailed-description="<h2>Reclaim Docker Desktop virtual disk space</h2><p>Space Manager targets the gap where Docker Desktop's WSL2 <code>.vhdx</code> files keep growing on Windows even after Docker reclaims its own internal space.</p><h3>What it does</h3><ul><li><b>Virtual disk report</b> — lists every Docker Desktop WSL2 VHDX, flags the largest, and estimates reclaimable bytes from Hyper-V minimum size or engine-VM filesystem usage.</li><li><b>One-click compaction</b> — UAC handoff: stops Docker Desktop and WSL, runs <code>diskpart compact vdisk</code> per VHDX, then restarts Docker Desktop and reports reclaimed bytes per disk.</li><li><b>Reclaim space</b> — prunes stopped containers and build cache, fstrims the engine VM, and then compacts the VHDX in one guarded flow.</li><li><b>Notifications</b> — opt-in Windows notification once per Docker Desktop session (and at most daily) when compactable space exceeds a user-set GB threshold.</li></ul><h3>Safety</h3><p>Every destructive action prompts for confirmation with the exact command, an explicit data-loss badge, and a runtime-impact badge. <code>docker volume prune</code> is invoked without <code>-a</code>, so named volumes are never touched. <code>fstrim</code> is disabled on native Linux Docker to avoid trimming the real host filesystem.</p><h3>Platform support</h3><p>Windows + Docker Desktop (WSL2) is the primary supported configuration for the end-to-end reclaim flow. Other platforms see the Docker context and prune UI without VHDX compaction.</p>" \
    com.docker.extension.publisher-url="https://github.com/JosiahSiegel/docker-space-manager" \
    com.docker.extension.additional-urls='[{"title":"Source","url":"https://github.com/JosiahSiegel/docker-space-manager"},{"title":"Issues","url":"https://github.com/JosiahSiegel/docker-space-manager/issues"}]' \
    com.docker.extension.categories="utility-tools" \
    com.docker.extension.changelog="<ul><li>0.1.0 — Initial release. Reclaim tab with VHDX donut, one-click prune + fstrim + compact flow, container hotspots scan, and opt-in compactable-space notifications.</li></ul>"

COPY --from=builder /backend/bin/service /
COPY docker-compose.yaml .
COPY metadata.json .
COPY docker.svg .
COPY host /host
COPY --from=client-builder /ui/build ui
CMD /service -socket /run/guest-services/backend.sock
