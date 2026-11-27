// Checks the actual SDK wire representation, not the public Source schema policy.
import { isDeepStrictEqual } from 'node:util';
import { asSchema, type Tool } from 'ai';
import type { prepareOpenAIResponsesInput } from './openai-responses-tools.js';
import { ProviderToolSchemaError } from './provider-tool-schema.js';

type Input = Awaited<ReturnType<typeof prepareOpenAIResponsesInput>>;
type ObjectValue = Record<string, unknown>;
type Format = 'chat' | 'responses' | 'anthropic' | 'google';
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const child = (path: string, key: string) => /^[A-Za-z_$][\w$]*$/.test(key) ? path + '.' + key : path + '[' + JSON.stringify(key) + ']';
const annotations = new Set(['description', 'title', '$comment']);
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const schemaLists = new Set(['anyOf', 'allOf', 'oneOf', 'prefixItems']);
const schemaChildren = new Set(['items', 'additionalProperties', 'additionalItems', 'contains', 'not', 'if', 'then', 'else',
    'propertyNames', 'unevaluatedProperties', 'unevaluatedItems']);

// Only schema positions are normalized. In particular enum/default are opaque business JSON.
function schemaNode(value: ObjectValue): ObjectValue {
    const node = Object.fromEntries(Object.entries(value).filter(([key]) => !annotations.has(key)));
    if (Object.hasOwn(node, 'const') && !Object.hasOwn(node, 'enum')) {
        node.enum = [node.const]; delete node.const;
    }
    if (node.additionalProperties === true) delete node.additionalProperties;
    if (Array.isArray(node.required) && !node.required.length) delete node.required;
    if (object(node.properties) && !Object.keys(node.properties).length) delete node.properties;
    return node;
}

function schemaDifference(expected: unknown, actual: unknown, path = '$', depth = 0): string | undefined {
    if (isDeepStrictEqual(expected, actual)) return;
    if (depth >= 64 || !object(expected) || !object(actual)) return path;
    const left = schemaNode(expected), right = schemaNode(actual);
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        const p = child(path, key), a = left[key], b = right[key];
        if (Object.hasOwn(left,key) !== Object.hasOwn(right,key)) return p;
        if (isDeepStrictEqual(a,b)) continue;
        if (schemaMaps.has(key) && object(a) && object(b)) {
            for (const field of new Set([...Object.keys(a),...Object.keys(b)])) {
                const issue = schemaDifference(a[field], b[field], child(p,field), depth+1);
                if (issue) return issue;
            }
        } else if ((schemaLists.has(key) || key === 'items') && Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return p;
            for (const [index,value] of a.entries()) {
                const issue = schemaDifference(value,b[index],p+'['+index+']',depth+1);
                if (issue) return issue;
            }
        } else if (schemaChildren.has(key)) {
            const issue = schemaDifference(a,b,p,depth+1);
            if (issue) return issue;
        } else return p;
    }
}

type FunctionEntry = { name: string; schema: unknown; strict?: boolean; deferred?: boolean };
type NativeEntry = { name: string; wire: ObjectValue };

function providerFormat(provider: string): Format {
    if (provider === 'google.generative-ai') return 'google';
    if (provider === 'anthropic.messages') return 'anthropic';
    if (provider.endsWith('.responses')) return 'responses';
    return 'chat';
}

