import React from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  LinearProgress,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import { createDockerDesktopClient } from '@docker/extension-api-client';

const client = createDockerDesktopClient();
const useDD = () => client;

type UsageEntry = { Type: string; Total: string; Active: string; Size: string; Reclaimable: string };
type UsageResponse = { summary: UsageEntry[]; verboseRaw: string; collectedAt: string; warning?: string };
type ContainerRow = { id: string; image: string; names: string; state: string; status: string; size: string };
type Hotspot = { path: string; bytes: number };
type VhdxEntry = { path: string; bytes: number };
type HostStatus = { admin: boolean; vhdx: VhdxEntry[] };
type Platform = { isDockerDesktop: boolean; operatingSystem: string; osType: string; name: string };
type PruneTarget = 'images' | 'build-cache' | 'volumes' | 'containers' | 'all';
type PendingAction =
  | { kind: 'prune'; target: PruneTarget; all: boolean; label: string; detail: string }
  | { kind: 'fstrim' }
  | { kind: 'compact' }
  | { kind: 'magic' };

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function shortName(path: string): string {
  return path.split(/[\\/]/).slice(-3).join(' / ');
}

function parseReclaimableBytes(s: string | undefined): number {
  if (!s) return 0;
  const m = s.match(/([\d.]+)\s*([KMGT]?B)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mul: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return n * (mul[unit] ?? 1);
}

function sumReclaimable(summary: UsageEntry[] | undefined): number {
  if (!summary) return 0;
  return summary.reduce((acc, e) => acc + parseReclaimableBytes(e.Reclaimable), 0);
}

function diskGradient(vhdx: VhdxEntry[]): string {
  const total = vhdx.reduce((s, v) => s + v.bytes, 0) || 1;
  const colors = ['#1d63ed', '#00b8a9', '#ffb020', '#d14343', '#7c3aed', '#64748b'];
  let cursor = 0;
  const parts = [...vhdx]
    .sort((a, b) => b.bytes - a.bytes)
    .map((v, i) => {
      const start = cursor;
      cursor += (v.bytes / total) * 100;
      return `${colors[i % colors.length]} ${start}% ${cursor}%`;
    });
  return `conic-gradient(${parts.join(', ')})`;
}

function reclaimStripeGradient(totalBytes: number, reclaimableBytes: number, estimateUnavailable: boolean): string {
  if (totalBytes <= 0) return 'transparent';
  if (estimateUnavailable) {
    return 'repeating-conic-gradient(from -12deg, rgba(17,24,39,0.72) 0deg 5deg, rgba(255,255,255,0.92) 5deg 10deg, transparent 10deg 16deg)';
  }
  if (reclaimableBytes <= 0) return 'transparent';
  const pct = Math.min(100, (reclaimableBytes / totalBytes) * 100);
  return `conic-gradient(rgba(17,24,39,0.72) 0 ${pct}%, transparent ${pct}% 100%)`;
}

export function App() {
  const dd = useDD();
  const [tab, setTab] = React.useState(0);
  const [usage, setUsage] = React.useState<UsageResponse | null>(null);
  const [usageErr, setUsageErr] = React.useState<string | null>(null);
  const [usageLoading, setUsageLoading] = React.useState(false);
  const [containers, setContainers] = React.useState<ContainerRow[]>([]);
  const [containersErr, setContainersErr] = React.useState<string | null>(null);
  const [selectedContainer, setSelectedContainer] = React.useState<string | null>(null);
  const [hotspots, setHotspots] = React.useState<Hotspot[] | null>(null);
  const [hotspotsErr, setHotspotsErr] = React.useState<string | null>(null);
  const [hotspotsLoading, setHotspotsLoading] = React.useState(false);
  const [hostStatus, setHostStatus] = React.useState<HostStatus | null>(null);
  const [hostErr, setHostErr] = React.useState<string | null>(null);
  const [platform, setPlatform] = React.useState<Platform | null>(null);
  const [running, setRunning] = React.useState<string | null>(null);
  const [pendingAction, setPendingAction] = React.useState<PendingAction | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<string | null>(null);

  const refreshUsage = React.useCallback(async () => {
    setUsageLoading(true);
    setUsageErr(null);
    try {
      setUsage((await dd.extension.vm?.service?.get('/usage')) as UsageResponse);
    } catch (e: any) {
      setUsageErr(e?.message ?? String(e));
    } finally {
      setUsageLoading(false);
    }
  }, [dd]);

  const refreshContainers = React.useCallback(async () => {
    setContainersErr(null);
    try {
      setContainers(((await dd.extension.vm?.service?.get('/containers')) as ContainerRow[]) ?? []);
    } catch (e: any) {
      setContainersErr(e?.message ?? String(e));
    }
  }, [dd]);

  const refreshPlatform = React.useCallback(async () => {
    try {
      setPlatform((await dd.extension.vm?.service?.get('/platform')) as Platform);
    } catch {
      setPlatform(null);
    }
  }, [dd]);

  const refreshHostStatus = React.useCallback(async () => {
    setHostErr(null);
    try {
      const r = await dd.extension.host?.cli.exec('dsm-host.cmd', ['status']);
      const out = (r?.stdout ?? '').trim();
      if (!out) throw new Error('Virtual disk helper returned no output. Windows VHDX support may be unavailable.');
      setHostStatus(JSON.parse(out));
    } catch (e: any) {
      setHostStatus(null);
      setHostErr(e?.message ?? String(e));
    }
  }, [dd]);

  React.useEffect(() => {
    refreshPlatform();
    refreshHostStatus();
    refreshUsage();
    refreshContainers();
  }, [refreshPlatform, refreshHostStatus, refreshUsage, refreshContainers]);

  const loadHotspots = async (id: string) => {
    setSelectedContainer(id);
    setHotspots(null);
    setHotspotsErr(null);
    setHotspotsLoading(true);
    try {
      const r = (await dd.extension.vm?.service?.get(`/containers/${id}/hotspots`)) as Hotspot[];
      r.sort((a, b) => b.bytes - a.bytes);
      setHotspots(r);
    } catch (e: any) {
      setHotspotsErr(e?.message ?? String(e));
    } finally {
      setHotspotsLoading(false);
    }
  };

  const runPrune = async (target: PruneTarget, all: boolean) => {
    const r = (await dd.extension.vm?.service?.post('/prune', { target, all })) as any;
    setLastResult(`Cleaned ${target}: ${String(r?.stdout ?? '').trim() || 'done'}`);
    await refreshUsage();
  };

  const doPrune = async (target: PruneTarget, all: boolean) => {
    setRunning(`prune:${target}`);
    setLastResult(null);
    try {
      await runPrune(target, all);
    } catch (e: any) {
      setLastResult(`Cleanup failed: ${e?.message ?? e}`);
    } finally {
      setRunning(null);
    }
  };

  const runFstrim = async () => {
    const r = (await dd.extension.vm?.service?.post('/fstrim', {})) as any;
    setLastResult(`Prepared freed blocks: ${String(r?.output ?? '').trim() || 'done'}`);
  };

  const doFstrim = async () => {
    setRunning('fstrim');
    setLastResult(null);
    try {
      await runFstrim();
    } catch (e: any) {
      setLastResult(`Prepare failed: ${e?.message ?? e}`);
    } finally {
      setRunning(null);
    }
  };

  const doCompact = async () => {
    setRunning('compact');
    setLastResult(null);
    try {
      await dd.extension.host?.cli.exec('dsm-host.cmd', ['compact']);
      setLastResult('Compaction launched. Docker Desktop will shut down and reload after restart.');
    } catch (e: any) {
      setLastResult(`Compaction failed: ${e?.message ?? e}`);
    } finally {
      setRunning(null);
      refreshHostStatus();
    }
  };

  const doMagic = async () => {
    setPendingAction(null);
    setRunning('magic');
    setLastResult(null);
    try {
      await runPrune('containers', false);
      await runPrune('build-cache', true);
      if (!fstrimDisabledReason) {
        await runFstrim();
      }
      setPendingAction({ kind: 'compact' });
    } finally {
      setRunning(null);
    }
  };

  const confirmAction = async () => {
    if (confirming || running) return;
    const a = pendingAction;
    setPendingAction(null);
    if (!a) return;
    setConfirming(true);
    try {
      if (a.kind === 'prune') await doPrune(a.target, a.all);
      if (a.kind === 'fstrim') await doFstrim();
      if (a.kind === 'compact') await doCompact();
      if (a.kind === 'magic') await doMagic();
    } finally {
      setConfirming(false);
    }
  };

  const commandBusy = Boolean(running) || confirming;
  const fstrimDisabledReason = platform && !platform.isDockerDesktop ? 'Disabled on native Linux Docker: --pid=host would target your real host filesystem, not a Docker VM.' : undefined;

  const vhdx = hostStatus?.vhdx ?? [];
  const sortedVhdx = [...vhdx].sort((a, b) => b.bytes - a.bytes);
  const totalVhdxBytes = vhdx.reduce((s, v) => s + v.bytes, 0);
  const biggestVhdx = sortedVhdx[0];
  const reclaimableBytes = sumReclaimable(usage?.summary);
  const reclaimEstimateUnavailable = Boolean(usage?.warning || (usage && usage.summary.length === 0));
  const reclaimablePct = totalVhdxBytes ? Math.min(100, (reclaimableBytes / totalVhdxBytes) * 100) : 0;

  return (
    <Box sx={{ py: 1 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5">Virtual Disk Reclaimer</Typography>
          <Typography variant="body2" color="text.secondary">Shrink Docker Desktop's WSL2 disks after Docker cleanup has already freed space.</Typography>
        </Box>
        <Button onClick={() => { refreshHostStatus(); refreshUsage(); refreshContainers(); }}>Refresh</Button>
      </Stack>

      {lastResult && (
        <Alert severity={lastResult.includes('failed') ? 'error' : 'success'} sx={{ mb: 2 }} onClose={() => setLastResult(null)}>
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{lastResult}</pre>
        </Alert>
      )}

      {hostErr && <Alert severity="warning" sx={{ mb: 2 }}>{hostErr}</Alert>}

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Reclaim" />
        <Tab label="Details" />
        <Tab label="Advanced" />
      </Tabs>

      {tab === 0 && (
        <Stack spacing={2}>
          <Paper sx={{ p: 3 }}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems="center">
              <Box sx={{ position: 'relative', width: 210, height: 210 }}>
                <Box
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: '50%',
                    background: vhdx.length ? diskGradient(sortedVhdx) : '#d9dee8',
                    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.08)',
                  }}
                />
                <Box
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: '50%',
                    background: reclaimStripeGradient(totalVhdxBytes, reclaimableBytes, reclaimEstimateUnavailable),
                    boxShadow: reclaimableBytes > 0 ? 'inset 0 0 0 2px rgba(17,24,39,0.35)' : undefined,
                    pointerEvents: 'none',
                  }}
                />
                <Box sx={{ position: 'absolute', inset: 38, borderRadius: '50%', bgcolor: 'background.paper', display: 'grid', placeItems: 'center', textAlign: 'center', p: 1 }}>
                  <Box>
                    <Typography variant="caption" color="text.secondary">VHDX total</Typography>
                    <Typography variant="h4">{fmtBytes(totalVhdxBytes)}</Typography>
                    {reclaimEstimateUnavailable ? (
                      <Typography variant="caption" color="warning.main" sx={{ fontWeight: 600 }}>estimate unavailable</Typography>
                    ) : reclaimablePct > 0 ? (
                      <Typography variant="caption" color="warning.main" sx={{ fontWeight: 600 }}>~{reclaimablePct.toFixed(0)}% reclaimable</Typography>
                    ) : null}
                  </Box>
                </Box>
              </Box>

              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="overline" color="text.secondary">
                  {vhdx.length ? `${vhdx.length} virtual disk${vhdx.length === 1 ? '' : 's'} found` : 'No virtual disks found'}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  {biggestVhdx ? `${shortName(biggestVhdx.path)} is the largest at ${fmtBytes(biggestVhdx.bytes)}.` : 'Looking for Docker Desktop WSL2 VHDX files.'}
                  {reclaimEstimateUnavailable ? ` The striped ring means Docker could not calculate reclaimable space right now; compact-only savings can still be measured after compaction.` : reclaimableBytes > 0 ? ` The dark slice shows Docker's reported reclaimable space; compact-only savings may be higher but can only be measured after compaction.` : ''}
                </Typography>

                <Stack direction="row" spacing={4} sx={{ mb: 3 }}>
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>Size on disk</Typography>
                    <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.2 }}>{fmtBytes(totalVhdxBytes)}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>VHDX file size. Only compaction shrinks this.</Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>Docker reclaimable</Typography>
                    <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.2 }}>{usage ? fmtBytes(reclaimableBytes) : '—'}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>Waste inside the VHDX. Reclaim space frees it so compaction can shrink the file more.</Typography>
                  </Box>
                </Stack>

                <Stack direction="row" spacing={1} alignItems="center">
                  <Button variant="contained" size="large" color="warning" disabled={!vhdx.length || commandBusy} onClick={() => setPendingAction({ kind: 'magic' })}>
                    {running ? <CircularProgress size={18} sx={{ mr: 1 }} /> : null}
                    Reclaim space
                  </Button>
                  <Button variant="text" size="large" disabled={!vhdx.length || commandBusy} onClick={() => setPendingAction({ kind: 'compact' })}>
                    Compact only
                  </Button>
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  Reclaim space deletes stopped containers and build cache. Both actions stop Docker Desktop during compaction, so running containers stop temporarily.
                </Typography>
              </Box>
            </Stack>
          </Paper>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <ActionPath
              title="Reclaim space"
              reclaimsLabel="Docker reclaimable + Size on disk"
              reclaimsDetail="Frees waste inside the VHDX, then compacts the file to shrink it on disk."
              steps={[
                { text: 'docker container prune — deletes stopped containers', kind: 'destructive', note: 'Running containers, images, and volumes are kept.' },
                { text: 'docker builder prune -a — deletes unused build cache', kind: 'destructive', note: 'Cache only. No images, containers, or volumes touched.' },
                { text: 'fstrim -av — marks freed blocks inside the VM', kind: 'safe', note: 'No data is removed.' },
                { text: 'Compact VHDX (UAC) — shuts Docker down and shrinks the file', kind: 'downtime', note: 'No data loss. Docker Desktop restarts when finished.' },
              ]}
              active={Boolean(running?.startsWith('prune')) || running === 'fstrim'}
            />
            <ActionPath
              title="Compact only"
              reclaimsLabel="Size on disk"
              reclaimsDetail="Shrinks VHDX files using free space already inside them. Docker reclaimable is untouched."
              steps={[
                { text: 'Stops Docker Desktop and shuts WSL down', kind: 'downtime', note: 'Running containers stop temporarily.' },
                { text: 'Prompts for admin (UAC)', kind: 'safe', note: 'Required so diskpart can attach the VHDX.' },
                { text: 'diskpart compact vdisk per file', kind: 'safe', note: 'Shrinks the virtual disk only. Contents are preserved.' },
                { text: 'Docker Desktop restarts automatically', kind: 'safe', note: 'Containers, images, volumes, and build cache come back untouched.' },
              ]}
              active={running === 'compact'}
            />
          </Stack>

          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Largest disks</Typography>
            <Stack spacing={1}>
              {sortedVhdx.slice(0, 4).map((v) => (
                <Box key={v.path}>
                  <Stack direction="row" justifyContent="space-between" spacing={2}>
                    <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName(v.path)}</Typography>
                    <Typography variant="body2">{fmtBytes(v.bytes)}</Typography>
                  </Stack>
                  <LinearProgress variant="determinate" value={totalVhdxBytes ? (v.bytes / totalVhdxBytes) * 100 : 0} sx={{ height: 8, borderRadius: 4 }} />
                </Box>
              ))}
              {sortedVhdx.length === 0 && <Typography variant="body2" color="text.secondary">No Docker Desktop VHDX files found.</Typography>}
            </Stack>
          </Paper>
        </Stack>
      )}

      {tab === 1 && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>Virtual disk details</Typography>
          {vhdx.length > 0 && (
            <Table size="small">
              <TableHead><TableRow><TableCell>Path</TableCell><TableCell align="right">Size</TableCell></TableRow></TableHead>
              <TableBody>
                {sortedVhdx.map((v) => <TableRow key={v.path}><TableCell sx={{ wordBreak: 'break-all' }}>{v.path}</TableCell><TableCell align="right">{fmtBytes(v.bytes)}</TableCell></TableRow>)}
              </TableBody>
            </Table>
          )}
          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2" sx={{ mb: 1 }}>Docker context</Typography>
          {usageLoading && <LinearProgress sx={{ mb: 1 }} />}
          {usageErr && <Alert severity="error" sx={{ mb: 2 }}>{usageErr}</Alert>}
          {usage?.warning && <Alert severity="warning" sx={{ mb: 2 }}>{usage.warning}</Alert>}
          {usage && (
            <Table size="small">
              <TableHead><TableRow><TableCell>Type</TableCell><TableCell align="right">Size</TableCell><TableCell align="right">Reclaimable</TableCell></TableRow></TableHead>
              <TableBody>
                {usage.summary.map((e) => <TableRow key={e.Type}><TableCell>{e.Type}</TableCell><TableCell align="right">{e.Size}</TableCell><TableCell align="right"><Chip size="small" color={e.Reclaimable && e.Reclaimable !== '0B' ? 'warning' : 'default'} label={e.Reclaimable || '0B'} /></TableCell></TableRow>)}
              </TableBody>
            </Table>
          )}
        </Paper>
      )}

      {tab === 2 && (
        <Stack spacing={2}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" sx={{ mb: 0.5 }}>Manual prep actions</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Red actions delete Docker data. Orange actions stop Docker Desktop or running containers. Green actions do neither.
            </Typography>
            <Stack spacing={2}>
              <CleanupAction title="Remove stopped containers" detail="docker container prune -f" dataRisk="destructive" runtimeRisk="safe" impact="Deletes stopped containers. Running containers, images, volumes, and networks are kept." disabled={commandBusy}
                running={running === 'prune:containers'} onClick={() => setPendingAction({ kind: 'prune', target: 'containers', all: false, label: 'Remove stopped containers', detail: 'docker container prune -f' })} />
              <CleanupAction title="Clear build cache" detail="docker builder prune -a -f" dataRisk="destructive" runtimeRisk="safe" impact="Deletes unused build cache. Running containers, images, and volumes are kept." disabled={commandBusy}
                running={running === 'prune:build-cache'} onClick={() => setPendingAction({ kind: 'prune', target: 'build-cache', all: true, label: 'Clear build cache', detail: 'docker builder prune -a -f' })} />
              <CleanupAction title="Prune unused images" detail="docker image prune -a -f" dataRisk="destructive" runtimeRisk="safe" impact="Deletes images not used by any container. Running containers and volumes are kept." disabled={commandBusy}
                running={running === 'prune:images'} onClick={() => setPendingAction({ kind: 'prune', target: 'images', all: true, label: 'Prune unused images', detail: 'docker image prune -a -f' })} />
              <CleanupAction title="Prune unused volumes" detail="docker volume prune -f" dataRisk="destructive" runtimeRisk="safe" impact="Deletes anonymous unused volumes only. Named volumes (typically used for databases) and running containers are kept." disabled={commandBusy}
                running={running === 'prune:volumes'} onClick={() => setPendingAction({ kind: 'prune', target: 'volumes', all: false, label: 'Prune unused volumes', detail: 'docker volume prune -f' })} />
              <CleanupAction
                title="Mark freed blocks"
                detail="fstrim -av inside the engine VM"
                dataRisk="safe"
                runtimeRisk="safe"
                impact="No Docker data is deleted and running containers are not stopped. Marks already-free blocks for compaction."
                disabled={commandBusy}
                running={running === 'fstrim'}
                onClick={() => setPendingAction({ kind: 'fstrim' })}
                disabledReason={fstrimDisabledReason}
              />
            </Stack>
          </Paper>

          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>Container hotspots</Typography>
            {containersErr && <Alert severity="error" sx={{ mb: 2 }}>{containersErr}</Alert>}
            <Stack direction="row" spacing={2}>
              <Box sx={{ flex: 1 }}>
                <Table size="small">
                  <TableHead><TableRow><TableCell>Name</TableCell><TableCell>State</TableCell><TableCell align="right">Size</TableCell></TableRow></TableHead>
                  <TableBody>
                    {containers.map((c) => (
                      <TableRow key={c.id} hover selected={c.id === selectedContainer} onClick={() => c.state === 'running' && loadHotspots(c.id)} sx={{ cursor: c.state === 'running' ? 'pointer' : 'not-allowed', opacity: c.state === 'running' ? 1 : 0.5 }}>
                        <TableCell><Tooltip title={c.image}><span>{c.names || c.id.slice(0, 12)}</span></Tooltip></TableCell>
                        <TableCell><Chip size="small" label={c.state} color={c.state === 'running' ? 'success' : 'default'} /></TableCell>
                        <TableCell align="right">{c.size}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
              <Box sx={{ flex: 1 }}>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>{selectedContainer ? `Hotspots in ${selectedContainer.slice(0, 12)}` : 'Select a running container'}</Typography>
                {hotspotsLoading && <CircularProgress size={18} />}
                {hotspotsErr && <Alert severity="error">{hotspotsErr}</Alert>}
                {hotspots && (
                  <Table size="small">
                    <TableHead><TableRow><TableCell>Path</TableCell><TableCell align="right">Size</TableCell></TableRow></TableHead>
                    <TableBody>
                      {hotspots.map((h) => <TableRow key={h.path}><TableCell>{h.path}</TableCell><TableCell align="right">{fmtBytes(h.bytes)}</TableCell></TableRow>)}
                      {hotspots.length === 0 && <TableRow><TableCell colSpan={2}>No matching paths found.</TableCell></TableRow>}
                    </TableBody>
                  </Table>
                )}
              </Box>
            </Stack>
          </Paper>
        </Stack>
      )}

      <Dialog open={pendingAction !== null} onClose={() => setPendingAction(null)}>
        <DialogTitle>{pendingAction?.kind === 'magic' ? 'Reclaim space?' : 'Confirm action'}</DialogTitle>
        <DialogContent>
          {pendingAction?.kind === 'magic' && (
            <DialogContentText component="div">
              <Typography component="span" color="warning.main" sx={{ fontWeight: 600, display: 'block', mb: 1 }}>
                Docker Desktop will stop during compaction. Running containers stop temporarily and restart after. Do not run this on a production host without a maintenance window.
              </Typography>
              <b>This will delete:</b>
              <ul style={{ marginTop: 4, marginBottom: 8 }}>
                <li>Stopped containers (running containers are kept)</li>
                <li>Unused build cache</li>
              </ul>
              <b>This will not delete:</b>
              <ul style={{ marginTop: 4, marginBottom: 8 }}>
                <li>Images, volumes, networks</li>
                <li>Running containers (they are stopped, then restarted)</li>
              </ul>
              After cleanup, the engine VM is trimmed and you'll get a second confirmation before Docker Desktop shuts down for VHDX compaction.
            </DialogContentText>
          )}
          {pendingAction?.kind === 'prune' && (
            <DialogContentText component="div">
              <b>{pendingAction.label}</b><br />
              Command: <code>{pendingAction.detail}</code><br /><br />
              <Typography component="span" color="error.main" sx={{ fontWeight: 600 }}>This deletes Docker data and cannot be undone.</Typography>
              {pendingAction.target === 'volumes' && (
                <Box component="span" sx={{ display: 'block', mt: 1 }}>
                  Only anonymous unused volumes are removed. Named volumes are kept, even if no container is currently attached.
                </Box>
              )}
            </DialogContentText>
          )}
          {pendingAction?.kind === 'fstrim' && <DialogContentText>No Docker data is deleted. Runs <code>fstrim -av</code> inside Docker's engine VM so Windows can reclaim freed blocks during compaction.</DialogContentText>}
          {pendingAction?.kind === 'compact' && (
            <DialogContentText component="div">
              <Typography component="span" color="warning.main" sx={{ fontWeight: 600, display: 'block', mb: 1 }}>
                Docker Desktop will stop and WSL will shut down. Running containers will stop temporarily and restart after compaction. Do not run on a production host without a maintenance window.
              </Typography>
              No Docker data is deleted. Each VHDX is compacted with <code>diskpart</code>, then Docker Desktop restarts. A UAC prompt will appear.
            </DialogContentText>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingAction(null)}>Cancel</Button>
          <Button onClick={confirmAction} color="warning" variant="contained" disabled={commandBusy}>Run</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

type StepKind = 'safe' | 'destructive' | 'downtime';
type ActionStep = { text: string; kind: StepKind; note: string };

function stepDotColor(kind: StepKind): string {
  if (kind === 'destructive') return 'error.main';
  if (kind === 'downtime') return 'warning.main';
  return 'success.main';
}

function ActionPath(props: { title: string; reclaimsLabel: string; reclaimsDetail: string; steps: ActionStep[]; active: boolean }) {
  const dataLoss = props.steps.some((s) => s.kind === 'destructive');
  const downtime = props.steps.some((s) => s.kind === 'downtime');
  return (
    <Paper variant="outlined" sx={{ p: 2, flex: 1, borderColor: props.active ? 'warning.main' : undefined }}>
      <Stack spacing={1.5}>
        <Box>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5, flexWrap: 'wrap' }}>
            <Typography variant="subtitle2">{props.title}</Typography>
            <Chip size="small" variant="outlined" color={dataLoss ? 'error' : 'success'} label={dataLoss ? 'Deletes Docker data' : 'No data deleted'} />
            {downtime && <Chip size="small" variant="outlined" color="warning" label="Stops running containers" />}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textTransform: 'uppercase', letterSpacing: 0.6 }}>Reclaims</Typography>
          <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.2 }}>{props.reclaimsLabel}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>{props.reclaimsDetail}</Typography>
        </Box>
        <Divider />
        <Stack spacing={1}>
          {props.steps.map((step) => (
            <Stack direction="row" spacing={1.25} alignItems="flex-start" key={step.text}>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: stepDotColor(step.kind), flexShrink: 0, mt: '7px' }} />
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="body2">{step.text}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{step.note}</Typography>
              </Box>
            </Stack>
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
}

function CleanupAction(props: { title: string; detail: string; dataRisk: StepKind; runtimeRisk: StepKind; impact: string; running: boolean; disabled?: boolean; onClick: () => void; disabledReason?: string }) {
  const destructive = props.dataRisk === 'destructive';
  const stopsContainers = props.runtimeRisk === 'downtime';
  const disabled = Boolean(props.disabled || props.disabledReason);
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderColor: destructive ? 'error.light' : stopsContainers ? 'warning.light' : undefined, opacity: disabled ? 0.7 : 1 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5, flexWrap: 'wrap' }}>
            <Typography variant="subtitle1">{props.title}</Typography>
            <Chip size="small" variant="outlined" color={destructive ? 'error' : 'success'} label={destructive ? 'Deletes Docker data' : 'No data deleted'} />
            <Chip size="small" variant="outlined" color={stopsContainers ? 'warning' : 'success'} label={stopsContainers ? 'Stops running containers' : 'Running containers unaffected'} />
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{props.detail}</Typography>
          <Typography variant="body2" color={destructive ? 'error.main' : 'text.secondary'} sx={{ mt: 0.5 }}>{props.impact}</Typography>
          {props.disabledReason && (
            <Typography variant="body2" color="warning.main" sx={{ mt: 0.5, fontWeight: 600 }}>{props.disabledReason}</Typography>
          )}
        </Box>
        <Tooltip title={props.disabledReason ?? ''} disableHoverListener={!props.disabledReason}>
          <span>
            <Button variant={destructive ? 'outlined' : 'contained'} color={destructive ? 'error' : stopsContainers ? 'warning' : 'success'} disabled={props.running || disabled} onClick={props.onClick}>
              {props.running ? <CircularProgress size={18} sx={{ mr: 1 }} /> : null}
              Run
            </Button>
          </span>
        </Tooltip>
      </Stack>
    </Paper>
  );
}
