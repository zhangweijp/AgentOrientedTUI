/**
 * Ref Exporter Interface
 * 
 * Defines the contract for registering and exporting Refs between SDK and Runtime.
 * This replaces the global __AOTUI_REF_REGISTRY__ with an explicit interface.
 * 
 * [RFC-002] Ref Registry Refactoring
 */

export interface IRefExporter {
    /**
     * Register a Ref data object
     * @param viewId The View ID
     * @param refId The Ref ID (unique within the View)
     * @param data The data object
     */
    registerRef(viewId: string, refId: string, data: object, refType?: string): IRefBinding;
}

/** A Ref registration handle; only its owner can update or release it. */
export interface IRefBinding {
    update(data: object): void;
    release(): void;
}
