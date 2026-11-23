/* Adapted from DeepSeek Harness scoped-repl.ts at 2e39e70496aa02986ca6a820c5d497e816b69d7e.
 * Copyright (c) 2026 DeepSeek. See LICENSE.deepseek-harness. */
import { parse, type Identifier, type ModuleDeclaration, type Pattern, type Statement } from 'acorn';
import { Script, type Context } from 'node:vm';

type Kind = 'var' | 'let' | 'const' | 'function' | 'class';
type Value = { kind: Kind; value: unknown };
type Binding = { kind: Kind; read: () => unknown };
type Compiled = { declarations: ReadonlyMap<string, Kind>; getters: readonly (() => unknown)[]; replaced: ReadonlyMap<string, Value> };
const prefix = '__$binding_';
const valuesName = prefix + 'vals';
const gettersName = prefix + 'getters';
const runBindings = new Set(['refs', 'tools', 'inspect', 'console', 'ToolCallError']);

function bindingNames(pattern: Pattern, visit: (identifier: Identifier) => void): void {
    switch (pattern.type) {
        case 'Identifier': visit(pattern); break;
        case 'ObjectPattern':
            for (const property of pattern.properties) bindingNames(property.type === 'RestElement' ? property.argument : property.value, visit);
            break;
        case 'ArrayPattern':
            for (const member of pattern.elements) if (member !== null) bindingNames(member, visit);
            break;
        case 'AssignmentPattern': bindingNames(pattern.left, visit); break;
        case 'RestElement': bindingNames(pattern.argument, visit); break;
    }
}

function scan(code: string): Map<string, Kind> {
    if (code.startsWith('#!')) throw new SyntaxError('Hashbang lines are not supported.');
    const reserved = () => new SyntaxError('Names starting with ' + prefix + ' are reserved.');
    if (code.includes(prefix)) throw reserved();
    const program = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true,
        onToken(token) { if ('value' in token && typeof token.value === 'string' && token.value.startsWith(prefix)) throw reserved(); },
    });
    const own = new Map<string, Kind>();
    const declare = (identifier: Identifier, kind: Kind) => {
        if (runBindings.has(identifier.name)) throw new SyntaxError(identifier.name + ' is supplied for each Console run. Use a different local name.');
        if (kind !== 'var' || own.get(identifier.name) !== 'function') own.set(identifier.name, kind);
    };
    const collectVar = (statement: Statement | ModuleDeclaration): void => {
        switch (statement.type) {
            case 'VariableDeclaration':
                if (statement.kind === 'var') for (const item of statement.declarations) bindingNames(item.id, id => declare(id, 'var'));
                break;
            case 'BlockStatement': statement.body.forEach(collectVar); break;
            case 'IfStatement': collectVar(statement.consequent); if (statement.alternate) collectVar(statement.alternate); break;
            case 'ForStatement':
                if (statement.init?.type === 'VariableDeclaration') collectVar(statement.init);
                collectVar(statement.body); break;
            case 'ForInStatement': case 'ForOfStatement':
                if (statement.left.type === 'VariableDeclaration') collectVar(statement.left);
                collectVar(statement.body); break;
            case 'WhileStatement': case 'DoWhileStatement': case 'LabeledStatement': case 'WithStatement': collectVar(statement.body); break;
            case 'TryStatement':
                collectVar(statement.block);
                if (statement.handler) collectVar(statement.handler.body);
                if (statement.finalizer) collectVar(statement.finalizer);
                break;
            case 'SwitchStatement': for (const branch of statement.cases) branch.consequent.forEach(collectVar); break;
        }
    };
    for (const statement of program.body) {
        switch (statement.type) {
            case 'VariableDeclaration': {
                const kind = statement.kind;
                if (kind !== 'var' && kind !== 'let' && kind !== 'const') throw new SyntaxError('Unsupported top-level declaration.');
                for (const item of statement.declarations) bindingNames(item.id, id => declare(id, kind));
                break;
            }
            case 'FunctionDeclaration': declare(statement.id, 'function'); break;
            case 'ClassDeclaration': declare(statement.id, 'class'); break;
            default: collectVar(statement);
        }
    }
    return own;
}

/** A submitted program inherits copies of prior bindings. Closures keep the scope that created them. */
export class ScopedReplScopes {
    private bindings = new Map<string, Binding>();
    private replaced: ReadonlyMap<string, Value> = new Map();
    private compiled?: Compiled;

    compile(code: string, context: Context): () => Promise<void> {
        const prior = this.compiled;
        this.compiled = undefined;
        if (prior && prior.declarations.size === prior.getters.length) {
            this.bindings = new Map([...prior.declarations].map(([name, kind], index) => [name, { kind, read: prior.getters[index]! }]));
            this.replaced = prior.replaced;
        }
        const own = scan(code);
        const declarations = new Map<string, Kind>();
        const replaced = new Map<string, Value>();
        const values: unknown[] = [];
        const copies: string[] = [];
        for (const [name, binding] of this.bindings) {
            let current: Value | undefined;
            try { current = { kind: binding.kind, value: binding.read() }; }
            catch { current = this.replaced.get(name); }
            if (!current) continue;
            const declared = own.get(name);
            if (declared !== undefined) replaced.set(name, current);
            else declarations.set(name, current.kind);
            if (declared === undefined || declared === 'var') {
                const keyword = declared === 'var' || current.kind === 'var' ? 'var' : 'let';
                copies.push(`${keyword} ${name} = ${valuesName}[${values.length}];`);
                values.push(current.value);
            }
        }
        for (const [name, kind] of own) declarations.set(name, kind);
        const readers = [...declarations.keys()].map(name => '() => ' + name);
        // A getter for a failed lexical initializer throws; the next compile recovers its prior value.
        const generated = '"use strict";(function (' + valuesName + ', ' + gettersName + ') { return async function () {' +
            copies.join('') + gettersName + '.push(' + readers.join(', ') + ');\n' + code + '\n} })';
        const factory = new Script(generated, { filename: 'console-program.js', lineOffset: -1 }).runInContext(context) as
            (values: unknown[], getters: (() => unknown)[]) => () => Promise<void>;
        const getters: (() => unknown)[] = [];
        const program = factory(values, getters);
        this.compiled = { declarations, getters, replaced };
        return program;
    }
}
