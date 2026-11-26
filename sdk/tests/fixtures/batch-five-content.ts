export const RAW = '    const count = 12;\r\n\r\n';
export const RAW_PARTS = ['  ', '  const label = "&amp; <literal> 🧪";', '\r\n', ' \t', '\r\n', '\r\n'] as const;
export const SPACES = ' \t\r\n\r\n';
export const AUTHOR_TABLE = '| A | B |\r\n| --- | --- |\r\n| a | b | c |\r\n\r\n';
export const DIAGRAM = 'flowchart TD\n  A --> B\n\n  B --> C';
export const ORDINARY_PIPES = ['A|B', 'A\\|B', 'A\\\\|B'] as const;
export const PIPE_CODE = '  C`| D  ';
export const BACKSLASH_CODE = ' x\\\\|` * _ &amp; <y> ';
export const STOCK = [
    ['商品', '库存'], ['钉子', '12'], ['垫片', '3'], ['  small  parts　 ', ''],
    ...ORDINARY_PIPES.map((part, i) => [part, String(i + 1)]),
    [PIPE_CODE, BACKSLASH_CODE], ['Ready today (box)!', '2'],
];
export const FILES = {
    headers: ['样例 __raw__', '内容 &copy;'],
    literalName: '__init__.py',
    linkShapedName: 'report[old](draft).txt',
    entityName: '&copy;.txt',
    spacedTarget: 'docs/stock list.md',
    mixedTarget: 'docs/(old) &copy; A|B.md',
    mixedLabel: 'old [copy] &copy; A|B',
    literalUrls: 'www.example.test user@site.test https://site.test/x',
    pipeAndBackslashes: 'A\\|\\\\B',
    codeWithPipe: 'C|\\D',
} as const;
export const RAW_VIEWS = {
    raw: RAW, split_raw: RAW_PARTS.join(''), whitespace: SPACES, author_table: AUTHOR_TABLE,
} as const;

export const STOCK_APP = 'stock_inventory';
export const PLAIN_APP = 'stock_plain';
