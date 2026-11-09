import { AppTools } from '@aotui/sdk';
import { fileTools } from '../m2-producer.js';
import { bindings } from '../jsx-bindings.js';
export const bad = <AppTools definition={fileTools} bindings={{ ...bindings, readFile: { ...bindings.readFile, enabled: undefined } }} />;
