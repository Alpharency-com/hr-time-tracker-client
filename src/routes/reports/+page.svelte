<script lang="ts">
	import type { TimeEntry } from '$lib/api';
	import { network } from '$lib/network';
	import { gotoApp } from '$lib/navigation';
	import { slide } from 'svelte/transition';
	import { Play } from '@lucide/svelte';
	import { ChartColumn } from '@jis3r/icons';

	import PageHeader from '$lib/PageHeader.svelte';
	import DailyActivityChart from '$lib/reports/DailyActivityChart.svelte';
	import PunchcardHeatmap from '$lib/reports/PunchcardHeatmap.svelte';
	import RankedBars from '$lib/reports/RankedBars.svelte';
	import TagChip from '$lib/TagChip.svelte';
	import { useReportData } from '$lib/queries/report';
	import {
		DAY_LABELS_SAT_FIRST,
		TIME_RANGE_OPTIONS,
		dayOfWeekFromAggregates,
		formatDuration,
		getEntryDurationSeconds,
		getPreviousRange,
		getTimeRangeDates,
		getTimeRangeDisplay,
		heatmapFromValues,
		hourlyFromAggregates,
		percentDelta,
		trendSeriesFromDaily,
		type BucketUnit,
		type HeatmapMatrix,
		type RankedItem,
		type TagDatum,
		type TrendBucket
	} from '$lib/reports/analytics';

	// ============================= Filter state =============================

	let selectedTimeRange = $state('thismonth');
	let showCustomDate = $state(false);
	// Committed custom dates (drive the query); pending inputs only commit on Apply.
	let customStartDate = $state('');
	let customEndDate = $state('');
	let pendingStart = $state('');
	let pendingEnd = $state('');

	const currentRange = $derived(
		getTimeRangeDates(selectedTimeRange, { customStart: customStartDate, customEnd: customEndDate })
	);
	const prevRange = $derived(
		getPreviousRange(selectedTimeRange, { customStart: customStartDate, customEnd: customEndDate })
	);

	// Single aggregated request: the server computes every series (see
	// api/time_entries/report_data), so the payload is a few KB regardless of
	// range — the old path fetched every raw entry in the window (twice, for
	// the deltas), which made the Year view cost thousands of serialized rows.
	const reportQuery = useReportData(
		() => currentRange,
		() => prevRange,
		() => ({ keepPreviousData: true })
	);

	const payload = $derived(reportQuery.data?.current);
	const prevWindow = $derived(reportQuery.data?.previous);

	// Recent-activity rows shaped as TimeEntry so the existing table template
	// (TagChip + live duration for a still-running entry) works unchanged.
	let recentEntries = $derived<TimeEntry[]>(
		(payload?.recent ?? []).map((row) => ({
			id: row.id,
			title: row.title,
			description: '',
			start_time: row.start_time ?? '',
			end_time: row.end_time,
			duration: row.duration,
			is_active: row.is_active,
			user: '',
			project: row.project ?? '',
			tags: row.tags.map((t) => ({
				id: t.id,
				title: t.title,
				tag: '',
				icon: t.icon,
				color: t.color,
				created_at: ''
			}))
		}))
	);

	let loading = $derived(reportQuery.isPending);
	let error = $derived(
		!reportQuery.data && reportQuery.isError ? 'Failed to load report data' : ''
	);
	let isShowingCachedData = $derived(!$network.isOnline && !!reportQuery.data);

	// ============================= Analytics ===============================
	// The server aggregates; the client only derives tiny view values
	// (averages, deltas, best-day/peak-hour picks).

	const totalSeconds = $derived(payload?.total_seconds ?? 0);
	const totalEntries = $derived(payload?.entry_count ?? 0);
	const days = $derived(payload?.span_days ?? 1);
	const avgDaily = $derived(Math.floor(totalSeconds / days));
	const trend = $derived(trendSeriesFromDaily(payload?.daily ?? [], currentRange));
	const heatmap = $derived(
		heatmapFromValues(payload?.heatmap ?? Array.from({ length: 7 }, () => Array<number>(24).fill(0)))
	);
	const projects = $derived(
		(payload?.projects ?? []).map((p) => ({
			name: p.name,
			totalSeconds: p.seconds,
			count: p.count
		}))
	);
	const tasks = $derived(
		(payload?.tasks ?? []).slice(0, 6).map((t) => ({
			name: t.name,
			totalSeconds: t.seconds,
			count: t.count
		}))
	);
	const tags = $derived<TagDatum[]>(
		(payload?.tags ?? []).slice(0, 10).map((t) => ({
			name: t.title,
			totalSeconds: t.seconds,
			count: t.count,
			color: t.color,
			tag: null
		}))
	);
	const dow = $derived(
		dayOfWeekFromAggregates(payload?.weekday_seconds ?? [], payload?.weekday_counts ?? [])
	);
	const hours = $derived(
		hourlyFromAggregates(payload?.hour_seconds ?? [], payload?.hour_counts ?? [])
	);

	const bestDay = $derived(
		dow.reduce((best, d) => (d.totalSeconds > best.totalSeconds ? d : best), dow[0])
	);
	const peakHour = $derived(
		hours.reduce((best, h) => (h.totalSeconds > best.totalSeconds ? h : best), hours[0])
	);
	const hasPeak = $derived(hours.some((h) => h.totalSeconds > 0));

	const topProject = $derived(
		projects[0]
			? {
					...projects[0],
					share: totalSeconds > 0 ? Math.round((projects[0].totalSeconds / totalSeconds) * 100) : 0
				}
			: null
	);

	// Period-over-period deltas (null until the report payload resolves).
	const hasPrev = $derived(reportQuery.data != null);
	const prevTotal = $derived(prevWindow?.total_seconds ?? 0);
	const prevAvg = $derived(
		prevWindow ? Math.floor(prevWindow.total_seconds / prevWindow.span_days) : 0
	);
	const totalDelta = $derived(hasPrev ? percentDelta(totalSeconds, prevTotal) : null);
	const avgDelta = $derived(hasPrev ? percentDelta(avgDaily, prevAvg) : null);

	const hasAnyData = $derived(totalEntries > 0 && totalSeconds > 0);

	// ============================= UI helpers ==============================

	const cardCls = 'card bg-base-100 border border-base-200 shadow-sm';

	const stats = $derived([
		{
			label: 'Total time',
			value: formatDuration(totalSeconds),
			sub: `${totalEntries} entr${totalEntries === 1 ? 'y' : 'ies'}`,
			delta: totalDelta,
			deltaSlot: true
		},
		{
			label: 'Daily avg',
			value: formatDuration(avgDaily),
			sub: `per day · ${days} day${days === 1 ? '' : 's'}`,
			delta: avgDelta,
			deltaSlot: true
		},
		{
			label: 'Peak hour',
			value: hasPeak ? `${String(peakHour.hour).padStart(2, '0')}:00` : '—',
			sub: hasPeak ? formatDuration(peakHour.totalSeconds) : 'most productive',
			delta: null,
			deltaSlot: false
		},
		{
			label: 'Best day',
			value: bestDay && bestDay.totalSeconds > 0 ? bestDay.name : '—',
			sub:
				bestDay && bestDay.totalSeconds > 0 ? formatDuration(bestDay.totalSeconds) : 'no data yet',
			delta: null,
			deltaSlot: false
		},
		{
			label: 'Top project',
			value: topProject?.name ?? '—',
			sub: topProject
				? `${formatDuration(topProject.totalSeconds)} · ${topProject.share}%`
				: 'no projects yet',
			delta: null,
			deltaSlot: false
		}
	]);

	const projectItems = $derived<RankedItem[]>(
		projects
			.slice(0, 8)
			.map((p) => ({ name: p.name, totalSeconds: p.totalSeconds, count: p.count }))
	);
	const taskItems = $derived<RankedItem[]>(
		tasks.map((t) => ({ name: t.name, totalSeconds: t.totalSeconds, count: t.count }))
	);
	const tagItems = $derived<RankedItem[]>(
		tags.map((t) => ({ name: t.name, totalSeconds: t.totalSeconds, color: t.color ?? null }))
	);
	const tagHalves = $derived([
		tagItems.slice(0, Math.ceil(tagItems.length / 2)),
		tagItems.slice(Math.ceil(tagItems.length / 2))
	]);

	function projectDotClass(name: string): string {
		const palette = [
			'bg-primary',
			'bg-secondary',
			'bg-accent',
			'bg-info',
			'bg-success',
			'bg-warning'
		];
		let sum = 0;
		for (let i = 0; i < name.length; i++) sum = (sum + name.charCodeAt(i)) % palette.length;
		return palette[sum];
	}

	function pickRange(value: string) {
		selectedTimeRange = value;
		if (value === 'custom') {
			pendingStart = customStartDate;
			pendingEnd = customEndDate;
			showCustomDate = true;
		} else {
			showCustomDate = false;
		}
	}

	function applyCustomDate() {
		customStartDate = pendingStart;
		customEndDate = pendingEnd;
		showCustomDate = false;
	}

	async function retry() {
		await reportQuery.refetch();
	}
