/**
 * types.ts — Type definitions for the task management system.
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskExecutionStats {
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export function isTaskExecutionStats(value: unknown): value is TaskExecutionStats {
  if (!value || typeof value !== "object") return false;
  const stats = value as Record<string, unknown>;
  if (typeof stats.startedAt !== "number" || !Number.isFinite(stats.startedAt)) return false;
  for (const key of ["completedAt", "durationMs", "inputTokens", "outputTokens"] as const) {
    if (stats[key] !== undefined && (typeof stats[key] !== "number" || !Number.isFinite(stats[key]))) {
      return false;
    }
  }
  return true;
}

export function isCompletedTaskExecutionStats(value: unknown): value is Required<TaskExecutionStats> {
  if (!isTaskExecutionStats(value)) return false;
  const stats = value as TaskExecutionStats;
  return [stats.completedAt, stats.durationMs, stats.inputTokens, stats.outputTokens]
    .every((part) => typeof part === "number" && Number.isFinite(part));
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  metadata: Record<string, any> & { executionStats?: TaskExecutionStats };
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

/** Serialized store format on disk. */
export interface TaskStoreData {
  nextId: number;
  tasks: Task[];
}

/** Background process associated with a task. */
export interface BackgroundProcess {
  taskId: string;
  pid: number;
  command?: string;
  output: string[];
  status: "running" | "completed" | "error" | "stopped";
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
  proc: import("node:child_process").ChildProcess;
  abortController: AbortController;
  waiters: Array<() => void>;
}
