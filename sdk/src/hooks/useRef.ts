/**
 * Declares a Ref to one application data value.
 *
 * @module @aotui/sdk/useDataRef
 */
import { useLayoutEffect } from 'preact/hooks';
import { useRefRegistry } from './useViewContext.js';

/** Formats content as a Ref marker for the registered ID. */
export type RefHandle = (content: string) => string;

/**
 * Creates a marker formatter and registers its data for the current View.
 *
 * @param refId - A Ref ID unique within the current View.
 * @param data - The value bound to the Ref.
 */
export function useDataRef(refId: string, data: object): RefHandle {
  const { registerRef, unregisterRef } = useRefRegistry();

  useLayoutEffect(() => {
    registerRef(refId, data);
    return () => unregisterRef(refId);
  }, [refId, data, registerRef, unregisterRef]);

  return (content: string) => `[${content}](${refId})`;
}
