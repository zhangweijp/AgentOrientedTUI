import { readFileSync } from 'node:fs';

export function loadAOTUIInstruction(options: { instruction?: string; instructionPath?: string }, fallback: string): string {
    if (options.instruction?.trim()) return options.instruction.trim();
    const path = options.instructionPath ?? process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
    if (!path) return fallback;
    try { return readFileSync(path, 'utf8'); }
    catch (error) {
        console.error(`[AOTUIDrivenSource] Failed to load system instruction from path: ${path}`, error);
        return fallback;
    }
}

