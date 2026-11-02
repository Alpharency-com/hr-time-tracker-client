import { readable } from 'svelte/store';

/**
 * True where the animated background is not worth loading: phones and other
 * touch-first devices (it is barely visible there and costs battery/GPU), narrow
 * windows, and users who ask for reduced motion. Updates live as the viewport changes.
 */
export const skipBackground = readable(false, (set) => {
	if (typeof window === 'undefined') return;
	const query = window.matchMedia(
		'(max-width: 767px), (pointer: coarse), (prefers-reduced-motion: reduce)'
	);
	const update = () => set(query.matches);
	update();
	query.addEventListener('change', update);
	return () => query.removeEventListener('change', update);
});
