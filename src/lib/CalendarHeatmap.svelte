<script lang="ts">
	import { useAllTimeEntriesInRange, getTehranToday } from '$lib/queries/timeEntries';
	import type { TimeEntry } from '$lib/api';
	import { network } from '$lib/network';
	import { DAY_LABELS_SAT_FIRST, formatDuration, formatLocalDate } from '$lib/reports/analytics';
	import confetti from 'canvas-confetti';
	var scalar = 2;

	var clock = confetti.shapeFromText({ text: '🕰️', scalar });
	var money = confetti.shapeFromText({ text: '💸', scalar });
	var money2 = confetti.shapeFromText({ text: '💰', scalar });
	var gold = confetti.shapeFromText({ text: '🪙', scalar });
	var star = confetti.shapeFromText({ text: '🌟', scalar });
	var fire = confetti.shapeFromText({ text: '🔥', scalar });

	interface HeatmapData {
		date: string; // YYYY-MM-DD (Tehran calendar day)
		day: number; // day of month
		value: number; // total seconds
		entries: TimeEntry[];
	}

	const TEHRAN_OFFSET_MS = 3.5 * 3600_000; // Asia/Tehran is a fixed +03:30 (no DST)
	const DAY_MS = 86_400_000;

	let currentMonth = $state(new Date());

	// The COMPLETE month dataset, fetched through the shared range query. The key
	// follows `currentMonth`, so navigating months re-fetches; any timer
	// start/stop/edit invalidates it (queryKeys.timeEntries.all).
	const monthQuery = useAllTimeEntriesInRange(
		() => formatLocalDate(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1)),
		() => formatLocalDate(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0))
	);

	const monthData = $derived(buildMonthData(monthQuery.data ?? [], currentMonth));
	const cells = $derived(monthData.cells);
	const todayStr = getTehranToday();
	const monthLabel = $derived(
		currentMonth.toLocaleString('en', { month: 'long', year: 'numeric' })
	);
	const isCurrentMonth = $derived(
		formatLocalDate(currentMonth).slice(0, 7) === todayStr.slice(0, 7)
	);
	const loading = $derived(monthQuery.isPending);
	const error = $derived(
		!monthQuery.data && monthQuery.isError
			? !$network.isOnline
				? 'No cached data available. Please connect to the internet.'
				: 'Failed to load activity data. Please try again.'
			: ''
	);

	/** Tehran calendar day (YYYY-MM-DD) of an instant. */
	function tehranDay(ms: number): string {
		return new Date(ms + TEHRAN_OFFSET_MS).toISOString().slice(0, 10);
	}

	/**
	 * Pure computation: turn the month's raw entries into per-day totals.
	 * An entry's recorded duration is attributed to the day it started; if it
	 * crosses midnight (Tehran) the duration is split across days in proportion
	 * to the time spent in each, so day values always add up to the month total.
	 */
	function buildMonthData(entries: TimeEntry[], baseDate: Date) {
		const year = baseDate.getFullYear();
		const month = baseDate.getMonth();
		const daysInMonth = new Date(year, month + 1, 0).getDate();

		const dayMap = new Map<string, HeatmapData>();
		for (let day = 1; day <= daysInMonth; day++) {
			const ds = formatLocalDate(new Date(year, month, day));
			dayMap.set(ds, { date: ds, day, value: 0, entries: [] });
		}

		const now = Date.now();
		let totalSeconds = 0;
		for (const entry of entries) {
			const startMs = new Date(entry.start_time).getTime();
			const endMs = entry.end_time ? new Date(entry.end_time).getTime() : now;
			const seconds = entry.duration
				? parseInt(entry.duration, 10) || 0
				: entry.is_active
					? Math.floor((now - startMs) / 1000)
					: 0;
			if (seconds <= 0) continue;

			const startDay = tehranDay(startMs);
			dayMap.get(startDay)?.entries.push(entry);
			totalSeconds += seconds;

			if (startDay === tehranDay(endMs) || endMs <= startMs) {
				const d = dayMap.get(startDay);
				if (d) d.value += seconds;
				continue;
			}
			const span = endMs - startMs;
			for (
				let dayStart = Date.parse(`${startDay}T00:00:00+03:30`);
				dayStart < endMs;
				dayStart += DAY_MS
			) {
				const overlap = Math.min(endMs, dayStart + DAY_MS) - Math.max(startMs, dayStart);
				const d = dayMap.get(tehranDay(dayStart));
				if (d && overlap > 0) d.value += (seconds * overlap) / span;
			}
		}

		const days = Array.from(dayMap.values());
		// Saturday-first grid (matches the Reports page); pad to whole weeks.
		const lead = (new Date(year, month, 1).getDay() + 1) % 7;
		const cells: (HeatmapData | null)[] = [...Array(lead).fill(null), ...days];
		while (cells.length % 7 !== 0) cells.push(null);

		const activeDays = days.filter((d) => d.value > 0).length;
		const maxDaySeconds = Math.max(0, ...days.map((d) => d.value));
		return { cells, totalSeconds, activeDays, maxDaySeconds };
	}

	function goToPreviousMonth() {
		currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
	}

	function goToNextMonth() {
		currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
	}

	function goToToday() {
		currentMonth = new Date();
	}

	// 0 = no activity, 1..4 = quartiles of the month's busiest day.
	const levelClasses = [
		'bg-base-200',
		'bg-primary/20',
		'bg-primary/40',
		'bg-primary/65 text-primary-content',
		'bg-primary text-primary-content'
	];

	function levelOf(seconds: number): number {
		const max = monthData.maxDaySeconds;
		if (seconds <= 0 || max <= 0) return 0;
		return Math.min(4, Math.max(1, Math.ceil((seconds / max) * 4)));
	}

	function dayLabel(day: HeatmapData): string {
		const [y, m, d] = day.date.split('-').map(Number);
		const when = new Date(y, m - 1, d).toLocaleDateString('en', {
			weekday: 'short',
			month: 'short',
			day: 'numeric'
		});
		const n = day.entries.length;
		return day.value > 0
			? `${when} · ${formatDuration(day.value)} · ${n} ${n === 1 ? 'entry' : 'entries'}`
			: `${when} · no activity`;
	}

	// Easter egg: confetti for days with ≥8 hours
	const confettiFiredFor = new Set<string>();

	async function handleDayHover(event: MouseEvent, day: HeatmapData) {
		if (confettiFiredFor.has(day.date) || day.value < 8 * 3600) return;
		confettiFiredFor.add(day.date);
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		await confetti({
			particleCount: 30,
			spread: 60,
			startVelocity: 40,
			origin: {
				x: (rect.left + rect.width / 2) / window.innerWidth,
				y: (rect.top + rect.height / 2) / window.innerHeight
			},
			ticks: 30,
			gravity: 0.9,
			scalar: 2,
			shapes: [clock, money, money2, gold, star, fire],
			disableForReducedMotion: true
		});
	}

	function resetConfettiForDay(date: string) {
		confettiFiredFor.delete(date);
	}
