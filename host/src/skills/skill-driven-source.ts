import type { ContextDrivenSource, DrivenSourceContext, ToolResult } from '@aotui/agent-driver-v2';
import { jsonSchema } from '@aotui/agent-driver-v2';
import { Logger } from '../utils/logger.js';
import { SkillCatalogService } from './skill-catalog-service.js';

interface SkillToolInput {
    name: string;
}

export interface SkillDrivenSourceOptions {
    projectPath?: string;
}

export class SkillDrivenSource implements ContextDrivenSource {
    readonly name = 'Skill';

    private listeners = new Set<() => void>();
    private logger = new Logger('SkillDrivenSource');
    private catalog: SkillCatalogService;
    private sourceEnabled = true;
    private disabledSkills = new Set<string>();

    constructor(options: SkillDrivenSourceOptions = {}) {
        this.catalog = new SkillCatalogService({ projectPath: options.projectPath });
    }

    triggerUpdate(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }

    setEnabled(enabled: boolean): void {
        this.sourceEnabled = enabled;
        this.triggerUpdate();
    }

    setSkillEnabled(skillName: string, enabled: boolean): void {
        if (enabled) {
            this.disabledSkills.delete(skillName);
        } else {
            this.disabledSkills.add(skillName);
        }
        this.triggerUpdate();
    }

    getControlState(): { enabled: boolean; disabledSkills: string[] } {
        return {
            enabled: this.sourceEnabled,
            disabledSkills: Array.from(this.disabledSkills).sort((a, b) => a.localeCompare(b)),
        };
    }

    async getContext(): Promise<DrivenSourceContext> {
        if (!this.sourceEnabled) return { messages: [], tools: {} };
        const catalog = this.catalog;
        try {
            const skills = await catalog.listSkills();
            return { messages: [], tools: this.createTools(skills),
                executeTool: (name, args, id) => this.executeSkill(catalog, name, args, id) };
        } catch (error) {
            this.logger.error('Failed to capture skill context', error);
            return { messages: [], tools: {} };
        }
    }

    private createTools(skills: Awaited<ReturnType<SkillCatalogService['listSkills']>>): DrivenSourceContext['tools'] {
        const enabledSkills = skills.filter((skill) => !this.disabledSkills.has(skill.name));
        const description =
            enabledSkills.length === 0
                ? 'Load a specialized skill. No skills are currently available.'
                : [
                    'Load a specialized skill by name. Available skills:',
                    ...enabledSkills.map((skill) => `- ${skill.name}: ${skill.description}`),
                ].join('\n');

        const skillTool: DrivenSourceContext['tools'][string] = {
            description,
            inputSchema: jsonSchema({
                type: 'object',
                additionalProperties: false,
                properties: {
                    name: {
                        type: 'string',
                        description: 'Skill name from available list',
                    },
                },
                required: ['name'],
            }),
            type: 'dynamic',
        };

        return {
            skill: skillTool,
        };
    }

    private async executeSkill(catalog: SkillCatalogService, toolName: string, args: unknown, toolCallId: string): Promise<ToolResult | undefined> {
        if (toolName !== 'skill') {
            return undefined;
        }

        const input = (args || {}) as Partial<SkillToolInput>;
        const requested = input.name?.trim();
        if (!requested) {
            this.triggerUpdate();
            return {
                toolCallId,
                toolName,
                error: {
                    code: 'E_INVALID_ARGS',
                    message: 'Missing required field: name',
                },
            };
        }

        const skill = await catalog.getSkill(requested);
        if (!skill) {
            const available = (await catalog.listSkills()).map((x) => x.name).join(', ') || 'none';
            this.triggerUpdate();
            return {
                toolCallId,
                toolName,
                error: {
                    code: 'E_SKILL_NOT_FOUND',
                    message: `Skill "${requested}" not found. Available skills: ${available}`,
                },
            };
        }

        if (this.disabledSkills.has(skill.name)) {
            this.triggerUpdate();
            return {
                toolCallId,
                toolName,
                error: {
                    code: 'E_SKILL_DISABLED',
                    message: `Skill "${skill.name}" is temporarily disabled for this topic.`,
                },
            };
        }

        this.logger.info('Skill loaded', {
            name: skill.name,
            scope: skill.scope,
            location: skill.location,
        });

        this.triggerUpdate();

        return {
            toolCallId,
            toolName,
            result: [
                `<skill_content name="${skill.name}">`,
                `# Skill: ${skill.name}`,
                '',
                skill.content,
                '',
                `Location: ${skill.location}`,
                `Scope: ${skill.scope}`,
                '</skill_content>',
            ].join('\n'),
        };
    }

    onUpdate(callback: () => void): () => void {
        this.listeners.add(callback);
        return () => {
            this.listeners.delete(callback);
        };
    }
}
