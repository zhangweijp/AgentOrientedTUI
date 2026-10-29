import { completeCreateFileWorkflow } from '../tui/create-file-workflow.js';

describe('completeCreateFileWorkflow', () => {
    it('creates a file and opens it in a new FileDetail view', async () => {
        const filePath = '/project/src/new-file.ts';
        const fileSystemService = {
            createFile: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined),
        };
        const persistenceService = {
            addOpenFile: jest.fn<Promise<void>, [string, { path: string; lastOpened: number }]>().mockResolvedValue(undefined),
        };
        const eventBus = {
            emit: jest.fn<Promise<void>, [string, unknown]>().mockResolvedValue(undefined),
        };
        const onOpenFileDetail = jest.fn<void, [string]>();

        const result = await completeCreateFileWorkflow({
            filePath,
            content: 'export const created = true;\n',
            workspaceFolders: ['/project'],
            fileSystemService,
            persistenceService,
            eventBus,
            onOpenFileDetail,
        });

        expect(fileSystemService.createFile).toHaveBeenCalledWith(filePath, 'export const created = true;\n');
        expect(onOpenFileDetail).toHaveBeenCalledWith(filePath);
        expect(persistenceService.addOpenFile).toHaveBeenCalledWith(
            '/project',
            expect.objectContaining({
                path: filePath,
                lastOpened: expect.any(Number),
            }),
        );
        expect(eventBus.emit.mock.calls).toEqual([
            ['open_files_updated', {}],
            ['file_changed', { filePath }],
        ]);
        expect(result).toEqual({
            message: `File created and opening a FileDetail View was requested. Check the next Workspace Snapshot for the actual View ID: ${filePath}`,
        });
    });
});


describe('P0: create_file result truthfully describes the filesystem outcome', () => {
    const filePath = '/project/src/new-file.ts';

    it('reports file creation as success with warnings when post-write UI steps fail', async () => {
        const warnings = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const created = jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined);
        const onOpenFileDetail = jest.fn<void, [string]>(() => { throw new Error('UI unavailable'); });
        const persisted = jest.fn<Promise<void>, [string, any]>()
            .mockRejectedValue(new Error('Persistence unavailable'));
        const emitted = jest.fn<Promise<void>, [string, unknown]>()
            .mockRejectedValue(new Error('Event bus unavailable'));
        try {
            const outcome = await completeCreateFileWorkflow({
                filePath, content: 'created',
                workspaceFolders: ['/project'],
                fileSystemService: { createFile: created },
                persistenceService: { addOpenFile: persisted },
                eventBus: { emit: emitted as any },
                onOpenFileDetail,
            });
            expect(created).toHaveBeenCalledTimes(1);
            expect(onOpenFileDetail).toHaveBeenCalledWith(filePath);
            expect(persisted).toHaveBeenCalledTimes(1);
            expect(emitted).toHaveBeenCalledTimes(2);
            expect(outcome.message).toContain('File created, but FileDetail opening');
            expect(outcome).toMatchObject({ warnings: [
                'FileDetail view opening could not be requested',
                'Open-file persistence failed',
                'Open-files notification failed',
                'File-change notification failed',
            ] });
            expect(JSON.stringify(outcome)).not.toContain('FileDetail View (fd_');
        } finally {
            warnings.mockRestore();
        }
    });

    it('when the atomic file create fails, does not claim creation or update UI', async () => {
        const failure = new Error('File already exists');
        const created = jest.fn<Promise<void>, [string, string]>().mockRejectedValue(failure);
        const onOpenFileDetail = jest.fn<void, [string]>();
        const persisted = jest.fn<Promise<void>, [string, any]>();
        const emitted = jest.fn<Promise<void>, [string, unknown]>();
        await expect(completeCreateFileWorkflow({
            filePath, content: 'new content', workspaceFolders: ['/project'],
            fileSystemService: { createFile: created },
            persistenceService: { addOpenFile: persisted },
            eventBus: { emit: emitted as any }, onOpenFileDetail,
        })).rejects.toThrow(/File already exists/);
        expect(onOpenFileDetail).not.toHaveBeenCalled();
        expect(persisted).not.toHaveBeenCalled();
        expect(emitted).not.toHaveBeenCalled();
    });
});
