import fs from "node:fs/promises";
import path from "node:path";
import type { BigIntStats } from "node:fs";
import { types } from "node:util";
import type { CreateIfAbsentOutcome } from "@aotui/sdk";
export interface WorkspaceCreateInput {
  readonly relativePath: string;
  readonly content: string;
}
export type WorkspaceFileCreator = (
  input: WorkspaceCreateInput,
) => Promise<CreateIfAbsentOutcome>;
export type WorkspaceFileCreatorFactory = (
  workspaceRoot: string,
  current?: () => void,
) => Promise<WorkspaceFileCreator>;
const failed = (
  code: string,
  message: string,
  effects: "none" | "partial" = "none",
): CreateIfAbsentOutcome => ({ status: "failed", code, message, effects });
const unknown = (): CreateIfAbsentOutcome => ({
  status: "unknown",
  code: "RESOURCE_OUTCOME_UNKNOWN",
  message: "Creation outcome could not be established",
});
function scalarText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
export function nativeOpenCode(error: unknown, target: string): string | undefined {
  try {
    if (!types.isNativeError(error)) return;
    const d = Object.getOwnPropertyDescriptors(error);
    if (
      d.syscall?.value !== "open" ||
      d.path?.value !== target ||
      !Number.isInteger(d.errno?.value) ||
      typeof d.code?.value !== "string"
    )
      return;
    return d.code.value;
  } catch {
    return;
  }
}
/** Trusted local workspace and stable parents. realpath/open are not an OS sandbox or whole-file transaction. */
export const createWorkspaceFileCreator: WorkspaceFileCreatorFactory = async (
  workspaceRoot,
  current,
) => {
  if (typeof workspaceRoot !== "string" || !workspaceRoot)
    throw new Error("WORKSPACE_ROOT_UNAVAILABLE");
  let root: string, identity: BigIntStats;
  try {
    root = await fs.realpath(workspaceRoot);
    identity = await fs.stat(root, { bigint: true });
    if (!identity.isDirectory()) throw new Error();
  } catch {
    throw new Error("WORKSPACE_ROOT_UNAVAILABLE");
  }
  return async (input) => {
    let relativePath: string, content: string;
    try {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        ![null, Object.prototype].includes(Object.getPrototypeOf(input))
      )
        throw new Error();
      const fields = Object.getOwnPropertyDescriptors(input);
      if (
        Reflect.ownKeys(fields).length !== 2 ||
        !["relativePath", "content"].every(
          (k) =>
            fields[k]?.enumerable &&
            "value" in fields[k]! &&
            typeof fields[k]!.value === "string",
        )
      )
        throw new Error();
      relativePath = fields.relativePath!.value as string;
      content = fields.content!.value as string;
      if (
        !relativePath ||
        /[\u0000-\u001f\u007f-\u009f\\]/.test(relativePath) ||
        path.isAbsolute(relativePath) ||
        path.win32.isAbsolute(relativePath) ||
        relativePath
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        !scalarText(relativePath) ||
        !scalarText(content)
      )
        throw new Error();
    } catch {
      return failed(
        "RESOURCE_INVALID_ARGS",
        "Expected an exact relative path and Unicode text",
      );
    }
    try {
      if ((await fs.realpath(workspaceRoot)) !== root)
        return failed(
          "WORKSPACE_ROOT_CHANGED",
          "Original workspace root changed",
        );
      const current = await fs.stat(root, { bigint: true });
      if (
        !current.isDirectory() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      )
        return failed(
          "WORKSPACE_ROOT_CHANGED",
          "Original workspace root changed",
        );
    } catch {
      return failed(
        "WORKSPACE_ROOT_CHANGED",
        "Original workspace root is unavailable",
      );
    }
    let parent: string;
    try {
      parent = await fs.realpath(path.dirname(path.join(root, relativePath)));
      const relative = path.relative(root, parent);
      if (
        relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative)
      )
        return failed(
          "RESOURCE_OUTSIDE_WORKSPACE",
          "Target parent is outside the original workspace",
        );
      if (!(await fs.stat(parent)).isDirectory())
        return failed(
          "RESOURCE_PARENT_INVALID",
          "Target parent is not a directory",
        );
    } catch {
      return failed(
        "RESOURCE_PARENT_UNAVAILABLE",
        "Target parent must already exist",
      );
    }
    const target = path.join(parent, path.basename(relativePath));
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try { current?.(); } catch { return failed('RESOURCE_SOURCE_STALE', 'Workspace source is no longer current'); }
    try {
      handle = await fs.open(target, "wx", 0o600);
    } catch (error) {
      const code = nativeOpenCode(error, target);
      if (code === "EEXIST")
        return failed("RESOURCE_ALREADY_EXISTS", "Target already exists");
      if (
        code &&
        ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(code)
      )
        return failed(
          "RESOURCE_OPEN_FAILED",
          "Target could not be opened for exclusive creation",
        );
      return unknown();
    }
    const bytes = Buffer.from(content, "utf8");
    let writeFailed = false;
    try {
      await handle.writeFile(bytes);
    } catch {
      writeFailed = true;
    }
    try {
      await handle.close();
    } catch {
      return unknown();
    }
    if (writeFailed)
      return failed(
        "RESOURCE_WRITE_FAILED",
        "File creation left partial effects",
        "partial",
      );
    return {
      status: "succeeded",
      value: { filePath: target, bytesWritten: bytes.byteLength },
    };
  };
};
