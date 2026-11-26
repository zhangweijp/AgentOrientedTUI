import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ModelTab } from '../../../src/gui/components/settings/ModelTab.js';

const bridge = vi.hoisted(() => ({
    query: vi.fn(),
    getAllLLMConfigs: vi.fn(),
    getActiveLLMConfig: vi.fn(),
    listCustomProviders: vi.fn(),
    updateLLMConfig: vi.fn(),
    setActiveLLMConfig: vi.fn(),
    getTrpcClient() {
        return { modelRegistry: { getModels: { query: this.query }, getProviders: { query: async () => [] } } };
    },
}));
vi.mock('../../../src/gui/ChatBridge.js', () => ({ useChatBridge: () => bridge }));

const providers = () => [
    { id: 1, providerId: 'openai', name: 'Model provider A', model: 'a-main', isActive: true },
    { id: 2, providerId: 'anthropic', name: 'Model provider B', model: 'b-old', isActive: false },
];
const a = [{ id: 'a-other', name: 'A Other' }, { id: 'a-main', name: 'A Main' }];
const b = [{ id: 'b-new', name: 'B New' }, { id: 'b-old', name: 'B Old' }];

beforeEach(() => {
    vi.resetAllMocks();
    bridge.listCustomProviders.mockResolvedValue([]);
});

it('renders the stored active model ID first and restores the choice through the normal bridge after remount', async () => {
    const configs = providers();
    bridge.getAllLLMConfigs.mockImplementation(async () => configs.map(value => ({ ...value })));
    bridge.query.mockImplementation(async ({ providerId }) => providerId === 'openai' ? a : b);
    bridge.updateLLMConfig.mockImplementation(async (id, data) => Object.assign(configs.find(config => config.id === id)!, data));
    bridge.setActiveLLMConfig.mockImplementation(async id => { for (const config of configs) config.isActive = config.id === id; });
    const tab = render(<ModelTab />);
    const active = await screen.findByRole('listitem', { name: 'A Main model (active)' });
    expect(within(screen.getByRole('list', { name: 'Model list' })).getAllByRole('listitem')[0]).toBe(active);
    fireEvent.click(screen.getByRole('radio', { name: /Model provider B/ }));
    const next = await screen.findByRole('listitem', { name: 'B New model' });
    expect(screen.queryByRole('listitem', { name: /\(active\)/ })).not.toBeInTheDocument();
    fireEvent.click(within(next).getByRole('button', { name: 'Activate' }));
    expect(await screen.findByRole('listitem', { name: 'B New model (active)' })).toBeInTheDocument();
    expect(bridge.updateLLMConfig).toHaveBeenCalledExactlyOnceWith(2, { model: 'b-new' });
    expect(bridge.setActiveLLMConfig).toHaveBeenCalledExactlyOnceWith(2);
    expect(bridge.getActiveLLMConfig).not.toHaveBeenCalled();
    tab.unmount();
    render(<ModelTab />);
    expect(await screen.findByRole('listitem', { name: 'B New model (active)' })).toBeInTheDocument();
});

it('uses only the selected provider response and reports a query failure', async () => {
    const first = Promise.withResolvers<typeof a>();
    bridge.getAllLLMConfigs.mockResolvedValue(providers().map(config => ({ ...config, isActive: false })));
    bridge.query.mockImplementation(async ({ providerId }) => {
        if (providerId === 'openai') return first.promise;
        throw Error('fixture query failed');
    });
    render(<ModelTab />);
    const providerA = await screen.findByRole('radio', { name: 'Model provider A provider' });
    expect(bridge.query).not.toHaveBeenCalled();
    fireEvent.click(providerA);
    expect(bridge.query).toHaveBeenCalledWith({ providerId: 'openai' });
    fireEvent.click(screen.getByRole('radio', { name: /Model provider B/ }));
    expect(await screen.findByText(/Failed to load models/)).toBeInTheDocument();
    await act(async () => { first.resolve(a);await first.promise; });
    expect(screen.queryByText('A Main')).not.toBeInTheDocument();
    expect(screen.getByText(/No models available/)).toBeInTheDocument();
});
