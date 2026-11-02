import {
  initialLoadedDiagnostics,
  transitionLoadedDiagnostics,
  loadedDiagnostic,
} from "../tui/loaded-diagnostics.js";
const diagnostic = () => ({
  range: { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } },
  severity: 1,
  message: "",
  line: 0,
  character: 0,
  code: undefined,
  source: undefined,
});
describe("loaded diagnostic DTO and local state versions", () => {
  test("omits known optional undefined while preserving zero and empty strings", () => {
    expect(loadedDiagnostic(diagnostic())).toEqual({
      range: diagnostic().range,
      severity: 1,
      message: "",
      line: 0,
      character: 0,
    });
    expect(
      loadedDiagnostic({ ...diagnostic(), code: 0, source: "" }),
    ).toMatchObject({ code: 0, source: "" });
  });
  test("versions accepted transitions only, with explicit idle/loading/error payloads", () => {
    const idle = initialLoadedDiagnostics("A");
    expect(idle).toEqual({
      filePath: "A",
      stateVersion: 0,
      status: "idle",
      diagnostics: [],
      updatedAt: null,
      error: null,
    });
    const loading = transitionLoadedDiagnostics(idle, "A", "loading", [], 0);
    const success = transitionLoadedDiagnostics(
      loading,
      "A",
      "success",
      [diagnostic()],
      1,
    );
    const error = transitionLoadedDiagnostics(
      success,
      "A",
      "error",
      [],
      2,
      "failure",
    );
    expect([
      loading.stateVersion,
      success.stateVersion,
      error.stateVersion,
    ]).toEqual([1, 2, 3]);
    expect(error).toMatchObject({ diagnostics: [], error: "failure" });
    expect(loading.updatedAt).toBe(0);
    expect(Object.isFrozen(success.diagnostics[0])).toBe(true);
  });
  test("copies ranges and preserves oversized content for wire budget rejection", () => {
    const d = diagnostic();
    const dto = loadedDiagnostic(d);
    d.range.start.line = 99;
    expect(dto.range.start.line).toBe(0);
    const text = "x".repeat(524288);
    expect(loadedDiagnostic({ ...diagnostic(), message: text }).message).toBe(
      text,
    );
  });
  test("refuses malformed required and optional data without truncation/getter execution", () => {
    for (const d of [
      { ...diagnostic(), message: undefined },
      { ...diagnostic(), code: {} },
      { ...diagnostic(), range: null },
      {
        ...diagnostic(),
        get source() {
          throw Error("private");
        },
      },
    ])
      expect(() => loadedDiagnostic(d as any)).toThrow();
  });
});
