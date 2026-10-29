/**
 * AOTUI SDK - useViewTypeTool Hook
 *
 * View Type Tool Aggregation - 注册 Type-level 工具
 *
 * Type Tool 绑定到 View Type 而非具体实例，在根视图中聚合展示。
 * LLM 调用时需显式传入 `view_id` 参数指定目标 View。
 *
 * @example 基础用法
 * ```tsx
 * // 在 WorkspaceContent (根视图) 中注册
 * useViewTypeTool('FileDetail', 'lsp_hover', {
 *     description: `Get type info. REQUIRED: view_id (e.g., "fd_0")`,
 *     params: defineParams({
 *         view_id: { type: 'string', required: true, desc: 'Target View ID' },
 *         line: { type: 'number', required: true },
 *         character: { type: 'number', required: true }
 *     })
 * }, async ({ view_id, line, character }) => {
 *     const filePath = getFilePathByViewId(view_id);
 *     // ... LSP 调用
 *     return { success: true };
 * });
 * ```
 *
 * @module @aotui/sdk/hooks/useViewTypeTool
 */

import { h, type VNode } from "preact";
import { useLayoutEffect, useRef, useContext, useMemo } from "./preact-hooks.js";
import { ViewRuntimeContext } from "../contexts/index.js";
import { validateArgs, formatValidationErrors } from "../utils/validateArgs.js";

// Import types from operation/types.ts
import type {
    ParamSchema,
    InferArgs,
    OperationResult,
} from "../operation/types.js";

// ─────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────

/** Type Tool 配置选项 */
export interface TypeToolOptions<T extends ParamSchema = ParamSchema> {
    /** Only explicit false allows experimental source-bound read-only execution. */
    isMutating?: boolean;
    /** 工具描述（应包含 view_id 参数说明） */
    description: string;
    /** 参数定义（必须包含 view_id） */
    params: T;
}

/** Type Tool Handler */
export type TypeToolHandler<T = any> = (
    args: T
) => Promise<OperationResult>;

/** Type Tool UI 组件 Props */
export interface TypeToolUIProps {
    /** 子元素（可选，默认显示工具名） */
    children?: string;
}

/** Type Tool UI 渲染器类型 */
export type TypeToolUI = (props: TypeToolUIProps) => VNode | null;

/** useViewTypeTool 返回值 */
export type UseViewTypeToolResult = [TypeToolUI];

// ─────────────────────────────────────────────────────────────
//  Hook Implementation  
// ─────────────────────────────────────────────────────────────

/**
 * 注册一个 Type-level Tool
 *
 * 工具 ID 格式: `app_name-view_type-tool_id`
 * LLM 必须传入 `view_id` 参数来指定目标 View
 *
 * @param viewType - View 类型（如 "FileDetail"）
 * @param toolName - 工具名（如 "lsp_hover"）
 * @param options - 工具配置选项
 * @param handler - 执行处理函数
 * @returns [TypeToolUI] - UI 渲染器组件
 */
