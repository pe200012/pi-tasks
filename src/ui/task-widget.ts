/**
 * task-widget.ts — Persistent widget showing task list with status icons and progress.
 *
 * Display style matches Claude Code's task list:
 *   ✔ completed tasks (strikethrough + dim)
 *   ◼ in_progress tasks
 *   ◻ pending tasks
 *   ✳/✽ actively executing task (star spinner with activeForm text)
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
import type { TaskStore } from "../task-store.js";
import { isCompletedTaskExecutionStats, isTaskExecutionStats, type Task, type TaskExecutionStats } from "../types.js";

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Star spinner frames for animated active task indicator (matches Claude Code). */
const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];

const MAX_VISIBLE_TASKS = 10;

/** Per-task runtime metrics (elapsed time, token usage). */
export interface TaskMetrics {
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
}

/** Format milliseconds as a human-readable duration (e.g., "2m 49s", "1h 3m"). */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** Format token count with k suffix (e.g., "4.1k", "850"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

/** Format a stable, human-readable clock time with second precision. */
function formatClockTime(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(ms);
}

function formatLiveStats(theme: Theme, metrics: TaskMetrics | undefined): string {
  if (!metrics) return "";

  const elapsed = formatDuration(Date.now() - metrics.startedAt);
  const tokenParts: string[] = [];
  if (metrics.inputTokens > 0) tokenParts.push(`↑ ${formatTokens(metrics.inputTokens)}`);
  if (metrics.outputTokens > 0) tokenParts.push(`↓ ${formatTokens(metrics.outputTokens)}`);

  const statParts = [`started ${formatClockTime(metrics.startedAt)}`, elapsed, ...tokenParts];
  return ` ${theme.fg("dim", `(${statParts.join(" · ")})`)}`;
}

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();
  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();
  /** Cached TUI instance for requestRender() calls. */
  private tui: any | undefined;
  /** Whether the widget callback is currently registered. */
  private widgetRegistered = false;

  constructor(private store: TaskStore) {}

  setStore(store: TaskStore) {
    this.store = store;
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  /** Persist the fact that a task started even before it completes. */
  private persistStartMetrics(taskId: string, startedAt: number, existingStats?: TaskExecutionStats) {
    this.store.update(taskId, {
      metadata: {
        executionStats: {
          ...existingStats,
          startedAt,
          inputTokens: existingStats?.inputTokens ?? 0,
          outputTokens: existingStats?.outputTokens ?? 0,
        },
      },
    });
  }

  /** Infer a reasonable execution window for completed tasks that missed live tracking. */
  private inferCompletedStats(task: Task, metrics?: TaskMetrics): Required<TaskExecutionStats> {
    const existingStats = isTaskExecutionStats(task.metadata?.executionStats)
      ? task.metadata.executionStats
      : undefined;
    if (metrics) {
      const startedAt = existingStats?.startedAt ?? metrics.startedAt;
      const completedAt = existingStats?.completedAt ?? task.updatedAt;
      return {
        startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - startedAt),
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
      };
    }
    if (isCompletedTaskExecutionStats(existingStats)) return existingStats;

    const blockerCompletedAt = task.blockedBy
      .map((id) => this.store.get(id))
      .flatMap((blocker) => {
        if (!blocker || blocker.status !== "completed") return [];
        const blockerStats = isTaskExecutionStats(blocker.metadata?.executionStats)
          ? blocker.metadata.executionStats
          : undefined;
        return [blockerStats?.completedAt ?? blocker.updatedAt];
      });
    const startedAt = Math.max(task.createdAt, ...blockerCompletedAt);
    return {
      startedAt,
      completedAt: task.updatedAt,
      durationMs: Math.max(0, task.updatedAt - startedAt),
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  /** Persist live metrics into task metadata when execution completes. */
  private persistMetrics(taskId: string, task?: Task) {
    const m = this.metrics.get(taskId);
    const existingStats = isTaskExecutionStats(task?.metadata?.executionStats)
      ? task.metadata.executionStats
      : undefined;

    if (task?.status === "completed" && (!isCompletedTaskExecutionStats(existingStats) || m)) {
      this.store.update(taskId, { metadata: { executionStats: this.inferCompletedStats(task, m) } });
    }

    if (m) {
      this.metrics.delete(taskId);
    }
  }

  /** Rebuild timing baselines for persisted in-progress tasks after startup/resume. */
  private syncTrackedTasks(tasks = this.store.list()) {
    for (const task of tasks) {
      if (task.status === "in_progress" && !this.metrics.has(task.id)) {
        const existingStats = isTaskExecutionStats(task.metadata?.executionStats)
          ? task.metadata.executionStats
          : undefined;
        const startedAt = existingStats?.startedAt ?? task.updatedAt;
        this.metrics.set(task.id, {
          startedAt,
          inputTokens: existingStats?.inputTokens ?? 0,
          outputTokens: existingStats?.outputTokens ?? 0,
        });
        if (!existingStats) {
          this.persistStartMetrics(task.id, startedAt);
        }
      }
    }

    for (const [id] of this.metrics) {
      const task = tasks.find(t => t.id === id) ?? this.store.get(id);
      if (!task) {
        this.activeTaskIds.delete(id);
        this.metrics.delete(id);
        continue;
      }
      if (task.status !== "in_progress") {
        this.activeTaskIds.delete(id);
        this.persistMetrics(id, task);
      }
    }

    for (const task of tasks) {
      if (task.status === "completed" && !isCompletedTaskExecutionStats(task.metadata?.executionStats)) {
        this.store.update(task.id, { metadata: { executionStats: this.inferCompletedStats(task) } });
      }
    }
  }

  /** Add or remove a task from the active spinner set. */
  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      const task = this.store.get(taskId);
      const existingStats = isTaskExecutionStats(task?.metadata?.executionStats)
        ? task.metadata.executionStats
        : undefined;
      if (!this.metrics.has(taskId)) {
        const startedAt = existingStats?.startedAt ?? Date.now();
        this.metrics.set(taskId, {
          startedAt,
          inputTokens: existingStats?.inputTokens ?? 0,
          outputTokens: existingStats?.outputTokens ?? 0,
        });
        if (!existingStats) {
          this.persistStartMetrics(taskId, startedAt);
        }
      }
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
      const task = this.store.get(taskId);
      this.persistMetrics(taskId, task);
    }
    this.update();
  }

  /** Record token usage for the currently active task(s). */
  addTokenUsage(inputTokens: number, outputTokens: number) {
    // Distribute to all currently active tasks
    for (const id of this.activeTaskIds) {
      const m = this.metrics.get(id);
      if (m) {
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
      }
    }
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 150);
    }
  }

  /** Build widget lines from current live state. Called from the render callback. */
  private renderWidget(tui: any, theme: Theme): string[] {
    const tasks = this.store.list();
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);

    if (tasks.length === 0) return [];

    const completed = tasks.filter(t => t.status === "completed");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const pending = tasks.filter(t => t.status === "pending");

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
    if (pending.length > 0) parts.push(`${pending.length} open`);
    const statusText = `${tasks.length} tasks (${parts.join(", ")})`;

    const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
    const lines: string[] = [truncate(theme.fg("accent", "●") + " " + theme.fg("accent", statusText))];

    const visible = tasks.slice(0, MAX_VISIBLE_TASKS);
    for (let i = 0; i < visible.length; i++) {
      const task = visible[i];
      const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress";

      let icon: string;
      if (isActive) {
        icon = theme.fg("accent", spinnerChar);
      } else if (task.status === "completed") {
        icon = theme.fg("success", "✔");
      } else if (task.status === "in_progress") {
        icon = theme.fg("accent", "◼");
      } else {
        icon = "◻";
      }

      let suffix = "";
      if (task.status === "pending" && task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = this.store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          suffix = theme.fg("dim", ` › blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }

      let text: string;
      if (isActive) {
        const form = task.activeForm || task.subject;
        const agentId = task.metadata?.agentId;
        const agentLabel = agentId ? ` (agent ${agentId.slice(0, 5)})` : "";
        const stats = formatLiveStats(theme, this.metrics.get(task.id));
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${theme.fg("accent", form + agentLabel + "…")}${stats}`;
      } else if (task.status === "completed") {
        const stats = isCompletedTaskExecutionStats(task.metadata.executionStats)
          ? task.metadata.executionStats
          : undefined;
        const statParts = stats
          ? [
            `started ${formatClockTime(stats.startedAt)}`,
            `ended ${formatClockTime(stats.completedAt)}`,
            formatDuration(stats.durationMs),
            ...(stats.inputTokens > 0 ? [`↑ ${formatTokens(stats.inputTokens)}`] : []),
            ...(stats.outputTokens > 0 ? [`↓ ${formatTokens(stats.outputTokens)}`] : []),
          ]
          : [];
        const statSuffix = statParts.length > 0 ? ` ${theme.fg("dim", `(${statParts.join(" · ")})`)}` : "";
        text = `  ${icon} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}${statSuffix}`;
      } else {
        const agentSuffix = task.status === "in_progress" && task.metadata?.agentId
          ? theme.fg("dim", ` (agent ${task.metadata.agentId.slice(0, 5)})`)
          : "";
        const stats = task.status === "in_progress"
          ? formatLiveStats(theme, this.metrics.get(task.id))
          : "";
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${task.subject}${agentSuffix}${stats}`;
      }

      lines.push(truncate(text + suffix));
    }

    if (tasks.length > MAX_VISIBLE_TASKS) {
      lines.push(truncate(theme.fg("dim", `    … and ${tasks.length - MAX_VISIBLE_TASKS} more`)));
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const tasks = this.store.list();
    this.syncTrackedTasks(tasks);

    // Transition: visible → hidden
    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    // Check if any task needs animation
    const hasActiveSpinner = tasks.some(t => this.activeTaskIds.has(t.id) && t.status === "in_progress");
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else if (!hasActiveSpinner && this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }

    this.widgetFrame++;

    // Transition: hidden → visible — register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("tasks", (tui, theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      // Widget already registered — just request a re-render
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("tasks", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}
