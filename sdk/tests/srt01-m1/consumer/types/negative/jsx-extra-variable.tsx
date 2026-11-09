import { AppTools } from '@aotui/sdk';
import { fileTools } from '../m2-producer.js';
import { bindings } from '../jsx-bindings.js';
const extra = { ...bindings, unexpected: bindings.readFile }; export const bad = <AppTools definition={fileTools} bindings={extra} />;
