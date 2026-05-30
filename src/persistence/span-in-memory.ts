/**
 * Span Repository — In-Memory
 *
 * For development mode. Stores execution spans in memory.
 */

import type { ExecutionSpan, SpanRepository } from "./types.js";

export const makeInMemorySpanRepository = (): SpanRepository => {
  const spans: ExecutionSpan[] = [];

  const save = async (span: ExecutionSpan): Promise<void> => {
    const idx = spans.findIndex((s) => s.id === span.id);
    if (idx >= 0) {
      spans[idx] = span;
    } else {
      span.id = span.id ?? crypto.randomUUID();
      spans.push(span);
    }
  };

  const findByExecution = async (executionId: string): Promise<ExecutionSpan[]> => {
    return spans
      .filter((s) => s.executionId === executionId)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  };

  const findById = async (id: string): Promise<ExecutionSpan | undefined> => {
    return spans.find((s) => s.id === id);
  };

  return { save, findByExecution, findById };
};
