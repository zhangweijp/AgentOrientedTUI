import { describe, it } from 'vitest';
import Type from 'typebox';
import * as tools from './tools.js';
import { staticCases } from '../tests/srt01-m1/consumer/runtime/static-cases.mjs';

describe('M1 static Tool contract', () => {
    for (const [name, check] of staticCases(tools, Type)) it(name, check);
});
