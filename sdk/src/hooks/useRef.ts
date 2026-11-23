/**
 * Declares a Ref to one application data value.
 *
 * @module @aotui/sdk/useDataRef
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import type Type from 'typebox';
import { capturePublication, formatRef, ref, type PublishedRef, type RefOptions, type RefSourceValue } from '../app-factory/refs.js';
import { useRefRegistry } from '../contexts/view-runtime-context.js';

/** Formats content as a Ref marker for the registered ID. */
export type RefHandle = (content: string) => string;

/**
 * Creates a marker formatter and registers its data for the current View.
 *
 * @param refId - A Ref ID unique within the current View.
 * @param data - The value bound to the Ref.
 * @param options - Explicit publication scope and optional business type and schema.
 */
export function useDataRef<Schema extends Type.TSchema>(
  refId: string, data: RefSourceValue<Schema>, options: RefOptions<Schema>,
): RefHandle {
  const descriptor = ref(refId, data, options);
  usePublishedRef('useDataRef', descriptor);
  return content => formatRef(content, descriptor);
}

export function usePublishedRef(hook: 'useDataRef' | 'useArrayRef', descriptor: PublishedRef): void {
  const { id } = descriptor;
  const { captureRef, registerRef } = useRefRegistry(hook, id);
  const captured = capturePublication(captureRef, descriptor);
  const bindingRef = useRef<{
    binding: ReturnType<typeof registerRef>; id: string; registerRef: typeof registerRef;
  }>();

  useLayoutEffect(() => () => {
    bindingRef.current?.binding.release();
    bindingRef.current = undefined;
  }, []);

  useLayoutEffect(() => {
    const current = bindingRef.current;
    if (current && current.id === id && current.registerRef === registerRef) {
      current.binding.update(captured);
    } else {
      current?.binding.release();
      bindingRef.current = undefined;
      bindingRef.current = { binding: registerRef(captured), id, registerRef };
    }
  });
}
