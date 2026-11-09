import { describe, it, expect } from 'vitest';
import { capturePersistenceAck, capturePersistenceOffer, captureStorageRequest, captureStorageResponse,
    captureManagedPersistenceReport, DEFAULT_STATE_SESSION_LIMITS as core, DEFAULT_STATE_TRANSPORT_LIMITS as limits } from './state-storage-protocol.js';
const request = () => ({ type: 'STATE_STORAGE_REQUEST', version: 1, instanceId: 'i', sequence: 1, action: 'replace',
    address: { namespace: '["d","a"]', key: 'k' }, text: '{}' });
describe('B02/B13/B14/B16 pure persistence protocol', () => {
    it('captures only an exact versioned offer and instance ACK', () => {
        const ack = { protocol: 'state-session-v1', version: 1, instanceId: 'i' };
        expect(capturePersistenceAck(ack, 'i')).toEqual(ack);
        for (const value of [undefined, { ...ack, instanceId: 'j' }, { ...ack, extra: true }, { ...ack, protocol: 'state-session-v2' }, { ...ack, version: 2 }]) expect(capturePersistenceAck(value, 'i')).toBeNull();
        const offer = { ...ack, limits: core, transport: limits };
        expect(capturePersistenceOffer(offer, 'i')).toEqual(offer);
        expect(capturePersistenceOffer({ ...offer, protocol: 'state-session-v2' }, 'i')).toBeNull();
        let getters = 0;
        for (const input of [ack, offer]) {
            const accessor = Object.defineProperty({ ...input }, 'protocol', { enumerable: true, get() { getters++;return 'state-session-v1'; } });
            expect(capturePersistenceAck(accessor, 'i')).toBeNull();
            expect(capturePersistenceOffer(accessor, 'i')).toBeNull();
        }
        expect(getters).toBe(0);
        for (const timeoutMs of [0, -1, Infinity, 300001, 1.5, 2147483648]) expect(capturePersistenceOffer({ ...offer, transport: { ...limits, timeoutMs } }, 'i')).toBeNull();
    });
    it('rejects accessor, inherited, extra, bad address/action and release bodies before evaluating getters', () => {
        let getters = 0;const bad = { ...request() };Object.defineProperty(bad, 'text', { enumerable: true, get() { getters++;return '{}'; } });
        for (const value of [bad, Object.create(request()), { ...request(), root: '/tmp' }, { ...request(), action: 'open' },
            { ...request(), address: { namespace: 'n', key: '' } }, { ...request(), sequence: 0 }, { ...request(), sequence: Number.MAX_SAFE_INTEGER + 1 },
            { ...request(), action: 'release' }, { ...request(), text: 'x'.repeat(limits.maxRecordBytes + 1) }]) expect(captureStorageRequest(value, limits)).toBeNull();
        expect(getters).toBe(0);
    });
    it('counts logical UTF8 rather than escaped JSON and matches all reply coordinates', () => {
        const sent = captureStorageRequest({ ...request(), text: '\\'.repeat(limits.maxRecordBytes) }, limits)!;
        expect(sent).not.toBeNull();
        const reply = { type: 'STATE_STORAGE_RESPONSE', version: 1, instanceId: 'i', sequence: 1, action: 'replace', result: { status: 'applied' } };
        expect(captureStorageResponse(reply, sent, limits)?.result.status).toBe('applied');
        for (const changed of [{ action: 'remove' }, { instanceId: 'j' }, { sequence: 2 }, { version: 2 }, { extra: true }])
            expect(captureStorageResponse({ ...reply, ...changed }, sent, limits)).toBeNull();
        expect(captureStorageResponse({ ...reply, result: { status: 'applied', extra: true } }, sent, limits)?.result.status).toBe('unknown');
    });
    it('captures bounded lifecycle facts and rejects an invented healthy close', () => {
        const report = { protocol: 'state-session-v1', instanceId: 'i', ok: true, unmount: 'completed', flush: { status: 'completed', ok: true, entries: [] },
            dispose: { status: 'disposed', unsaved: [], release: { status: 'released' } } };
        expect(captureManagedPersistenceReport(report, 'i')).toEqual(report);
        expect(captureManagedPersistenceReport({ ...report, dispose: undefined }, 'i')).toBeNull();
        expect(captureManagedPersistenceReport({ ...report, extra: 'business' }, 'i')).toBeNull();
        expect(captureManagedPersistenceReport({ ...report, instanceId: 'j' }, 'i')).toBeNull();
    });
});
