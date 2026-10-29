import { describe, it, expect, vi } from "vitest";
import { invokeCreateIfAbsentTool } from "../../src/utils/create-if-absent-tool.js";
const params = {
  relativePath: { type: "string", required: true },
  content: { type: "string", required: true },
};
describe("W06 safe creation wrapper", () => {
  it.each([
    "extra",
    "missing",
    "number",
    "null",
    "array",
    "getter",
    "symbol",
    "hidden",
    "prototype",
    "over-budget",
  ])("rejects %s without create entry", async (kind) => {
    let args: any = { relativePath: "file", content: "" };
    if (kind === "extra") args.root = "/elsewhere";
    if (kind === "missing") delete args.content;
    if (kind === "number") args.content = 0;
    if (kind === "null") args = null;
    if (kind === "array") args = [];
    if (kind === "getter")
      Object.defineProperty(args, "content", {
        enumerable: true,
        get() {
          throw Error("private");
        },
      });
    if (kind === "symbol") args[Symbol()] = 1;
    if (kind === "hidden") Object.defineProperty(args, "secret", { value: 1 });
    if (kind === "prototype") Object.setPrototypeOf(args, { inherited: true });
    if (kind === "over-budget") args.content = "x".repeat(131072);
    const create = vi.fn();
    expect(await invokeCreateIfAbsentTool(params, args, create)).toMatchObject({
      phase: "not-entered",
      outcome: { status: "rejected", code: "E_INVALID_ARGS" },
    });
    expect(create).not.toHaveBeenCalled();
  });
  it.each(["throw", "reject"])(
    "keeps entered %s as fixed unknown without arbitrary error formatting",
    async (kind) => {
      let reads = 0;
      const error = {
        get message() {
          reads++;
          throw Error("private");
        },
        toString() {
          reads++;
          throw Error("private");
        },
      };
      const handler = () => {
        if (kind === "throw") throw error;
        return Promise.reject(error);
      };
      expect(
        await invokeCreateIfAbsentTool(
          params,
          { relativePath: "file", content: "" },
          handler,
        ),
      ).toEqual({
        phase: "entered-returned",
        outcome: {
          status: "unknown",
          code: "RESOURCE_OUTCOME_UNKNOWN",
          message: "Creation outcome could not be established",
        },
      });
      expect(reads).toBe(0);
    },
  );
  it("checks approximate as well as canonical string input boundaries", async () => {
    const create = vi.fn(async () => ({
      status: "succeeded" as const,
      value: null,
    }));
    const n = 128 * 1024 - 34;
    expect(
      (
        await invokeCreateIfAbsentTool(
          params,
          { relativePath: "f", content: "x".repeat(n) },
          create,
        )
      ).phase,
    ).toBe("entered-returned");
    expect(
      (
        await invokeCreateIfAbsentTool(
          params,
          { relativePath: "f", content: "x".repeat(n + 1) },
          create,
        )
      ).phase,
    ).toBe("not-entered");
    expect(create).toHaveBeenCalledOnce();
  });
  it("passes exact string values and business partial/unknown results unchanged", async () => {
    for (const outcome of [
      {
        status: "failed" as const,
        code: "WRITE",
        message: "Partial",
        effects: "partial" as const,
      },
      { status: "unknown" as const, code: "UNKNOWN", message: "Unknown" },
    ]) {
      const args = { relativePath: "sub/file", content: "文本😀" };
      const create = vi.fn(async (value) => {
        expect(value).toBe(args);
        return outcome;
      });
      expect(await invokeCreateIfAbsentTool(params, args, create)).toEqual({
        phase: "entered-returned",
        outcome,
      });
    }
  });
});
