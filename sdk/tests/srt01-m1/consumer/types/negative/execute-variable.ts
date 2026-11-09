import Type from 'typebox';
import { defineViewTypeTool } from '@aotui/sdk';
const declaration = { viewType: 'File', name: 'read', description: 'Read.', inputSchema: Type.Object({ path: Type.String() }), execute: () => ({ success: true }) };
defineViewTypeTool(declaration);
