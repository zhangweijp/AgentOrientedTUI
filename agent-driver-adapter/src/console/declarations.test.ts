import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compileToolParameters, type JsonValue } from '@aotui/core';
import { NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA, projectNativeToolSchema } from '@aotui/runtime/adapters';
import { expect, it } from 'vitest';
import { consoleDeclarations, programToolInput } from './declarations.js';

type Schema = Readonly<Record<string, JsonValue>>;
const marker = { 'x-aotui-ref-kind': 'Choice', 'x-aotui-ref-value': { type: 'string' } };
const result = compileToolParameters({
    type: 'object', additionalProperties: false,
    required: ['choices', 'item', 'parts', 'ordinary'],
    properties: {
        choices: { type: 'array', items: { type: 'string' }, enum: [['fast']] },
        item: marker,
        parts: { type: 'array', items: marker },
        ordinary: { type: 'string', description: 'A complete $ref.app_id.view_id.ref_id address.' },
        optional: { type: 'string', default: '$ref.x' },
    },
});
if (!result.ok) throw Error(JSON.stringify(result.issue));
const business = result.contract.schema;
const name = 'workspace-Editor-save';
const standard = projectNativeToolSchema({ multiplicity: 'multiple', viewType: 'Editor', inputSchema: business });
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const declaration = (schema: Schema) => consoleDeclarations([{ name, input: programToolInput(schema, business) }], []);

it('recognizes only the exact generated address structure, also after a JSON round trip', () => {
    const original = declaration(standard);
    expect(declaration(json(standard))).toEqual(original);
    expect(consoleDeclarations([{ name, input: programToolInput(json(standard), json(business)) }], [])).toEqual(original);
    expect(original.names).toEqual([name]);
    expect(original.issues).toEqual([]);
    expect(original.declaration).toContain('readonly item: AppRefAddress');
    expect(original.declaration).toContain('readonly parts: ReadonlyArray<AppRefAddress>');
    expect(original.declaration).toContain('readonly ordinary: string');
    expect(original.declaration).toContain('readonly choices: ReadonlyArray<string> | AppRefAddress');

    for (const similar of [
        { ...NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA, pattern: '^\\$ref\\.' },
        { ...NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA, maxLength: 10 },
    ]) {
        const schema = { ...standard, properties: { ...standard.properties as Schema, item: similar } };
        const output = declaration(schema);
        expect(output.names).toEqual([]);
        expect(output.issues).toMatchObject([{ tool: name, path: '$.properties.item.pattern' }]);
        expect(declaration(json(schema))).toEqual(output);
    }
});

it('strictly compiles actual generated declarations and rejects each illegal input independently', () => {
    const generated = declaration(json(standard)).declaration;
    const folder = mkdtempSync(join(tmpdir(), 'aotui-b-types-'));
    const config = join(folder, 'tsconfig.json');
    const options = { target: 'ES2022', module: 'ESNext', lib: ['ES2022'], types: [],
        strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true };
    const positive = [
        'tools["workspace-Editor-save"]({ view_id: "editor_1", choices: ["$ref.workspace.editor_1.fast"], item: "$ref.workspace.editor_1.fast", parts: ["$ref.workspace.editor_1.fast"], ordinary: "$HOME" });',
        'tools["workspace-Editor-save"]({ view_id: "editor_1", choices: "$ref.workspace.editor_1.all", item: "$ref.workspace.editor_1.fast", parts: [], ordinary: "plain" });',
    ];
    const negative = [
        'tools["workspace-Editor-save"]({ choices: ["fast"], item: "$ref.x", parts: [], ordinary: "plain" });',
        'tools["workspace-Editor-save"]({ view_id: "editor_1", choices: [true], item: "$ref.x", parts: [], ordinary: "plain" });',
        'tools["workspace-Editor-save"]({ view_id: "editor_1", choices: ["fast"], item: "plain", parts: [], ordinary: "plain" });',
        'tools["workspace-Editor-save"]({ view_id: "editor_1", choices: ["fast"], item: "$ref.x", parts: "$ref.x", ordinary: "plain" });',
        'tools["workspace-Editor-save"]({ view_id: "editor_1", choices: ["fast"], item: "$ref.x", parts: [], ordinary: "plain", optional: undefined });',
    ];
    try {
        writeFileSync(config, JSON.stringify({ compilerOptions: options, files: ['case.ts'] }));
        const compile = (body: string) => {
            writeFileSync(join(folder, 'case.ts'), generated + '\n' + body + '\n');
            const actual = spawnSync(resolve('node_modules/.bin/tsc'), ['-p', config, '--pretty', 'false'], { encoding: 'utf8' });
            expect(actual.error).toBeUndefined();
            return { status: actual.status, output: actual.stdout + actual.stderr };
        };
        expect(compile(positive.join('\n'))).toEqual({ status: 0, output: '' });
        for (const invalid of negative) {
            const outcome = compile(invalid);
            expect(outcome.status).not.toBe(0);
            expect(outcome.output).toMatch(/error TS\d+:/);
        }
        expect(compile([...positive, ...negative.flatMap(line => ['// @ts-expect-error invalid input', line])].join('\n')))
            .toEqual({ status: 0, output: '' });
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}, 30_000);