/** New View-local API: derives the ViewType and target instance from View context. */
export function useViewTypeTool<T extends ParamSchema = ParamSchema>(
    toolName: string,
    options: TypeToolOptions<T>,
    handler: TypeToolHandler<InferArgs<T>>,
    config?: { enabled?: boolean },
): UseViewTypeToolResult;
/** Existing Root-owned type-wide API: kept unchanged until M4 source-bound migration. */
export function useViewTypeTool<T extends ParamSchema = ParamSchema>(
    viewType: string,
    toolName: string,
    options: TypeToolOptions<T>,
    handler: TypeToolHandler<InferArgs<T>>,
    config?: { enabled?: boolean },
): UseViewTypeToolResult;
export function useViewTypeTool<T extends ParamSchema = ParamSchema>(
    viewTypeOrName: string,
    toolNameOrOptions: string | TypeToolOptions<T>,
    optionsOrHandler: TypeToolOptions<T> | TypeToolHandler<InferArgs<T>>,
    handlerOrConfig?: TypeToolHandler<InferArgs<T>> | { enabled?: boolean },
    legacyConfig?: { enabled?: boolean },
): UseViewTypeToolResult {
    const isLegacy = typeof toolNameOrOptions === 'string';
    const ctx = useContext(ViewRuntimeContext);
    if (!ctx) {
        throw new Error('[AOTUI SDK] useViewTypeTool must be used within a View');
    }
    const viewType = isLegacy ? viewTypeOrName : (ctx.meta.viewType ?? '');
    const toolName = isLegacy ? toolNameOrOptions : viewTypeOrName;
    const options = (isLegacy ? optionsOrHandler : toolNameOrOptions) as TypeToolOptions<T>;
    const handler = (isLegacy ? handlerOrConfig : optionsOrHandler) as TypeToolHandler<InferArgs<T>>;
    const config = (isLegacy ? legacyConfig : handlerOrConfig) as { enabled?: boolean } | undefined;
    const enabled = config?.enabled ?? true;
    const { description, params } = options;

    // 使用 ref 保存最新 handler，避免重新注册
    const handlerRef = useRef(handler);
    handlerRef.current = handler;
    const paramsRef = useRef(params);
    paramsRef.current = params;
    // View-local declarations compare JSON parameter value rather than the
    // fresh object identity created by inline defineParams() on each render.
    const localParamsKey = isLegacy ? undefined : ctx.viewTools?.fingerprintParams(params);

    // 创建 stable wrapper (仅当 params 变化时重建)
    const stableHandler = useMemo(() => {
        return async (args: Record<string, unknown>): Promise<OperationResult> => {
            // 运行时参数验证
            if (paramsRef.current) {
                const errors = validateArgs(args, paramsRef.current);
                if (errors.length > 0) {
                    return {
                        success: false,
                        // @ts-ignore - SPI types mismatch fix later
                        error: {
                            code: "E_INVALID_ARGS",
                            message: formatValidationErrors(errors),
                            context: { errors, receivedArgs: args },
                        },
                    };
                }
            }

            // 调用用户 handler
            const currentHandler = handlerRef.current;

            try {
                const result = await currentHandler(args as InferArgs<T>);
                return {
                    success: result.success,
                    data: result.data,
                    error: result.error,
                };
            } catch (err) {
                return {
                    success: false,
                    error: {
                        code: "E_HANDLER_ERROR",
                        message: err instanceof Error ? err.message : String(err),
                    },
                };
            }
        };
    }, [isLegacy ? params : undefined]); // Legacy signature retains existing effect behavior.

    // 注册 Type Tool 到 AppKernel
    // Tool availability must match the committed View/Ref projection, not a later passive effect.
    useLayoutEffect(() => {
        if (!isLegacy) {
            if (!ctx.viewTools) {
                throw new Error('[AOTUI SDK] View-local Tools require a Runtime View-owned Tool port');
            }
            if (!enabled) return;
            return ctx.viewTools.registerTool(toolName, {
                description, params, handler: stableHandler,
                isMutating: options.isMutating ?? true,
            });
        }

        // [RFC-020-Fix] 使用 Context API 直接注册
        if (!ctx.typeTools) {
            console.warn("[SDK] ViewRuntimeContext.typeTools is missing. Type Tools will not be registered.");
            return;
        }

        // [Conditional Registration] 如果 enabled=false，只卸载，不注册
        if (!enabled) {
            try {
                ctx.typeTools.unregisterTypeTool(viewType, toolName);
            } catch (err) {
                // 如果工具本来就不存在，忽略错误
            }
            return;
        }

        try {
            ctx.typeTools.registerTypeTool(viewType, toolName, {
                description,
                params,
                handler: stableHandler,
                ...(ctx.meta.viewGeneration ? {
                    declaredByViewId: ctx.meta.viewId,
                    declaredByViewGeneration: ctx.meta.viewGeneration,
                } : {}),
            });
        } catch (err) {
            console.error(`[SDK] Failed to register type tool ${viewType}.${toolName}:`, err);
        }

        return () => {
            // Cleanup: Unregister tool
            if (ctx.typeTools) {
                try {
                    ctx.typeTools.unregisterTypeTool(viewType, toolName);
                } catch (err) {
                    console.error(`[SDK] Failed to unregister type tool ${viewType}.${toolName}:`, err);
                }
            }
        };
    }, [isLegacy, viewType, toolName, description, options.isMutating, isLegacy ? params : localParamsKey, stableHandler, ctx.typeTools, ctx.viewTools, ctx.meta.viewId, ctx.meta.viewGeneration, enabled]);

    // 创建 UI 渲染器组件
    const TypeToolUIComponent = useMemo(() => {
        const UIComponent: TypeToolUI = ({ children }: TypeToolUIProps): VNode | null => {
            // Stage 1: a local Tool cannot be invoked by Agent until source-bound
            // Snapshot dispatch is implemented. Do not render a ghost marker.
            if (!isLegacy) return null;
            // 渲染为 <tool-ref> 元素
            return h(
                "tool-ref",
                {
                    "view-type": viewType,
                    "tool-name": toolName,
                    desc: description,
                } as any,
                children || toolName
            ) as VNode;
        };
        (UIComponent as any).displayName = `TypeToolUI(${viewType}.${toolName})`;
        return UIComponent;
    }, [isLegacy, viewType, toolName, description]);

    return [TypeToolUIComponent];
}
