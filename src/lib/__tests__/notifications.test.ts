import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writable } from 'svelte/store';

const h = vi.hoisted(() => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }));

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/logger', () => ({
	default: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}));
vi.mock('$lib/queryClient', () => ({
	queryClient: { setQueryData: h.setQueryData, invalidateQueries: h.invalidateQueries }
}));
vi.mock('../stores', async () => {
	const { writable } = await import('svelte/store');
	return { authToken: writable<string | null>('tok'), baseUrl: writable('http://localhost:3000') };
});
vi.mock('../network', async () => {
	const { writable } = await import('svelte/store');
	return { network: writable({ isOnline: true }) };
});

class FakeWS {
	static OPEN = 1;
	static instances: FakeWS[] = [];
	readyState = 1;
	onopen: any;
	onmessage: any;
	onclose: any;
	onerror: any;
	sent: string[] = [];
	constructor(public url: string) {
		FakeWS.instances.push(this);
	}
	send(d: string) {
		this.sent.push(d);
	}
	close = vi.fn();
}

const okTicket = () => ({ ok: true, json: async () => ({ ticket: 'abc' }) });

async function setup(token: string | null = 'tok') {
	const { authToken } = await import('../stores');
	const { createNotificationService } = await import('../notifications');
	// Build the service tokenless so its constructor doesn't auto-connect, then set the
	// token and let the module-level singleton connect and settle; discard its socket.
	(authToken as any).set(null);
	const service = createNotificationService();
	(authToken as any).set(token);
	await vi.advanceTimersByTimeAsync(0);
	FakeWS.instances = [];
	vi.mocked(fetch).mockClear();
	return { authToken, service };
}

describe('NotificationService (websocket)', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		FakeWS.instances = [];
		h.setQueryData.mockClear();
		h.invalidateQueries.mockClear();
		vi.stubGlobal('WebSocket', FakeWS);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okTicket()));
		const { authToken } = await import('../stores');
		(authToken as any).set('tok');
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('fetches a ticket and opens the socket with it', async () => {
		const { service } = await setup();
		await service.connect();
		expect(fetch).toHaveBeenCalledWith(
			'http://localhost:3000/api/notifications/websocket-ticket/',
			expect.objectContaining({ method: 'POST' })
		);
		expect(FakeWS.instances.at(-1)!.url).toBe('ws://localhost:3000/ws/notifications/?ticket=abc');
		FakeWS.instances.at(-1)!.onopen();
		expect(service.isConnected()).toBe(true);
		service.disconnect();
	});

	it('does not connect without a token', async () => {
		const { service } = await setup(null);
		await service.connect();
		expect(fetch).not.toHaveBeenCalled();
		expect(service.isConnected()).toBe(false);
	});

	it('records an error when the ticket fails', async () => {
		vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as any);
		const { service } = await setup();
		await service.connect();
		expect(service.getLastError()).toBe('Failed to obtain WebSocket ticket');
		service.disconnect();
	});

	it('seeds the active-entry cache on ready and acks', async () => {
		const { service } = await setup();
		await service.connect();
		const ws = FakeWS.instances.at(-1)!;
		ws.onopen();
		ws.onmessage({
			data: JSON.stringify({ version: 1, type: 'ready', connection_id: 'c1', active_entry: null })
		});
		expect(h.setQueryData).toHaveBeenCalledWith(expect.anything(), null);
		expect(ws.sent.some((s) => JSON.parse(s).type === 'ready_ack')).toBe(true);
		service.disconnect();
	});

	it('throttles time_entry_changed invalidations', async () => {
		const { service } = await setup();
		await service.connect();
		const ws = FakeWS.instances.at(-1)!;
		ws.onopen();
		const msg = { data: JSON.stringify({ version: 1, type: 'time_entry_changed' }) };
		ws.onmessage(msg);
		ws.onmessage(msg);
		expect(h.invalidateQueries).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(5_000);
		expect(h.invalidateQueries).toHaveBeenCalledTimes(2);
		service.disconnect();
	});

	it('ignores malformed and wrong-version messages', async () => {
		const { service } = await setup();
		await service.connect();
		const ws = FakeWS.instances.at(-1)!;
		ws.onopen();
		ws.onmessage({ data: 'not json' });
		ws.onmessage({ data: JSON.stringify({ version: 2, type: 'time_entry_changed' }) });
		expect(h.invalidateQueries).not.toHaveBeenCalled();
		service.disconnect();
	});

	it('clears the token on close code 4401', async () => {
		const { service, authToken } = await setup();
		await service.connect();
		const ws = FakeWS.instances.at(-1)!;
		ws.onopen();
		ws.onclose({ code: 4401 });
		let token: string | null = 'x';
		authToken.subscribe((v: any) => (token = v))();
		expect(token).toBeNull();
		expect(service.getLastError()).toMatch(/Authentication expired/);
	});

	it('disconnect closes the socket', async () => {
		const { service } = await setup();
		await service.connect();
		const ws = FakeWS.instances.at(-1)!;
		ws.onopen();
		service.disconnect();
		expect(ws.close).toHaveBeenCalled();
		expect(service.isConnected()).toBe(false);
	});
});
