import Type from 'typebox';
export const declaration = { viewType: 'File', name: 'read', description: 'Read.', inputSchema: Type.Object({ path: Type.String() }), execute: () => ({ success: true }) };
