/**
 * Memory monitoring utility for detecting memory leaks
 * 
 * This service helps identify memory leaks by:
 * - Tracking memory usage over time
 * - Taking heap snapshots
 * - Monitoring for increasing memory patterns
 */

import { app } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureException } from './sentry';

interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
}

const memorySnapshots: MemorySnapshot[] = [];
const MAX_SNAPSHOTS = 1000; // Keep last 1000 snapshots
let monitoringInterval: NodeJS.Timeout | null = null;
let isMonitoring = false;

/**
 * Get current memory usage
 */
export function getMemoryUsage(): NodeJS.MemoryUsage {
  return process.memoryUsage();
}

/**
 * Take a memory snapshot
 */
export function takeMemorySnapshot(): MemorySnapshot {
  const usage = getMemoryUsage();
  const snapshot: MemorySnapshot = {
    timestamp: Date.now(),
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    rss: usage.rss,
  };

  memorySnapshots.push(snapshot);

  // Keep only last MAX_SNAPSHOTS
  if (memorySnapshots.length > MAX_SNAPSHOTS) {
    memorySnapshots.shift();
  }

  return snapshot;
}

/**
 * Start continuous memory monitoring
 */
export function startMemoryMonitoring(intervalMs = 60000): void {
  if (isMonitoring) {
    console.warn('[Memory Monitor] Already monitoring');
    return;
  }

  isMonitoring = true;
  console.log('[Memory Monitor] Starting memory monitoring...');

  // Take initial snapshot
  takeMemorySnapshot();

  monitoringInterval = setInterval(() => {
    const snapshot = takeMemorySnapshot();
    const memMB = (snapshot.heapUsed / 1024 / 1024).toFixed(2);
    const rssMB = (snapshot.rss / 1024 / 1024).toFixed(2);
    
    console.log(`[Memory Monitor] Heap: ${memMB}MB | RSS: ${rssMB}MB`);

    // Check for potential memory leak (if memory grew > 50MB in last 10 snapshots)
    if (memorySnapshots.length >= 10) {
      const recent = memorySnapshots.slice(-10);
      const oldest = recent[0]!;
      const newest = recent[recent.length - 1]!;
      const growth = newest.heapUsed - oldest.heapUsed;
      const growthMB = growth / 1024 / 1024;

      if (growthMB > 50) {
        console.warn(
          `[Memory Monitor] ⚠️ Potential memory leak detected! Growth: ${growthMB.toFixed(2)}MB over last 10 checks`
        );
        captureException(new Error('Potential memory leak detected'), {
          memoryGrowth: growthMB,
          currentHeap: newest.heapUsed,
          previousHeap: oldest.heapUsed,
        });
      }
    }
  }, intervalMs);
}

/**
 * Stop memory monitoring
 */
export function stopMemoryMonitoring(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    isMonitoring = false;
    console.log('[Memory Monitor] Stopped monitoring');
  }
}

/**
 * Get memory statistics
 */
export function getMemoryStats(): {
  current: MemorySnapshot;
  snapshots: MemorySnapshot[];
  average: { heapUsed: number; rss: number };
  peak: { heapUsed: number; rss: number; timestamp: number };
  trend: 'increasing' | 'decreasing' | 'stable';
} {
  const current = memorySnapshots[memorySnapshots.length - 1] || takeMemorySnapshot();
  const recent = memorySnapshots.slice(-20); // Last 20 snapshots

  const avgHeap = recent.reduce((sum, s) => sum + s.heapUsed, 0) / recent.length;
  const avgRss = recent.reduce((sum, s) => sum + s.rss, 0) / recent.length;

  const peak = memorySnapshots.reduce(
    (max, s) => (s.heapUsed > max.heapUsed ? s : max),
    memorySnapshots[0] || current
  );

  // Determine trend (compare last 5 vs previous 5)
  let trend: 'increasing' | 'decreasing' | 'stable' = 'stable';
  if (recent.length >= 10) {
    const last5 = recent.slice(-5);
    const prev5 = recent.slice(-10, -5);
    const last5Avg = last5.reduce((sum, s) => sum + s.heapUsed, 0) / 5;
    const prev5Avg = prev5.reduce((sum, s) => sum + s.heapUsed, 0) / 5;
    const diff = last5Avg - prev5Avg;
    const diffMB = diff / 1024 / 1024;

    if (diffMB > 10) trend = 'increasing';
    else if (diffMB < -10) trend = 'decreasing';
  }

  return {
    current,
    snapshots: [...memorySnapshots],
    average: {
      heapUsed: avgHeap,
      rss: avgRss,
    },
    peak: {
      heapUsed: peak.heapUsed,
      rss: peak.rss,
      timestamp: peak.timestamp,
    },
    trend,
  };
}

/**
 * Export memory snapshot to file
 */
export async function exportMemorySnapshot(filename?: string): Promise<string> {
  const stats = getMemoryStats();
  const userDataPath = app.getPath('userData');
  const snapshotFile = filename || `memory-snapshot-${Date.now()}.json`;
  const filePath = join(userDataPath, snapshotFile);

  await writeFile(
    filePath,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        ...stats,
        snapshots: stats.snapshots.map((s) => ({
          ...s,
          heapUsedMB: (s.heapUsed / 1024 / 1024).toFixed(2),
          rssMB: (s.rss / 1024 / 1024).toFixed(2),
          timestamp: new Date(s.timestamp).toISOString(),
        })),
      },
      null,
      2
    ),
    'utf-8'
  );

  console.log(`[Memory Monitor] Snapshot exported to: ${filePath}`);
  return filePath;
}

/**
 * Clear all memory snapshots
 */
export function clearMemorySnapshots(): void {
  memorySnapshots.length = 0;
  console.log('[Memory Monitor] Cleared all snapshots');
}

/**
 * Get memory usage as human-readable string
 */
export function formatMemoryUsage(usage: NodeJS.MemoryUsage = getMemoryUsage()): string {
  return {
    heapUsed: `${(usage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
    heapTotal: `${(usage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
    external: `${(usage.external / 1024 / 1024).toFixed(2)} MB`,
    rss: `${(usage.rss / 1024 / 1024).toFixed(2)} MB`,
  } as any;
}
