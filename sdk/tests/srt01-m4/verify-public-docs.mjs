import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Capability documents describe contracts. package.json owns the exact candidate identity.
export async function inspectPublicDocIdentity(packageRoot) {
 const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
 const files = ['README.md'];
 async function visit(directory) {
  for (const entry of await fs.readdir(path.join(packageRoot, directory), { withFileTypes: true })) {
   const relative = path.posix.join(directory, entry.name);
   if (entry.isDirectory()) await visit(relative);
   else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relative);
  }
 }
 await visit('docs');
 const references = [];
 for (const file of files.sort()) {
  const lines = (await fs.readFile(path.join(packageRoot, file), 'utf8')).split('\n');
  for (const [index, text] of lines.entries()) {
   for (const match of text.matchAll(/\b\d+\.\d+\.\d+-srt\d+-[A-Za-z0-9.-]+\b/g)) {
    references.push({ file, line: index + 1, declared: match[0], packageVersion: manifest.version,
     mismatch: match[0] !== manifest.version, excerpt: text });
   }
  }
 }
 return { passed: references.length === 0, packageVersion: manifest.version, files,
  rule: 'Keep exact SRT candidate identities in package metadata and review records, outside capability documents.', references };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const result = await inspectPublicDocIdentity(path.resolve(process.argv[2]));
 console.log(JSON.stringify(result, null, 2));
 if (!result.passed) process.exitCode = 1;
}
