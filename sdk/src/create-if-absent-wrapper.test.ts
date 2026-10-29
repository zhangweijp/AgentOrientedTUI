import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { createTUIApp } from "./app-factory/createTUIApp.js";
import { View } from "./components/View.js";
import { useViewTypeTool } from "./hooks/useViewTypeTool.js";
import { experimental_useCreateIfAbsentTool as useCreate } from "./hooks/useCreateIfAbsentTool.js";
import { AppKernel } from "../../runtime/src/worker-runtime/app-kernel/AppKernel.js";

const close: Array<() => Promise<void>> = [];
async function setup(
  Content: any,
  support: any = "create-if-absent-v1",
  root?: any,
) {
  const captures: any[] = [],
    registrations: any[] = [];
  let port: any;
  const factory = createTUIApp({
    app_name: "safe_fixture",
    component:
      root ??
      (() => h(View, { id: "file_view", type: "File" }, h(Content, {}))),
  });
  const initialize = factory.initializeComponent;
  factory.initializeComponent = async (container, context) => {
    port = context.viewTools;
    const forwarded: any = {
      ...port,
      safeCreateIfAbsentInvocationSupport: support,
      registerTool: (...args: any[]) => {
        const options = args[3];
        registrations.push(options);
        if (options?.createSafeCreateIfAbsentInvoker)
          args[3] = {
            ...options,
            createSafeCreateIfAbsentInvoker: (p: any) => {
              captures.push(p);
              return options.createSafeCreateIfAbsentInvoker(p);
            },
          };
        return port.registerTool(...args);
      },
    };
    if (support === "missing")
      delete forwarded.safeCreateIfAbsentInvocationSupport;
    return initialize(container, { ...context, viewTools: forwarded });
  };
  const kernel = new AppKernel({
    ...factory.kernelConfig,
    component: factory,
  } as any);
  kernel.setId("safe_app" as any);
  kernel.setAppExecutionInstanceId("safe_instance");
  const container = document.createElement("div");
  document.body.appendChild(container);
  close.push(async () => {
    await kernel.onClose();
    container.remove();
  });
  await kernel.onOpen(
    {
      appId: "safe_app" as any,
      desktopId: "d" as any,
      markDirty() {},
      onRender() {},
    },
    container,
  );
  const tool = () => kernel.getViewOwnedToolDefinitions()[0];
  return {
    kernel,
    container,
    captures,
    registrations,
    get port() {
      return port;
    },
    tool,
    invoke: (args: any, source = tool(), target = source.targets[0]) =>
      kernel.invokeBoundCreateIfAbsentViewTool(source, target, args),
  };
}
afterEach(async () => {
  for (const cleanup of close.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

import { createIfAbsentV1Response } from "../../runtime/src/adapters/create-if-absent-invocation-v1.js";
const params = () => ({
  relativePath: {
    type: "string" as const,
    required: true as const,
    desc: "Path",
  },
  content: { type: "string" as const, required: true as const },
});
const args = { relativePath: "file", content: "text" };
describe("W06 SDK layout captures creator identity", () => {
  it("captures params once, rebinds same schema when creator changes, and cannot use legacy invoke", async () => {
    const a = vi.fn(async () => ({
        status: "succeeded" as const,
        value: { root: "A" },
      })),
      b = vi.fn(async () => ({
        status: "succeeded" as const,
        value: { root: "B" },
      }));
    let update!: (b: boolean) => void;
    function Content() {
      const [other, set] = useState(false);
      update = set;
      useCreate(
        "create",
        { description: "Create", params: params() },
        other ? b : a,
      );
      return h("p", {}, "Stable");
    }
    const x = await setup(Content);
    const before = x.tool();
    expect(Object.isFrozen(x.captures[0])).toBe(true);
    expect((await x.invoke(args, before)).outcome).toEqual({
      status: "succeeded",
      value: { root: "A" },
    });
    expect(
      await x.kernel.invokeBoundReadOnlyTool(before, before.targets[0], args),
    ).toMatchObject({ success: false });
    expect(
      await (x.kernel as any).viewOwnedTools.invoke(
        { ...before, appId: "safe_app", appInstanceId: "safe_instance" },
        before.targets[0],
        args,
      ),
    ).toMatchObject({
      success: false,
      error: { code: "TOOL_EXECUTION_UNAVAILABLE" },
    });
    expect(a).toHaveBeenCalledOnce();
    update(true);
    expect((await x.invoke(args, before)).outcome.value).toEqual({ root: "A" });
    await act(() => {});
    expect(x.tool().inputSchema).toEqual(before.inputSchema);
    expect(x.tool().targets[0].bindingVersion).not.toBe(
      before.targets[0].bindingVersion,
    );
    expect((await x.invoke(args, before)).phase).toBe("not-entered");
    expect((await x.invoke(args)).outcome.value).toEqual({ root: "B" });
    expect(b).toHaveBeenCalledOnce();
  });
  it("an already entered A callable keeps A when B commits", async () => {
    let update!: (v: boolean) => void,
      release!: (v: any) => void,
      mark!: () => void;
    const entered = new Promise<void>((resolve) => {
      mark = resolve;
    });
    const a = vi.fn(() => {
      mark();
      return new Promise<any>((yes) => (release = yes));
    });
    const b = vi.fn(async () => ({
      status: "succeeded" as const,
      value: { root: "B" },
    }));
    function Content() {
      const [other, set] = useState(false);
      update = set;
      useCreate(
        "create",
        { description: "Create", params: params() },
        other ? b : a,
      );
      return h("p", {}, "Stable");
    }
    const x = await setup(Content),
      old = x.tool();
    const pending = x.invoke(args, old);
    await entered;
    await act(() => update(true));
    release({ status: "succeeded", value: { root: "A" } });
    expect((await pending).outcome.value).toEqual({ root: "A" });
    expect(b).not.toHaveBeenCalled();
    expect((await x.invoke(args, old)).phase).toBe("not-entered");
  });
  it("failed render does not install a candidate creator", async () => {
    let update!: (v: boolean) => void;
    const a = vi.fn(async () => ({ status: "succeeded" as const, value: "A" })),
      b = vi.fn(async () => ({ status: "succeeded" as const, value: "B" }));
    function Content() {
      const [bad, set] = useState(false);
      update = set;
      useCreate(
        "create",
        { description: "Create", params: params() },
        bad ? b : a,
      );
      if (bad) throw Error("W06 candidate failed");
      return h("p", {}, "Stable");
    }
    const x = await setup(Content),
      old = x.tool();
    await expect(
      Promise.resolve().then(() => act(() => update(true))),
    ).rejects.toThrow("W06 candidate failed");
    await x.invoke(args, old);
    expect(b).not.toHaveBeenCalled();
  });
  it("enabled changes bind new version without altering DOM or schema", async () => {
    let update!: (v: boolean) => void;
    const creator = async () => ({ status: "succeeded" as const, value: null });
    function Content() {
      const [on, set] = useState(true);
      update = set;
      useCreate(
        "create",
        { description: "Create", params: params() },
        creator,
        { enabled: on },
      );
      return h("p", {}, "Stable");
    }
    const x = await setup(Content),
      old = x.tool(),
      html = x.container.innerHTML;
    await act(() => update(false));
    expect(x.tool()).toBeUndefined();
    expect((await x.invoke(args, old)).phase).toBe("not-entered");
    await act(() => update(true));
    expect(x.container.innerHTML).toBe(html);
    expect(x.tool().targets[0].bindingVersion).not.toBe(
      old.targets[0].bindingVersion,
    );
  });
  it.each(["missing", "future", false])(
    "explicitly refuses missing old port %s",
    async (support) => {
      function Content() {
        useCreate(
          "create",
          { description: "Create", params: params() },
          async () => ({ status: "succeeded", value: null }),
        );
        return h("p", {}, "Stable");
      }
      await expect(setup(Content, support)).rejects.toThrow(
        "CREATE_IF_ABSENT_UNSUPPORTED",
      );
    },
  );
  it("ordinary mutating registration has no safe creation qualification", async () => {
    const creator = vi.fn(async () => ({ success: true }));
    function Content() {
      useViewTypeTool(
        "create",
        { description: "Create", params: params(), isMutating: true },
        creator,
      );
      return h("p", {}, "Stable");
    }
    const x = await setup(Content);
    expect((await x.invoke(args)).phase).toBe("not-entered");
    expect(creator).not.toHaveBeenCalled();
  });
  it.each([
    "marker",
    "mixed",
    "factory-getter",
    "factory-throws",
    "factory-return",
    "readonly",
    "optional",
    "default",
  ])(
    "rejects malformed registration %s without half qualification",
    async (kind) => {
      const x = await setup(() => h("p", {}, "Stable"));
      const id = x.port.mount("manual", "Manual");
      const options: any = {
        safeCreateIfAbsentInvocationMode: "create-if-absent-v1",
        createSafeCreateIfAbsentInvoker: () => async () => ({
          phase: "entered-returned",
          outcome: { status: "succeeded", value: null },
        }),
      };
      const p: any = params();
      let reads = 0;
      if (kind === "marker") delete options.createSafeCreateIfAbsentInvoker;
      if (kind === "mixed") options.safeRefInvocationMode = "snapshot-value-v1";
      if (kind === "factory-getter")
        Object.defineProperty(options, "createSafeCreateIfAbsentInvoker", {
          enumerable: true,
          get() {
            reads++;
            throw Error("private");
          },
        });
      if (kind === "factory-throws")
        options.createSafeCreateIfAbsentInvoker = () => {
          throw Error("private");
        };
      if (kind === "factory-return")
        options.createSafeCreateIfAbsentInvoker = () => undefined;
      if (kind === "optional") p.content.required = false;
      if (kind === "default") p.content.default = "x";
      expect(() =>
        x.port.registerTool(
          id,
          "create",
          {
            description: "Create",
            params: p,
            isMutating: kind !== "readonly",
            handler: async () => ({ success: false }),
          },
          options,
        ),
      ).toThrow();
      expect(reads).toBe(0);
      expect(x.kernel.getViewOwnedToolDefinitions()).toEqual([]);
      x.port.unmount(id);
    },
  );
});

describe("W06 actual SDK handler exceptions and invalid outcomes", () => {
  it.each(["throw", "getter-result", "oversize", "accepted"])(
    "captures actual registered %s without arbitrary formatting",
    async (kind) => {
      let reads = 0;
      const create = vi.fn(async () => {
        if (kind === "throw")
          throw {
            get message() {
              reads++;
              throw Error("private");
            },
            toString() {
              reads++;
              throw Error("private");
            },
          };
        if (kind === "getter-result")
          return {
            get status() {
              reads++;
              throw Error("private");
            },
          };
        if (kind === "oversize")
          return { status: "succeeded", value: "x".repeat(525000) };
        return { status: "accepted", operationId: "forged" };
      });
      function Content() {
        useCreate(
          "create",
          { description: "Create", params: params() },
          create as any,
        );
        return h("p", {}, "Stable");
      }
      const x = await setup(Content),
        terminal = await x.invoke(args),
        response = createIfAbsentV1Response(
          { requestId: "r", appId: "safe_app", instanceId: "safe_instance" },
          terminal,
        );
      expect(create).toHaveBeenCalledOnce();
      expect(reads).toBe(0);
      if (kind === "throw")
        expect(response).toMatchObject({
          terminal: {
            phase: "entered-returned",
            outcome: { status: "unknown", code: "RESOURCE_OUTCOME_UNKNOWN" },
          },
        });
      else expect(response).toBeNull();
    },
  );
});
