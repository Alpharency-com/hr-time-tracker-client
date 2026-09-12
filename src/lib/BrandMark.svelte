<script lang="ts">
	import markUrl from '$lib/assets/brand-mark.png';

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
