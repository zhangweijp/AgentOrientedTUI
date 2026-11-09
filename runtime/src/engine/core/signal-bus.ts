/**
 * SignalBus - Desktop 信号发布订阅
 * 
 * [H1 拆分] 从 Desktop 提取的信号管理模块。
 * 
 * 职责:
 * - 管理 UpdateSignal 订阅者
 * - 发布信号到订阅者
 */

import type { DesktopID, UpdateSignal } from '../../spi/index.js';

export type SignalListener = (signal: UpdateSignal) => void;

/**
 * SignalBus - 统一管理所有 Desktop 的信号发布订阅
 */
export class SignalBus {
    private states = new Map<DesktopID, Set<SignalListener>>();
    /**
     * 订阅指定 Desktop 的信号
     * 
     * @param desktopId Desktop ID
     * @param listener 信号处理函数
     * @returns 取消订阅的函数
     */
    subscribe(desktopId: DesktopID, listener: SignalListener): () => void {
        const state = this.states.get(desktopId) ?? new Set<SignalListener>();
        this.states.set(desktopId, state);
        state.add(listener);

        return () => {
            state.delete(listener);
        };
    }

    /**
     * 发布信号到指定 Desktop 的所有订阅者
     */
    emit(desktopId: DesktopID, signal: UpdateSignal): void {
        const state = this.states.get(desktopId);
        if (!state) return;

        state.forEach(listener => {
            try { listener(signal); }
            catch (error) { console.error('[SignalBus] Error in signal listener:', error); }
        });
    }

    /**
     * 便捷方法：发布带原因的信号
     */
    emitSignal(desktopId: DesktopID, reason: UpdateSignal['reason']): void {
        this.emit(desktopId, {
            desktopId,
            timestamp: Date.now(),
            reason
        });
    }

    /**
     * 清理指定 Desktop 的所有状态
     */
    cleanup(desktopId: DesktopID): void {
        this.states.delete(desktopId);
    }

    /**
     * 获取订阅者数量（用于调试）
     */
    getListenerCount(desktopId: DesktopID): number {
        return this.states.get(desktopId)?.size ?? 0;
    }


}

