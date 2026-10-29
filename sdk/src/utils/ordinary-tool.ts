import type { ViewToolInvocationTerminal } from "@aotui/runtime/spi";
import type { OperationResult } from "../operation/types.js";

/** No property reads, defaults or transforms; captured empty declarations and arguments only. */
export function isEmptyOrdinaryObject(
  value: unknown,
): value is Record<string, never> {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [null, Object.prototype].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === 0
    );
  } catch {
    return false;
  }
}
export async function invokeOrdinaryTool(
  params: unknown,
  args: unknown,
  handler: (
    args: Record<string, unknown>,
  ) => OperationResult | Promise<OperationResult>,
): Promise<ViewToolInvocationTerminal> {
  if (!isEmptyOrdinaryObject(params) || !isEmptyOrdinaryObject(args))
    return {
      phase: "not-entered",
      result: {
        success: false,
        error: {
          code: "E_INVALID_ARGS",
          message: "Expected empty Tool parameters and arguments",
        },
      },
    };
  try {
    return { phase: "entered-returned", result: await handler(args) };
  } catch {
    return {
      phase: "entered-returned",
      result: {
        success: false,
        error: { code: "E_HANDLER_ERROR", message: "Tool handler failed" },
      },
    };
  }
}
