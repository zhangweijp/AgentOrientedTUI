/**
 * Declares a Ref to one application data value.
 *
 * @module @aotui/sdk/useDataRef
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import type Type from 'typebox';
import { captureRefEntries, formatRef, ref, type RefOptions, type RefSourceValue } from '../app-factory/refs.js';
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
export function useDataRef<Schema extends Type.TSchema>(
  refId: string, data: RefSourceValue<Schema>, options?: RefOptions<Schema>,
): RefHandle {
  const descriptor = ref(refId, data, options);
  const { refType } = descriptor;
  const { captureRef, registerRef } = useRefRegistry();
  const captured = captureRefEntries(captureRef, descriptor).get(refId)!;
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

  return content => formatRef(content, descriptor);
}
