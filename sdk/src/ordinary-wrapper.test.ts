import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { createTUIApp } from "./app-factory/createTUIApp.js";
import { View } from "./components/View.js";
import { useViewTypeTool } from "./hooks/useViewTypeTool.js";
import { AppKernel } from "../../runtime/src/worker-runtime/app-kernel/AppKernel.js";

const close: Array<() => Promise<void>> = [];
async function setup(Content: any, support: any = "ordinary-v1", root?: any) {
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
      safeOrdinaryInvocationSupport: support,
      registerTool: (...args: any[]) => {
        const options = args[3];
        registrations.push(options);
        if (options?.createSafeOrdinaryInvoker)
          args[3] = {
            ...options,
            createSafeOrdinaryInvoker: (p: any) => {
              captures.push(p);
              return options.createSafeOrdinaryInvoker(p);
            },
          };
        return port.registerTool(...args);
      },
    };
    if (support === "missing") delete forwarded.safeOrdinaryInvocationSupport;
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
      kernel.invokeBoundOrdinaryViewTool(source, target, args),
  };
}
afterEach(async () => {
  for (const cleanup of close.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

describe("W05 actual SDK ordinary commits and qualification", () => {
  it("keeps unchanged binding while reads see only committed state", async () => {
    let update!: (n: number) => void;
    const calls: number[] = [];
    function Content() {
      const [n, set] = useState(1);
      update = set;
      useViewTypeTool(
        "read",
        { description: "Read", params: {}, isMutating: false },
        () => {
          calls.push(n);
          return { success: true, data: { n } };
        },
      );
      return h("p", {}, "Stable");
    }
    const x = await setup(Content);
    const original = x.tool();
    expect(original.inputSchema).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    update(2);
    expect((await x.invoke({})).result.data).toEqual({ n: 1 });
    await act(() => {});
    expect((await x.invoke({})).result.data).toEqual({ n: 2 });
    expect(x.tool()).toEqual(original);
    expect(x.captures).toHaveLength(1);
    expect(calls).toEqual([1, 2]);
  });
  it("Tool-only disable/enable changes epoch and binding with no DOM mutation", async () => {
    let enabled!: (n: boolean) => void;
    function Content() {
      const [on, set] = useState(true);
      enabled = set;
      useViewTypeTool(
        "read",
        { description: "Read", params: {}, isMutating: false },
        () => ({ success: true }),
        { enabled: on },
      );
      return h("p", {}, "Stable");
    }
    const x = await setup(Content);
    const original = x.tool(),
      html = x.container.innerHTML,
      epoch = x.kernel.getProjectionCoordinator().token().epoch;
    await act(() => enabled(false));
    expect(x.container.innerHTML).toBe(html);
    expect(x.tool()).toBeUndefined();
    expect(x.kernel.getProjectionCoordinator().token()).toMatchObject({
      ready: true,
    });
    expect(x.kernel.getProjectionCoordinator().token().epoch).toBeGreaterThan(
      epoch,
    );
    await act(() => enabled(true));
    expect(x.container.innerHTML).toBe(html);
    expect(x.tool().targets[0].bindingVersion).not.toBe(
      original.targets[0].bindingVersion,
    );
    expect((await x.invoke({}, original)).phase).toBe("not-entered");
  });
  it("an internal failed render cannot install its uncommitted closure", async () => {
    let update!: (n: boolean) => void;
    const calls: string[] = [];
    function Content() {
      const [bad, set] = useState(false);
      update = set;
      useViewTypeTool(
        "read",
        { description: "Read", params: {}, isMutating: false },
        () => {
          calls.push(bad ? "uncommitted" : "committed");
          return { success: true };
        },
      );
      if (bad) throw Error("W05 failed render");
      return h("p", {}, "Stable");
    }
    const x = await setup(Content),
      original = x.tool();
    await expect(
      Promise.resolve().then(() => act(() => update(true))),
    ).rejects.toThrow("W05 failed render");
    await x.invoke({}, original);
    expect(calls).not.toContain("uncommitted");
    expect(x.captures).toHaveLength(1);
  });
  it("failed initial render revokes all partial View/Tool registrations", async () => {
    let kernel: any;
    function Good() {
      useViewTypeTool(
        "read",
        { description: "Read", params: {}, isMutating: false },
        () => ({ success: true }),
      );
      return h("p", {}, "Good");
    }
    function Bad() {
      throw Error("W05 initial failure");
    }
    const factory = createTUIApp({
      app_name: "initial_fail",
      component: () =>
        h("main", {}, [
          h(View, { id: "good", type: "Good" }, h(Good, {})),
          h(Bad, {}),
        ]),
    });
    kernel = new AppKernel({
      ...factory.kernelConfig,
      component: factory,
    } as any);
    kernel.setId("fail" as any);
    kernel.setAppExecutionInstanceId("failure");
    const container = document.createElement("div");
    await expect(
      kernel.onOpen(
        { appId: "fail", desktopId: "d", markDirty() {}, onRender() {} } as any,
        container,
      ),
    ).rejects.toThrow("W05 initial failure");
    expect(kernel.getViewOwnedToolDefinitions()).toEqual([]);
    expect(kernel.getViewOwnedViewInstances()).toEqual([]);
  });
  it.each(["missing", "future", false])(
    "no implicit qualification without support: %s",
    async (support) => {
      function Content() {
        useViewTypeTool(
          "read",
          { description: "Read", params: {}, isMutating: false },
          () => ({ success: true }),
        );
        return h("p", {}, "Stable");
      }
      const x = await setup(Content, support);
      expect(x.registrations).toEqual([undefined]);
      expect(x.tool().inputSchema).not.toHaveProperty("additionalProperties");
      expect((await x.invoke({})).phase).toBe("not-entered");
    },
  );
  it.each(["mixed", "marker", "mutating", "params", "getter"])(
    "enforces trusted ordinary factory metadata: %s",
    async (kind) => {
      const x = await setup(() => h("p", {}, "Stable"));
      const id = x.port.mount("manual", "Manual");
      let reads = 0;
      const options: any = {
        safeOrdinaryInvocationMode: "ordinary-v1",
        createSafeOrdinaryInvoker: () => async () => ({
          phase: "entered-returned",
          result: { success: true },
        }),
      };
      if (kind === "mixed") options.safeRefInvocationMode = "snapshot-value-v1";
      if (kind === "marker") delete options.createSafeOrdinaryInvoker;
      if (kind === "getter")
        Object.defineProperty(options, "createSafeOrdinaryInvoker", {
          enumerable: true,
          get() {
            reads++;
            throw Error("private");
          },
        });
      const run = () =>
        x.port.registerTool(
          id,
          "read",
          {
            description: "Read",
            params: kind === "params" ? { x: { type: "string" } } : {},
            isMutating: kind === "mutating",
            handler: () => ({ success: true }),
          },
          options,
        );
      if (kind === "marker") {
        run();
        expect(
          x.kernel.validateBoundOrdinaryViewTool(x.tool(), x.tool().targets[0])
            .success,
        ).toBe(false);
      } else expect(run).toThrow();
      expect(reads).toBe(0);
      x.port.unmount(id);
    },
  );
});
