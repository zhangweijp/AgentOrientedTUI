import type {
  CreateIfAbsentOutcome,
  CreateIfAbsentTerminal,
} from "@aotui/runtime/spi";
export type RequiredStringParams = Readonly<
  Record<string, Readonly<{ type: "string"; required: true; desc?: string }>>
>;
export type RequiredStringArgs<T extends RequiredStringParams> = {
  readonly [K in keyof T]: string;
};
function descriptors(value: unknown): Record<string, PropertyDescriptor> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
    throw new Error();
  const d = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(d).some(
      (k) => typeof k !== "string" || !d[k]!.enumerable || !("value" in d[k]!),
    )
  )
    throw new Error();
  return d;
}
/** The trusted Runtime bounds and detaches declarations; this wrapper never transforms string input. */
export async function invokeCreateIfAbsentTool(
  params: unknown,
  args: unknown,
  create: (
    input: Readonly<Record<string, string>>,
  ) => Promise<CreateIfAbsentOutcome>,
): Promise<CreateIfAbsentTerminal> {
  try {
    const fields = descriptors(params),
      values = descriptors(args),
      keys = Object.keys(fields);
    if (!keys.length || Object.keys(values).length !== keys.length)
      throw new Error();
    for (const key of keys) {
      const p = descriptors(fields[key]!.value);
      if (
        p.type?.value !== "string" ||
        p.required?.value !== true ||
        Object.keys(p).some((k) => !["type", "required", "desc"].includes(k)) ||
        (p.desc && typeof p.desc.value !== "string") ||
        !Object.hasOwn(values, key) ||
        typeof values[key]!.value !== "string"
      )
        throw new Error();
    }
    const data = Object.fromEntries(
      Object.entries(values).map(([k, d]) => [k, d.value]),
    );
    const encoder = new TextEncoder();
    const approximate =
      2 +
      Object.entries(data).reduce(
        (n, [key, value]) =>
          n +
          encoder.encode(key).byteLength +
          6 +
          encoder.encode(value).byteLength,
        0,
      );
    if (
      approximate > 128 * 1024 ||
      encoder.encode(JSON.stringify(data)).byteLength > 128 * 1024
    )
      throw new Error();
  } catch {
    return {
      phase: "not-entered",
      outcome: {
        status: "rejected",
        code: "E_INVALID_ARGS",
        message: "Expected exact required string creation arguments",
      },
    };
  }
  try {
    return {
      phase: "entered-returned",
      outcome: await create(args as Readonly<Record<string, string>>),
    };
  } catch {
    return {
      phase: "entered-returned",
      outcome: {
        status: "unknown",
        code: "RESOURCE_OUTCOME_UNKNOWN",
        message: "Creation outcome could not be established",
      },
    };
  }
}
