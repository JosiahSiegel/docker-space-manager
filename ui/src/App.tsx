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
  FormControlLabel,
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
  TextField,
  Tooltip,
  Typography,
  Switch,
} from '@mui/material';
import { createDockerDesktopClient } from '@docker/extension-api-client';

const client = createDockerDesktopClient();
const useDD = () => client;

type UsageEntry = { Type: string; Total: string; Active: string; Size: string; Reclaimable: string };
type UsageResponse = { summary: UsageEntry[]; verboseRaw?: string; collectedAt: string; warning?: string };
type ContainerRow = { id: string; image: string; names: string; state: string; status: string; size: string };
type Hotspot = { path: string; bytes: number };
type VhdxEntry = { path: string; bytes: number; fileSize?: number; minimumSize?: number; usedBytes?: number };
type HostStatus = { admin: boolean; vhdx: VhdxEntry[] };
type CompactResultRow = { path: string; before: number; after: number; reclaimed: number };
type CompactSummary = { totalReclaimed: number; preTotal: number; postTotal: number; rows: CompactResultRow[]; at: string };
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

const DONUT_RECLAIM_COLOR = '#ed6c02';
const DONUT_COMPACT_COLOR = '#2e7d32';
const DONUT_USED_COLOR = '#cfd8dc';
const COMPACT_NOTIFY_ENABLED_KEY = 'dsm.compactNotifyEnabled';
const COMPACT_NOTIFY_THRESHOLD_GB_KEY = 'dsm.compactNotifyThresholdGb';
const COMPACT_NOTIFY_LAST_AT_KEY = 'dsm.compactNotifyLastAt';
const COMPACT_NOTIFY_LAST_SESSION_KEY = 'dsm.compactNotifyLastSession';
const DEFAULT_COMPACT_NOTIFY_THRESHOLD_GB = 20;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function compositeDonutGradient(
  totalBytes: number,
  reclaimableBytes: number,
  compactableBytes: number,
  estimateUnavailable: boolean,
): string {
  if (totalBytes <= 0) return DONUT_USED_COLOR;
  const reclaimPct = Math.max(0, Math.min(100, (reclaimableBytes / totalBytes) * 100));
  const compactPct = Math.max(0, Math.min(100 - reclaimPct, (compactableBytes / totalBytes) * 100));
  if (reclaimPct <= 0 && compactPct <= 0) {
    if (estimateUnavailable) {
      return 'repeating-conic-gradient(#cfd8dc 0deg 6deg, #eceff1 6deg 12deg)';
    }
    return DONUT_USED_COLOR;
  }
  const usedStart = reclaimPct + compactPct;
  const parts: string[] = [];
  if (reclaimPct > 0) parts.push(`${DONUT_RECLAIM_COLOR} 0 ${reclaimPct}%`);
  if (compactPct > 0) parts.push(`${DONUT_COMPACT_COLOR} ${reclaimPct}% ${usedStart}%`);
  parts.push(`${DONUT_USED_COLOR} ${usedStart}% 100%`);
  return `conic-gradient(${parts.join(', ')})`;
}

function compactSavingsGradient(preTotalBytes: number, reclaimedBytes: number): string {
  if (preTotalBytes <= 0 || reclaimedBytes <= 0) return 'transparent';
  const pct = Math.min(100, (reclaimedBytes / preTotalBytes) * 100);
  return `conic-gradient(rgba(46,125,50,0.85) 0 ${pct}%, transparent ${pct}% 100%)`;
}

type CompactableSource = 'vhd' | 'engine' | 'mixed' | 'none';

