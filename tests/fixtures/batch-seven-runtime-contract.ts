import { createAppId, createDesktopId, createRuntime, type IKernel, type IDesktop, type DesktopCloseHandle,
    type DesktopCloseReport, type RuntimeCloseHandle, type RuntimeCloseReport } from '@aotui/runtime';
// @ts-expect-error Launch config belongs to each registered App.
import type { IRuntimeContext } from '@aotui/runtime/spi';
// @ts-expect-error Worker handshake details stay internal.
import { WORKER_PROTOCOL } from '@aotui/runtime';

// @ts-expect-error Runtime allocates App IDs from names, not numeric indices.
const numericAppId: (id: number) => unknown = createAppId;

export async function closeAndReopen(): Promise<{ desktopReport: DesktopCloseReport; runtimeReport: RuntimeCloseReport }> {
    const runtime: IKernel = createRuntime();
    const id = await runtime.createDesktop(createDesktopId('installed-owner'));
    const desktop: IDesktop = runtime.getDesktop(id);
    if (desktop.isClosing) throw new Error('New Desktop is closing');
    const close: DesktopCloseHandle = desktop.beginClose();
    if (runtime.beginDesktopShutdown(id) !== close) throw new Error('Different Desktop close handles');
    const desktopReport = await close.completion;
    if (!desktopReport.resourcesReleased) throw new Error('Desktop resources are still held');
    await runtime.createDesktop(id);
    if (runtime.getDesktop(id) === desktop) throw new Error('Expected a new Desktop');
    const shutdown: RuntimeCloseHandle = runtime.beginShutdown();
    return { desktopReport, runtimeReport: await shutdown.completion };
}
