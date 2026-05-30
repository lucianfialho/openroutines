/**
 * Execution Analyzer
 *
 * Analyzes execution spans and applies auto-tags, detects patterns,
 * and generates insights for optimization.
 */

import type { ExecutionRecord, ExecutionSpan } from "../persistence/types.js";

export interface ExecutionAnalysis {
  autoTags: string[];
  insights: string[];
  riskLevel: "low" | "medium" | "high";
  durationMs?: number;
  tokenEfficiency?: number;
}

export const analyzeExecution = (
  execution: ExecutionRecord,
  spans: ExecutionSpan[]
): ExecutionAnalysis => {
  const autoTags: string[] = [];
  const insights: string[] = [];
  let riskLevel: "low" | "medium" | "high" = "low";

  const durationMs = execution.finishedAt && execution.startedAt
    ? execution.finishedAt.getTime() - execution.startedAt.getTime()
    : undefined;

  // Tag: gate-blocked
  const gateBlocked = spans.some(
    (s) => s.type === "gate_check" && s.output && (s.output as Record<string, unknown>).approved === false
  );
  if (gateBlocked) {
    autoTags.push("gate-blocked");
    insights.push("Execution was blocked by a quality gate — review approval criteria");
  }

  // Tag: tool-failure
  const failedTools = spans.filter(
    (s) => s.type === "tool_call" && s.status === "failed"
  );
  if (failedTools.length > 0) {
    autoTags.push("tool-failure");
    const toolNames = failedTools.map((t) => t.name).join(", ");
    insights.push(`Tool(s) failed: ${toolNames} — check connector configuration or permissions`);
    riskLevel = "high";
  }

  // Tag: high-tokens
  if (execution.totalTokens && execution.totalTokens > 4000) {
    autoTags.push("high-tokens");
    insights.push(`High token usage (${execution.totalTokens}) — consider simplifying the skill or breaking into smaller steps`);
    if (riskLevel === "low") riskLevel = "medium";
  }

  // Tag: slow
  if (durationMs && durationMs > 30000) {
    autoTags.push("slow");
    insights.push(`Slow execution (${(durationMs / 1000).toFixed(1)}s) — consider optimizing tool calls or reducing iterations`);
    if (riskLevel === "low") riskLevel = "medium";
  }

  // Tag: empty-output
  if (!execution.output || execution.output.trim().length < 50) {
    autoTags.push("empty-output");
    insights.push("Output is very short — the LLM may not have had enough context or the skill needs clarification");
  }

  // Tag: many-iterations
  const llmCalls = spans.filter((s) => s.type === "llm_call").length;
  if (llmCalls > 3) {
    autoTags.push("many-iterations");
    insights.push(`Many ReAct iterations (${llmCalls}) — the LLM may be struggling. Consider improving the skill instructions`);
    if (riskLevel === "low") riskLevel = "medium";
  }

  // Tag: golden-path (good execution)
  if (
    execution.status === "completed" &&
    !gateBlocked &&
    failedTools.length === 0 &&
    (!durationMs || durationMs < 15000) &&
    (!execution.totalTokens || execution.totalTokens < 3000) &&
    llmCalls <= 2
  ) {
    autoTags.push("golden-path");
    insights.push("Clean execution — consider using this as a reference for the skill");
  }

  // Tag: provider-error
  const providerError = spans.some(
    (s) => s.type === "llm_call" && s.error
  );
  if (providerError) {
    autoTags.push("provider-error");
    insights.push("Provider (LLM) returned an error — check API key, quota, or model availability");
    riskLevel = "high";
  }

  // Token efficiency
  const tokenEfficiency = execution.totalTokens && durationMs
    ? Math.round(execution.totalTokens / (durationMs / 1000))
    : undefined;

  return {
    autoTags,
    insights,
    riskLevel,
    durationMs,
    tokenEfficiency,
  };
};

export interface AggregatedMetrics {
  totalExecutions: number;
  completed: number;
  failed: number;
  paused: number;
  successRate: number;
  averageDurationMs: number;
  averageTokens: number;
  totalTokens: number;
  mostUsedRoutine?: string;
  mostFailingTool?: string;
  mostRejectedGate?: string;
  topAutoTags: Array<{ tag: string; count: number }>;
  routines: Array<{
    routineId: string;
    count: number;
    successRate: number;
    avgTokens: number;
    avgDurationMs: number;
  }>;
  tools: Array<{
    name: string;
    calls: number;
    failures: number;
    avgDurationMs: number;
  }>;
}