</script>

<div class="p-0 md:p-6 lg:p-8">
	<div class="max-w-7xl mx-auto flex flex-col gap-5 md:gap-6">
		<!-- ============================= Header ============================= -->
		<PageHeader
			icon={ChartColumn}
			title="Reports"
			subtitle={`Where your hours go — ${getTimeRangeDisplay(selectedTimeRange).toLowerCase()}`}
		/>

		<!-- ====================== Range toolbar (scrolls on phones) ====================== -->
		<div class="flex flex-col gap-2">
			{#if isShowingCachedData}
				<div class="badge badge-warning badge-outline gap-1.5 py-3 px-3 self-start">
					<span class="loading loading-dots loading-xs"></span>
					Offline — showing cached data
				</div>
			{/if}
			<div class="-mx-4 px-4 md:mx-0 md:px-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				<div
					class="inline-flex gap-1 bg-base-100 border border-base-200 rounded-full p-1 shadow-sm min-w-max"
					role="tablist"
					aria-label="Time range"
				>
					{#each TIME_RANGE_OPTIONS as opt}
						<button
							type="button"
							role="tab"
							aria-selected={selectedTimeRange === opt.value}
							class="btn btn-sm rounded-full border-0 whitespace-nowrap {selectedTimeRange ===
							opt.value
								? 'bg-primary text-primary-content shadow-sm'
								: 'btn-ghost text-base-content/70 hover:bg-base-200'}"
							onclick={() => pickRange(opt.value)}
						>
							{opt.label}
						</button>
					{/each}
				</div>
			</div>
		</div>

		<!-- ======================= Custom range panel ======================= -->
		{#if showCustomDate}
			<div class={cardCls} transition:slide={{ duration: 150 }}>
				<div class="card-body p-4 gap-3">
					<div class="grid grid-cols-2 gap-3 sm:max-w-md">
						<label class="form-control min-w-0">
							<span class="label-text text-xs font-medium text-base-content/70 pb-1">From</span>
							<input type="date" class="input input-bordered w-full" bind:value={pendingStart} />
						</label>
						<label class="form-control min-w-0">
							<span class="label-text text-xs font-medium text-base-content/70 pb-1">To</span>
							<input type="date" class="input input-bordered w-full" bind:value={pendingEnd} />
						</label>
					</div>
					<div class="flex gap-2">
						<button
							class="btn btn-primary flex-1 sm:flex-none"
							onclick={applyCustomDate}
							disabled={!pendingStart || !pendingEnd}
						>
							Apply range
						</button>
						<button class="btn btn-ghost" onclick={() => (showCustomDate = false)}>Cancel</button>
					</div>
					<p class="text-xs text-base-content/60">
						Deltas compare against the same-length window right before this range.
					</p>
				</div>
			</div>
		{/if}

		<!-- =========================== Error state =========================== -->
		{#if error}
			<div class="alert alert-error shadow-sm justify-between" role="alert">
				<span>{error}</span>
				<button class="btn btn-sm btn-outline btn-error" onclick={retry}>Retry</button>
			</div>
		{:else if loading && !reportQuery.data}
			<!-- ======================== Skeleton states ======================== -->
			<div class="grid grid-cols-2 lg:grid-cols-5 gap-3" aria-busy="true">
				{#each Array.from({ length: 5 }) as _, i}
					<div class="{cardCls} {i === 4 ? 'col-span-2 lg:col-span-1' : ''}">
						<div class="card-body p-4 gap-2">
							<div class="skeleton h-3 w-16"></div>
							<div class="skeleton h-6 w-24"></div>
							<div class="skeleton h-3 w-20"></div>
						</div>
					</div>
				{/each}
			</div>
			<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
				<div class="{cardCls} lg:col-span-2">
					<div class="card-body p-4 sm:p-5">
						<div class="skeleton h-64 w-full rounded-xl"></div>
					</div>
				</div>
				<div class={cardCls}>
					<div class="card-body p-4 sm:p-5 space-y-4">
						{#each Array.from({ length: 5 }) as _}
							<div class="skeleton h-3 w-full"></div>
						{/each}
					</div>
				</div>
			</div>
		{:else}
			<!-- ============================ Stat strip =========================== -->
			<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
				{#each stats as stat, i}
					<div
						class="{cardCls} min-w-0 {i === stats.length - 1
							? 'col-span-2 md:col-span-1'
							: ''}"
					>
						<div class="card-body p-4 gap-1">
							<div class="flex items-center justify-between gap-2 min-h-5">
								<span class="text-xs text-base-content/70 truncate">{stat.label}</span>
								{#if stat.deltaSlot}
									{#if stat.delta !== null}
										<span
											class="badge badge-sm border-0 px-1.5 tabular-nums {stat.delta >= 0
												? 'bg-success/15 text-success'
												: 'bg-error/15 text-error'}"
											title="vs previous period"
										>
											{stat.delta >= 0 ? '+' : '-'}{Math.abs(stat.delta)}%
										</span>
									{:else}
										<span class="text-xs text-base-content/60" title="No previous period to compare"
											>vs prior</span
										>
									{/if}
								{/if}
							</div>
							<p class="text-2xl font-bold tabular-nums leading-tight truncate" title={stat.value}>
								{stat.value}
							</p>
							<p class="text-xs text-base-content/70 truncate">{stat.sub}</p>
						</div>
					</div>
				{/each}
			</div>

			<!-- ====================== Whole-page empty state ====================== -->
			{#if !hasAnyData}
				<div class={cardCls}>
					<div class="card-body items-center text-center py-12 gap-3">
						<h2 class="text-lg font-bold">No tracked time in this range</h2>
						<p class="text-sm text-base-content/70 max-w-sm">
							Start a timer and this page fills with trends, your weekly rhythm, and where the hours
							went.
						</p>
						<button class="btn btn-primary mt-2" onclick={() => gotoApp('/timer')}>
							<Play class="w-4 h-4" />
							Start tracking
						</button>
					</div>
				</div>
			{:else}
				<!-- ===================== Row 1: daily activity + projects ===================== -->
				<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
					<section class="{cardCls} min-w-0 lg:col-span-2">
						<div class="card-body p-4 sm:p-5 gap-3">
							<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
								<h3 class="card-title text-base">Daily activity</h3>
								<span class="text-xs text-base-content/70 tabular-nums">
									{currentRange.start ?? '—'} to {currentRange.end ?? '—'}
								</span>
							</div>
							<DailyActivityChart buckets={trend.buckets} unit={trend.unit} />
						</div>
					</section>

					<section class="{cardCls} min-w-0">
						<div class="card-body p-4 sm:p-5 gap-4">
							<h3 class="card-title text-base">By project</h3>
							{#if projectItems.length}
								<RankedBars items={projectItems} ariaLabel="Time by project" />
							{:else}
								<p class="text-sm text-base-content/70">No project data in this range.</p>
							{/if}
						</div>
					</section>
				</div>

				<!-- ===================== Row 2: rhythm + tasks ===================== -->
				<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
					<section class="{cardCls} min-w-0 lg:col-span-2">
						<div class="card-body p-4 sm:p-5 gap-4">
							<div>
								<h3 class="card-title text-base">Work rhythm</h3>
								<p class="text-sm text-base-content/70">
									When your hours land, Sat to Fri, 00:00 to 23:00
								</p>
							</div>
							<PunchcardHeatmap matrix={heatmap} />
						</div>
					</section>

					<section class="{cardCls} min-w-0">
						<div class="card-body p-4 sm:p-5 gap-4">
							<h3 class="card-title text-base">Top tasks</h3>
							{#if taskItems.length}
								<RankedBars items={taskItems} ariaLabel="Top tasks by time" />
							{:else}
								<p class="text-sm text-base-content/70">No task titles in this range.</p>
							{/if}
						</div>
					</section>
				</div>

				<!-- =========================== Top tags =========================== -->
				<section class="{cardCls} min-w-0">
					<div class="card-body p-4 sm:p-5 gap-4">
						<div>
							<h3 class="card-title text-base">Top tags</h3>
							<p class="text-sm text-base-content/70">Time by tag, in each tag's color</p>
						</div>
						{#if tagItems.length}
							<div class="grid md:grid-cols-2 gap-x-10 gap-y-3.5">
								{#each tagHalves as half, halfIndex}
									{#if half.length}
										<RankedBars items={half} ariaLabel={`Top tags (part ${halfIndex + 1})`} />
									{/if}
								{/each}
							</div>
						{:else}
							<p class="text-sm text-base-content/70">No tags used in this range.</p>
						{/if}
					</div>
				</section>

				<!-- ======================== Recent activity ======================== -->
				<section class="{cardCls} min-w-0">
					<div class="card-body p-4 sm:p-5 gap-3">
						<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
							<h3 class="card-title text-base">Recent activity</h3>
							<span class="text-xs text-base-content/70 tabular-nums">
								Showing {recentEntries.length} of {totalEntries}
							</span>
						</div>

						<!-- Phones: one row per entry -->
						<ul class="md:hidden divide-y divide-base-200 -mx-4">
							{#each recentEntries as entry}
								<li class="px-4 py-3 flex items-start justify-between gap-3">
									<div class="min-w-0 flex-1">
										<p class="text-xs text-base-content/70 tabular-nums">
											{new Date(entry.start_time).toLocaleDateString(undefined, {
												month: 'short',
												day: 'numeric'
											})}
										</p>
										<p class="font-medium truncate" title={entry.title}>{entry.title}</p>
										{#if entry.project}
											<p class="flex items-center gap-1.5 text-sm text-base-content/70 min-w-0">
												<span
													class="w-2 h-2 rounded-full {projectDotClass(entry.project)} shrink-0"
												></span>
												<span class="truncate">{entry.project}</span>
											</p>
										{/if}
										{#if entry.tags?.length}
											<div class="flex gap-1 flex-wrap items-center mt-1.5">
												{#each entry.tags.slice(0, 3) as tag}
													<TagChip {tag} size="xs" />
												{/each}
												{#if entry.tags.length > 3}
													<span class="badge badge-xs badge-ghost font-normal"
														>+{entry.tags.length - 3}</span
													>
												{/if}
											</div>
										{/if}
									</div>
									<span class="font-mono tabular-nums text-sm shrink-0">
										{formatDuration(getEntryDurationSeconds(entry))}
									</span>
								</li>
							{/each}
						</ul>

						<!-- Tablet and up: table -->
						<div class="hidden md:block overflow-x-auto">
							<table class="table table-sm">
								<thead>
									<tr class="text-xs text-base-content/70">
										<th>Date</th>
										<th>Title</th>
										<th>Project</th>
										<th>Tags</th>
										<th class="text-right">Duration</th>
									</tr>
								</thead>
								<tbody>
									{#each recentEntries as entry}
										<tr class="hover">
											<td class="text-sm whitespace-nowrap tabular-nums">
												{new Date(entry.start_time).toLocaleDateString(undefined, {
													month: 'short',
													day: 'numeric'
												})}
											</td>
											<td class="text-sm truncate max-w-[220px] font-medium" title={entry.title}
												>{entry.title}</td
											>
											<td class="text-sm whitespace-nowrap">
												{#if entry.project}
													<span class="flex items-center gap-1.5">
														<span
															class="w-2 h-2 rounded-full {projectDotClass(
																entry.project
															)} inline-block shrink-0"
														></span>
														{entry.project}
													</span>
												{:else}
													<span class="text-base-content/60">—</span>
												{/if}
											</td>
											<td class="text-sm">
												{#if entry.tags?.length}
													<div class="flex gap-1 flex-wrap items-center">
														{#each entry.tags.slice(0, 3) as tag}
															<TagChip {tag} size="xs" />
														{/each}
														{#if entry.tags.length > 3}
															<span class="badge badge-xs badge-ghost font-normal"
																>+{entry.tags.length - 3}</span
															>
														{/if}
													</div>
												{:else}
													<span class="text-base-content/60">—</span>
												{/if}
											</td>
											<td class="text-sm text-right font-mono tabular-nums">
												{formatDuration(getEntryDurationSeconds(entry))}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				</section>
			{/if}
		{/if}
	</div>
</div>