/** Finite, adapter-specific native forms. Unverified native capabilities are not silently ignored. */
function nativeForm(format: Format, model: string, tool: Extract<Tool,{type:'provider'}>): ObjectValue | undefined {
    const args = tool.args ?? {};
    const only = (...keys: string[]) => Object.keys(args).every(key => keys.includes(key));
    if (format === 'google') {
        const newer = /gemini-[23]/.test(model) || ['gemini-flash-latest','gemini-flash-lite-latest','gemini-pro-latest'].includes(model);
        if (tool.id === 'google.google_search' && only('mode', 'dynamicThreshold')) {
            if (!newer && model.includes('gemini-1.5-flash') && !model.includes('-8b'))
                return json({googleSearchRetrieval:{dynamicRetrievalConfig:{mode:args.mode,dynamicThreshold:args.dynamicThreshold}}});
            // Only the legacy dynamic-retrieval encoder preserves these options.
            if (args.mode !== undefined || args.dynamicThreshold !== undefined) return;
            return newer ? {googleSearch:{}} : {googleSearchRetrieval:{}};
        }
        const simple: Record<string,string> = {'google.url_context':'urlContext','google.code_execution':'codeExecution',
            'google.enterprise_web_search':'enterpriseWebSearch','google.google_maps':'googleMaps'};
        if (newer && Object.hasOwn(simple,tool.id) && !Object.keys(args).length) return {[simple[tool.id]!]:{}};
        if (tool.id === 'google.file_search' && /gemini-(2\.5|3)/.test(model)) return {fileSearch:json(args)};
    }
    if (format === 'anthropic') {
        if ((tool.id === 'anthropic.tool_search_regex_20251119' || tool.id === 'anthropic.tool_search_bm25_20251119') && !Object.keys(args).length) {
            const kind = tool.id.includes('regex') ? 'regex' : 'bm25';
            return {type:'tool_search_tool_'+kind+'_20251119',name:'tool_search_tool_'+kind};
        }
        if (tool.id === 'anthropic.web_search_20250305' && only('maxUses','allowedDomains','blockedDomains','userLocation')) return json({type:'web_search_20250305',name:'web_search',
            max_uses:args.maxUses,allowed_domains:args.allowedDomains,blocked_domains:args.blockedDomains,user_location:args.userLocation});
        if (tool.id === 'anthropic.web_fetch_20250910' && only('maxUses','allowedDomains','blockedDomains','citations','maxContentTokens')) return json({type:'web_fetch_20250910',name:'web_fetch',
            max_uses:args.maxUses,allowed_domains:args.allowedDomains,blocked_domains:args.blockedDomains,citations:args.citations,max_content_tokens:args.maxContentTokens});
    }
    if (format === 'responses') {
        if (tool.id === 'openai.tool_search' && only('execution','description','parameters')) return json({type:'tool_search',execution:args.execution,
            description:args.description,parameters:args.parameters});
        if (tool.id === 'openai.web_search_preview' && only('searchContextSize','userLocation')) return json({type:'web_search_preview',search_context_size:args.searchContextSize,user_location:args.userLocation});
        if (tool.id === 'openai.web_search' && only('filters','externalWebAccess','searchContextSize','userLocation')) {
            if (object(args.filters) && Object.keys(args.filters).some(key=>key!=='allowedDomains'&&key!=='blockedDomains')) return;
            const filters = object(args.filters) ? {allowed_domains:args.filters.allowedDomains,blocked_domains:args.filters.blockedDomains} : undefined;
            return json({type:'web_search',filters,external_web_access:args.externalWebAccess,
                search_context_size:args.searchContextSize,user_location:args.userLocation});
        }
    }
}

function nativeKey(format: Format, entry: ObjectValue): string | undefined {
    if (format === 'google') return Object.keys(entry).length === 1 ? Object.keys(entry)[0] : undefined;
    return typeof entry.type === 'string' ? entry.type : undefined;
}

function historySearchOutputs(input: Input) {
    // These are saved Provider protocol results, not new Source tools. Their
    // exact ordered definitions still have to survive the current encoding.
    return input.responsesForms ? input.messages.flatMap(message => {
        if (message.role !== 'assistant' && message.role !== 'tool' || !Array.isArray(message.content)) return [];
        return message.content.flatMap(part => {
            if (part.type !== 'tool-result' || part.toolName !== 'tool_search' || part.output.type !== 'json' ||
                !object(part.output.value) || !Array.isArray(part.output.value.tools)) return [];
            return [{execution:message.role === 'assistant' ? 'server':'client',
                id:message.role === 'assistant' ? part.providerOptions?.openai?.itemId ?? part.toolCallId : part.toolCallId,
                tools:json(part.output.value.tools)}];
        });
    }) : [];
}

