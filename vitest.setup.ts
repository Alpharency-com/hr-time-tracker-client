// Minimal browser globals for tests that run under Node (no jsdom installed).
const g = globalThis as any;
g.window ??= g;
g.document ??= {
	addEventListener: () => {},
	removeEventListener: () => {},
	visibilityState: 'visible',
	hidden: false
};
if (typeof g.addEventListener !== 'function') {
	// Real event bus so window.dispatchEvent(new Event('online')) reaches listeners.
	const bus = new EventTarget();
	g.addEventListener = bus.addEventListener.bind(bus);
	g.removeEventListener = bus.removeEventListener.bind(bus);
	g.dispatchEvent = bus.dispatchEvent.bind(bus);
}
if (typeof g.localStorage === 'undefined') {
	const m = new Map<string, string>();
	g.localStorage = {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, String(v)),
		removeItem: (k: string) => void m.delete(k),
		clear: () => m.clear(),
		key: (i: number) => [...m.keys()][i] ?? null,
		get length() {
			return m.size;
		}
	};
}
