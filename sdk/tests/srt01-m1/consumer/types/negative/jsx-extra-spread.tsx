import { AppTools } from '@aotui/sdk';
import { fileTools } from '../m2-producer.js';
import { bindings } from '../jsx-bindings.js';
const extra = { definition: fileTools, bindings: { ...bindings, unexpected: bindings.readFile } }; export const bad = <AppTools {...extra} />;
