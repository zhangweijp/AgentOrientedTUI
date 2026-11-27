import pkg from './package.json' with { type: 'json' };
import { appendFileSync, closeSync, constants, existsSync, fstatSync, ftruncateSync, openSync,
  readdirSync, readFileSync, realpathSync, watch, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, createView, defineViewType, formatRef, ref, type ToolResult, type ViewHandle } from '@aotui/sdk';

type OpenFile = { value: string; writable: boolean; view: ViewHandle<typeof File> };
type Edit = { text: string; expected: string };
const text = { type: 'string' } as const;
const done = { success: true as const };
const unavailable = { success: false, error: {
  code: 'FILE_UNAVAILABLE', message: 'Choose an existing regular file directly in the configured directory.',
} } as const;
const faultName = '.fail-file-view';
const journalName = 'edits.jsonl';
const Directory = defineViewType<{
  open(name: string): ToolResult;
  setWritable(name: string, writable: boolean): ToolResult;
}>()({
  name: 'Directory', region: 'static', multiplicity: 'single', tools: {
    open_file: {
      description: 'Open a regular file by its name in the configured directory or refresh its current page from disk.',
      inputSchema: { type: 'object', properties: { name: text }, required: ['name'] },
      execute: ({ input, context }) => context.open(input.name),
    },
    set_writable: {
      description: 'Allow or disallow edits to an open file.',
      inputSchema: { type: 'object', properties: { name: text, writable: { type: 'boolean' } }, required: ['name', 'writable'] },
      execute: ({ input, context }) => context.setWritable(input.name, input.writable),
    },
  },
});
const File = defineViewType<{ writable: boolean; edit(input: Edit): ToolResult; close(): ToolResult }>()({
  name: 'File', region: 'dynamic', multiplicity: 'multiple',
  onClose: { execute: ({ context }) => context.close() }, tools: {
    edit: {
      description: 'Write text to the receiving page. Select the text Ref shown on that page for expected.',
      inputSchema: { type: 'object', properties: { text, expected: text }, required: ['text', 'expected'] },
      enabled: ({ writable }) => writable,
      execute: ({ input, context }) => context.edit(input),
    },
  },
});

export default createApp({
  ...pkg.aotui, viewTypes: [Directory, File],
  initialize({ launchConfig, publish: commit, registerLifecycle }) {
    if (typeof launchConfig?.folder !== 'string' || !launchConfig.folder) throw new Error('Set config.folder to an existing directory.');
    const folder = realpathSync(launchConfig.folder);
    let files = new Map<string, OpenFile>();
    const testTrace = launchConfig.traceProjection === true;
    const fault = join(folder, faultName);
    let projectionFailed = false;

    function directoryFiles() {
      return readdirSync(folder, { withFileTypes: true })
        .filter(item => item.isFile() && (!testTrace || ![faultName, journalName].includes(item.name.toLowerCase())))
        .map(item => item.name);
    }

    function withFile<T>(name: string, flags: number, run: (fd: number) => T): T | undefined {
      let fd: number;
      try {
        if (!directoryFiles().includes(name)) return;
        fd = openSync(join(folder, name), flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && ['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR', 'EACCES', 'EPERM', 'EROFS', 'ENAMETOOLONG'].includes(code)) return;
        throw error;
      }
      try {
        if (fstatSync(fd).isFile()) return run(fd);
      } finally { closeSync(fd); }
    }

    const directory = createView(Directory, { id: 'directory' });
    function frames(open: Map<string, OpenFile>) { return [directory.frame({
      body: 'Files: ' + (directoryFiles().sort().map(name => JSON.stringify(name)).join(', ') || 'none') +
        '\n\nOpen: ' + ([...open.keys()].join(', ') || 'none'),
      context: {
        open(name) {
          const value = withFile(name, constants.O_RDONLY, fd => readFileSync(fd, 'utf8'));
          if (value === undefined) return unavailable;
          const existing = files.get(name);
          if (existing) {
            existing.value = value;
            publish();
          } else {
            const next = new Map(files).set(name, { value, writable: true, view: createView(File) });
            const result = commit(() => frames(next), { mode: 'candidate' });
            if (!result.ok) return { success: false, error: {
              code: result.issue.code, message: 'Close an open File page before opening this file.',
            } };
            files = next;
          }
          return done;
        },
        setWritable(name, writable) {
          const entry = files.get(name);
          if (!entry) return { success: false, error: { code: 'FILE_NOT_OPEN', message: 'Open the file first.' } };
          entry.writable = writable;
          publish();
          return done;
        },
      },
    }), ...Array.from(open, ([name, entry]) => {
          if (testTrace && existsSync(fault)) throw new Error('The file View could not render while the fixture marker exists.');
          const current = ref('text', entry.value, { scope: 'public', schema: text });
          return entry.view.frame({
            name, bindingKey: name, body: `# ${name}\n\n${entry.value}\n\n${formatRef('Current text', current)}`,
            refs: [current],
            context: { writable: entry.writable, close() {
              const next = new Map(files); next.delete(name);
              const result = commit(() => frames(next), { mode: 'candidate' });
              if (!result.ok) return { success: false, error: result.issue };
              files = next; return done;
            }, edit(input) {
              const saved = withFile(name, constants.O_RDWR, fd => {
                if (readFileSync(fd, 'utf8') !== input.expected) return false;
                const bytes = Buffer.from(input.text);
                let offset = 0;
                while (offset < bytes.length) {
                  const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
                  if (written === 0) throw new Error('The file write made no progress.');
                  offset += written;
                }
                ftruncateSync(fd, bytes.length);
                return true;
              });
              if (saved === undefined) return unavailable;
              if (!saved) return { success: false,
                error: { code: 'FILE_CHANGED', message: 'The file changed on disk. Refresh this page before editing.' } } as const;
              if (testTrace) appendFileSync(join(folder, journalName), JSON.stringify({ name, text: input.text }) + '\n');
              entry.value = input.text;
              const result = publish();
              if (!result.ok) {
                projectionFailed = true;
                return { success: true as const, data: { saved: true, projection: result.issue.code } };
              }
              return done;
            } },
          });
    })]; }
    function publish() { return commit(() => frames(files)); }
    if (testTrace) {
      let watcher: ReturnType<typeof watch> | undefined;
      registerLifecycle({ close: () => watcher?.close() });
      watcher = watch(folder, (_event, name) => {
        if (name !== faultName || existsSync(fault) || !projectionFailed) return;
        projectionFailed = !publish().ok;
      });
    }
    publish();
  },
});
