/**
 * [RFC-027] Component Mode Integration Test
 * 
 * 验证createTUIApp + View组件的基础功能
 */
import { describe, it, expect } from 'vitest';
import { createTUIApp, View } from '../src/index.js';
import { h } from 'preact';

describe('[RFC-027] Component Mode', () => {
    it('should create TUIApp with component field', () => {
        function TestApp() {
            return h(View, { kind: 'state', id: 'test_view', type: 'TestView', name: 'TestView' }, 'Hello');
        }

        const app = createTUIApp({
            app_name: 'test_app',
            component: TestApp,
        } as any);

        expect(app).toBeDefined();
        expect(app.displayName).toBe('test_app');
        // component字段被转换为factory对象
        expect(typeof app.initialize).toBe('function');
        expect(app.kernelConfig).not.toHaveProperty('component');
        expect(app.kernelConfig.name).toBe('test_app');
    });



    it('keeps the component out of neutral kernel metadata', () => {
        function TestApp() {
            return h(View, { kind: 'state', id: 'test_view', type: 'TestView', name: 'TestView' }, 'Hello');
        }

        const app = createTUIApp({
            app_name: 'test_app',
            component: TestApp,
        } as any);

        // component字段应该存在(已转换为factory)
        expect(typeof app.initialize).toBe('function');
        // root字段不应该存在(已废弃)
        expect(app.kernelConfig).not.toHaveProperty('root');
    });
});
