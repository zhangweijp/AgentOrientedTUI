import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { types } from "node:util";
import {
  createWorkspaceFileCreator,
  mapWorkspaceFileCreationResult,
} from "../core/conditional-file-create.js";
let directory: string, root: string, outside: string;
beforeEach(async () => {
  directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "aotui-w06-native-")),
  );
  root = path.join(directory, "root");
  outside = path.join(directory, "outside");
  await fs.mkdir(path.join(root, "sub"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "sentinel"), "outside");
});
afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});
async function missing(file: string) {
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
}
describe("W06 native exclusive workspace creator", () => {
  test("maps only the successful creation receipt metadata to OperationResult", () => {
    const result = mapWorkspaceFileCreationResult({
      status: "succeeded",
      value: { filePath: path.join(root, "new"), bytesWritten: 5 },
    });
    expect(result).toEqual({
      success: true,
      data: { filePath: path.join(root, "new"), bytesWritten: 5 },
    });
    expect(result.data).not.toHaveProperty("content");
  });
  test.each(["none", "partial"] as const)(
    "preserves known failed effects: %s",
    (effects) => {
      expect(
        mapWorkspaceFileCreationResult({
          status: "failed",
          code: "RESOURCE_WRITE_FAILED",
          message: "File creation left partial effects",
          effects,
        }),
      ).toEqual({
        success: false,
        error: {
          code: "RESOURCE_WRITE_FAILED",
          message: "File creation left partial effects",
        },
        effects,
      });
    },
  );
  test("maps an uncertain resource result without claiming effects", () => {
    const result = mapWorkspaceFileCreationResult({
      status: "unknown",
      code: "RESOURCE_OUTCOME_UNKNOWN",
      message: "Creation outcome could not be established",
    });
    expect(result).toEqual({
      success: false,
      error: {
        code: "RESOURCE_OUTCOME_UNKNOWN",
        message: "Creation outcome could not be established",
      },
    });
    expect(Object.prototype.hasOwnProperty.call(result, "effects")).toBe(false);
  });
  test.each(["", "plain", "文本😀\n"])(
    "writes exact UTF-8 and closes for %j",
    async (content) => {
      const create = await createWorkspaceFileCreator(root),
        target = path.join(root, "new");
      const result = await create({ relativePath: "new", content });
      expect(result).toEqual({
        status: "succeeded",
        value: { filePath: target, bytesWritten: Buffer.byteLength(content) },
      });
      expect(await fs.readFile(target, "utf8")).toBe(content);
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    },
  );
  test("different IDs/callers racing the same native wx target have one complete winner", async () => {
    const [a, b] = await Promise.all([
      createWorkspaceFileCreator(root),
      createWorkspaceFileCreator(root),
    ]);
    const results = await Promise.all([
      a({ relativePath: "race", content: "A".repeat(7000) }),
      b({ relativePath: "race", content: "B".repeat(9000) }),
    ]);
    expect(
      results.filter((r: { status: string }) => r.status === "succeeded"),
    ).toHaveLength(1);
    expect(
      results.filter((r: { status: string }) => r.status === "failed"),
    ).toEqual([
      {
        status: "failed",
        code: "RESOURCE_ALREADY_EXISTS",
        message: "Target already exists",
        effects: "none",
      },
    ]);
    const winner =
      results[0].status === "succeeded" ? "A".repeat(7000) : "B".repeat(9000);
    expect(await fs.readFile(path.join(root, "race"), "utf8")).toBe(winner);
  });
  test.each([
    "file",
    "empty",
    "directory",
    "internal-link",
    "external-link",
    "dangling-link",
  ])("preserves existing %s", async (kind) => {
    const target = path.join(root, "existing");
    if (kind === "directory") await fs.mkdir(target);
    else if (kind.endsWith("link"))
      await fs.symlink(
        kind === "internal-link"
          ? path.join(root, "sub")
          : kind === "external-link"
            ? path.join(outside, "sentinel")
            : path.join(outside, "missing"),
        target,
      );
    else await fs.writeFile(target, kind === "empty" ? "" : "original");
    const before = await fs.lstat(target);
    const create = await createWorkspaceFileCreator(root);
    expect(
      await create({ relativePath: "existing", content: "overwrite" }),
    ).toMatchObject({
      status: "failed",
      code: "RESOURCE_ALREADY_EXISTS",
      effects: "none",
    });
    expect((await fs.lstat(target)).ino).toBe(before.ino);
    if (kind === "file" || kind === "empty")
      expect(await fs.readFile(target, "utf8")).toBe(
        kind === "empty" ? "" : "original",
      );
    expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe(
      "outside",
    );
  });
  test.each([
    "",
    "/absolute",
    "../outside",
    "sub/../file",
    "./file",
    "sub//file",
    "sub/",
    "sub\\file",
    "C:/absolute",
    "file\0name",
    "file\nname",
  ])(
    "refuses invalid relative path %j without side effects",
    async (relativePath) => {
      const create = await createWorkspaceFileCreator(root);
      expect(await create({ relativePath, content: "text" })).toMatchObject({
        status: "failed",
        effects: "none",
      });
      expect((await fs.readdir(root)).sort()).toEqual(["sub"]);
      expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe(
        "outside",
      );
    },
  );
  test.each(["\ud800", "\udc00", "x\ud800y"])(
    "rejects unpaired surrogate content %j without replacement",
    async (content) => {
      const create = await createWorkspaceFileCreator(root);
      expect(await create({ relativePath: "invalid", content })).toMatchObject({
        status: "failed",
        effects: "none",
      });
      await missing(path.join(root, "invalid"));
    },
  );
  test("does not create missing parents; resolves internal parents and rejects external parent symlink", async () => {
    await fs.symlink(path.join(root, "sub"), path.join(root, "inside"));
    await fs.symlink(outside, path.join(root, "escape"));
    const create = await createWorkspaceFileCreator(root);
    expect(
      await create({ relativePath: "missing/new", content: "x" }),
    ).toMatchObject({ status: "failed", effects: "none" });
    await missing(path.join(root, "missing"));
    expect(
      await create({ relativePath: "escape/new", content: "x" }),
    ).toMatchObject({
      status: "failed",
      code: "RESOURCE_OUTSIDE_WORKSPACE",
      effects: "none",
    });
    await missing(path.join(outside, "new"));
    expect(
      await create({ relativePath: "inside/new", content: "inside" }),
    ).toMatchObject({ status: "succeeded" });
    expect(await fs.readFile(path.join(root, "sub/new"), "utf8")).toBe(
      "inside",
    );
  });
  test("detects root inode replacement and parent removal", async () => {
    const create = await createWorkspaceFileCreator(root);
    await fs.rmdir(path.join(root, "sub"));
    expect(
      await create({ relativePath: "sub/new", content: "x" }),
    ).toMatchObject({ status: "failed", effects: "none" });
    await fs.rename(root, root + "-old");
    await fs.mkdir(root);
    expect(await create({ relativePath: "new", content: "x" })).toMatchObject({
      status: "failed",
      code: "WORKSPACE_ROOT_CHANGED",
      effects: "none",
    });
    await missing(path.join(root, "new"));
    await missing(path.join(root + "-old", "new"));
  });
  test.each([
    "zero",
    "partial",
    "close",
    "unknown-open",
    "after-open-forged-error",
  ])(
    "reports actual file facts for %s fault and attempts close",
    async (kind) => {
      const create = await createWorkspaceFileCreator(root),
        nativeOpen = fs.open.bind(fs);
      let opened = 0,
        closed = 0;
      const target = path.join(root, "fault");
      jest.spyOn(fs, "open").mockImplementation((async (...args: any[]) => {
        if (kind === "unknown-open")
          throw {
            get code() {
              throw Error("private");
            },
            get message() {
              throw Error("private");
            },
          };
        const handle = await (nativeOpen as any)(...args);
        opened++;
        if (kind === "after-open-forged-error") {
          await handle.close();
          closed++;
          throw Object.assign(Error("not native provenance"), {
            code: "EEXIST",
          });
        }
        return {
          writeFile: async (data: any) => {
            if (kind === "zero") throw Error("write failed");
            if (kind === "partial") {
              await handle.writeFile(data.subarray(0, 3));
              throw Error("write partial");
            }
            await handle.writeFile(data);
          },
          close: async () => {
            closed++;
            await handle.close();
            if (kind === "close") throw Error("close state unavailable");
          },
        };
      }) as any);
      const result = await create({ relativePath: "fault", content: "abcdef" });
      if (kind === "zero" || kind === "partial") {
        expect(result).toMatchObject({
          status: "failed",
          code: "RESOURCE_WRITE_FAILED",
          effects: "partial",
        });
        expect(await fs.readFile(target, "utf8")).toBe(
          kind === "zero" ? "" : "abc",
        );
      } else {
        expect(result).toMatchObject({ status: "unknown" });
        if (kind === "unknown-open") await missing(target);
        else
          expect(await fs.readFile(target, "utf8")).toBe(
            kind === "close" ? "abcdef" : "",
          );
      }
      expect(closed).toBe(opened);
    },
  );
  test("native EEXIST provenance is measured inside the Jest realm", async () => {
    const target = path.join(root, "existing");
    await fs.writeFile(target, "original");
    let caught: unknown;
    try {
      await fs.open(target, "wx");
    } catch (error) {
      caught = error;
    }
    expect(types.isNativeError(caught)).toBe(true);
    const fields = Object.getOwnPropertyDescriptors(caught);
    const fact = {
      environment: "Jest VM",
      node: process.version,
      instanceofError: caught instanceof Error,
      sameErrorPrototype: Object.getPrototypeOf(caught) === Error.prototype,
      nativeBrand: types.isNativeError(caught),
      code: fields.code?.value,
      syscall: fields.syscall?.value,
      pathMatches: fields.path?.value === target,
      errnoIsInteger: Number.isInteger(fields.errno?.value),
    };
    console.log("W06_NATIVE_ERROR_PROBE", JSON.stringify(fact));
    expect(fact).toMatchObject({
      nativeBrand: true,
      code: "EEXIST",
      syscall: "open",
      pathMatches: true,
      errnoIsInteger: true,
    });
    const create = await createWorkspaceFileCreator(root);
    expect(
      await create({ relativePath: "existing", content: "no" }),
    ).toMatchObject({
      status: "failed",
      code: "RESOURCE_ALREADY_EXISTS",
      effects: "none",
    });
  });
  test("workspace root alias resolves to captured canonical identity and changing alias cannot redirect it", async () => {
    const alias = path.join(directory, "alias");
    await fs.symlink(root, alias);
    const create = await createWorkspaceFileCreator(alias);
    expect(await create({ relativePath: "alias.txt", content: "A" })).toEqual({
      status: "succeeded",
      value: { filePath: path.join(root, "alias.txt"), bytesWritten: 1 },
    });
    await fs.unlink(alias);
    await fs.symlink(outside, alias);
    expect(
      await create({ relativePath: "no.txt", content: "no" }),
    ).toMatchObject({
      status: "failed",
      code: "WORKSPACE_ROOT_CHANGED",
      effects: "none",
    });
    await missing(path.join(root, "no.txt"));
    await missing(path.join(outside, "no.txt"));
  });
  test("before-open invalid input does not execute getters or native open", async () => {
    const create = await createWorkspaceFileCreator(root),
      open = jest.spyOn(fs, "open");
    let reads = 0;
    const input: any = {
      relativePath: "new",
      get content() {
        reads++;
        throw Error("private");
      },
    };
    expect(await create(input)).toMatchObject({
      status: "failed",
      effects: "none",
    });
    expect(reads).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });
});
