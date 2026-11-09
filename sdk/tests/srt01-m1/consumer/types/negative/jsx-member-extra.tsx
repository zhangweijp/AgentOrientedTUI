import { AppTools } from '@aotui/sdk';
import { fileTools } from '../m2-producer.js';
import { bindings } from '../jsx-bindings.js';
const extra = { ...bindings, readFile: { ...bindings.readFile, surprise: true } }; export const bad = <AppTools definition={fileTools} bindings={extra} />;
