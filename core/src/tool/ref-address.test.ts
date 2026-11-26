import { describe, expect, it } from 'vitest';
import { parseRefAddress } from './ref-parameters.js';

describe('qualified Ref address syntax', () => {
    it.each([
        ['$ref.app.list.people', 'people', []],
        ['$ref.app.list.people[0]["display.name"]', 'people', [0, 'display.name']],
        ['$ref.app.list.people["0"].name', 'people', ['0', 'name']],
        ['$ref.app.list._items2["items[0]"]', '_items2', ['items[0]']],
    ] as const)('resolves %s as data-only path syntax', (input, refId, path) => {
        expect(parseRefAddress(input)).toEqual({ appId: 'app', viewId: 'list', refId, path });
    });
    it.each([
        '$app.list.people', '$HOME', '$ref.app.list', '$ref.app.list.people[00]', '$ref.app.list.people[-1]',
        '$ref.app.list["items[0]"]', '$ref.app.list["people"]', '$ref.app.list.2fa', '$ref.app.list.person$',
        '$ref.app.list.people[0xA]', '$ref.app.list.people[0]?.info', '$ref.app.list.people[1 /* trailing */]',
        '$ref.app.list.people[1 + 2]', '$ref.app.list.people["a"]()', '$ref.app.list.people["x".repeat(2)]',
        '$ref.app.list.people["' + '字'.repeat(1400) + '"]', '$ref.app.list.people' + '.x'.repeat(60),
    ])('rejects non-address syntax %s', input => expect(parseRefAddress(input)).toBeUndefined());
});
