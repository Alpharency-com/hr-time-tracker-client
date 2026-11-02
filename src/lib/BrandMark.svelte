<script lang="ts">
	import spring from '$lib/assets/brand-mark-spring.png';
	import summer from '$lib/assets/brand-mark-summer.png';
	import fall from '$lib/assets/brand-mark-fall.png';
	import winter from '$lib/assets/brand-mark-winter.png';

	// Northern-hemisphere months; same mapping as the favicon in app.html
	const m = new Date().getMonth();
	const markUrl = m >= 2 && m <= 4 ? spring : m <= 7 && m >= 5 ? summer : m <= 10 && m >= 8 ? fall : winter;

	let {
		size = 40,
		class: className = ''
	}: {
		size?: number;
		class?: string;
	} = $props();
</script>

<img
	src={markUrl}
	width={size}
	height={size}
	alt=""
	draggable="false"
	class="brand-mark {className}"
	style="width:{size}px;height:{size}px"
/>

<style>
	.brand-mark {
		display: block;
		flex-shrink: 0;
		border-radius: 22%;
		object-fit: cover;
	}
</style>
