package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/sirupsen/logrus"
)

var logger = logrus.New()

var operationLock sync.Mutex
var operationActive bool

var sessionStartedAt = time.Now().UTC()

func main() {
	var socketPath string
	flag.StringVar(&socketPath, "socket", "/run/guest-services/backend.sock", "Unix domain socket to listen on")
	flag.Parse()

	_ = os.RemoveAll(socketPath)

	logger.SetOutput(os.Stdout)

	logMiddleware := middleware.LoggerWithConfig(middleware.LoggerConfig{
		Skipper: middleware.DefaultSkipper,
		Format: `{"time":"${time_rfc3339_nano}","id":"${id}",` +
			`"method":"${method}","uri":"${uri}",` +
			`"status":${status},"error":"${error}"` +
			`}` + "\n",
		CustomTimeFormat: "2006-01-02 15:04:05.00000",
		Output:           logger.Writer(),
	})

	logger.Infof("Starting listening on %s\n", socketPath)
	router := echo.New()
	router.HideBanner = true
	router.Use(logMiddleware)

	ln, err := listen(socketPath)
	if err != nil {
		logger.Fatal(err)
	}
	router.Listener = ln

	router.GET("/health", health)
	router.GET("/session", getSession)
	router.GET("/platform", getPlatform)
	router.GET("/usage", getUsage)
	router.GET("/containers", listContainers)
	router.GET("/containers/:id/hotspots", containerHotspots)
	router.POST("/prune", prune)
	router.POST("/fstrim", fstrim)

	logger.Fatal(router.Start(""))
}

func listen(path string) (net.Listener, error) {
	return net.Listen("unix", path)
}

func health(ctx echo.Context) error {
	return ctx.JSON(http.StatusOK, map[string]string{"status": "ok"})
}

// getSession returns when this backend process started. The extension VM
// container restarts with Docker Desktop, so this approximates Docker
// Desktop's own session start — used by the UI to throttle daily notifications.
func getSession(ctx echo.Context) error {
	return ctx.JSON(http.StatusOK, map[string]string{"startedAt": sessionStartedAt.Format(time.RFC3339Nano)})
}

type PlatformInfo struct {
	IsDockerDesktop bool   `json:"isDockerDesktop"`
	OperatingSystem string `json:"operatingSystem"`
	OSType          string `json:"osType"`
	Name            string `json:"name"`
}

// getPlatform reports whether the engine is Docker Desktop or a native daemon.
// fstrim --pid=host is safe inside the Docker Desktop VM (it trims the VM's
// disk) but on native Linux Docker it would trim the user's real root fs.
// The UI uses isDockerDesktop to gate the fstrim button.
func getPlatform(ctx echo.Context) error {
	platform, err := detectPlatform()
	if err != nil {
		return ctx.JSON(http.StatusInternalServerError, errResp(err))
	}
	return ctx.JSON(http.StatusOK, platform)
}

