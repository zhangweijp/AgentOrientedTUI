/**
 * SPI Layer - Foundation Types
 * 
 * 最基础的类型定义，零依赖。
 * 这些类型是整个 Runtime 的"语言"。
 */

// ============================================================================
// Branded Type Symbol
// ============================================================================

/**
 * 用于创建 Branded Types 的 unique symbol。
 * 
 * Branded Types 在编译期区分不同的 ID 类型，防止混用。
 * 例如：`getDesktop(appId)` 会在编译时报错。
 * 
 * @internal
 */
declare const __brand: unique symbol;

// ============================================================================
// 标识符类型 (Branded Types)
// ============================================================================

/** 桌面唯一标识 (Branded Type) */
export type DesktopID = string & { readonly [__brand]: 'DesktopID' };

/** 应用唯一标识 (Branded Type) */
export type AppID = string & { readonly [__brand]: 'AppID' };
