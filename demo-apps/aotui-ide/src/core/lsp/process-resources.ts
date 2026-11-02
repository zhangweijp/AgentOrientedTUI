import type { ChildProcess } from 'node:child_process';
import { IDEError } from '../ide-errors.js';
// Every managed POSIX server starts in its own process group. We retain that
// group until observing it empty; no descendant PID list or detached/unref
// shortcut is used as evidence of resource release.
const alive = (group: number) => {
    try { process.kill(-group, 0); return true; }
    catch (error: any) {
        if (error.code === 'ESRCH') return false;
        // EPERM is not proof of absence. Retain the group and poll within the
        // same deadline; a persistently inaccessible group still fails close.
        if (error.code === 'EPERM') return true;
        throw error;
    }
};
async function waitGone(group: number, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (alive(group)) { if (Date.now() >= until) return false; await new Promise(resolve => setTimeout(resolve, 25)); }
    return true;
}
export function signalProcessGroup(group: number | undefined, child: ChildProcess, signal: NodeJS.Signals): void {
    if (!group) { child.kill(signal); return; }
    try { process.kill(-group, signal); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
}
export async function joinProcessGroup(group: number | undefined): Promise<void> {
    if (!group) throw new IDEError('LSP_PROCESS_GROUP_UNVERIFIED');
    if (await waitGone(group, 5000)) return;
    try { process.kill(-group, 'SIGTERM'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
    if (!await waitGone(group, 5000)) {
        try { process.kill(-group, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
        await waitGone(group, 5000);
    }
    throw new IDEError('LSP_DESCENDANT_SHUTDOWN_FAILED');
}
