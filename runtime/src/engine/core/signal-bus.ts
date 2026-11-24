import type { UpdateSignal } from '../../spi/core/signals.js';

export type SignalListener = (signal: UpdateSignal) => void;

export class SignalBus {
    private readonly listeners = new Set<SignalListener>();

    subscribe(listener: SignalListener): void {
        this.listeners.add(listener);
    }

    unsubscribe(listener: SignalListener): void {
        this.listeners.delete(listener);
    }

    emit(signal: UpdateSignal, isActive: () => boolean): void {
        for (const listener of this.listeners) {
            if (!isActive()) break;
            try { listener(signal); }
            catch (error) { console.error('[SignalBus] Error in signal listener:', error); }
        }
    }

    cleanup(): void {
        this.listeners.clear();
    }
}
