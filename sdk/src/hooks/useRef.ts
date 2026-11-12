/**
 * Declares a Ref to one application data value.
 *
 * @module @aotui/sdk/useDataRef
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import { captureRefEntries, formatRef, type RefOptions } from '../app-factory/refs.js';
import { useRefRegistry } from '../contexts/view-runtime-context.js';

/** Formats content as a Ref marker for the registered ID. */
export type RefHandle = (content: string) => string;

/**
 * Creates a marker formatter and registers its data for the current View.
 *
 * @param refId - A Ref ID unique within the current View.
 * @param data - The value bound to the Ref.
 * @param options - Explicit business type and optional schema for a JSON Ref. The marker
 * becomes `refType:refId`; registration stays local to its View.
 * Tool input uses `view_id.refId`, without the display type prefix.
 */
export function useDataRef(refId: string, data: unknown, options?: RefOptions): RefHandle {
  const refType = options?.refType;
  const { captureRef, registerRef } = useRefRegistry();
  const captured = captureRefEntries(captureRef, { id: refId, value: data, ...options }).get(refId)!;
  const bindingRef = useRef<{
    binding: ReturnType<typeof registerRef>; refId: string; refType: string | undefined; registerRef: typeof registerRef;
  }>();

  useLayoutEffect(() => () => {
    bindingRef.current?.binding.release();
    bindingRef.current = undefined;
  }, []);

  useLayoutEffect(() => {
    const current = bindingRef.current;
    if (current && current.refId === refId && current.refType === refType && current.registerRef === registerRef) {
      current.binding.update(captured);
    } else {
      current?.binding.release();
      bindingRef.current = undefined;
      const binding = refType === undefined ? registerRef(refId, captured) : registerRef(refId, captured, refType);
      bindingRef.current = { binding, refId, refType, registerRef };
    }
  });

  return content => formatRef(content, refId, refType);
}
