import { expect, it } from 'vitest';
import { defineRuntimeConfig } from '../../spi/config/index.js';
import { Desktop } from './desktop.js';

it('bounds each Desktop log and preserves the other Desktop on close', async () => {
    const runtimeConfig = defineRuntimeConfig({ logger: { maxSystemLogs: 10 } });
    const first = new Desktop('desk', { runtimeConfig }), neighbor = new Desktop('desk:a', { runtimeConfig });
    for (let index = 0; index < 10; index++) first.logSystem('old-' + index);
    first.logSystem('warning', 'warn');
    first.logSystem('error', 'error');
    neighbor.logSystem('neighbor');
    const logs = first.getSystemLogs();
    expect(logs).toHaveLength(10);
    expect(logs[0]?.message).toBe('old-2');
    expect(logs.slice(-2)).toEqual([
        { timestamp: expect.any(Number), level: 'warn', message: 'warning' },
        { timestamp: expect.any(Number), level: 'error', message: 'error' },
    ]);

    await first.beginClose().completion;
    const next = new Desktop('desk', { runtimeConfig });
    first.logSystem('late');
    expect(first.getSystemLogs()).toEqual([]);
    expect(next.getSystemLogs().map(entry => entry.message)).toEqual(['Desktop initialized.']);
    expect(neighbor.getSystemLogs().at(-1)).toMatchObject({ message: 'neighbor', level: 'info' });

    await Promise.all([next.beginClose().completion, neighbor.beginClose().completion]);
});
