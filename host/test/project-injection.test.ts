import { afterEach, expect, it, vi } from 'vitest';
import { createRuntime } from '@aotui/runtime';
import { DesktopManager } from '../src/core/desktop-manager.js';
import { LLMConfigService } from '../src/core/llm-config-service.js';
import { MessageService } from '../src/core/message-service.js';
import { SessionManagerV3 } from '../src/core/session-manager-v3.js';
import * as db from '../src/db/index.js';
import { ModelRegistry } from '../src/services/model-registry.js';

afterEach(() => vi.restoreAllMocks());

it.each(['/synthetic/project', undefined])('passes the selected project path to App installation (%s)', async projectPath => {
    const desktopId = projectPath ? 'topic_with_project' : 'topic_without_project';
    const projectId = projectPath ? 'project' : undefined;
    vi.spyOn(db, 'getTopic').mockReturnValue({
        id: desktopId, title: 'Topic', projectId, createdAt: 1, updatedAt: 1, status: 'hot',
    });
    vi.spyOn(db, 'getProject').mockReturnValue(projectPath
        ? { id: 'project', path: projectPath, name: 'Project', createdAt: 1 } : null);
    const kernel = createRuntime();
    const desktopManager = new DesktopManager({ kernel });
    const createDesktop = vi.spyOn(desktopManager, 'createDesktop');
    const llm = new LLMConfigService(new ModelRegistry());
    vi.spyOn(llm, 'resolveLLMConfig').mockResolvedValue({ model: 'synthetic', provider: { id: 'openai' } });
    const manager = new SessionManagerV3(desktopManager, llm, new MessageService());
    try {
        await manager.ensureSession(desktopId);
        expect(createDesktop).toHaveBeenCalledExactlyOnceWith(desktopId,
            projectPath ? { projectPath, workspace_dir_path: projectPath } : undefined);
    } finally {
        await manager.cleanup();
    }
});