function compactableEstimate(vhdx: VhdxEntry[]): { bytes: number; partial: boolean; complete: boolean; source: CompactableSource } {
  let bytes = 0;
  let reported = 0;
  let usedVhd = false;
  let usedEngine = false;
  for (const v of vhdx) {
    let reclaimable: number | null = null;
    if (v.fileSize != null && v.minimumSize != null) {
      reclaimable = Number(v.fileSize) - Number(v.minimumSize);
      usedVhd = true;
    } else if (v.usedBytes != null) {
      reclaimable = Number(v.bytes) - Number(v.usedBytes);
      usedEngine = true;
    } else {
      continue;
    }
    reported++;
    if (!Number.isFinite(reclaimable) || reclaimable <= 0) continue;
    bytes += reclaimable;
  }
  const source: CompactableSource = usedVhd && usedEngine ? 'mixed' : usedVhd ? 'vhd' : usedEngine ? 'engine' : 'none';
  return { bytes, partial: reported > 0 && reported < vhdx.length, complete: vhdx.length > 0 && reported === vhdx.length, source };
}

function compactableSourceLabel(source: CompactableSource): string {
  if (source === 'vhd') return 'From Hyper-V VHDX minimum size.';
  if (source === 'engine') return 'Estimated from Docker engine filesystem usage.';
  if (source === 'mixed') return 'Mix of Hyper-V VHDX minimum size and Docker engine filesystem usage.';
  return 'Unavailable until Windows can read VHDX minimum size or Docker can report engine filesystem usage.';
}

