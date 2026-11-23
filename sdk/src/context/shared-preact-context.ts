import { createContext, options, type Context } from 'preact';
import { VIEW_TYPE_TOOL_PROTOCOL } from '@aotui/core';

/** Share Context identity only between adapter copies using this Preact instance. */
export function sharedPreactContext<Value>(name: 'app' | 'view'): Context<Value | null> {
    const key = Symbol.for('@aotui/sdk/' + VIEW_TYPE_TOOL_PROTOCOL + '/' + name + '-context');
    const existing = Object.getOwnPropertyDescriptor(options, key);
    if (existing) return existing.value as Context<Value | null>;
    const context = createContext<Value | null>(null);
    Object.defineProperty(options, key, { value: context });
    return context;
}
