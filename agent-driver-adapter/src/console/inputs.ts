import { checkWireJson, type ActiveTurn, type InteractionIssue, type JsonValue, type PublicRefValue } from '@aotui/core';

type InputPath = Omit<PublicRefValue, 'value'>;
type Tree = Record<string, JsonValue>;
export type ConsoleInputs = Readonly<{ status: 'ready'; refs: Tree; paths: readonly InputPath[] }> |
    Readonly<{ status: 'rejected'; issue: InteractionIssue }>;

export const consoleInputCapacity = { code: 'CONSOLE_INPUT_CAPACITY', message: 'Console inputs exceed the limit. Supply a smaller imports list.' };

export async function prepareConsoleInputs(turn: Pick<ActiveTurn, 'readPublicRefs'>, imports?: readonly string[]): Promise<ConsoleInputs> {
    const selected = await turn.readPublicRefs(imports);
    if (selected.status === 'rejected')
        return selected.issue.code === 'REF_READ_CAPACITY' ? { status: 'rejected', issue: consoleInputCapacity } : selected;

    // Core checks every requested path before the Console removes overlapping branches.
    const paths: InputPath[] = [];
    const refs: Tree = Object.create(null);
    for (const { value, ...entry } of [...selected.refs].sort((a, b) => a.path.length - b.path.length)) {
        if (paths.some(parent => parent.appId === entry.appId && parent.viewId === entry.viewId &&
            parent.refId === entry.refId && parent.path.every((part, i) => part === entry.path[i]))) continue;
        paths.push(entry);
        const keys = [entry.appId, entry.viewId, entry.refId, ...entry.path.map(String)];
        const leaf = keys.pop()!;
        let node = refs;
        for (const key of keys) node = (node[key] ??= Object.create(null)) as Tree;
        node[leaf] = value;
    }
    const result = { status: 'ready' as const, refs, paths };
    try {
        checkWireJson(result, { maxDepth: 40, maxNodes: 12_000, maxCanonicalBytes: 128 * 1024 }, true);
        return result;
    } catch { return { status: 'rejected', issue: consoleInputCapacity }; }
}
