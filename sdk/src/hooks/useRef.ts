/**
 * Declares a Ref to one application data value.
 *
 * @module @aotui/sdk/useDataRef
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import { useRefRegistry } from './useViewContext.js';

/** Formats content as a Ref marker for the registered ID. */
export type RefHandle = (content: string) => string;

/**
 * Creates a marker formatter and registers its data for the current View.
 *
 * @param refId - A Ref ID unique within the current View.
 * @param data - The value bound to the Ref.
 * @param options - Explicit business type for a single object Ref. The marker
 * becomes `refType:refId`; registration stays local to its View.
 * Tool input uses `view_id.refId`, without the display type prefix.
 */
export function useDataRef(refId: string, data: object, options?: { refType: string }): RefHandle {
  const refType = options?.refType;
  if (options !== undefined && (typeof refType !== 'string' || refType.trim().length === 0)) {
    throw new TypeError('[AOTUI SDK] useDataRef refType must be a non-empty string.');
  }
  if (refType !== undefined && (data === null || typeof data !== 'object' || Array.isArray(data))) {
    throw new TypeError('[AOTUI SDK] Typed useDataRef data must be a single object.');
  }
  const marker = refType === undefined ? refId : `${refType}:${refId}`;
  const { registerRef } = useRefRegistry();
  const bindingRef = useRef<{ binding: ReturnType<typeof registerRef>; value: object } | null>(null);

  useLayoutEffect(() => {
    const binding = refType === undefined
      ? registerRef(refId, data)
      : registerRef(refId, data, refType);
    const current = { binding, value: data };
    bindingRef.current = current;
    return () => {
      current.binding.release();
      if (bindingRef.current === current) bindingRef.current = null;
    };
  }, [refId, refType, registerRef]);

  useLayoutEffect(() => {
    const current = bindingRef.current;
    if (current && current.value !== data) {
      current.binding.update(data);
      current.value = data;
    }
  }, [data]);

  return (content: string) => `[${content}](${marker})`;
}
