import type { AppEvents, FileInfo } from '../types.js';

type CreateFileWorkflowDependencies = {
    filePath: string;
    content: string;
    workspaceFolders: string[];
    fileSystemService: {
        createFile(filePath: string, content: string): Promise<void>;
    };
    persistenceService: {
        addOpenFile(workspacePath: string, fileInfo: FileInfo): Promise<void>;
    };
    eventBus: {
        emit<Name extends keyof AppEvents>(eventName: Name, eventData: AppEvents[Name]): Promise<void>;
    };
    onOpenFileDetail(filePath: string): void;
};

export async function completeCreateFileWorkflow({
    filePath,
    content,
    workspaceFolders,
    fileSystemService,
    persistenceService,
    eventBus,
    onOpenFileDetail,
}: CreateFileWorkflowDependencies): Promise<{ message: string; warnings?: string[] }> {
    await fileSystemService.createFile(filePath, content);

    // After the exclusive filesystem create succeeds, later UI/persistence
    // failures must not be reported as "file was not created".
    const warnings: string[] = [];
    let openingRequested = false;
    try {
        onOpenFileDetail(filePath);
        openingRequested = true;
    } catch {
        warnings.push('FileDetail view opening could not be requested');
    }

    try {
        await persistenceService.addOpenFile(workspaceFolders[0] ?? 'default', {
            path: filePath,
            lastOpened: Date.now(),
        });
    } catch (error) {
        console.warn('[RootView] Failed to persist created file as open:', error);
        warnings.push('Open-file persistence failed');
    }

    try {
        await eventBus.emit('open_files_updated', {});
    } catch {
        warnings.push('Open-files notification failed');
    }
    try {
        await eventBus.emit('file_changed', { filePath });
    } catch {
        warnings.push('File-change notification failed');
    }

    return {
        message: openingRequested
            ? `File created and opening a FileDetail View was requested. Check the next Workspace Snapshot for the actual View ID: ${filePath}`
            : `File created, but FileDetail opening was not requested successfully. Check the Workspace and retry opening the View: ${filePath}`,
        ...(warnings.length ? { warnings } : {}),
    };
}