</script>

<div class="card bg-base-100 shadow-lg border border-base-200 h-full flex flex-col">
	<div class="card-body p-4 flex-1 flex flex-col gap-3">
		<!-- Header: title + month navigation -->
		<div class="flex flex-wrap items-center justify-between gap-2">
			<h2 class="card-title text-sm flex items-center">
				<svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
					></path>
				</svg>
				Month Activity
			</h2>
			<div class="flex items-center gap-1 text-xs font-semibold">
				<button
					class="btn btn-ghost btn-xs btn-square"
					onclick={goToPreviousMonth}
					aria-label="Previous month"
				>
					‹
				</button>
				<span class="min-w-28 text-center tabular-nums">{monthLabel}</span>
				<button
					class="btn btn-ghost btn-xs btn-square"
					onclick={goToNextMonth}
					aria-label="Next month"
					disabled={isCurrentMonth}
				>
					›
				</button>
				{#if !isCurrentMonth}
					<button class="btn btn-outline btn-xs" onclick={goToToday}>Today</button>
				{/if}
			</div>
		</div>

		{#if error}
			<div class="alert alert-error">
				<span>{error}</span>
			</div>
		{:else}
			<div class="w-full max-w-md mx-auto flex-1 flex flex-col justify-center gap-1.5">
				<!-- Weekday labels -->
				<div class="grid grid-cols-7 gap-1.5 text-[10px] text-base-content/60 text-center">
					{#each DAY_LABELS_SAT_FIRST as label}
						<div>{label}</div>
					{/each}
				</div>

				{#if loading}
					<div class="w-full aspect-[7/5] rounded-md skeleton"></div>
				{:else}
					<div class="grid grid-cols-7 gap-1.5 fade-in-grid">
						{#each cells as day}
							{#if day}
								{@const future = day.date > todayStr}
								<div class="tooltip tooltip-top" data-tip={dayLabel(day)}>
									<div
										role="img"
										aria-label={dayLabel(day)}
										class="aspect-square rounded-md flex items-center justify-center text-[10px] tabular-nums transition-transform hover:scale-110 {levelClasses[
											levelOf(day.value)
										]} {day.date === todayStr
											? 'ring-2 ring-primary ring-offset-1 ring-offset-base-100 font-bold'
											: ''} {future ? 'opacity-40' : ''} {day.value === 0 ? 'text-base-content/50' : ''}"
										onmouseenter={(e) => handleDayHover(e, day)}
										onmouseleave={() => resetConfettiForDay(day.date)}
									>
										{day.day}
									</div>
								</div>
							{:else}
								<div class="aspect-square"></div>
							{/if}
						{/each}
					</div>
				{/if}
			</div>

			<!-- Footer: month stats + legend -->
			<div class="flex flex-wrap items-end justify-between gap-3 pt-1">
				<div class="flex gap-5">
					<div>
						<p class="text-[10px] uppercase tracking-wider text-base-content/50">Total</p>
						<p class="text-sm font-bold tabular-nums">
							{loading ? '—' : formatDuration(monthData.totalSeconds)}
						</p>
					</div>
					<div>
						<p class="text-[10px] uppercase tracking-wider text-base-content/50">Active days</p>
						<p class="text-sm font-bold tabular-nums">{loading ? '—' : monthData.activeDays}</p>
					</div>
					<div>
						<p class="text-[10px] uppercase tracking-wider text-base-content/50">Daily avg</p>
						<p class="text-sm font-bold tabular-nums">
							{loading || !monthData.activeDays
								? '—'
								: formatDuration(monthData.totalSeconds / monthData.activeDays)}
						</p>
					</div>
				</div>
				<div class="flex items-center gap-1 text-[10px] text-base-content/60" aria-hidden="true">
					Less
					{#each levelClasses as cls}
						<span class="w-3 h-3 rounded-sm {cls.split(' ')[0]}"></span>
					{/each}
					More
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.fade-in-grid {
		animation: fadeInUp 220ms ease-out;
		animation-fill-mode: both;
	}

	@keyframes fadeInUp {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
