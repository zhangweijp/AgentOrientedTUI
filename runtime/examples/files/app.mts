import pkg from './package.json' with { type: 'json' };
import { appendFileSync, existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Type from 'typebox';
import { createApp, createView, defineViewType, formatRef, ref, type ToolResult, type ViewHandle } from '@aotui/sdk/app';

type FileName = 'a.txt' | 'b.txt';
type OpenFile = { value: string; writable: boolean; view: ViewHandle };
type Edit = { text: string; expected: string };
const fileName = Type.Union([Type.Literal('a.txt'), Type.Literal('b.txt')]);
const text = Type.String();
const done = { success: true as const };
const Directory = defineViewType<{
  open(name: FileName): ToolResult;
  setWritable(name: FileName, writable: boolean): ToolResult;
}>()({
  name: 'Directory', region: 'static', multiplicity: 'single', tools: {
    open_file: {
      description: 'Open one of the two listed files or refresh its current page from disk.',
      inputSchema: Type.Object({ name: fileName }),
      execute: ({ input, context }) => context.open(input.name),
    },
    set_writable: {
      description: 'Allow or disallow edits to an open file.',
      inputSchema: Type.Object({ name: fileName, writable: Type.Boolean() }),
      execute: ({ input, context }) => context.setWritable(input.name, input.writable),
    },
  },
});
const File = defineViewType<{ writable: boolean; edit(input: Edit): ToolResult }>()({
  name: 'File', region: 'dynamic', multiplicity: 'multiple', tools: {
    edit: {
      description: 'Write text to the receiving page. Select the text Ref shown on that page for expected.',
      inputSchema: Type.Object({ text, expected: text }),
      enabled: ({ writable }) => writable,
      execute: ({ input, context }) => context.edit(input),
    },
  },
});

export default createApp({
  ...pkg.aotui, viewTypes: [Directory, File],
  initialize({ launchConfig, prepareProjection, registerCleanup }) {
    if (typeof launchConfig?.folder !== 'string') throw new Error('Set config.folder to a folder containing a.txt and b.txt.');
    const folder = launchConfig.folder;
    const files = new Map<FileName, OpenFile>();
    const testTrace = launchConfig.traceProjection === true;
    const fault = join(folder, '.fail-file-view');
    let projectionFailed = false;
    const directory = createView(Directory, { id: 'directory', render: () => ({
      body: 'Files: a.txt and b.txt.',
      context: {
        open(name) {
          const value = readFileSync(join(folder, name), 'utf8');
          const existing = files.get(name);
          if (existing) existing.value = value;
          else files.set(name, mount(name, value));
          publish();
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
    }) });
    function publish() { return prepareProjection({ views: [directory, ...Array.from(files.values(), file => file.view)] }); }
    function mount(name: FileName, value: string): OpenFile {
      const entry: OpenFile = { value, writable: true, view: createView(File, {
        name, onClose: () => { files.delete(name); publish(); return done; },
        render: () => {
          if (testTrace && existsSync(fault)) throw new Error('The file View could not render while the fixture marker exists.');
          const current = ref('text', entry.value, { scope: 'public', schema: text });
          return {
            body: `# ${name}\n\n${entry.value}\n\n${formatRef('Current text', current)}`,
            refs: [current],
            context: { writable: entry.writable, edit(input) {
              const path = join(folder, name);
              if (readFileSync(path, 'utf8') !== input.expected) return { success: false,
                error: { code: 'FILE_CHANGED', message: 'The file changed on disk. Refresh this page before editing.' } } as const;
              writeFileSync(path, input.text);
              if (testTrace) appendFileSync(join(folder, 'edits.jsonl'), JSON.stringify({ name, text: input.text }) + '\n');
              entry.value = input.text;
              try { publish(); }
              catch (error) {
                projectionFailed = true;
                const issue = error as { code?: string };
                return { success: true as const, data: { saved: true, projection: issue.code ?? 'SNAPSHOT_PREPARE_FAILED' } };
              }
              return done;
            } },
          };
        },
      }) };
      return entry;
    }
    if (testTrace) {
      const watcher = watch(folder, (_event, name) => {
        if (name !== '.fail-file-view' || existsSync(fault) || !projectionFailed) return;
        publish();
        projectionFailed = false;
      });
      registerCleanup({ close: () => watcher.close() });
    }
    publish();
  },
});