export const aggregateMetrics = (
  executions: ExecutionRecord[],
  spans: ExecutionSpan[]
): AggregatedMetrics => {
  const totalExecutions = executions.length;
  const completed = executions.filter((e) => e.status === "completed").length;
  const failed = executions.filter((e) => e.status === "failed").length;
  const paused = executions.filter((e) => e.status === "paused").length;

  const completedExecutions = executions.filter((e) => e.finishedAt && e.startedAt);
  const averageDurationMs = completedExecutions.length
    ? completedExecutions.reduce((sum, e) => sum + (e.finishedAt!.getTime() - e.startedAt.getTime()), 0) / completedExecutions.length
    : 0;

  const totalTokens = executions.reduce((sum, e) => sum + (e.totalTokens || 0), 0);
  const averageTokens = totalExecutions ? totalTokens / totalExecutions : 0;

  // Most used routine
  const routineCounts: Record<string, number> = {};
  executions.forEach((e) => {
    routineCounts[e.routineId] = (routineCounts[e.routineId] || 0) + 1;
  });
  const mostUsedRoutine = Object.entries(routineCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0];

  // Tool stats
  const toolStats: Record<string, { calls: number; failures: number; totalDuration: number }> = {};
  spans.filter((s) => s.type === "tool_call").forEach((s) => {
    const name = s.name || "unknown";
    if (!toolStats[name]) toolStats[name] = { calls: 0, failures: 0, totalDuration: 0 };
    toolStats[name].calls++;
    if (s.status === "failed") toolStats[name].failures++;
    if (s.durationMs) toolStats[name].totalDuration += s.durationMs;
  });

  const tools = Object.entries(toolStats).map(([name, stats]) => ({
    name,
    calls: stats.calls,
    failures: stats.failures,
    avgDurationMs: stats.calls ? Math.round(stats.totalDuration / stats.calls) : 0,
  }));

  const mostFailingTool = tools
    .filter((t) => t.failures > 0)
    .sort((a, b) => b.failures - a.failures)[0]?.name;

  // Gate stats
  const gateSpans = spans.filter((s) => s.type === "gate_check");
  const gateRejects: Record<string, number> = {};
  gateSpans.forEach((s) => {
    const output = s.output as Record<string, unknown> | undefined;
    if (output && output.approved === false) {
      gateRejects[s.name || "unknown"] = (gateRejects[s.name || "unknown"] || 0) + 1;
    }
  });
  const mostRejectedGate = Object.entries(gateRejects)
    .sort((a, b) => b[1] - a[1])[0]?.[0];

  // Auto-tags
  const allTags: Record<string, number> = {};
  executions.forEach((e) => {
    const tags = (e.metadata?.autoTags as string[]) || [];
    tags.forEach((tag) => {
      allTags[tag] = (allTags[tag] || 0) + 1;
    });
  });

  // Per-routine metrics
  const routineMetrics: Record<string, { count: number; completed: number; totalTokens: number; totalDuration: number }> = {};
  executions.forEach((e) => {
    if (!routineMetrics[e.routineId]) {
      routineMetrics[e.routineId] = { count: 0, completed: 0, totalTokens: 0, totalDuration: 0 };
    }
    routineMetrics[e.routineId].count++;
    if (e.status === "completed") routineMetrics[e.routineId].completed++;
    routineMetrics[e.routineId].totalTokens += e.totalTokens || 0;
    if (e.finishedAt) {
      routineMetrics[e.routineId].totalDuration += e.finishedAt.getTime() - e.startedAt.getTime();
    }
  });

  const routines = Object.entries(routineMetrics).map(([routineId, m]) => ({
    routineId,
    count: m.count,
    successRate: Math.round((m.completed / m.count) * 100),
    avgTokens: Math.round(m.totalTokens / m.count),
    avgDurationMs: Math.round(m.totalDuration / m.count),
  }));

  return {
    totalExecutions,
    completed,
    failed,
    paused,
    successRate: totalExecutions ? Math.round((completed / totalExecutions) * 100) : 0,
    averageDurationMs: Math.round(averageDurationMs),
    averageTokens: Math.round(averageTokens),
    totalTokens,
    mostUsedRoutine,
    mostFailingTool,
    mostRejectedGate,
    topAutoTags: Object.entries(allTags)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    routines,
    tools,
  };
};