export async function createRequestToolCheck(input: Input, provider: string, model: string, label: string) {
    const format = providerFormat(provider);
    function fail(name: string, path: string, reason: string): never {
        // No raw request bodies or argument values in diagnostics.
        throw new ProviderToolSchemaError(label.slice(0,160), name.slice(0,160), path.slice(0,512), reason);
    }
    const functions = new Map<string,FunctionEntry>(), natives = new Map<string,NativeEntry>();
    const forms = input.responsesForms;
    const omitted = forms?.registrationOnly ?? new Set<string>();
    const positioned = json(forms?.positioned ?? []);
    const searchOutputs = historySearchOutputs(input);
    for (const [name, tool] of Object.entries(input.tools)) {
        if (tool.type === 'provider') {
            const wire = nativeForm(format,model,tool);
            const key = wire && nativeKey(format,wire);
            if (!key || !wire) fail(name,'$.tools','This native capability has no verified transport form on the selected endpoint.');
            if (natives.has(key)) fail(name,'$.tools','Native capability aliases collide in the actual transport.');
            natives.set(key,{name,wire});
            continue;
        }
        if (omitted.has(name)) continue;
        const providerOptions = format === 'responses' ? tool.providerOptions?.openai : format === 'anthropic' ? tool.providerOptions?.anthropic : undefined;
        if (providerOptions?.namespace !== undefined || providerOptions?.allowedCallers !== undefined || providerOptions?.async === true)
            fail(name,'$.tools','This function calling form is outside the verified transport profile.');
        const deferred = providerOptions?.deferLoading === true;
        functions.set(name,{name,schema:json(await asSchema(tool.inputSchema).jsonSchema),strict:tool.strict,deferred});
    }
    for (const {name,wire} of natives.values()) {
        const wireName = typeof wire.name === 'string' ? wire.name : format === 'responses' ? wire.type : undefined;
        if (typeof wireName === 'string' && functions.has(wireName))
            fail(name,'$.tools','A function collides with a native capability name in the actual transport.');
    }
    if (forms) {
        if (format !== 'responses') fail('tool_search','$.tools','Responses registrations require the Responses transport.');
        // The helper's client search handler uses exactly this catalog, not the latest Source.
        for (const definition of forms.clientCatalog) {
            const tool = input.tools[definition.name];
            if (!tool || tool.type === 'provider' || !omitted.has(definition.name) ||
                schemaDifference(definition.parameters,json(await asSchema(tool.inputSchema).jsonSchema)) ||
                definition.strict !== tool.strict)
                fail(definition.name,'$.tools','Client search catalog differs from its captured tool declaration.');
        }
    }
    for (const entry of functions.values()) if (entry.deferred &&
        !(format === 'responses' ? natives.get('tool_search')?.wire.execution === 'server'
            : format === 'anthropic' && [...natives.keys()].some(key=>key.startsWith('tool_search_tool_'))))
        fail(entry.name,'$.tools','A deferred function requires its verified search capability.');

    function checkFunction(expected: FunctionEntry, value: ObjectValue, schema: unknown) {
        const issue = schemaDifference(expected.schema,schema);
        if (issue) fail(expected.name,issue,'The actual encoded parameter schema changes the declared input or field presence.');
        if (expected.strict === true ? value.strict !== true : value.strict === true ||
            value.strict !== undefined && value.strict !== false)
            fail(expected.name,'$.strict','The actual strict setting differs from the selected tool.');
        if ((value.defer_loading === true) !== !!expected.deferred || value.defer_loading !== undefined && typeof value.defer_loading !== 'boolean')
            fail(expected.name,'$.defer_loading','The actual calling form differs from the selected tool.');
        if (value.async !== undefined && value.async !== false || value.allowed_callers !== undefined || value.namespace !== undefined)
            fail(expected.name,'$.tools','The actual function uses an unverified calling form.');
    }

    function checkPositioned(expected: readonly unknown[], actual: unknown, path: string) {
        if (!Array.isArray(actual) || actual.length !== expected.length)
            fail('tool_search',path,'The encoded historical definition group differs from the captured group.');
        for (const [index,definition] of expected.entries()) {
            const entry = actual[index];
            if (!object(definition) || definition.type !== 'function' || typeof definition.name !== 'string' ||
                !object(entry) || entry.type !== 'function' || entry.name !== definition.name)
                fail('tool_search',path+'['+index+']','The encoded historical definition is missing, renamed or unsupported.');
            checkFunction({name:definition.name,schema:definition.parameters,strict:definition.strict === true,deferred:definition.defer_loading === true},
                entry,entry.parameters);
        }
    }

    return (body: unknown): void => {
        if (!object(body)) fail('request','$.tools','Expected a JSON model request object.');
        if (format !== 'google' && body.model !== model)
            fail('request','$.model','The actual request changes the selected model.');
        if (body.functions !== undefined || body.function_call !== undefined)
            fail('request','$.tools','An unverified legacy function list or calling form was encoded.');
        const raw = body.tools === undefined ? [] : body.tools;
        if (!Array.isArray(raw)) fail('request','$.tools','Expected the encoded tool list.');
        const seenFunctions = new Set<string>(), seenNatives = new Set<string>();
        const checkFn = (value: unknown, schemaKey: string) => {
            if (!object(value) || typeof value.name !== 'string') fail('function','$.tools','Invalid encoded function definition.');
            const name = value.name;
            const expected = functions.get(name);
            if (!expected || seenFunctions.has(name)) fail(name,'$.tools','Unexpected or duplicate encoded function.');
            checkFunction(expected,value,value[schemaKey]);
            seenFunctions.add(name);
        };
        const checkNative = (value: ObjectValue) => {
            const key = nativeKey(format,value);
            const expected = key ? natives.get(key) : undefined;
            if (!key || !expected || seenNatives.has(key)) fail(key ?? 'native capability','$.tools','Unexpected or duplicate encoded native capability.');
            // Anthropic's cache control is an annotation, not a different capability.
            const actual = format === 'anthropic' ? Object.fromEntries(Object.entries(value).filter(([name])=>name!=='cache_control')) : value;
            if (!isDeepStrictEqual(expected.wire,actual)) fail(expected.name,'$.tools','The encoded native capability or its arguments changed.');
            seenNatives.add(key);
        };
        for (const entry of raw) {
            if (!object(entry)) fail('request','$.tools','Invalid encoded tool entry.');
            if (format === 'google' && Object.hasOwn(entry,'functionDeclarations')) {
                if (Object.keys(entry).length !== 1 || !Array.isArray(entry.functionDeclarations))
                    fail('function','$.tools','Unexpected Google tool group.');
                for (const fn of entry.functionDeclarations) {
                    if (!object(fn) || Object.hasOwn(fn,'parameters') && Object.hasOwn(fn,'parametersJsonSchema'))
                        fail('function','$.tools','Ambiguous Google function schema.');
                    checkFn(fn,Object.hasOwn(fn,'parametersJsonSchema')?'parametersJsonSchema':'parameters');
                }
            } else if (format === 'chat' && entry.type === 'function') checkFn(entry.function,'parameters');
            else if (format === 'responses' && entry.type === 'function') checkFn(entry,'parameters');
            else if (format === 'anthropic' && entry.type === undefined) checkFn(entry,'input_schema');
            else checkNative(entry);
        }
        for (const name of functions.keys()) if (!seenFunctions.has(name))
            fail(name,'$.tools','The selected function is missing from the actual encoded request.');
        for (const [key,{name}] of natives) if (!seenNatives.has(key))
            fail(name,'$.tools','The selected native capability is missing from the actual encoded request.');
        const choice = body.tool_choice;
        if (choice !== undefined && choice !== 'auto' &&
            !(format === 'anthropic' && object(choice) && choice.type === 'auto' &&
                Object.keys(choice).every(key=>key==='type'||key==='disable_parallel_tool_use')))
            fail('request','$.tool_choice','The actual request changes the selected callable set.');
        if (format === 'google' && body.toolConfig !== undefined) {
            const config = object(body.toolConfig) && body.toolConfig.functionCallingConfig;
            if (!object(config) || config.mode !== 'AUTO' || config.allowedFunctionNames !== undefined)
                fail('request','$.toolConfig','The actual request changes the selected callable set.');
        }
        if (format === 'responses') {
            const items: unknown[] = Array.isArray(body.input) ? body.input : [];
            const additional = items.filter((item): item is ObjectValue => object(item)&&item.type==='additional_tools');
            if (additional.length !== positioned.length) fail('tool_search','$.input','Unexpected or missing positioned tool definition group.');
            if (input.openaiToolLoad?.length && additional.at(-1) !== items.at(-1))
                fail('tool_search','$.input','The current positioned definition group is not at the end of the encoded input.');
            for (const [index,group] of positioned.entries()) {
                const item = additional[index]!;
                if (item.role !== 'developer') fail('tool_search','$.input','The positioned tool definition changed roles.');
                checkPositioned(group,item.tools,'$.input.additional_tools['+index+'].tools');
            }
            const outputs = items.filter((item): item is ObjectValue => object(item)&&item.type==='tool_search_output');
            if (outputs.length !== searchOutputs.length) fail('tool_search','$.input','Unexpected or missing saved search result.');
            for (const [index,expected] of searchOutputs.entries()) {
                const item = outputs[index]!;
                if (item.execution !== expected.execution || (item.execution==='server'?item.id:item.call_id) !== expected.id)
                    fail('tool_search','$.input','The encoded search result changed its original identity.');
                const beforeOutput = items.slice(0,items.indexOf(item));
                if (!beforeOutput.some(call=>object(call)&&call.type==='tool_search_call'&&call.execution===expected.execution&&
                    (expected.execution==='server' || call.call_id===item.call_id)))
                    fail('tool_search','$.input','The encoded search result has no preceding compatible search call.');
                checkPositioned(expected.tools,item.tools,'$.input.tool_search_output['+index+'].tools');
            }
        }
    };
}
