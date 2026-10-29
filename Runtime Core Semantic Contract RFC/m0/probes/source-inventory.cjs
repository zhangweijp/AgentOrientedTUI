/* M0 SP-03: AST inventory of SDK semantic APIs in demo app TS/TSX source.
 * Reads implementation code only; no .md files, no writes outside stdout.
 * Run at repository root: node "Runtime Core Semantic Contract RFC/m0/probes/source-inventory.cjs"
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require(path.resolve('sdk/node_modules/typescript'));
const root = path.resolve('demo-apps');
const tracked = ['useDataRef', 'useArrayRef', 'useViewTypeTool', 'createTUIApp'];
const entries = [];
const totals = {};
let scannedFiles = 0;

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (['node_modules', 'dist', 'coverage', '.git'].includes(name)) continue;
    if (fs.statSync(full).isDirectory()) { walk(full); continue; }
    if (!/\.(ts|tsx)$/.test(name) || /\.(test|spec)\./.test(name)) continue;
    scannedFiles++;
    const source = fs.readFileSync(full, 'utf8');
    const ast = ts.createSourceFile(full, source, ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const app = path.relative(root, full).split(path.sep)[0];
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(ast);
        if (tracked.includes(callee)) {
          const loc = ast.getLineAndCharacterOfPosition(node.getStart(ast));
          const args = node.arguments.map(arg => arg.getText(ast).replace(/\s+/g, ' ').slice(0, 90));
          entries.push({ app, file: path.relative(process.cwd(), full), line: loc.line+1, api: callee, arguments: args });
          const key = app + '/' + callee;
          totals[key] = (totals[key] || 0) + 1;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
walk(root);
console.log(JSON.stringify({
  source: 'local TS AST demo-apps excluding generated files/tests',
  scannedFiles,
  totals,
  count: entries.length,
  refCallsites: entries.filter(x => x.api === 'useDataRef' || x.api === 'useArrayRef'),
}, null, 2));
