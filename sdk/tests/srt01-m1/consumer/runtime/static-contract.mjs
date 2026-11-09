import test from 'node:test';
import assert from 'node:assert/strict';
import Type from 'typebox';
import * as tools from '@aotui/sdk/tools';
import * as root from '@aotui/sdk';
import { staticCases } from './static-cases.mjs';

for (const [name, check] of staticCases(tools, Type)) test(name, check);

test('root and tools exports share constructors and private brand tables', () => {
  for (const name of ['defineViewTypeTool', 'defineToolSet', 'getToolCatalog']) assert.equal(root[name], tools[name]);
  const definition = name => ({ viewType: 'File', name, description: 'Read.', inputSchema: Type.Object({ path: Type.String() }) });
  const fromRoot = root.defineViewTypeTool(definition('root'));
  const fromTools = tools.defineViewTypeTool(definition('tools'));
  const rootSet = root.defineToolSet({ fromTools });
  const toolsSet = tools.defineToolSet({ fromRoot });
  assert.equal(tools.getToolCatalog(rootSet)[0].name, 'tools');
  assert.equal(root.getToolCatalog(toolsSet)[0].name, 'root');
});

test('pure entry exposes pure tools and implemented root Preact adapters', () => {
  assert.deepEqual(Object.keys(tools).sort(), ['TOOL_BINDING_DIAGNOSTIC_LIMITS', 'createToolBindings', 'defineToolSet', 'defineViewTypeTool', 'getToolCatalog', 'refParam']);
  for (const name of ['AppTools', 'ToolRef', 'ToolCatalog']) {
    assert.equal(typeof root[name], 'function');
    assert.equal(Object.hasOwn(tools, name), false);
  }
  assert.equal(Object.hasOwn(root, 'useViewTypeTool'), false);
  assert.equal(Object.hasOwn(tools, 'useViewTypeTool'), false);
});
