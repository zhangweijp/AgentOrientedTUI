import { apply, tools, context, type Input, type Output } from './positive.js';
import type { Tool, DrivenSourceContext } from '@aotui/agent-driver-v2';
import type { ModelMessage } from 'ai';
export const transferred: Tool<Input,Output> = apply;
export const complete: DrivenSourceContext = { ...context, tools };
export function acceptCallback(callback: (message: ModelMessage) => void): (message: ModelMessage) => void { return callback; }