function parseCompactResult(out: string): CompactResultRow[] | null {
  const trimmed = out.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((r) => r && typeof r.path === 'string')
      .map((r) => ({
        path: String(r.path),
        before: Number(r.before) || 0,
        after: Number(r.after) || 0,
        reclaimed: Number(r.reclaimed) || 0,
      }));
  } catch {
    return null;
  }
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
  const [lastCompactSummary, setLastCompactSummary] = React.useState<CompactSummary | null>(null);
  const [compactNotifyEnabled, setCompactNotifyEnabled] = React.useState(() => localStorage.getItem(COMPACT_NOTIFY_ENABLED_KEY) === 'true');
  const [compactNotifyThresholdGb, setCompactNotifyThresholdGb] = React.useState(() => {
    const saved = Number(localStorage.getItem(COMPACT_NOTIFY_THRESHOLD_GB_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_COMPACT_NOTIFY_THRESHOLD_GB;
  });
  const [notificationPermission, setNotificationPermission] = React.useState(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission));
  const [compactNotifyThresholdEditing, setCompactNotifyThresholdEditing] = React.useState(false);
  const [sessionStartedAt, setSessionStartedAt] = React.useState<string | null>(null);
  const [nowTick, setNowTick] = React.useState(() => Date.now());
  const compactNotificationsRef = React.useRef<Notification[]>([]);

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
    void Promise.all([refreshPlatform(), refreshHostStatus(), refreshUsage(), refreshContainers()]);
  }, [refreshPlatform, refreshHostStatus, refreshUsage, refreshContainers]);

  React.useEffect(() => {
    (async () => {
      try {
        const r = (await dd.extension.vm?.service?.get('/session')) as { startedAt?: string };
        if (r?.startedAt) setSessionStartedAt(r.startedAt);
      } catch {
        // Backend may not yet expose /session on older builds; fall back to leaving null.
      }
    })();
  }, [dd]);

  // Re-evaluate the notification gate hourly so a Docker Desktop session that
  // stays open for many days still fires once a day without a tab reopen.
  React.useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 60 * 60 * 1000);
    return () => window.clearInterval(id);
  }, []);

  React.useEffect(() => {
    localStorage.setItem(COMPACT_NOTIFY_ENABLED_KEY, compactNotifyEnabled ? 'true' : 'false');
  }, [compactNotifyEnabled]);

  React.useEffect(() => {
    localStorage.setItem(COMPACT_NOTIFY_THRESHOLD_GB_KEY, String(compactNotifyThresholdGb));
  }, [compactNotifyThresholdGb]);

  React.useEffect(() => {
    if (!compactNotifyThresholdEditing) return;
    const timeout = window.setTimeout(() => setCompactNotifyThresholdEditing(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [compactNotifyThresholdEditing, compactNotifyThresholdGb]);

  const openExtensionFromNotification = () => {
    window.focus();
    setTab(0);
  };

  const enableCompactNotifications = async (checked: boolean) => {
    if (!checked) {
      setCompactNotifyEnabled(false);
      return;
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      setCompactNotifyEnabled(permission === 'granted');
      if (permission !== 'granted') {
        dd.desktopUI?.toast?.warning?.('Notifications were not enabled. Allow notifications to get compact reminders.');
      }
      return;
    }
    if (typeof Notification !== 'undefined') setNotificationPermission(Notification.permission);
    setCompactNotifyEnabled(true);
  };

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
    setLastCompactSummary(null);
    const preSnapshot = new Map((hostStatus?.vhdx ?? []).map((v) => [v.path, v.bytes]));
    try {
      await dd.extension.host?.cli.exec('dsm-host.cmd', ['compact']);
      try {
        const r = await dd.extension.host?.cli.exec('dsm-host.cmd', ['result']);
        const rows = parseCompactResult(r?.stdout ?? '');
        if (rows && rows.length) {
          const preTotal = rows.reduce((s, row) => s + (preSnapshot.get(row.path) ?? row.before ?? 0), 0);
          const postTotal = rows.reduce((s, row) => s + (row.after ?? 0), 0);
          const totalReclaimed = rows.reduce((s, row) => s + (row.reclaimed ?? 0), 0);
          setLastCompactSummary({ rows, preTotal, postTotal, totalReclaimed, at: new Date().toISOString() });
          setLastResult(`Compaction reclaimed ${fmtBytes(totalReclaimed)} across ${rows.length} disk${rows.length === 1 ? '' : 's'}.`);
        } else {
          setLastResult('Compaction launched. Docker Desktop will shut down and reload after restart.');
        }
      } catch {
        setLastResult('Compaction launched. Docker Desktop will shut down and reload after restart.');
      }
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
  const compactable = compactableEstimate(vhdx);
  const compactNotifyThresholdBytes = compactNotifyThresholdGb * 1024 ** 3;

  React.useEffect(() => {
    if (compactNotifyThresholdEditing) return;
    if (!compactNotifyEnabled || compactNotifyThresholdBytes <= 0) return;
    if (compactable.bytes < compactNotifyThresholdBytes) return;
    if (!sessionStartedAt) return;

    const lastAt = Number(localStorage.getItem(COMPACT_NOTIFY_LAST_AT_KEY)) || 0;
    const lastSession = localStorage.getItem(COMPACT_NOTIFY_LAST_SESSION_KEY) ?? '';
    const sessionChanged = lastSession !== sessionStartedAt;
    const dayElapsed = Date.now() - lastAt > ONE_DAY_MS;
    if (!sessionChanged && !dayElapsed) return;

    const message = `${fmtBytes(compactable.bytes)} can likely be reclaimed. Open Docker Desktop → Extensions → Space Manager and click Compact.`;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const notification = new Notification('Space Manager', { body: message });
      compactNotificationsRef.current.push(notification);
      notification.onclick = () => {
        openExtensionFromNotification();
        notification.close();
      };
      notification.onclose = () => {
        compactNotificationsRef.current = compactNotificationsRef.current.filter((n) => n !== notification);
      };
    } else {
      dd.desktopUI?.toast?.warning?.(message);
    }
    localStorage.setItem(COMPACT_NOTIFY_LAST_AT_KEY, String(Date.now()));
    localStorage.setItem(COMPACT_NOTIFY_LAST_SESSION_KEY, sessionStartedAt);
  }, [compactNotifyThresholdEditing, compactNotifyEnabled, compactNotifyThresholdBytes, compactable.bytes, sessionStartedAt, nowTick, dd]);

  return (
    <Box sx={{ py: 1 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="h6">Virtual Disk Reclaimer</Typography>
        <Button size="small" onClick={() => { refreshHostStatus(); refreshUsage(); refreshContainers(); }}>Refresh</Button>
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
              <Box sx={{ position: 'relative', width: 200, height: 200, flexShrink: 0 }}>
                <Box
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: '50%',
                    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.08)',
                    zIndex: 0,
                  }}
                  style={{
                    background: vhdx.length
                      ? compositeDonutGradient(totalVhdxBytes, reclaimableBytes, compactable.bytes, reclaimEstimateUnavailable)
                      : DONUT_USED_COLOR,
                  }}
                />
                {lastCompactSummary && lastCompactSummary.totalReclaimed > 0 && (
                  <Box
                    sx={{ position: 'absolute', inset: 0, borderRadius: '50%', pointerEvents: 'none', zIndex: 1 }}
                    style={{ background: compactSavingsGradient(lastCompactSummary.preTotal, lastCompactSummary.totalReclaimed) }}
                  />
                )}
                <Box sx={{ position: 'absolute', inset: 36, borderRadius: '50%', bgcolor: 'background.paper', display: 'grid', placeItems: 'center', textAlign: 'center', p: 1, zIndex: 4 }}>
                  <Box>
                    <Typography variant="caption" color="text.secondary">VHDX total</Typography>
                    <Typography variant="h4" sx={{ lineHeight: 1.1 }}>{fmtBytes(totalVhdxBytes)}</Typography>
                    {lastCompactSummary && lastCompactSummary.totalReclaimed > 0 ? (
                      <Typography variant="caption" color="success.main" sx={{ fontWeight: 600, display: 'block', mt: 0.25 }}>
                        −{fmtBytes(lastCompactSummary.totalReclaimed)} reclaimed
                      </Typography>
                    ) : compactable.bytes > 0 ? (
                      <Tooltip title={`${compactableSourceLabel(compactable.source)}${compactable.partial ? ' Some disks omitted.' : ''}`}>
                        <Typography variant="caption" color="success.main" sx={{ fontWeight: 600, display: 'block', mt: 0.25 }}>
                          ~{fmtBytes(compactable.bytes)} compactable
                        </Typography>
                      </Tooltip>
                    ) : reclaimEstimateUnavailable ? (
                      <Typography variant="caption" color="warning.main" sx={{ fontWeight: 600, display: 'block', mt: 0.25 }}>estimate unavailable</Typography>
                    ) : null}
                  </Box>
                </Box>
              </Box>

              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  {biggestVhdx
                    ? `${vhdx.length} virtual disk${vhdx.length === 1 ? '' : 's'} · largest ${shortName(biggestVhdx.path)} at ${fmtBytes(biggestVhdx.bytes)}`
                    : 'No Docker Desktop WSL2 virtual disks found.'}
                </Typography>

                <Stack direction="row" spacing={4} sx={{ mb: 2.5, flexWrap: 'wrap', rowGap: 1.5 }}>
                  <Box>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: DONUT_USED_COLOR, border: '1px solid rgba(0,0,0,0.12)' }} />
                      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>Size on disk</Typography>
                    </Stack>
                    <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.2 }}>{fmtBytes(totalVhdxBytes)}</Typography>
                  </Box>
                  <Tooltip title="Waste Docker has identified inside the VHDX. Reclaim space frees it so compaction can shrink the file further.">
                    <Box>
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: DONUT_RECLAIM_COLOR }} />
                        <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>Docker reclaimable</Typography>
                      </Stack>
                      <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.2 }}>{usage ? fmtBytes(reclaimableBytes) : '—'}</Typography>
                    </Box>
                  </Tooltip>
                  <Tooltip title={compactable.bytes > 0 ? `${compactableSourceLabel(compactable.source)}${compactable.partial ? ' Some disks omitted.' : ''} Actual compaction may differ.` : compactableSourceLabel('none')}>
                    <Box>
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: compactable.bytes > 0 ? DONUT_COMPACT_COLOR : 'rgba(0,0,0,0.16)' }} />
                        <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>Compactable est.</Typography>
                      </Stack>
                      <Typography variant="h6" color={compactable.bytes > 0 ? 'success.main' : 'text.secondary'} sx={{ fontWeight: 600, lineHeight: 1.2 }}>{compactable.bytes > 0 ? fmtBytes(compactable.bytes) : '—'}</Typography>
                    </Box>
                  </Tooltip>
                </Stack>

                <Paper variant="outlined" sx={{ p: 1.5, mb: 2, bgcolor: 'rgba(46,125,50,0.04)', borderColor: 'rgba(46,125,50,0.22)' }}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'flex-start', sm: 'center' }} justifyContent="space-between">
                    <FormControlLabel
                      control={<Switch color="success" checked={compactNotifyEnabled} onChange={(_, checked) => void enableCompactNotifications(checked)} />}
                      label="Notify me when compactable space is high"
                    />
                    <TextField
                      size="small"
                      type="number"
                      label="Threshold"
                      value={compactNotifyThresholdGb}
                      onChange={(e) => {
                        setCompactNotifyThresholdEditing(true);
                        const next = Number(e.target.value);
                        if (Number.isFinite(next) && next > 0) setCompactNotifyThresholdGb(next);
                      }}
                      onFocus={() => setCompactNotifyThresholdEditing(true)}
                      onBlur={() => setCompactNotifyThresholdEditing(false)}
                      disabled={!compactNotifyEnabled}
                      inputProps={{ min: 1, step: 1 }}
                      InputProps={{ endAdornment: <Typography variant="caption" color="text.secondary">GB</Typography> }}
                      sx={{ width: 150 }}
                    />
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                    Notifies you once per Docker Desktop session (and at most once a day) when the compactable estimate reaches {fmtBytes(compactNotifyThresholdBytes)}.
                    {notificationPermission === 'denied' ? ' Browser notifications are blocked, so Docker Desktop toasts will be used instead.' : ''}
                  </Typography>
                </Paper>

                <Stack spacing={1.25}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" rowGap={0.75}>
                    <Button sx={{ minWidth: 160 }} variant="contained" color="warning" disabled={!vhdx.length || commandBusy} onClick={() => setPendingAction({ kind: 'magic' })}>
                      {running === 'magic' ? <CircularProgress size={16} sx={{ mr: 1 }} /> : null}
                      Reclaim space
                    </Button>
                    <Chip size="small" variant="outlined" color="error" label="Deletes stopped containers" />
                    <Chip size="small" variant="outlined" color="warning" label="Clears build cache" />
                    <Chip size="small" variant="outlined" label="Pauses Docker briefly" />
                  </Stack>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" rowGap={0.75}>
                    <Button sx={{ minWidth: 160 }} variant="contained" color="success" disabled={!vhdx.length || commandBusy} onClick={() => setPendingAction({ kind: 'compact' })}>
                      {running === 'compact' ? <CircularProgress size={16} sx={{ mr: 1 }} /> : null}
                      Compact only
                    </Button>
                    <Chip size="small" variant="outlined" color="success" label="No data deleted" />
                    <Chip size="small" variant="outlined" label="Pauses Docker briefly" />
                  </Stack>
                </Stack>
              </Box>
            </Stack>
          </Paper>

          {sortedVhdx.length > 1 && (
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Largest disks</Typography>
              <Stack spacing={1}>
                {sortedVhdx.slice(0, 4).map((v) => (
                  <Box key={v.path}>
                    <Stack direction="row" justifyContent="space-between" spacing={2}>
                      <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName(v.path)}</Typography>
                      <Typography variant="body2">{fmtBytes(v.bytes)}</Typography>
                    </Stack>
                    <LinearProgress variant="determinate" value={totalVhdxBytes ? (v.bytes / totalVhdxBytes) * 100 : 0} sx={{ height: 6, borderRadius: 3 }} />
                  </Box>
                ))}
              </Stack>
            </Paper>
          )}
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
              The orange action removes stopped containers and build cache first, then briefly pauses Docker for compaction. The green action skips cleanup and only compacts.
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
