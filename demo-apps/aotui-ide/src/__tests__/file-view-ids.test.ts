import { reconcileFileViewIds } from '../tui/file-view-ids.js';

describe('P0: stable public FileDetail viewId', () => {
    it('keeps View IDs when preceding files close or activeFiles reorder', () => {
        const initial = reconcileFileViewIds(['/a/App.tsx', '/a/package.json', '/a/index.ts'], new Map(), 0);
        expect([...initial.ids]).toEqual([
            ['/a/App.tsx', 'fd_0'], ['/a/package.json', 'fd_1'], ['/a/index.ts', 'fd_2'],
        ]);
        const afterClose = reconcileFileViewIds(['/a/package.json', '/a/index.ts'], initial.ids, initial.nextId);
        expect([...afterClose.ids]).toEqual([
            ['/a/package.json', 'fd_1'], ['/a/index.ts', 'fd_2'],
        ]);
        const reordered = reconcileFileViewIds(['/a/index.ts', '/a/package.json'], afterClose.ids, afterClose.nextId);
        expect(reordered.ids.get('/a/index.ts')).toBe('fd_2');
        expect(reordered.ids.get('/a/package.json')).toBe('fd_1');
        expect(reordered.nextId).toBe(3);
        // Immutable prior observations remain unchanged.
        expect(initial.ids.get('/a/App.tsx')).toBe('fd_0');
    });

    it('never assigns a closed file viewId to another file or a reopened file', () => {
        const initial = reconcileFileViewIds(['/a/App.tsx', '/a/package.json'], new Map(), 0);
        const afterClose = reconcileFileViewIds(['/a/package.json'], initial.ids, initial.nextId);
        const newFile = reconcileFileViewIds(['/a/package.json', '/a/util.ts'], afterClose.ids, afterClose.nextId);
        expect(newFile.ids.get('/a/package.json')).toBe('fd_1');
        expect(newFile.ids.get('/a/util.ts')).toBe('fd_2');
        const reopened = reconcileFileViewIds(['/a/App.tsx', '/a/package.json'], newFile.ids, newFile.nextId);
        expect(reopened.ids.get('/a/App.tsx')).toBe('fd_3');
        expect(reopened.ids.get('/a/package.json')).toBe('fd_1');
        expect([...reopened.ids.values()]).not.toContain('fd_0');
    });

    it('refuses duplicate file paths rather than giving two Views the same public ID', () => {
        expect(() => reconcileFileViewIds(['/a/App.tsx', '/a/App.tsx'], new Map(), 0))
            .toThrow(/Duplicate FileDetail path/);
    });

    it('restored persisted activeFiles obtain fresh IDs scoped to this App lifetime', () => {
        const persisted = ['/a/index.ts', '/a/App.tsx'];
        const first = reconcileFileViewIds(persisted, new Map(), 0);
        const repeated = reconcileFileViewIds(persisted, first.ids, first.nextId);
        expect([...repeated.ids]).toEqual([...first.ids]);
        const otherApp = reconcileFileViewIds(persisted, new Map(), 0);
        expect([...otherApp.ids]).toEqual([...first.ids]);
        // Distinct AppInstanceId + ViewInstanceId disambiguate across App restarts.
    });
});