func detectPlatform() (PlatformInfo, error) {
	out, err := dockerJSON("info", "--format", "{{json .}}")
	if err != nil {
		return PlatformInfo{}, err
	}
	var raw struct {
		OperatingSystem string `json:"OperatingSystem"`
		OSType          string `json:"OSType"`
		Name            string `json:"Name"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return PlatformInfo{}, err
	}
	isDD := strings.Contains(raw.OperatingSystem, "Docker Desktop") ||
		strings.EqualFold(raw.Name, "docker-desktop")
	return PlatformInfo{
		IsDockerDesktop: isDD,
		OperatingSystem: raw.OperatingSystem,
		OSType:          raw.OSType,
		Name:            raw.Name,
	}, nil
}

// dockerJSON runs `docker <args...>` and returns trimmed stdout. Stderr is bundled into the error.
func dockerJSON(args ...string) ([]byte, error) {
	c, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(c, "docker", args...)
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return out, fmt.Errorf("docker %s: %s: %w", strings.Join(args, " "), strings.TrimSpace(string(ee.Stderr)), err)
		}
		return out, fmt.Errorf("docker %s: %w", strings.Join(args, " "), err)
	}
	return out, nil
}

type UsageEntry struct {
	Type        string `json:"Type"`
	Total       string `json:"Total"`
	Active      string `json:"Active"`
	Size        string `json:"Size"`
	Reclaimable string `json:"Reclaimable"`
}

func getUsage(ctx echo.Context) error {
	out, err := dockerJSON("system", "df", "--format", "{{json .}}")
	if err != nil {
		return ctx.JSON(http.StatusOK, map[string]any{
			"summary":     []UsageEntry{},
			"collectedAt": time.Now().UTC().Format(time.RFC3339),
			"warning":     fmt.Sprintf("Docker could not calculate disk usage: %s", err.Error()),
		})
	}
	entries := []UsageEntry{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		var e UsageEntry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue
		}
		entries = append(entries, e)
	}

	return ctx.JSON(http.StatusOK, map[string]any{
		"summary":     entries,
		"collectedAt": time.Now().UTC().Format(time.RFC3339),
		"warning":     "",
	})
}

type ContainerInfo struct {
	ID     string `json:"id"`
	Image  string `json:"image"`
	Names  string `json:"names"`
	State  string `json:"state"`
	Status string `json:"status"`
	Size   string `json:"size"`
}

func listContainers(ctx echo.Context) error {
	out, err := dockerJSON("ps", "-a", "--size", "--format", "{{json .}}")
	if err != nil {
		out, err = dockerJSON("ps", "-a", "--format", "{{json .}}")
		if err != nil {
			return ctx.JSON(http.StatusInternalServerError, errResp(err))
		}
	}
	type raw struct {
		ID     string `json:"ID"`
		Image  string `json:"Image"`
		Names  string `json:"Names"`
		State  string `json:"State"`
		Status string `json:"Status"`
		Size   string `json:"Size"`
	}
	containers := []ContainerInfo{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		var r raw
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			continue
		}
		size := r.Size
		if size == "" {
			size = "Unavailable"
		}
		containers = append(containers, ContainerInfo{
			ID: r.ID, Image: r.Image, Names: r.Names,
			State: r.State, Status: r.Status, Size: size,
		})
	}
	return ctx.JSON(http.StatusOK, containers)
}

// containerHotspots: du -sh of common cache/temp dirs in a running container.
// Only runs against running containers; skips dirs that don't exist.
func containerHotspots(ctx echo.Context) error {
	id := ctx.Param("id")
	if id == "" {
		return ctx.JSON(http.StatusBadRequest, errResp(fmt.Errorf("missing container id")))
	}
	paths := []string{
		"/tmp", "/var/tmp", "/var/cache", "/var/log",
		"/root/.cache", "/root/.npm", "/root/.cargo/registry",
		"/home", "/var/lib/apt/lists",
	}
	c, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// `|| true` keeps each iteration's exit code from killing the loop when du
	// hits an unreadable path. Try `du -sb` first (GNU/BusyBox bytes) then fall
	// back to `du -sk` (1K blocks) for stripped-down images.
	script := "for p in " + strings.Join(paths, " ") + "; do " +
		"if [ -e \"$p\" ]; then " +
		"(du -sb \"$p\" 2>/dev/null || du -sk \"$p\" 2>/dev/null | awk '{printf \"%d\\t%s\\n\", $1*1024, $2}') || true; " +
		"fi; done"
	args := []string{"exec", id, "sh", "-c", script}
	cmd := exec.CommandContext(c, "docker", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	type entry struct {
		Path  string `json:"path"`
		Bytes int64  `json:"bytes"`
	}
	results := []entry{}
	for _, line := range strings.Split(strings.TrimSpace(stdout.String()), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		var b int64
		fmt.Sscanf(fields[0], "%d", &b)
		results = append(results, entry{Path: fields[1], Bytes: b})
	}
	if len(results) == 0 && runErr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = runErr.Error()
		} else {
			msg = fmt.Sprintf("%s (%s)", msg, runErr.Error())
		}
		return ctx.JSON(http.StatusInternalServerError, errResp(fmt.Errorf("%s", msg)))
	}
	return ctx.JSON(http.StatusOK, results)
}

type PruneRequest struct {
	Target string `json:"target"` // images | build-cache | volumes | containers | all
	All    bool   `json:"all"`    // for images: also include un-tagged & dangling=false
}

func prune(ctx echo.Context) error {
	unlock, ok := tryStartOperation()
	if !ok {
		return ctx.JSON(http.StatusConflict, errResp(fmt.Errorf("another operation is already running")))
	}
	defer unlock()

	var req PruneRequest
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, errResp(err))
	}
	var args []string
	switch req.Target {
	case "images":
		args = []string{"image", "prune", "-f"}
		if req.All {
			args = append(args, "-a")
		}
	case "build-cache":
		args = []string{"builder", "prune", "-f"}
		if req.All {
			args = append(args, "-a")
		}
	case "volumes":
		args = []string{"volume", "prune", "-f"}
		if req.All {
			args = append(args, "-a")
		}
	case "containers":
		args = []string{"container", "prune", "-f"}
	case "all":
		args = []string{"system", "prune", "-f"}
		if req.All {
			args = append(args, "-a", "--volumes")
		}
	default:
		return ctx.JSON(http.StatusBadRequest, errResp(fmt.Errorf("unknown target %q", req.Target)))
	}
	out, err := dockerJSON(args...)
	if err != nil {
		return ctx.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error(), "stdout": string(out)})
	}
	return ctx.JSON(http.StatusOK, map[string]any{"target": req.Target, "stdout": string(out)})
}

// fstrim: runs a privileged ephemeral container that fstrims the engine root
// so the WSL VHDX compaction can later reclaim those bytes.
func fstrim(ctx echo.Context) error {
	unlock, ok := tryStartOperation()
	if !ok {
		return ctx.JSON(http.StatusConflict, errResp(fmt.Errorf("another operation is already running")))
	}
	defer unlock()

	platform, err := detectPlatform()
	if err != nil {
		return ctx.JSON(http.StatusInternalServerError, errResp(err))
	}
	if !platform.IsDockerDesktop {
		return ctx.JSON(http.StatusBadRequest, errResp(fmt.Errorf("fstrim is disabled on native Docker because --pid=host would target the real host filesystem")))
	}

	c, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	cmd := exec.CommandContext(c, "docker", "run", "--rm", "--privileged",
		"--pid=host", "alpine", "sh", "-c",
		"apk add --no-cache util-linux >/dev/null 2>&1 || true; fstrim -av 2>&1 || true")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return ctx.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error(), "output": string(out)})
	}
	return ctx.JSON(http.StatusOK, map[string]any{"output": string(out)})
}

func tryStartOperation() (func(), bool) {
	operationLock.Lock()
	defer operationLock.Unlock()
	if operationActive {
		return nil, false
	}
	operationActive = true
	return func() {
		operationLock.Lock()
		operationActive = false
		operationLock.Unlock()
	}, true
}

func errResp(err error) map[string]string {
	return map[string]string{"error": err.Error()}
}
