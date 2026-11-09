import Type from 'typebox';
import { defineViewTypeTool } from '@aotui/sdk/tools';
defineViewTypeTool({ viewType: 'File', name: 'read', description: 'Read.', inputSchema: Type.String() });
