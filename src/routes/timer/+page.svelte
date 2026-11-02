<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { gotoApp, appPath } from '$lib/navigation';
	import PageHeader from '$lib/PageHeader.svelte';
	import { Timer as TimerIcon } from '@jis3r/icons';
	import logger from '$lib/logger';
	import {
		authToken,
		user,
		timeEntriesDisplayMode,
		timerRefreshInterval,
		autoRefreshEnabled
	} from '$lib/stores';
	import { parseErrorResponse, type Project, type Tag, type TimeEntry } from '$lib/api';
	import { preventDefault } from '$lib/commands.svelte';
	import TasksModal from '$lib/TasksModal.svelte';
	import type { PageData } from './$types';
	import { network } from '$lib/network';
	import { createEditableEntryHandlers, type EditableEntryStateUpdate } from '$lib/editableEntry';
	import TagPicker from '$lib/TagPicker.svelte';
	import TagChip from '$lib/TagChip.svelte';
	import ProjectPicker from '$lib/ProjectPicker.svelte';
	import {
		useProjects,
		useActiveTimer,
		useTodaySessions,
		useRecentEntriesForSuggestions,
		useStartTimerMutation,
		useUpdateTimeEntryMutation,
		useStopTimerMutation
	} from '$lib/queries/timeEntries';
	import { queryClient } from '$lib/queryClient';
	import { createHotkey } from '@tanstack/svelte-hotkeys';
	import { queryKeys } from '$lib/queries/keys';

	// Get any data loaded on server (may be empty)
	const { data } = $props<{ data: PageData }>();

	// Server state via TanStack Query — shared cache + automatic revalidation
	const projectsQuery = useProjects();
	const activeQuery = useActiveTimer(() => ({
		refetchInterval: $autoRefreshEnabled ? $timerRefreshInterval || 30000 : false
	}));
	const todayQuery = useTodaySessions(() => ({
		refetchInterval: $autoRefreshEnabled ? $timerRefreshInterval || 30000 : false
	}));
	const startTimerMutation = useStartTimerMutation();
	const stopTimerMutation = useStopTimerMutation();
	const updateEntryMutation = useUpdateTimeEntryMutation();

	// One-time initialization from the server-loaded page data; later errors are
	// set explicitly in the handlers, so the initial read is intentionally untracked.
	let error = $state(untrack(() => data.error || ''));
	let projectsList = $derived(projectsQuery.data ?? []);
	let loadingProjects = $derived(projectsQuery.isPending);
	let activeEntry = $derived<TimeEntry | null>(activeQuery.data ?? null);
	let loadingActiveEntry = $derived(activeQuery.isPending);
	let todaySessions = $derived<TimeEntry[]>(todayQuery.data ?? []);
	let loadingTodaySessions = $derived(todayQuery.isPending);

	// --- Title-based project/tag suggestions -----------------------------------
	// As the user types a task title, surface the most-used project + tags from
	// similar past entries (client-side token matching over recent history).
	const suggestionQuery = useRecentEntriesForSuggestions();
	const recentEntries = $derived(suggestionQuery.data ?? []);

	// id -> Tag map collected from recent entries (no extra query needed).
	const tagById = $derived.by(() => {
		const map = new Map<number, Tag>();
		for (const entry of recentEntries) {
			for (const tag of entry.tags) {
				if (!map.has(tag.id)) map.set(tag.id, tag);
			}
		}
		return map;
	});

	function tokenizeTitle(t: string): string[] {
		return t
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length >= 2);
	}

	// A typed token matches a title token when one starts with the other
	// (e.g. "deploy" -> "deployment", "redesign" -> "redesign").
	function tokenMatch(typed: string, titleWord: string): boolean {
		return titleWord.startsWith(typed) || typed.startsWith(titleWord);
	}

	interface TitleSuggestion {
		projectId: number | null;
		projectName: string;
		tagIds: number[];
	}

	const titleSuggestions = $derived.by<TitleSuggestion | null>(() => {
		const typed = title.trim();
		if (typed.length < 3) return null;
		const tokens = tokenizeTitle(typed);
		if (tokens.length === 0) return null;

		const scored = recentEntries
			.map((entry) => {
				const titleTokens = tokenizeTitle(entry.title);
				const matched = tokens.filter((t) => titleTokens.some((w) => tokenMatch(t, w))).length;
				return { entry, score: matched / tokens.length };
			})
			.filter((x) => x.score >= 0.5)
			.sort((a, b) => b.score - a.score || (a.entry.start_time < b.entry.start_time ? 1 : -1))
			.slice(0, 5);
		if (scored.length === 0) return null;

		const projectCounts = new Map<string, number>();
		for (const { entry } of scored) {
			projectCounts.set(entry.project, (projectCounts.get(entry.project) ?? 0) + 1);
		}
		const projectName = [...projectCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
		const projectId = projectsList.find((p) => p.title === projectName)?.id ?? null;

		const tagCounts = new Map<number, number>();
		for (const { entry } of scored) {
			for (const tag of entry.tags) tagCounts.set(tag.id, (tagCounts.get(tag.id) ?? 0) + 1);
		}
		const tagIds = [...tagCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([id]) => id);

		return { projectId, projectName, tagIds };
	});

	function applyProjectSuggestion(id: number | null) {
		selectedProject = selectedProject === id ? null : id;
		suggestionFocus = null;
	}

	function toggleTagSuggestion(id: number) {
		selectedTags = selectedTags.includes(id)
			? selectedTags.filter((t) => t !== id)
			: [...selectedTags, id];
		suggestionFocus = null;
	}

	// --- Keyboard navigation for the suggestion chips (TanStack Hotkeys) -------
	// While typing in the title field: ←/→ highlight a chip, Enter applies it,
	// Esc clears the highlight. Scoped to the input via {@attach}; single keys
	// need ignoreInputs: false so they fire inside the text input.
	let suggestionFocus = $state<number | null>(null);
	let titleInputFocused = $state(false);

	interface SuggestionChip {
		kind: 'project' | 'tag';
		id: number | null;
	}

	const suggestionChips = $derived.by<SuggestionChip[]>(() => {
		if (!titleSuggestions) return [];
		const chips: SuggestionChip[] = [];
		if (titleSuggestions.projectId !== null && titleSuggestions.projectName) {
			chips.push({ kind: 'project', id: titleSuggestions.projectId });
		}
		for (const tagId of titleSuggestions.tagIds) chips.push({ kind: 'tag', id: tagId });
		return chips;
	});

	// Reset the highlight whenever the typed title (and thus the chips) change.
	$effect(() => {
		title;
		suggestionFocus = null;
	});

	const suggestionHotkeysActive = () =>
		titleInputFocused && $network.isOnline && !!titleSuggestions && suggestionChips.length > 0;

	function applyFocusedSuggestion() {
		if (suggestionFocus === null || suggestionFocus >= suggestionChips.length) return;
		const chip = suggestionChips[suggestionFocus];
		if (chip.kind === 'project') {
			applyProjectSuggestion(chip.id);
		} else if (chip.id !== null) {
			toggleTagSuggestion(chip.id);
		}
		suggestionFocus = null;
	}

	const suggestionNavLeft = createHotkey(
		'ArrowLeft',
		() => {
			const n = suggestionChips.length;
			if (n === 0) return;
			suggestionFocus = suggestionFocus === null ? n - 1 : (suggestionFocus - 1 + n) % n;
		},
		() => ({ enabled: suggestionHotkeysActive(), ignoreInputs: false })
	);

	const suggestionNavRight = createHotkey(
		'ArrowRight',
		() => {
			const n = suggestionChips.length;
			if (n === 0) return;
			suggestionFocus = suggestionFocus === null ? 0 : (suggestionFocus + 1) % n;
		},
		() => ({ enabled: suggestionHotkeysActive(), ignoreInputs: false })
	);

	const suggestionApply = createHotkey(
		'Enter',
		() => applyFocusedSuggestion(),
		() => ({
			enabled: suggestionHotkeysActive() && suggestionFocus !== null,
			ignoreInputs: false
		})
	);

	const suggestionDismiss = createHotkey(
		'Escape',
		() => {
			suggestionFocus = null;
		},
		() => ({ enabled: suggestionHotkeysActive(), ignoreInputs: false })
	);

	// Keep the ticking timer in sync with the query-driven active entry
	// (starts when a timer appears, stops when it disappears — e.g. stopped externally)
	$effect(() => {
		if (activeEntry) {
			if (!timerInterval) startTimer();
		} else if (timerInterval) {
			clearInterval(timerInterval);
			timerInterval = null;
			elapsed = 0;
		}
	});

	// Form data
	let title = $state('');
	let description = $state('');
	let selectedProject = $state<number | null>(null);
	let selectedTags: number[] = $state([]);
	let isStartingTimer = $state(false);

	// Custom start time state (60-minute buffer feature)
	let useCustomStartTime = $state(false);
	let now = $state(new Date());
	let sliderMinutesAgo = $state(0); // Track slider position separately for consistent UI
	let lastCustomStartTickLogMs = $state(0);
	let customStartTime = $derived(
		useCustomStartTime ? new Date(now.getTime() - sliderMinutesAgo * 60 * 1000) : null
	);
	let startTimeValidationError = $state<string | null>(null);
	const MAX_START_TIME_PAST_MINUTES = 60; // Maximum minutes in the past for start time

	$effect(() => {
		if (!useCustomStartTime) return;
		const intervalId = setInterval(() => {
			now = new Date();
			const nowMs = now.getTime();
			if (nowMs - lastCustomStartTickLogMs >= 10_000) {
				lastCustomStartTickLogMs = nowMs;
				logger.debug('[timer] custom start time tick', {
					now: now.toISOString(),
					sliderMinutesAgo,
					customStartTime: customStartTime?.toISOString() ?? null
				});
			}
		}, 1000);
		return () => clearInterval(intervalId);
	});

	$effect(() => {
		if (!useCustomStartTime) {
			startTimeValidationError = null;
			return;
		}
		if (!customStartTime) {
			startTimeValidationError = null;
			return;
		}
		const validation = validateStartTime(customStartTime, now);
		startTimeValidationError = validation.valid ? null : validation.error || null;
		logger.debug('[timer] custom start time validation', {
			now: now.toISOString(),
			sliderMinutesAgo,
			customStartTime: customStartTime.toISOString(),
			valid: validation.valid,
			error: validation.error ?? null
		});
	});

	// Edit mode state for active entry
	let isEditingTitle = $state(false);
	let isEditingDescription = $state(false);
	let editedTitle = $state('');
	let editedDescription = $state('');
	let isSavingEdit = $state(false);
	let editError = $state('');

	// Create edit handlers using the reusable utility
	const editHandlers = createEditableEntryHandlers({
		getState: () => ({
			isEditingTitle,
			isEditingDescription,
			editedTitle,
			editedDescription,
			isSaving: isSavingEdit,
			editError
		}),
		setState: (updates: EditableEntryStateUpdate) => {
			if ('isEditingTitle' in updates && updates.isEditingTitle !== undefined)
				isEditingTitle = updates.isEditingTitle;
			if ('isEditingDescription' in updates && updates.isEditingDescription !== undefined)
				isEditingDescription = updates.isEditingDescription;
			if ('editedTitle' in updates && updates.editedTitle !== undefined)
				editedTitle = updates.editedTitle;
			if ('editedDescription' in updates && updates.editedDescription !== undefined)
				editedDescription = updates.editedDescription;
			if ('isSaving' in updates && updates.isSaving !== undefined) isSavingEdit = updates.isSaving;
			if ('editError' in updates && updates.editError !== undefined) editError = updates.editError;
		},
		getEntry: () => activeEntry,
		setEntry: (updatedEntry) => {
			queryClient.setQueryData(queryKeys.timeEntries.active, updatedEntry);
		},
		onUpdate: (id, data) => updateEntryMutation.mutateAsync({ id, data }),
		onUpdateSuccess: (updatedEntry) => {
			// Reflect in the query cache; lists revalidate via the mutation's invalidation.
			queryClient.setQueryData(queryKeys.timeEntries.active, updatedEntry);
		},
		isOnline: () => $network.isOnline
	});

	// Tag editing state for the active entry (mirrors TimeEntryDetailModal)
	let isEditingTags = $state(false);
	let selectedTagIds: number[] = $state([]);
	let tagSaveError = $state('');

	function startEditTags(): void {
		if (!activeEntry || !$network.isOnline) return;
		selectedTagIds = (activeEntry.tags ?? []).map((t) => t.id);
		isEditingTags = true;
		tagSaveError = '';
	}

	async function saveTags(): Promise<void> {
		if (!activeEntry || !$network.isOnline) return;
		tagSaveError = '';
		try {
			await updateEntryMutation.mutateAsync({
				id: activeEntry.id,
				data: { tags: selectedTagIds }
			});
			isEditingTags = false;
		} catch {
			tagSaveError = 'Failed to save tags.';
		}
	}

	// Timer
	let elapsed = $state(0);
	let timerInterval = $state<ReturnType<typeof setInterval> | null>(null);

	// Tasks modal
	let showTasksModal = $state(false);

	// Last server update timestamp

	// Projects refresh debounce state
	let lastProjectsRefreshTime = $state<number>(0);
	const PROJECTS_REFRESH_DEBOUNCE_MS = 5000; // 5 seconds minimum between refreshes

	/**
	 * Handler for project dropdown open event
	 * Triggers a revalidation of projects when the dropdown is opened
	 * Uses debouncing to prevent excessive refetches
	 */
	function onProjectDropdownOpen() {
		const now = Date.now();
		// Only refresh if enough time has passed since last refresh
		if (now - lastProjectsRefreshTime > PROJECTS_REFRESH_DEBOUNCE_MS) {
			console.log('Project dropdown opened, refreshing projects...');
			lastProjectsRefreshTime = now;
			void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
		} else {
			console.log('Skipping projects refresh - too soon since last refresh');
		}
	}

	onMount(() => {
		console.log('Timer onMount started at', new Date().toISOString());

		// Run the async setup, but return the cleanup function synchronously
		// so onMount's return type stays `() => void`.
		void (async () => {
			const token = get(authToken);
			if (!token) {
				gotoApp('/');
				return;
			}

			// Listen for events from Tauri
			if (typeof window !== 'undefined' && (window as any).__TAURI__) {
				const { listen, emit } = await import('@tauri-apps/api/event');
				listen('stop-timer', (event) => {
					console.log('Received stop-timer event from tray:', event);
					onStopTimer();
				});

				listen('request-timer-state', (event) => {
					console.log('Received request-timer-state event from tray:', event);
					// Respond with current timer state
					const timerState = activeEntry
						? {
								active: true,
								title: activeEntry.title,
								start_time: activeEntry.start_time
							}
						: {
								active: false,
								title: null
							};
					console.log('Sending timer state response:', timerState);
					emit('timer-state-response', timerState);
				});
			}
		})();

		// Cleanup function for onMount
		return () => {
			// Clean up timer interval to prevent memory leak
			if (timerInterval) {
				clearInterval(timerInterval);
				timerInterval = null;
			}
		};
	});

	function startTimer() {
		// Clear any existing interval first to prevent multiple concurrent intervals
		if (timerInterval) {
			clearInterval(timerInterval);
			timerInterval = null;
		}
		if (activeEntry) {
			const startTime = new Date(activeEntry.start_time).getTime();
			elapsed = Math.floor((Date.now() - startTime) / 1000);
			timerInterval = setInterval(() => {
				elapsed = Math.floor((Date.now() - startTime) / 1000);
			}, 1000);
		}
	}

	/**
	 * Slides a too-long title back and forth so it can be read in full; short
	 * titles stay still. Re-measures whenever the title or container resizes.
	 */
	function marquee(node: HTMLElement) {
		const inner = node.firstElementChild as HTMLElement;
		const measure = () => {
			const overflow = inner.scrollWidth - node.clientWidth;
			node.style.setProperty('--marquee-shift', `${-Math.max(0, overflow)}px`);
			node.dataset.overflow = overflow > 1 ? 'true' : 'false';
		};
		const ro = new ResizeObserver(measure);
		ro.observe(node);
		ro.observe(inner);
		measure();
		return { destroy: () => ro.disconnect() };
	}

	function formatTime(seconds: number): string {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		const secs = seconds % 60;
		return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
	}

	/**
	 * Validate the selected start time
	 * @param selectedTime - The selected start time to validate
	 * @param referenceTime - Optional reference time (defaults to now). Must be the same time used for calculation to avoid timing issues.
	 * @returns Object with valid flag and optional error message
	 */
	function validateStartTime(
		selectedTime: Date,
		referenceTime: Date = new Date()
	): { valid: boolean; error?: string } {
		const diffMs = referenceTime.getTime() - selectedTime.getTime();
		const diffSeconds = diffMs / 1000;
		const maxPastSeconds = MAX_START_TIME_PAST_MINUTES * 60;

		if (diffSeconds < 0) {
			return { valid: false, error: 'Start time cannot be in the future.' };
		}

		if (diffSeconds > maxPastSeconds) {
			return {
				valid: false,
				error: `Start time cannot be more than ${MAX_START_TIME_PAST_MINUTES} minutes in the past.`
			};
		}

		return { valid: true };
	}

	function resolveCustomStartTime(referenceTime: Date = new Date()): Date {
		return new Date(referenceTime.getTime() - sliderMinutesAgo * 60 * 1000);
	}

	async function extractStartTimerError(err: unknown): Promise<string | null> {
		const response = (err as { response?: { status?: number; _data?: Record<string, unknown> } })
			?.response;
		if (!response) {
			return null;
		}

		let errorData = response._data;
		if (!errorData) {
			try {
				errorData = await parseErrorResponse(response);
			} catch {
				return null;
			}
		}

		if (errorData?.start_time) {
			const startTimeError = errorData.start_time;
			return Array.isArray(startTimeError) ? startTimeError[0] : String(startTimeError);
		}

		if (errorData?.non_field_errors) {
			const nonFieldError = errorData.non_field_errors;
			return Array.isArray(nonFieldError) ? nonFieldError[0] : String(nonFieldError);
		}

		if (typeof errorData?.detail === 'string') {
			return errorData.detail;
		}

		return null;
	}

	/**
	 * Set custom start time to a specific number of minutes ago
	 */
	function setStartTimeMinutesAgo(minutes: number) {
		sliderMinutesAgo = minutes; // Update slider position to match
	}

	/**
	 * Handle slider change for minutes ago
	 */
	function onSliderChange(event: Event) {
		const target = event.target;
		if (target instanceof HTMLInputElement) {
			const minutes = parseInt(target.value, 10);
			if (!isNaN(minutes)) {
				setStartTimeMinutesAgo(minutes);
			}
		}
	}

	/**
	 * Toggle custom start time and initialize to current time
	 */
	function toggleCustomStartTime() {
		useCustomStartTime = !useCustomStartTime;
		if (useCustomStartTime) {
			// Always re-initialize to current time when enabling
			// This prevents stale time values from previous toggles
			now = new Date();
			sliderMinutesAgo = 0; // Reset slider to "now"
			startTimeValidationError = null;
		}
	}

	const onStartTimer = preventDefault(async () => {
		if (!selectedProject || !title) return;

		// Check if online before starting timer
		if (!$network.isOnline) {
			error = 'Cannot start timer while offline. Please check your internet connection.';
			return;
		}

		const submitNow = new Date();
		let startTimeForSubmit: Date | null = null;

		if (useCustomStartTime) {
			now = submitNow;
			startTimeForSubmit = resolveCustomStartTime(submitNow);
			const validation = validateStartTime(startTimeForSubmit, submitNow);
			logger.debug('[timer] submit validation', {
				now: submitNow.toISOString(),
				sliderMinutesAgo,
				customStartTime: startTimeForSubmit.toISOString(),
				valid: validation.valid,
				error: validation.error ?? null
			});
			if (!validation.valid) {
				startTimeValidationError = validation.error || 'Invalid start time';
				return;
			}
		}

		try {
			isStartingTimer = true;

			// Build the payload
			const payload: {
				title: string;
				description: string;
				project: number;
				start_time?: string;
				tags?: number[];
			} = {
				title,
				description,
				project: selectedProject,
				tags: selectedTags
			};

			if (useCustomStartTime && startTimeForSubmit) {
				payload.start_time = startTimeForSubmit.toISOString();
				logger.debug('[timer] starting timer with custom start time', {
					start_time: payload.start_time
				});
			}

			const startedEntry = await startTimerMutation.mutateAsync(payload);
			startTimer();
			error = ''; // Clear any previous failure so the page UI returns

			// Emit event to Tauri
			if (typeof window !== 'undefined' && (window as any).__TAURI__) {
				const { emit } = await import('@tauri-apps/api/event');
				console.log('Emitting timer-started event:', startedEntry.title);
				await emit('timer-started', {
					title: startedEntry.title,
					start_time: startedEntry.start_time
				});
			}

			// Reset form but keep the state for the new layout
			title = '';
			description = '';
			selectedProject = null;
			selectedTags = [];
			isStartingTimer = false;
			// Reset custom start time state
			useCustomStartTime = false;
			sliderMinutesAgo = 0;
			now = new Date();
			startTimeValidationError = null;
		} catch (err: unknown) {
			const message = await extractStartTimerError(err);
			if (message) {
				if (useCustomStartTime) {
					startTimeValidationError = message;
				} else {
					error = message;
				}
			} else {
				console.error('Failed to start timer:', err);
				error = 'Failed to start timer';
			}
			isStartingTimer = false;
		}
	});

	const onStopTimer = async () => {
		if (!activeEntry) return;

		// Check if online before stopping timer
		if (!$network.isOnline) {
			error = 'Cannot stop timer while offline. Please check your internet connection.';
			return;
		}

		try {
			await stopTimerMutation.mutateAsync(activeEntry.id);
			error = ''; // Clear any previous failure so the page UI returns

			// Emit event to Tauri
			if (typeof window !== 'undefined' && (window as any).__TAURI__) {
				const { emit } = await import('@tauri-apps/api/event');
				console.log('Emitting timer-stopped event');
				await emit('timer-stopped', {});
			}
		} catch (err) {
			error = 'Failed to stop timer';
		}
	};

	// Destructure edit handlers for use in template
	const { startEditingTitle, startEditingDescription, cancelEditing, saveTitle, saveDescription } =
		editHandlers;

	const openTimeEntries = async () => {
		console.log('openTimeEntries called, mode:', get(timeEntriesDisplayMode));
		const mode = get(timeEntriesDisplayMode);

		if (mode === 'modal') {
			console.log('Opening tasks in modal');
			showTasksModal = true;
			return;
		}

		// Default to window/tab mode
		try {
			const { getCurrentWindow } = await import('@tauri-apps/api/window');
			getCurrentWindow(); // Test if running in Tauri
			console.log('Detected Tauri environment, opening new window');
			const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
			console.log('WebviewWindow imported successfully');
			// Windows uses the custom frontend titlebar (decorations:false); macOS
			// and Linux keep the native OS-drawn chrome.
			let useCustomTitlebar = true;
			try {
				const os = await import('@tauri-apps/plugin-os');
				useCustomTitlebar = os.platform() === 'windows';
			} catch {
				useCustomTitlebar = false;
			}
			const webview = new WebviewWindow('time-entries', {
				url: `${window.location.origin}${appPath('/entries')}`,
				title: 'Time Entries',
				width: 1000,
				height: 700,
				resizable: true,
				decorations: !useCustomTitlebar,
				fullscreen: false,
				contentProtected: true
			});
			console.log('WebviewWindow created:', webview);
		} catch {
			console.log('Web environment, opening new tab');
			window.open(appPath('/entries'), '_blank');
		}
	};
</script>

{#snippet sessionTags(tags: TimeEntry['tags'])}
	{#if tags && tags.length > 0}
		<div class="flex flex-wrap gap-1 mt-1.5">
			{#each tags as tag (tag.id)}
				{#if typeof tag === 'string'}
					<span class="badge badge-outline badge-xs">{tag}</span>
				{:else}
					<TagChip {tag} size="xs" />
				{/if}
			{/each}
		</div>
	{/if}
{/snippet}

<div class="mx-auto max-w-7xl p-0 md:p-6 lg:p-8">
	<!-- Page Header -->
	<div class="mb-6">
		<PageHeader icon={TimerIcon} title="Timer" subtitle="Track your time with precision" />
	</div>

	{#if loadingProjects}
		<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]" aria-busy="true">
			<div class="skeleton h-96 rounded-box"></div>
			<div class="skeleton h-96 rounded-box"></div>
		</div>
	{:else if error}
		<div class="alert alert-error mb-6">
			<span>{error}</span>
		</div>
	{:else if loadingActiveEntry}
		<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]" aria-busy="true">
			<div class="skeleton h-72 rounded-box"></div>
			<div class="skeleton h-72 rounded-box"></div>
		</div>
	{:else}
		<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] items-start">
			<!-- Workbench: the running timer, or the start form -->
			{#if activeEntry || isStartingTimer}
				<section class="card bg-base-100 border border-base-300" aria-label="Running timer">
					<div class="card-body gap-6 p-4 sm:p-6">
						<p class="text-sm font-medium {activeEntry ? 'text-success' : 'text-base-content/70'}">
							{activeEntry ? 'In Progress' : 'Starting...'}
						</p>

						{#if activeEntry}
							<!-- The readout is the object this page is known by -->
							<p
								class="font-mono tabular-nums text-5xl min-[400px]:text-6xl sm:text-7xl lg:text-8xl font-semibold leading-none text-base-content"
								role="timer"
								aria-label="Elapsed time"
							>
								{formatTime(elapsed)}
							</p>

							<div class="space-y-3 max-w-2xl">
								<!-- Task Title (Editable) -->
								{#if isEditingTitle}
									<div class="flex items-center gap-2">
										<input
											type="text"
											bind:value={editedTitle}
											class="input input-bordered input-lg text-xl font-semibold flex-1 min-w-0 {isSavingEdit
												? 'opacity-50 cursor-wait'
												: ''}"
											placeholder="Task title"
											aria-label="Task title"
											disabled={isSavingEdit}
											onkeydown={(e) => {
												if (e.key === 'Enter') saveTitle();
												if (e.key === 'Escape') cancelEditing();
											}}
										/>
										<button
											class="btn btn-primary btn-circle"
											onclick={saveTitle}
											disabled={isSavingEdit || !editedTitle.trim()}
											aria-label="Save title"
										>
											{#if isSavingEdit}
												<span class="loading loading-spinner loading-sm"></span>
											{:else}
												<svg
													class="w-5 h-5"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M5 13l4 4L19 7"
													></path>
												</svg>
											{/if}
										</button>
										<button
											class="btn btn-ghost btn-circle"
											onclick={cancelEditing}
											disabled={isSavingEdit}
											aria-label="Cancel editing"
										>
											<svg
												class="w-5 h-5"
												fill="none"
												stroke="currentColor"
												viewBox="0 0 24 24"
												aria-hidden="true"
											>
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M6 18L18 6M6 6l12 12"
												></path>
											</svg>
										</button>
									</div>
								{:else}
									<div class="flex items-center justify-between gap-3 min-w-0">
										<h2
											class="marquee min-w-0 flex-1 overflow-hidden text-xl sm:text-2xl font-semibold text-base-content"
											title={activeEntry.title}
											use:marquee
										>
											<span class="marquee-inner inline-block whitespace-nowrap">{activeEntry.title}</span>
										</h2>
										{#if $network.isOnline}
											<button
												class="btn btn-outline btn-sm shrink-0"
												onclick={startEditingTitle}
												title="Edit title"
												aria-label="Edit title"
											>
												Edit
											</button>
										{/if}
									</div>
								{/if}

								{#if activeEntry.project}
									<p class="text-sm text-base-content/70">{activeEntry.project}</p>
								{/if}

								<!-- Description (Editable) -->
								{#if isEditingDescription}
									<div class="flex flex-col gap-2">
										<textarea
											bind:value={editedDescription}
											class="textarea textarea-bordered {isSavingEdit
												? 'opacity-50 cursor-wait'
												: ''}"
											placeholder="Add a description..."
											aria-label="Description"
											rows="2"
											disabled={isSavingEdit}
											onkeydown={(e) => {
												if (e.key === 'Enter' && e.ctrlKey) saveDescription();
												if (e.key === 'Escape') cancelEditing();
											}}
										></textarea>
										<div class="flex gap-2">
											<button
												class="btn btn-primary btn-sm"
												onclick={saveDescription}
												disabled={isSavingEdit}
											>
												{#if isSavingEdit}
													<span class="loading loading-spinner loading-sm"></span>
												{:else}
													Save
												{/if}
											</button>
											<button
												class="btn btn-ghost btn-sm"
												onclick={cancelEditing}
												disabled={isSavingEdit}
											>
												Cancel
											</button>
										</div>
									</div>
								{:else}
									<div class="flex items-center justify-between gap-3">
										{#if activeEntry.description}
											<p class="text-sm text-base-content/70">{activeEntry.description}</p>
										{:else}
											<p class="text-sm text-base-content/60">No description</p>
										{/if}
										{#if $network.isOnline}
											<button
												class="btn btn-outline btn-sm shrink-0"
												onclick={startEditingDescription}
												title="Edit description"
												aria-label="Edit description"
											>
												Edit
											</button>
										{/if}
									</div>
								{/if}

								<!-- Active Entry Tags (editable while running) -->
								{#if isEditingTags}
									<div class="rounded-box border border-base-300 bg-base-200/40 p-3">
										<TagPicker bind:value={selectedTagIds} allowCreate={false} />
										{#if tagSaveError}
											<p class="text-xs text-error mt-2">{tagSaveError}</p>
										{/if}
										<div class="flex gap-2 mt-3">
											<button
												class="btn btn-primary btn-sm"
												onclick={saveTags}
												disabled={!$network.isOnline}
											>
												Save tags
											</button>
											<button class="btn btn-ghost btn-sm" onclick={() => (isEditingTags = false)}>
												Cancel
											</button>
										</div>
									</div>
								{:else}
									<div class="flex items-center justify-between gap-3">
										{#if activeEntry.tags && activeEntry.tags.length > 0}
											<div class="flex flex-wrap gap-1.5">
												{#each activeEntry.tags as tag (tag.id)}
													{#if typeof tag === 'string'}
														<span class="badge badge-outline badge-xs">{tag}</span>
													{:else}
														<TagChip {tag} size="xs" />
													{/if}
												{/each}
											</div>
										{:else}
											<p class="text-sm text-base-content/60">No tags</p>
										{/if}
										{#if $network.isOnline}
											<button
												class="btn btn-outline btn-sm shrink-0"
												onclick={startEditTags}
												title="Edit tags"
												aria-label="Edit tags"
											>
												Edit
											</button>
										{/if}
									</div>
								{/if}

								{#if editError}
									<div class="alert alert-error py-2" role="alert">
										<span class="text-sm">{editError}</span>
									</div>
								{/if}
							</div>

							<div class="flex flex-wrap items-center gap-3 pt-4 border-t border-base-300">
								<button
									class="btn btn-error btn-lg"
									onclick={onStopTimer}
									disabled={!$network.isOnline}
								>
									<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
										<rect x="6" y="6" width="12" height="12" rx="2" />
									</svg>
									Stop
								</button>
								<p class="text-sm text-base-content/70">
									Started {new Date(activeEntry.start_time).toLocaleTimeString([], {
										hour: '2-digit',
										minute: '2-digit'
									})}
								</p>
								{#if !$network.isOnline}
									<p class="text-sm text-warning font-medium">Cannot stop timer while offline</p>
								{/if}
							</div>
						{:else if isStartingTimer}
							<div class="py-6 flex items-center gap-3">
								<span class="loading loading-spinner loading-lg text-primary"></span>
								<p class="text-base-content/70">Starting timer...</p>
							</div>
						{/if}
					</div>
				</section>
			{:else}
				<section class="card bg-base-100 border border-base-300" aria-label="Start a timer">
					<form onsubmit={onStartTimer} class="card-body gap-5 p-4 sm:p-6">
						<div>
							<h2 class="text-2xl font-semibold text-base-content">Ready to start tracking?</h2>
							<p class="text-base-content/70">Start a new timer session</p>
						</div>

						<div class="form-control">
							<label class="label" for="title">
								<span class="label-text">Task Title</span>
							</label>
							<input
								id="title"
								bind:value={title}
								type="text"
								placeholder="What are you working on?"
								class="input input-bordered input-lg w-full"
								required
								onfocus={() => (titleInputFocused = true)}
								onblur={() => (titleInputFocused = false)}
							/>

							{#if $network.isOnline && suggestionChips.length > 0}
								<div class="flex flex-wrap items-center gap-1.5 mt-2">
									<span class="text-xs text-base-content/60">Suggestions:</span>
									{#each suggestionChips as chip, i (chip.kind + ':' + chip.id)}
										{#if chip.kind === 'project'}
											<button
												type="button"
												class="inline-flex items-center gap-1 rounded-full border border-base-300 bg-base-200/60 px-2.5 py-0.5 text-xs font-medium text-base-content/80 transition-colors hover:border-primary/60 hover:text-primary {selectedProject ===
												chip.id
													? 'border-primary bg-primary/10 text-primary'
													: ''} {suggestionFocus === i ? 'ring-2 ring-primary/70' : ''}"
												onclick={() => applyProjectSuggestion(chip.id)}
											>
												<svg
													class="w-3 h-3"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
													></path>
												</svg>
												{chip.kind === 'project' ? titleSuggestions?.projectName : ''}
											</button>
										{:else}
											{@const tag = chip.id !== null ? tagById.get(chip.id) : undefined}
											{#if tag}
												<button
													type="button"
													onclick={() => toggleTagSuggestion(chip.id!)}
													class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors {suggestionFocus ===
													i
														? 'ring-2 ring-primary/70'
														: ''}"
													style="background:{tag.color}{selectedTags.includes(chip.id!)
														? '4d'
														: '22'};color:{tag.color};border:1px solid {tag.color}55;"
												>
													{tag.title}
												</button>
											{/if}
										{/if}
									{/each}
									<span
										class="ml-auto hidden sm:inline-flex items-center gap-1 whitespace-nowrap text-xs text-base-content/60"
										aria-label="Keyboard shortcuts: arrow keys to select a suggestion, Enter to apply, Escape to clear"
									>
										<kbd class="kbd kbd-xs">←</kbd>
										<kbd class="kbd kbd-xs">→</kbd>
										<span>select</span>
										<kbd class="kbd kbd-xs">Enter</kbd>
										<span>apply</span>
										<kbd class="kbd kbd-xs">Esc</kbd>
										<span>clear</span>
									</span>
								</div>
							{/if}
						</div>

						<div class="form-control">
							<label class="label" for="project-picker-trigger">
								<span class="label-text">Project</span>
							</label>
							<ProjectPicker
								bind:value={selectedProject}
								projects={projectsList}
								onOpen={onProjectDropdownOpen}
								inputId="project-picker-trigger"
							/>
						</div>

						<div class="form-control">
							<div class="label pb-1">
								<span class="label-text">Tags (optional)</span>
								{#if selectedTags.length > 0}
									<span class="badge badge-sm badge-ghost font-normal"
										>{selectedTags.length} selected</span
									>
								{/if}
							</div>
							<div id="timer-tags" class="rounded-box border border-base-300 bg-base-200/40 p-2.5">
								<TagPicker bind:value={selectedTags} />
							</div>
						</div>

						<div class="form-control">
							<label class="label" for="description">
								<span class="label-text">Description (optional)</span>
							</label>
							<textarea
								id="description"
								bind:value={description}
								placeholder="Additional details..."
								class="textarea textarea-bordered w-full"
								rows="2"
							></textarea>
						</div>

						<!-- Start time: now, or backdate up to an hour -->
						<div class="form-control">
							<span class="label"><span class="label-text">Start Time</span></span>
							<div class="join w-fit" role="group" aria-label="Start time">
								<button
									type="button"
									class="btn btn-sm join-item {!useCustomStartTime ? 'btn-primary' : 'btn-outline'}"
									aria-pressed={!useCustomStartTime}
									onclick={() => useCustomStartTime && toggleCustomStartTime()}
								>
									Start from now
								</button>
								<button
									type="button"
									class="btn btn-sm join-item {useCustomStartTime ? 'btn-primary' : 'btn-outline'}"
									aria-pressed={useCustomStartTime}
									onclick={() => !useCustomStartTime && toggleCustomStartTime()}
								>
									Custom time
								</button>
							</div>

							{#if useCustomStartTime}
								<div class="space-y-4 p-4 mt-3 bg-base-200 rounded-box">
									<div>
										<div class="flex justify-between items-baseline mb-2">
											<label for="start-offset" class="label-text text-sm font-medium"
												>Start timer</label
											>
											<span class="text-lg font-semibold text-primary tabular-nums"
												>{sliderMinutesAgo} min ago</span
											>
										</div>
										<input
											id="start-offset"
											type="range"
											min="0"
											max={MAX_START_TIME_PAST_MINUTES}
											value={sliderMinutesAgo}
											oninput={onSliderChange}
											class="range range-primary range-sm w-full"
											step="1"
										/>
										<div class="flex justify-between text-xs text-base-content/60 mt-1">
											<span>Now</span>
											<span>{MAX_START_TIME_PAST_MINUTES} min ago</span>
										</div>
									</div>

									<div class="flex flex-wrap items-center gap-2">
										<span class="text-xs text-base-content/70">Quick select</span>
										{#each [0, 15, 30, 45, 60] as minutes}
											<button
												type="button"
												class="btn btn-xs {sliderMinutesAgo === minutes
													? 'btn-primary'
													: 'btn-outline'}"
												onclick={() => setStartTimeMinutesAgo(minutes)}
											>
												{minutes === 0 ? 'Now' : `${minutes} min`}
											</button>
										{/each}
									</div>

									{#if customStartTime}
										<p class="text-sm text-base-content/70">
											Timer will start from <span
												class="font-semibold text-base-content tabular-nums"
												>{customStartTime.toLocaleTimeString([], {
													hour: '2-digit',
													minute: '2-digit',
													second: '2-digit'
												})}</span
											>
										</p>
									{/if}

									{#if startTimeValidationError}
										<div class="alert alert-error py-2" role="alert">
											<span class="text-sm">{startTimeValidationError}</span>
										</div>
									{/if}
								</div>
							{/if}
						</div>

						<div class="flex flex-wrap items-center gap-3 pt-4 border-t border-base-300">
							<button
								class="btn btn-primary btn-lg"
								type="submit"
								disabled={!$network.isOnline || !!startTimeValidationError}
							>
								<svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
									<polygon points="6 3 20 12 6 21 6 3" />
								</svg>
								Start Timer
							</button>
							{#if !$network.isOnline}
								<p class="text-sm text-warning font-medium">Cannot start timer while offline</p>
							{/if}
						</div>
					</form>
				</section>
			{/if}

			<!-- Today's sessions ledger -->
			<aside class="card bg-base-100 border border-base-300" aria-label="Today's sessions">
				<div class="card-body gap-3 p-0">
					<h3 class="text-base font-semibold px-5 pt-5">Today's Sessions</h3>
					{#if loadingTodaySessions}
						<div class="px-5 pb-5 space-y-3" aria-busy="true">
							{#each Array(3) as _}
								<div class="skeleton h-14 w-full"></div>
							{/each}
						</div>
					{:else if todaySessions.length > 0}
						<ul class="divide-y divide-base-300">
							{#each todaySessions as session (session.id)}
								<li class="px-5 py-3 hover:bg-base-200/60 transition-colors">
									<div class="flex justify-between items-start gap-3">
										<div class="min-w-0">
											<h4 class="font-medium text-base-content truncate">{session.title}</h4>
											<p class="text-sm text-base-content/70 truncate">{session.project}</p>
											{#if session.description}
												<p class="text-sm text-base-content/60 truncate">{session.description}</p>
											{/if}
											{@render sessionTags(session.tags)}
										</div>
										<div class="text-right shrink-0">
											<div class="text-sm font-mono tabular-nums text-base-content">
												{session.duration ? formatTime(parseFloat(session.duration)) : '00:00:00'}
											</div>
											<div class="text-xs text-base-content/60 mt-0.5 tabular-nums">
												{new Date(session.start_time).toLocaleTimeString([], {
													hour: '2-digit',
													minute: '2-digit'
												})} - {session.end_time
													? new Date(session.end_time).toLocaleTimeString([], {
															hour: '2-digit',
															minute: '2-digit'
														})
													: 'Active'}
											</div>
										</div>
									</div>
								</li>
							{/each}
						</ul>
					{:else}
						<div class="px-5 pb-6">
							<p class="text-base-content/70">No completed sessions today</p>
							<p class="text-sm text-base-content/60 mt-1">
								Your completed timer sessions will appear here
							</p>
						</div>
					{/if}
				</div>
			</aside>
		</div>
	{/if}

	{#if showTasksModal}
		<TasksModal on:close={() => (showTasksModal = false)} />
	{/if}
</div>

<style>
	.marquee[data-overflow='true'] .marquee-inner {
		animation: marquee-slide 9s ease-in-out infinite alternate;
	}
	@keyframes marquee-slide {
		0%,
		15% {
			transform: translateX(0);
		}
		85%,
		100% {
			transform: translateX(var(--marquee-shift));
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.marquee[data-overflow='true'] .marquee-inner {
			animation: none;
			white-space: normal;
		}
	}
</style>
