/**
 * AOTUI SDK - useViewTypeTool Hook
 *
 * View Type Tool Aggregation - 注册 Type-level 工具
 *
 * 四参 legacy 调用绑定 View Type，通常显式声明 view_id；
 * 三参 View-local 调用从父 View 获取目标，不要求应用声明 view_id。
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
import { invokeOrdinaryTool, isEmptyOrdinaryObject } from '../utils/ordinary-tool.js';
import { invokeOrdinaryParameterTool } from '../utils/ordinary-parameter-tool.js';
import { invokeSnapshotValueTool } from "../utils/snapshot-value-tool.js";

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
    /** Defaults to a state-changing Tool; business preconditions remain application-owned. */
    isMutating?: boolean;
    additionalProperties?: boolean;
    /** 工具描述；四参 legacy 调用应说明显式目标参数。 */
    description: string;
    /** 参数定义；三参 View-local 调用由运行时绑定目标。 */
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
 * 四参 legacy 重载通常使用显式 view_id；三参重载使用父 View 的来源绑定。
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
    const optionFields = Object.getOwnPropertyDescriptors(options);
    for (const key of ['description', 'params', 'isMutating', 'additionalProperties']) {
        const field = optionFields[key];
        if (field && (!field.enumerable || !('value' in field))) {
            throw new Error('Accessors/hidden properties are forbidden');
        }
    }
    const description = optionFields.description?.value as string;
    const params = optionFields.params?.value as T;
    const isMutating = optionFields.isMutating?.value as boolean | undefined;
    const additionalProperties = optionFields.additionalProperties?.value ?? false;
    if (typeof additionalProperties !== 'boolean') throw new Error('additionalProperties must be boolean');
    // Detect presence only. The supporting Runtime validates copied declarations
    // in fingerprintParams; no new SPI value import breaks an older Runtime.
    const parameterFields = Object.values(Object.getOwnPropertyDescriptors(params));
    const requestsRefDeclaration = parameterFields.some(field => {
        if (!('value' in field)) throw new Error('Accessors/hidden properties are forbidden');
        const value = field.value;
        return value && typeof value === 'object' &&
            (Object.hasOwn(value, 'refSource') || Object.hasOwn(value, 'x-aotui-ref'));
    });
    const hasReferenceParameter = parameterFields.some(field => 'value' in field && field.value &&
        typeof field.value === 'object' && Object.getOwnPropertyDescriptor(field.value, 'type')?.value === 'reference');
    if (requestsRefDeclaration) {
        if (isLegacy || ctx.viewTools?.refDeclarationSupport !== 'snapshot-value-v1') {
            throw new Error('REF_CONTRACT_UNSUPPORTED: Runtime cannot preserve this View-local Ref declaration');
        }
        if (isMutating !== false) {
            throw new Error('REF_DECLARATION_INVALID: Ref declarations require an explicitly read-only Tool');
        }
    }

    // 使用 ref 保存最新 handler，避免重新注册
    const handlerRef = useRef(handler);
    handlerRef.current = handler;
    const paramsRef = useRef(params);
    paramsRef.current = params;
    const committedHandler = useRef(handler);
    useLayoutEffect(() => { committedHandler.current = handler; });
    // View-local declarations compare JSON parameter value rather than the
    // fresh object identity created by inline defineParams() on each render.
    const ordinaryV2 = !isLegacy && !requestsRefDeclaration && !hasReferenceParameter &&
        (isMutating !== false || additionalProperties || !isEmptyOrdinaryObject(params)) &&
        ctx.viewTools?.safeOrdinaryParametersInvocationSupport === 'ordinary-v2' &&
        typeof ctx.viewTools.fingerprintOrdinaryParams === 'function';
    const localParamsKey = ordinaryV2 ? ctx.viewTools!.fingerprintOrdinaryParams!(params, additionalProperties)
        : isLegacy ? undefined : ctx.viewTools?.fingerprintParams(params);
    const ordinaryRegistration = useRef<{ name: string; description: string; key: string; mutating: boolean; release(): void }>();
    useLayoutEffect(() => () => {
        ordinaryRegistration.current?.release(); ordinaryRegistration.current = undefined;
    }, [ctx.viewTools, ctx.meta.viewId, ctx.meta.viewGeneration]);
    useLayoutEffect(() => {
        const previous = ordinaryRegistration.current;
        if (!ordinaryV2 || !enabled) {
            previous?.release(); ordinaryRegistration.current = undefined;
        } else if (!previous || previous.name !== toolName || previous.description !== description ||
            previous.key !== localParamsKey || previous.mutating !== (isMutating ?? true)) {
            previous?.release(); ordinaryRegistration.current = undefined;
            let capturedKey = localParamsKey!;
            const release = ctx.viewTools!.registerTool(toolName, {
                description, params, isMutating: isMutating ?? true,
                handler: async () => ({ success: false, error: { code: 'TOOL_EXECUTION_UNAVAILABLE', message: 'Use the negotiated Tool channel' } }),
            }, {
                safeOrdinaryParametersInvocationMode: 'ordinary-v2', additionalProperties,
                createSafeOrdinaryParametersInvoker: contract => {
                    capturedKey = contract.fingerprint;
                    return args => invokeOrdinaryParameterTool(contract, args,
                        effective => committedHandler.current(effective as InferArgs<T>));
                },
            });
            ordinaryRegistration.current = { name: toolName, description, key: capturedKey, mutating: isMutating ?? true, release };
        }
    });

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
            if (!enabled || ordinaryV2) return;
            return ctx.viewTools.registerTool(toolName, {
                description, params, handler: stableHandler,
                isMutating: isMutating ?? true,
            }, requestsRefDeclaration && ctx.viewTools.safeRefInvocationSupport === 'snapshot-value-v1' ? {
                safeRefInvocationMode: 'snapshot-value-v1',
                createSafeRefInvoker: committedParams => args => invokeSnapshotValueTool(
                    committedParams as ParamSchema, args,
                    effective => committedHandler.current(effective as InferArgs<T>),
                ),
            } : isMutating === false && isEmptyOrdinaryObject(params) && ctx.viewTools.safeOrdinaryInvocationSupport === 'ordinary-v1' ? {
                safeOrdinaryInvocationMode: 'ordinary-v1',
                createSafeOrdinaryInvoker: committedParams => args => invokeOrdinaryTool(committedParams,args,
                    effective => committedHandler.current(effective as InferArgs<T>)),
            } : undefined);
        }

        // [RFC-020-Fix] 使用 Context API 直接注册
        if (!ctx.typeTools) {
            if (enabled) throw new Error('SDK_TYPE_TOOLS_UNAVAILABLE: legacy useViewTypeTool requires a Runtime context with typeTools; use a supporting host or disable this registration.');
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
    }, [isLegacy, ordinaryV2, viewType, toolName, description, isMutating, isLegacy ? params : localParamsKey, stableHandler, ctx.typeTools, ctx.viewTools, ctx.meta.viewId, ctx.meta.viewGeneration, enabled]);

    // 创建 UI 渲染器组件
    const TypeToolUIComponent = useMemo(() => {
        const UIComponent: TypeToolUI = ({ children }: TypeToolUIProps): VNode | null => {
            if (!isLegacy && !ordinaryV2) return null;
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
    }, [isLegacy, ordinaryV2, viewType, toolName, description]);

    return [TypeToolUIComponent];
}
