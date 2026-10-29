import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const [consumer, artifactFacts, output] = process.argv.slice(2);
const sdkPath = path.join(consumer, 'node_modules/@aotui/sdk');
const sdk = await import(pathToFileURL(path.join(sdkPath, 'dist/index.js')).href);
const retired = ['persistenceManager', 'useMountableViewRegistry', 'useDynamicViewRegistry',
    'useResourceRef', 'useSignalStore', 'validateOperationName', 'validateAppId',
    'validateViewId', 'validateFunctionName', 'assertValidOperationName'];
for (const name of retired) assert.equal(Object.hasOwn(sdk, name), false, name);
assert.equal(typeof sdk.useRef, 'function');
assert.equal(typeof sdk.useDataRef, 'function');
assert.equal(typeof sdk.useArrayRef, 'function');
const status = await fs.readFile(path.join(sdkPath, 'docs/api-status.md'), 'utf8');
const names = section => status.match(new RegExp(section + ' export：\\s*```text\\n([\\s\\S]*?)\\n```'))[1].split(/[\s,]+/u).filter(Boolean).sort();
assert.deepEqual(Object.keys(sdk).sort(), names('值'));

const require = createRequire(path.join(consumer, 'package.json'));
const ts = require('typescript');
const entry = path.join(sdkPath, 'dist/index.d.ts');
const program = ts.createProgram([entry], { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, skipLibCheck: false, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: ['node'], typeRoots: [path.join(consumer, 'node_modules/@types')] });
const checker = program.getTypeChecker();
const symbols = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(entry)));
const types = symbols.filter(symbol => {
    const actual = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return Boolean(actual.flags & ts.SymbolFlags.Type);
}).map(symbol => symbol.name).sort();
assert.deepEqual(types, names('类型'));

const facts = JSON.parse(await fs.readFile(artifactFacts, 'utf8'));
const forbidden = ['dist/engine/view/snapshot/builder.', 'dist/engine/view/transformer/index.',
    'dist/adapters/session/', 'dist/core/invocation/bound-action-executor.',
    'dist/engine/core/operation-log-buffer.', 'dist/worker-runtime/app-kernel/view-tree.',
    'dist/spi/app/view-tree.interface.', 'dist/spi/runtime/transformer.interface.',
    'dist/core/snapshot/workspace.', 'dist/hooks/persistence-manager.',
    'dist/hooks/useSignalStore.', 'dist/utils/validation.'];
for (const artifact of facts.artifacts) {
    for (const file of artifact.files) {
        assert.equal(forbidden.some(name => file.includes(name)), false, file);
    }
}
const removedTypes = { '@aotui/sdk': ['SignalStore', 'IMountableViewRegistry'],
    '@aotui/runtime/spi': ['IViewTree', 'ViewNode', 'ViewContextFactory', 'MountableViewEntry',
        'ITransformer', 'IOperationLogBuffer', 'IMountableViewRegistry', 'IDynamicViewRegistry'] };
const negative = path.join(consumer, 'retired-types.ts');
await fs.writeFile(negative, Object.entries(removedTypes).flatMap(([module, exports]) => exports.map((name, index) =>
    `// @ts-expect-error C01 removed this public type.\nimport type { ${name} as Removed_${module.replace(/\W/g, '_')}_${index} } from '${module}';`)).join('\n'));
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), negative,
    '--noEmit', '--strict', '--skipLibCheck', 'false', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--target', 'ES2022'], { cwd: consumer, stdio: 'pipe' });
await fs.writeFile(output, JSON.stringify({ passed: true, consumer, sdkValues: Object.keys(sdk).sort(),
    sdkTypes: types, retiredValues: retired, removedTypes, forbiddenArtifactPaths: forbidden,
    artifactsChecked: facts.artifacts.map(a => ({ name: a.name, sha256: a.sha256 })) }, null, 2));
console.log('C01 tar exports, documentation, negative types and retired artifact paths passed.');
