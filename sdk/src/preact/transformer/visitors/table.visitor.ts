const inlineElements = new Set(['span', 'strong', 'b', 'em', 'i', 'a', 'code']);

function* structure(parent: Element): Generator<Node> {
    for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType !== 8 && (child.nodeType !== 3 || /\S/.test((child as Text).data))) yield child;
    }
}

const tag = (node: Node) => node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : '';

export function transformTable(table: Element, renderCell: (cell: Element) => string, number: number,
    invalid: (message: string) => never): string {
    const fail = (reason: string, row?: number, column?: number): never => invalid(
        `table ${number}${row === undefined ? '' : `, row ${row}`}${column === undefined ? '' : `, column ${column}`}: ${reason}`);
    const rows: string[][] = [];

    const readRow = (node: Node) => {
        const row = rows.length + 1;
        if (tag(node) !== 'tr') fail('Expected a row', row);
        const cells = [...structure(node as Element)];
        const expected = rows[0]?.length;
        if (expected === undefined && !cells.length) fail('The header needs at least one cell', row);
        if (expected !== undefined && cells.length !== expected)
            fail(`Expected ${expected} cells, got ${cells.length}`, row, Math.min(expected, cells.length) + 1);
        const expectedTag = row === 1 ? 'th' : 'td';
        rows.push(cells.map((child, index) => {
            const column = index + 1;
            if (tag(child) !== expectedTag) fail(`Expected a ${expectedTag} cell`, row, column);
            const cell = child as Element;
            if (cell.getAttributeNames().some(name => /^(colspan|rowspan)$/i.test(name) && cell.getAttribute(name)?.trim() !== '1'))
                fail('Merged cells are unsupported', row, column);
            for (const item of Array.from(cell.querySelectorAll('*'))) {
                const name = tag(item);
                if (name === 'table') fail('Nested tables are unsupported', row, column);
                if (name === 'br') fail('Cell contains a line break', row, column);
                if (!inlineElements.has(name)) fail('Cell needs text or inline markup', row, column);
            }
            const content = renderCell(cell);
            if (/[\r\n]/.test(content)) fail('Cell contains a line break', row, column);
            return content.replace(/^\s+|\s+$/g, edge => Array.from(edge, char => `&#${char.charCodeAt(0)};`).join(''));
        }));
    };

    for (const child of structure(table)) {
        const name = tag(child);
        if (name === 'tr') readRow(child);
        else if (name === 'thead' || name === 'tbody') {
            for (const row of structure(child as Element)) readRow(row);
        } else fail('Expected tr, thead or tbody');
    }
    const header = rows[0] ?? fail('The table needs a header row');
    const line = (cells: string[]) => '| ' + cells.join(' | ') + ' |';
    return '\n\n' + [line(header), line(header.map(() => '---')), ...rows.slice(1).map(line)].join('\n') + '\n\n';
}
