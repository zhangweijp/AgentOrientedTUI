import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

const guiTests = ['src/gui/**/*.test.{ts,tsx}', 'test/gui/**/*.test.{ts,tsx}'];

export default defineConfig({
    plugins: [react()],
    root: __dirname,
    test: {
        globals: true,
        setupFiles: [path.resolve(__dirname, './test/setup.ts')],
        projects: [
            {
                extends: true,
                test: {
                    name: 'node',
                    environment: 'node',
                    exclude: [...configDefaults.exclude, '**/dist/**', ...guiTests],
                },
            },
            {
                extends: true,
                test: {
                    name: 'gui',
                    environment: 'happy-dom',
                    include: guiTests,
                },
            },
        ],
    }
});
