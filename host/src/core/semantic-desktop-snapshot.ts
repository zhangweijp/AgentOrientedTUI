import type { IDesktop, IKernel } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/runtime/adapters';

/** GUI inspection owns a separate short-lived observation; it cannot replace an in-flight Agent context. */
export async function readSemanticDesktopSnapshot(desktop: IDesktop, kernel: IKernel): Promise<{ markup: string }> {
    const source = new SemanticAOTUIDrivenSource(desktop, kernel, { includeInstruction: false });
    let context: Awaited<ReturnType<typeof source.getContext>> | undefined;
    try {
        context = await source.getContext();
        const markup = context.messages.map(message => typeof message.content === 'string' ? message.content
            : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')).join('\n\n');
        return { markup };
    } finally {
        await context?.release?.();
        await source.dispose();
    }
}
