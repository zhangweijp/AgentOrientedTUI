import { describe, it, expect, vi } from "vitest";
import { invokeOrdinaryTool } from "../../src/utils/ordinary-tool.js";
describe("safe empty ordinary wrapper", () => {
  it.each([0, 1, 2, 3, 4, 5])(
    "rejects invalid arguments case %s",
    async (index) => {
      const args = [
        null,
        [],
        { extra: 1 },
        Object.defineProperty({}, "hidden", { value: 1 }),
        {
          get x() {
            throw Error("sentinel");
          },
        },
        Object.assign({}, { [Symbol()]: 1 }),
      ][index];
      const h = vi.fn();
      expect(await invokeOrdinaryTool({}, args, h)).toMatchObject({
        phase: "not-entered",
        result: { error: { code: "E_INVALID_ARGS" } },
      });
      expect(h).not.toHaveBeenCalled();
    },
  );
  it("refuses nonempty committed params", async () => {
    const h = vi.fn();
    expect((await invokeOrdinaryTool({ extra: {} }, {}, h)).phase).toBe(
      "not-entered",
    );
    expect(h).not.toHaveBeenCalled();
  });
  it("keeps the same code at different phases and preserves null-prototype empty args", async () => {
    const result = {
      success: false,
      error: { code: "E_INVALID_ARGS", message: "" },
      data: { zero: 0 },
    };
    expect(
      await invokeOrdinaryTool({}, Object.create(null), () => result),
    ).toEqual({ phase: "entered-returned", result });
  });
  it.each(["throw", "reject"])(
    "captures entered %s without reading arbitrary exceptions",
    async (kind) => {
      let reads = 0;
      const sentinel = {
        get message() {
          reads++;
          throw Error("private");
        },
        toString() {
          reads++;
          throw Error("private");
        },
      };
      const h = () => {
        if (kind === "throw") throw sentinel;
        return Promise.reject(sentinel);
      };
      expect(await invokeOrdinaryTool({}, {}, h)).toEqual({
        phase: "entered-returned",
        result: {
          success: false,
          error: { code: "E_HANDLER_ERROR", message: "Tool handler failed" },
        },
      });
      expect(reads).toBe(0);
    },
  );
});
