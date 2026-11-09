/**
 * @aotui/host - SystemPromptDrivenSource Tests
 * 
 * 单元测试
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentDriverV2, type ContextDrivenSource } from '@aotui/agent-driver-v2';
import { SystemPromptDrivenSource } from '../../src/adapters/system-prompt-source.js';

describe('SystemPromptDrivenSource', () => {
    describe('Constructor', () => {
        it('should create source with valid config', () => {
            const source = new SystemPromptDrivenSource({
                systemPrompt: 'Test prompt',
            });
            
            expect(source.name).toBe('SystemPrompt');
        });
        
        it('should throw error with empty prompt', () => {
            expect(() => {
                new SystemPromptDrivenSource({
                    systemPrompt: '',
                });
            }).toThrow('systemPrompt cannot be empty');
        });
        
        it('should throw error with whitespace-only prompt', () => {
            expect(() => {
                new SystemPromptDrivenSource({
                    systemPrompt: '   ',
                });
            }).toThrow('systemPrompt cannot be empty');
        });
    });
    
    describe('getContext messages', () => {
        it('should return system message with timestamp 0', async () => {
            const source = new SystemPromptDrivenSource({
                systemPrompt: 'Test prompt',
            });
            
            const messages = await source.getContext().then(context => context.messages);
            
            expect(messages).toHaveLength(1);
            expect(messages[0]).toMatchObject({
                role: 'system',
                content: 'Test prompt',
                timestamp: 0,
            });
        });
        
        it('should return same message on multiple calls', async () => {
            const source = new SystemPromptDrivenSource({
                systemPrompt: 'Test prompt',
            });
            
            const messages1 = await source.getContext().then(context => context.messages);
            const messages2 = await source.getContext().then(context => context.messages);
            
            expect(messages1).toEqual(messages2);
        });

        it('isolates a failed prompt read, continues the real Driver and recovers on the next capture', async () => {
            const failure = new Error('Prompt provider temporarily unavailable');
            let failRead = false;
            const source = new SystemPromptDrivenSource({
                get systemPrompt() {
                    if (failRead) throw failure;
                    return 'Recovered instructions';
                },
            });
            const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
            const capture = vi.spyOn(source, 'getContext');
            const release = vi.fn(), onRunError = vi.fn();
            const healthy: ContextDrivenSource = {
                name: 'healthy',
                getContext: vi.fn(async () => {
                    driver.stop();
                    return { messages: [], tools: {}, release };
                }),
                onUpdate: () => () => {},
            };
            const driver = new AgentDriverV2({
                sources: [source, healthy], llm: { model: 'openai:controlled-prompt-read' }, onRunError,
            });
            try {
                failRead = true;
                await driver.trigger();
                await driver['runInFlight'];
                expect(healthy.getContext).toHaveBeenCalledTimes(1);
                expect(onRunError).not.toHaveBeenCalled();
                expect(release).toHaveBeenCalledTimes(1);
                expect(capture).toHaveBeenCalledTimes(1);
                await expect(capture.mock.results[0].value).resolves.toStrictEqual({ messages: [], tools: {} });
                expect(diagnostic).toHaveBeenCalledExactlyOnceWith('Failed to capture context from SystemPrompt:', failure);
                failRead = false;
                await expect(source.getContext()).resolves.toStrictEqual({
                    messages: [{ role: 'system', content: 'Recovered instructions', timestamp: 0, region: 'static' }], tools: {},
                });
                expect(diagnostic).toHaveBeenCalledTimes(1);
                expect(() => source.setSystemPrompt('   ')).toThrow('systemPrompt cannot be empty');
                expect(() => new SystemPromptDrivenSource({ get systemPrompt(): string { throw failure; } })).toThrow(failure);
            } finally {
                driver.stop();
                await driver['runInFlight'];
                driver.dispose();
                capture.mockRestore();
                diagnostic.mockRestore();
            }
        });
    });
    
    describe('getContext tools', () => {
        it('should return empty object', async () => {
            const source = new SystemPromptDrivenSource({
                systemPrompt: 'Test',
            });
            
            const tools = await source.getContext().then(context => context.tools);
            expect(Object.keys(tools)).toHaveLength(0);
        });
    });
    
    describe('no executor', () => {
        it('should return undefined', async () => {
            const source = new SystemPromptDrivenSource({
                systemPrompt: 'Test',
            });
            
            const result = (await source.getContext()).executeTool;
            
            expect(result).toBeUndefined();
        });
    });
    
    describe('onUpdate', () => {
        it('should return unsubscribe function', () => {
            const source = new SystemPromptDrivenSource({
                systemPrompt: 'Test',
            });
            
            const unsubscribe = source.onUpdate(() => {});
            expect(typeof unsubscribe).toBe('function');
            
            // Should not throw
            unsubscribe();
        });
        
        it('does not notify for capture, but publishes prompt changes without altering old captures', async () => {
            const source = new SystemPromptDrivenSource({ systemPrompt: 'Test' });
            const changed = vi.fn();
            const off = source.onUpdate(changed);
            const first = await source.getContext();
            expect(changed).not.toHaveBeenCalled();
            source.setSystemPrompt('Updated');
            const second = await source.getContext();
            expect(first.messages).toEqual([{ role: 'system', content: 'Test', timestamp: 0, region: 'static' }]);
            expect(second.messages).toEqual([{ role: 'system', content: 'Updated', timestamp: 0, region: 'static' }]);
            expect(changed).toHaveBeenCalledTimes(1);
            off();
            source.setSystemPrompt('After unsubscribe');
            expect(changed).toHaveBeenCalledTimes(1);
        });
    });
    
    describe('getMetadata', () => {
        it('should return empty object when no metadata provided', () => {
            const source = new SystemPromptDrivenSource({
                systemPrompt: 'Test',
            });
            
            const metadata = source.getMetadata();
            expect(metadata).toEqual({});
        });
        
        it('should return provided metadata', () => {
            const source = new SystemPromptDrivenSource({
                systemPrompt: 'Test',
                metadata: {
                    version: '1.0',
                    locale: 'en-US',
                },
            });
            
            const metadata = source.getMetadata();
            expect(metadata).toEqual({
                version: '1.0',
                locale: 'en-US',
            });
        });
    });
});
