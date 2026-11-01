/**
 * SPI Core Layer - Foundation Types
 * 
 * 最基础的类型定义，零外部依赖。
 * 这是整个 AOTUI 框架的"语言"。
 * 
 * @module @aotui/runtime/spi/core
 */

// ============================================================================
// ID Types
// ============================================================================
export type {
    DesktopID,
    AppID,
    ViewID,
} from './types.js';

// ============================================================================
// ID Factory Functions
// ============================================================================
export {
    // Factory Functions
    createDesktopId,
    createAppId,
    createViewId,
    // Constants
    ID_PREFIXES,
} from './id-factory.js';


// ============================================================================
// Data Structures
// ============================================================================
export type {
    DataPayload,
} from './types.js';

// ============================================================================
// State Types
// ============================================================================
export type {
    DesktopStatus,
    AppState,
    DesktopState,
} from './types.js';

// ============================================================================
// Operation Types
// ============================================================================
export type {
    OperationError,
    OperationResult,
} from './operations.js';

// ============================================================================
// Signals
// ============================================================================
export type { UpdateSignal } from './signals.js';

// ============================================================================
// Error System
// ============================================================================
export {
    ERROR_CODES,
    AOTUIError,
} from './errors.js';

export type { ErrorCode } from './errors.js';

// ============================================================================
// LLM Output Types (RFC-011)
// ============================================================================
export type {
    LLMOutputEvent,
    LLMOutputEventMeta,
    LLMOutputListener,
} from './llm-output.js';
