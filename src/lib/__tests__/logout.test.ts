import { describe, it, expect, vi, beforeEach } from 'vitest';

const gotoApp = vi.hoisted(() => vi.fn());
const queryClient = vi.hoisted(() => ({ clear: vi.fn() }));
const queryPersister = vi.hoisted(() => ({ removeClient: vi.fn() }));

vi.mock('$lib/navigation', () => ({ gotoApp }));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('../queryClient', () => ({ queryClient, queryPersister }));

function createStorageMock() {
	const store = new Map<string, string>();
	return {
		getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
		setItem: (key: string, value: string) => void store.set(key, String(value)),
		removeItem: (key: string) => void store.delete(key),
		clear: () => void store.clear(),
		key: (index: number) => [...store.keys()][index] ?? null,
		get length() {
			return store.size;
		}
	};
}

describe('globalLogout', () => {
	let localStorageMock: ReturnType<typeof createStorageMock>;
	let sessionStorageMock: ReturnType<typeof createStorageMock>;

	beforeEach(() => {
		vi.clearAllMocks();
		localStorageMock = createStorageMock();
		sessionStorageMock = createStorageMock();
		vi.stubGlobal('localStorage', localStorageMock);
		vi.stubGlobal('sessionStorage', sessionStorageMock);
	});

	it('wipes auth/cache keys but keeps settings untouched and unquoted', async () => {
		const { globalLogout } = await import('../stores');

		// Let the persistent stores finish their async initialization so their
		// writes can't race with the assertion below.
		await new Promise((resolve) => setTimeout(resolve, 0));

		localStorage.setItem('authToken', 'test-token');
		localStorage.setItem('user', '{"id":1}');
		localStorage.setItem('ftt-query-cache', '{"clientState":{}}');
		localStorage.setItem('api_cache_projects:all', '{"data":[]}');
		localStorage.setItem('timer_last_active_entry', '{}');
		localStorage.setItem('dashboard_today_entries', '[]');
		localStorage.setItem('theme', 'dark');
		localStorage.setItem('refreshInterval', '45000');
		localStorage.setItem('sidebarCollapsed', 'true');
		sessionStorage.setItem('secret', 'value');

		globalLogout();

		expect(localStorage.getItem('authToken')).toBeNull();
		expect(localStorage.getItem('user')).toBeNull();
		expect(localStorage.getItem('ftt-query-cache')).toBeNull();
		expect(localStorage.getItem('api_cache_projects:all')).toBeNull();
		expect(localStorage.getItem('timer_last_active_entry')).toBeNull();
		expect(localStorage.getItem('dashboard_today_entries')).toBeNull();
		expect(localStorage.getItem('theme')).toBe('dark');
		expect(localStorage.getItem('refreshInterval')).toBe('45000');
		expect(localStorage.getItem('sidebarCollapsed')).toBe('true');
		expect(sessionStorage.getItem('secret')).toBeNull();
		expect(gotoApp).toHaveBeenCalledWith('/');

		await vi.waitFor(() => expect(queryClient.clear).toHaveBeenCalled());
		expect(queryPersister.removeClient).toHaveBeenCalled();
	});
});
