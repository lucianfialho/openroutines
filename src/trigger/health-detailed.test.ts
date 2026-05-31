import { describe, it, expect } from "vitest";
import handler from "../../api/health/detailed";
import type { VercelRequest, VercelResponse } from "@vercel/node";

describe("GET /health/detailed", () => {
  it("returns status ok and memory usage", () => {
    const req = {} as VercelRequest;
    const jsonMock = vi.fn();
    const statusMock = vi.fn(() => ({ json: jsonMock }));
    const res = { status: statusMock } as unknown as VercelResponse;

    handler(req, res);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        memory: expect.any(Object),
      })
    );
  });
});
