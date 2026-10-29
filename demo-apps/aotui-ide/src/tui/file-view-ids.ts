/**
 * FileDetail's public viewId is stable for one mounted file lifetime.
 * Never derive it from the current array index (which changes on close/reorder).
 */
export function reconcileFileViewIds(
  paths: readonly string[],
  previous: ReadonlyMap<string, string>,
  nextId: number
): { ids: ReadonlyMap<string, string>; nextId: number } {
  const ids = new Map<string, string>();
  for (const filePath of paths) {
    if (ids.has(filePath)) {
      throw new Error('Duplicate FileDetail path: ' + filePath);
    }
    ids.set(filePath, previous.get(filePath) ?? `fd_${nextId++}`);
  }
  return { ids, nextId };
}
