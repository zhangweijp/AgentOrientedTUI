import { useContext, useLayoutEffect } from "./preact-hooks.js";
import { ViewRuntimeContext } from "../contexts/view-runtime-context.js";
import {
  invokeCreateIfAbsentTool,
  type RequiredStringParams,
  type RequiredStringArgs,
} from "../utils/create-if-absent-tool.js";
import type { CreateIfAbsentOutcome } from "@aotui/runtime/spi";
export type {
  RequiredStringParams,
  RequiredStringArgs,
} from "../utils/create-if-absent-tool.js";
export type {
  CreateIfAbsentOutcome,
  CreateIfAbsentTerminal,
} from "@aotui/runtime/spi";
export interface CreateIfAbsentToolOptions<T extends RequiredStringParams> {
  readonly description: string;
  readonly params: T;
}
export type CreateIfAbsentHandler<T extends RequiredStringParams> = (
  args: RequiredStringArgs<T>,
) => Promise<CreateIfAbsentOutcome>;
const unavailable = async () => ({
  success: false,
  error: {
    code: "TOOL_EXECUTION_UNAVAILABLE",
    message: "Creation requires the negotiated safe channel",
  },
});
export function experimental_useCreateIfAbsentTool<
  T extends RequiredStringParams,
>(
  name: string,
  options: CreateIfAbsentToolOptions<T>,
  create: CreateIfAbsentHandler<T>,
  config: Readonly<{ enabled?: boolean }> = {},
): void {
  const context = useContext(ViewRuntimeContext),
    port = context?.viewTools;
  if (
    !port ||
    port.safeCreateIfAbsentInvocationSupport !== "create-if-absent-v1"
  )
    throw new Error(
      "CREATE_IF_ABSENT_UNSUPPORTED: Runtime creation port is required",
    );
  const fields = Object.getOwnPropertyDescriptors(options),
    configuration = Object.getOwnPropertyDescriptors(config);
  if (
    Reflect.ownKeys(fields).some(
      (k) =>
        typeof k !== "string" ||
        !["description", "params"].includes(k) ||
        !fields[k]!.enumerable ||
        !("value" in fields[k]!),
    ) ||
    typeof fields.description?.value !== "string" ||
    !fields.params ||
    typeof create !== "function" ||
    Reflect.ownKeys(configuration).some(
      (k) =>
        k !== "enabled" ||
        !configuration[k]!.enumerable ||
        !("value" in configuration[k]!),
    ) ||
    (configuration.enabled && typeof configuration.enabled.value !== "boolean")
  )
    throw new Error("Invalid creation Tool declaration");
  const description = fields.description.value,
    params = fields.params.value,
    key = port.fingerprintParams(params),
    enabled = configuration.enabled?.value ?? true;
  useLayoutEffect(() => {
    if (!enabled) return;
    return port.registerTool(
      name,
      { description, params, isMutating: true, handler: unavailable },
      {
        safeCreateIfAbsentInvocationMode: "create-if-absent-v1",
        createSafeCreateIfAbsentInvoker: (committedParams) => (args) =>
          invokeCreateIfAbsentTool(committedParams, args, (values) =>
            create(values as RequiredStringArgs<T>),
          ),
      },
    );
  }, [
    port,
    name,
    description,
    key,
    create,
    enabled,
    context?.meta.viewId,
    context?.meta.viewGeneration,
  ]);
}
