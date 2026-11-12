import { describe, it } from 'vitest';
import Type from 'typebox';
import * as tools from './app.js';
import { staticCases } from '../tests/fixtures/static-tool-cases.mjs';

describe('M1 static Tool contract', () => {
    for (const [name, check] of staticCases(tools, Type)) it(name, check);
});
