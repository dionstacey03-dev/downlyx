import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Trash2,
  Copy,
  Check,
  ArrowUpRight,
  Inbox,
  RotateCcw,
  Layers,
  Download,
  Ban,
  X,
  HardDrive,
  AlertCircle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import type {
  DownloadJob,
  DownloadStatus,
  HistoryItem,
  NavPage,
  PlatformId,
} from '../types/media.ts';
import {
  DEFAULT_SORT_DIRECTION,
  filterHistoryItems,
  getVisibleSelectionState,
  pruneSelectedIds,
  sortHistoryItems,
  splitHighlightSegments,
  summarizeDownloadsHistory,
  toggleSelectAllVisible,
  toggleSelectId,
  type HistorySortDirection,
  type HistorySortField,
} from '../utils/historyFilter.ts';
import { STORAGE_KEYS } from '../utils/platformDetector.ts';
import { PlatformIcon } from '../components/PlatformIcon.tsx';
import { StatusIndicator } from '../components/StatusIndicator.tsx';
import { Tooltip } from '../components/Tooltip.tsx';
import { LoadingState } from '../components/LoadingState.tsx';

interface DownloadsPageProps {
  history: HistoryItem[];
  downloadJobs: DownloadJob[];
  isLoading: boolean;
  onCancelDownload: (jobId: string) => Promise<void>;
  onDownloadFile: (
    jobId: string,
    fallbackContainer?: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onRemoveItem: (id: string) => Promise<void>;
  onRemoveItems: (ids: string[]) => Promise<void>;
  onClearAll: () => Promise<void>;
  onInspectUrl: (url: string) => void;
  onNavigate: (page: NavPage) => void;
}

type StatusFilter = 'all' | DownloadStatus;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function isRunningStatus(status: DownloadStatus): boolean {
  return status === 'queued' || status === 'processing' || status === 'verifying';
}

function readPersistedSearchQuery(): string {
  try {
    return localStorage.getItem(STORAGE_KEYS.downloadsSearch) ?? '';
  } catch {
    return '';
  }
}

const HighlightedText: React.FC<{ text: string; query: string }> = ({
  text,
  query,
}) => {
  const segments = splitHighlightSegments(text, query);
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark
            key={`${index}-${segment.text}`}
            className="rounded-xs bg-[#8B5CF6]/20 px-0.5 font-semibold text-[#6D28D9] dark:bg-[#22D3EE]/25 dark:text-[#67E8F9]"
          >
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={`${index}-${segment.text}`}>
            {segment.text}
          </React.Fragment>
        )
      )}
    </>
  );
};

export const DownloadsPage: React.FC<DownloadsPageProps> = ({
  history,
  downloadJobs,
  isLoading,
  onCancelDownload,
  onDownloadFile,
  onRemoveItem,
  onRemoveItems,
  onClearAll,
  onInspectUrl,
  onNavigate,
}) => {
  const [searchQuery, setSearchQuery] = useState<string>(readPersistedSearchQuery);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [platformFilter, setPlatformFilter] = useState<'all' | PlatformId>('all');
  const [sortBy, setSortBy] = useState<HistorySortField>('date');
  const [sortDirection, setSortDirection] = useState<HistorySortDirection>('desc');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectAllDesktopRef = useRef<HTMLInputElement>(null);
  const selectAllMobileRef = useRef<HTMLInputElement>(null);

  const shortcutLabel = useMemo(() => {
    if (
      typeof navigator !== 'undefined' &&
      /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent)
    ) {
      return '⌘K';
    }
    return 'Ctrl+K';
  }, []);

  useEffect(() => {
    try {
      if (searchQuery) {
        localStorage.setItem(STORAGE_KEYS.downloadsSearch, searchQuery);
      } else {
        localStorage.removeItem(STORAGE_KEYS.downloadsSearch);
      }
    } catch {
      // Ignore storage unavailability
    }
  }, [searchQuery]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEYS.downloadsSearch) {
        setSearchQuery(event.newValue ?? '');
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault();
        const input = searchInputRef.current;
        if (input) {
          input.focus();
          input.select();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const jobsById = useMemo(() => {
    const map = new Map<string, DownloadJob>();
    for (const job of downloadJobs) {
      map.set(job.id, job);
    }
    return map;
  }, [downloadJobs]);

  const filteredItems = useMemo(() => {
    const filtered = filterHistoryItems(history, {
      searchQuery,
      statusFilter,
      platformFilter,
    });
    return sortHistoryItems(filtered, sortBy, sortDirection, downloadJobs);
  }, [history, searchQuery, statusFilter, platformFilter, sortBy, sortDirection, downloadJobs]);

  const summary = useMemo(
    () => summarizeDownloadsHistory(history, downloadJobs),
    [history, downloadJobs]
  );

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    statusFilter !== 'all' ||
    platformFilter !== 'all';

  const {
    selectedVisibleCount,
    allVisibleSelected,
    someVisibleSelected,
  } = useMemo(
    () => getVisibleSelectionState(selectedIds, filteredItems),
    [selectedIds, filteredItems]
  );

  useEffect(() => {
    setSelectedIds((prev) => pruneSelectedIds(prev, history));
  }, [history]);

  useEffect(() => {
    if (selectedIds.size === 0) {
      setConfirmBatchDelete(false);
    }
  }, [selectedIds]);

  useEffect(() => {
    if (selectAllDesktopRef.current) {
      selectAllDesktopRef.current.indeterminate = someVisibleSelected;
    }
    if (selectAllMobileRef.current) {
      selectAllMobileRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected, filteredItems.length]);

  const handleToggleItemSelection = (id: string) => {
    setConfirmBatchDelete(false);
    setSelectedIds((prev) => toggleSelectId(prev, id));
  };

  const handleToggleSelectAllVisible = () => {
    setConfirmBatchDelete(false);
    setSelectedIds((prev) => toggleSelectAllVisible(prev, filteredItems));
  };

  const handleConfirmBatchDelete = async () => {
    if (selectedIds.size === 0 || isBatchDeleting) return;
    const idsToDelete = Array.from(selectedIds);
    setIsBatchDeleting(true);
    try {
      await onRemoveItems(idsToDelete);
      setSelectedIds(new Set());
      setConfirmBatchDelete(false);
    } finally {
      setIsBatchDeleting(false);
    }
  };

  const handleCopy = async (id: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1800);
    } catch {
      // Clipboard write unavailable
    }
  };

  const resetFilters = () => {
    setSearchQuery('');
    setStatusFilter('all');
    setPlatformFilter('all');
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
            Downloads &amp; Queue History
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Track analyzed URLs, active isolated worker jobs, verified files, and expiring download links.{' '}
            <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
              ({history.length} total)
            </span>
          </p>
        </div>

        {history.length > 0 && (
          <div className="flex items-center gap-2 shrink-0">
            {confirmClear ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    void onClearAll();
                    setConfirmClear(false);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-rose-700 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                >
                  Confirm Clear All
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-200 whitespace-nowrap"
                >
                  Cancel
                </button>
              </>
            ) : (
              <Tooltip content="Remove all items and cancel active jobs">
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:bg-white/[0.08] whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                >
                  <Trash2 className="h-3.5 w-3.5 text-rose-500" aria-hidden="true" />
                  <span>Clear History</span>
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {/* Downloads Summary Card */}
      <section
        aria-label="Downloads summary"
        className="rounded-2xl border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-[#111827]/75"
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-slate-200 dark:divide-white/[0.08]">
          <div className="flex items-center gap-3.5 px-5 py-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#8B5CF6]/10 text-[#7C3AED] dark:bg-[#8B5CF6]/15 dark:text-[#A78BFA]">
              <Download className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Total Downloads
              </p>
              <p
                data-testid="summary-total-downloads"
                className="mt-0.5 font-display text-2xl font-bold tracking-tight tabular-nums text-slate-900 dark:text-white"
              >
                {summary.totalDownloads}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3.5 px-5 py-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
              <HardDrive className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Completed File Size
              </p>
              <div className="mt-0.5 flex items-baseline gap-2">
                <p
                  data-testid="summary-completed-size"
                  className="font-display text-2xl font-bold tracking-tight tabular-nums text-slate-900 dark:text-white"
                >
                  {formatBytes(summary.completedTotalBytes)}
                </p>
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                  ({summary.completedCount} {summary.completedCount === 1 ? 'file' : 'files'})
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3.5 px-5 py-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-500/10 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400">
              <AlertCircle className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Failed Attempts
              </p>
              <p
                data-testid="summary-failed-count"
                className={`mt-0.5 font-display text-2xl font-bold tracking-tight tabular-nums ${
                  summary.failedCount > 0
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-slate-900 dark:text-white'
                }`}
              >
                {summary.failedCount}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Filter & Sort Toolbar */}
      <div className="space-y-2.5">
        <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-3 dark:border-white/[0.08] dark:bg-[#111827]/75">
          <div className="flex flex-col md:flex-row md:items-center gap-2.5">
            <div className="relative flex-1 min-w-0">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
                aria-hidden="true"
              />
              <input
                ref={searchInputRef}
                id="downloads-search-input"
                type="text"
                inputMode="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by platform name or media type..."
                aria-label="Search history by platform name or media type"
                aria-keyshortcuts="Control+K Meta+K"
                className={`h-10 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#8B5CF6] focus:bg-white focus:outline-none dark:border-white/10 dark:bg-[#080B14] dark:text-slate-100 dark:placeholder:text-slate-500 ${
                  searchQuery.length > 0 ? 'pr-9' : 'pr-3 sm:pr-16'
                }`}
              />
              {searchQuery.length > 0 ? (
                <button
                  type="button"
                  id="downloads-search-clear"
                  onClick={() => {
                    setSearchQuery('');
                    searchInputRef.current?.focus();
                  }}
                  title="Clear search"
                  aria-label="Clear search query"
                  className="absolute right-2 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : (
                <kbd
                  aria-hidden="true"
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center rounded-md border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-400 dark:border-white/10 dark:bg-[#111827] dark:text-slate-500"
                >
                  {shortcutLabel}
                </kbd>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <select
                aria-label="Filter by platform"
                value={platformFilter}
                onChange={(e) => setPlatformFilter(e.target.value as 'all' | PlatformId)}
                className="h-10 rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-700 focus:border-[#8B5CF6] focus:outline-none dark:border-white/10 dark:bg-[#080B14] dark:text-slate-200"
              >
                <option value="all">All Platforms</option>
                <option value="youtube">YouTube</option>
                <option value="instagram">Instagram</option>
                <option value="tiktok">TikTok</option>
                <option value="facebook">Facebook</option>
                <option value="x">X / Twitter</option>
                <option value="direct">Direct Media URL</option>
                <option value="unsupported">Unsupported</option>
              </select>

              <div className="flex items-center gap-1.5">
                <div className="relative flex items-center">
                  <ArrowUpDown
                    className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-slate-400"
                    aria-hidden="true"
                  />
                  <select
                    id="downloads-sort-select"
                    aria-label="Sort history by"
                    value={sortBy}
                    onChange={(e) => {
                      const nextField = e.target.value as HistorySortField;
                      setSortBy(nextField);
                      setSortDirection(DEFAULT_SORT_DIRECTION[nextField]);
                    }}
                    className="h-10 rounded-xl border border-slate-200 bg-slate-50 pl-8 pr-3 text-xs font-medium text-slate-700 focus:border-[#8B5CF6] focus:outline-none dark:border-white/10 dark:bg-[#080B14] dark:text-slate-200"
                  >
                    <option value="date">Date Added</option>
                    <option value="size">File Size</option>
                    <option value="platform">Platform Name</option>
                  </select>
                </div>

                <Tooltip
                  content={
                    sortDirection === 'asc'
                      ? 'Ascending order (click to reverse)'
                      : 'Descending order (click to reverse)'
                  }
                >
                  <button
                    type="button"
                    id="downloads-sort-direction"
                    onClick={() =>
                      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))
                    }
                    aria-label={`Sort direction: ${
                      sortDirection === 'asc' ? 'ascending' : 'descending'
                    }. Click to toggle.`}
                    className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:border-white/10 dark:bg-[#080B14] dark:text-slate-300 dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                  >
                    {sortDirection === 'asc' ? (
                      <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>

          <div
            role="group"
            aria-label="Filter by status"
            className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 dark:border-white/10 dark:bg-[#080B14] w-fit max-w-full"
          >
            {(
              [
                'all',
                'processing',
                'completed',
                'failed',
                'permanently_failed',
                'cancelled',
                'analyzed',
                'unsupported',
              ] as StatusFilter[]
            ).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setStatusFilter(status)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium capitalize transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
                  statusFilter === status
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-[#8B5CF6] dark:text-white'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                {status === 'permanently_failed' ? 'Permanently Failed' : status}
              </button>
            ))}
          </div>
        </div>

      {hasActiveFilters && history.length > 0 && (
        <div
          aria-live="polite"
          className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500 dark:text-slate-400"
        >
          <span>
            Showing{' '}
            <span className="font-mono font-medium text-slate-900 dark:text-slate-200">
              {filteredItems.length}
            </span>{' '}
            of{' '}
            <span className="font-mono font-medium text-slate-900 dark:text-slate-200">
              {history.length}
            </span>{' '}
            history {history.length === 1 ? 'item' : 'items'}
          </span>
          <button
            type="button"
            onClick={resetFilters}
            className="inline-flex items-center gap-1 font-medium text-[#7C3AED] hover:underline dark:text-[#22D3EE]"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            <span>Reset filters</span>
          </button>
        </div>
      )}
      </div>

      {/* Batch Selection Toolbar */}
      {selectedIds.size > 0 && history.length > 0 && (
        <div
          role="region"
          aria-label="Batch selection actions"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#8B5CF6]/35 bg-[#8B5CF6]/[0.06] px-4 py-2.5 dark:border-[#8B5CF6]/40 dark:bg-[#8B5CF6]/10"
        >
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center rounded-lg bg-[#8B5CF6] px-2.5 py-1 font-mono font-semibold text-white tabular-nums">
              {selectedIds.size} selected
            </span>
            {selectedIds.size > selectedVisibleCount && (
              <span className="text-slate-600 dark:text-slate-300">
                ({selectedIds.size - selectedVisibleCount} hidden by filter)
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setSelectedIds(new Set());
                setConfirmBatchDelete(false);
              }}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-200 dark:hover:bg-white/[0.1] whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
            >
              Clear selection
            </button>

            {confirmBatchDelete ? (
              <>
                <button
                  type="button"
                  disabled={isBatchDeleting}
                  onClick={() => void handleConfirmBatchDelete()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-60 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Confirm Delete ({selectedIds.size})</span>
                </button>
                <button
                  type="button"
                  disabled={isBatchDeleting}
                  onClick={() => setConfirmBatchDelete(false)}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-200 whitespace-nowrap"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmBatchDelete(true)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Delete Selected ({selectedIds.size})</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Download Error Alert */}
      {downloadError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50/80 px-4 py-3 text-xs text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
        >
          <span>{downloadError}</span>
          <button
            type="button"
            onClick={() => setDownloadError(null)}
            className="font-semibold underline underline-offset-2 whitespace-nowrap"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Consistent Loading State */}
      {isLoading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]/75">
          <LoadingState label="Loading downloads & queue history..." rows={3} />
        </div>
      ) : history.length === 0 ? (
        /* New User Empty State */
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 px-6 py-16 text-center dark:border-white/10 dark:bg-[#111827]/45">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/[0.04]">
            <Inbox className="h-6 w-6 text-slate-400" aria-hidden="true" />
          </div>
          <h2 className="mt-4 font-display text-lg font-semibold text-slate-900 dark:text-white">
            Your download queue is empty
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            No downloads or inspections have been recorded yet. Analyze an HTTPS link
            on the Home Dashboard to inspect capabilities or run an authorized download.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => onNavigate('home')}
              className="inline-flex items-center gap-2 rounded-xl bg-[#8B5CF6] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#7C3AED] transition-colors whitespace-nowrap"
            >
              <span>Analyze First URL</span>
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onNavigate('platforms')}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-200 whitespace-nowrap"
            >
              <Layers className="h-4 w-4 text-[#22D3EE]" aria-hidden="true" />
              <span>Supported Platforms</span>
            </button>
          </div>
        </div>
      ) : filteredItems.length === 0 ? (
        /* Filtered Empty State */
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center dark:border-white/[0.08] dark:bg-[#111827]/65">
          <p className="text-sm font-medium text-slate-900 dark:text-white">
            No matching queue entries found
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Adjust your search query or reset active status and platform filters.
          </p>
          <button
            type="button"
            onClick={resetFilters}
            className="mt-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-200"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Reset Filters</span>
          </button>
        </div>
      ) : (
        <>
          {/* Mobile / Tablet / Narrow-Desktop Card List */}
          <div className="xl:hidden space-y-3">
            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 dark:border-white/[0.08] dark:bg-[#111827]/75">
              <label className="inline-flex items-center gap-2.5 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer select-none">
                <input
                  ref={selectAllMobileRef}
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={handleToggleSelectAllVisible}
                  aria-label={
                    allVisibleSelected
                      ? 'Deselect all visible items'
                      : 'Select all visible items'
                  }
                  className="h-4 w-4 rounded border-slate-300 text-[#8B5CF6] accent-[#8B5CF6] focus:ring-2 focus:ring-[#8B5CF6] dark:border-white/20 dark:bg-[#080B14] cursor-pointer"
                />
                <span>
                  {allVisibleSelected
                    ? `Deselect all (${filteredItems.length})`
                    : `Select all (${filteredItems.length})`}
                </span>
              </label>
              {selectedVisibleCount > 0 && (
                <span className="font-mono text-xs text-[#7C3AED] dark:text-[#22D3EE] tabular-nums">
                  {selectedVisibleCount} checked
                </span>
              )}
            </div>

            {filteredItems.map((item) => {
              const liveJob = item.jobId ? jobsById.get(item.jobId) : undefined;
              const downloadUrl = liveJob?.downloadUrl || item.downloadUrl;
              const sizeBytes = liveJob?.verifiedMetadata?.sizeBytes ?? item.sizeBytes;
              const isExpired =
                item.expiresAt !== undefined && Date.now() > Date.parse(item.expiresAt);
              const isRunning = isRunningStatus(item.status);
              const isSelected = selectedIds.has(item.id);

              return (
                <div
                  key={item.id}
                  className={`rounded-2xl border p-4 space-y-3 transition-colors ${
                    isSelected
                      ? 'border-[#8B5CF6]/55 bg-[#8B5CF6]/[0.04] dark:border-[#8B5CF6]/55 dark:bg-[#8B5CF6]/[0.08]'
                      : 'border-slate-200 bg-white dark:border-white/[0.08] dark:bg-[#111827]/75'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleItemSelection(item.id)}
                        aria-label={`Select ${item.platformName} entry`}
                        className="h-4 w-4 shrink-0 rounded border-slate-300 text-[#8B5CF6] accent-[#8B5CF6] focus:ring-2 focus:ring-[#8B5CF6] dark:border-white/20 dark:bg-[#080B14] cursor-pointer"
                      />
                      <PlatformIcon platform={item.platform} className="h-4 w-4 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-slate-900 dark:text-white">
                          <HighlightedText text={item.platformName} query={searchQuery} />
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          <HighlightedText text={item.mediaType} query={searchQuery} /> ·{' '}
                          <span className="font-mono">{item.fileType}</span>
                          {sizeBytes ? ` · ${formatBytes(sizeBytes)}` : ''}
                        </p>
                      </div>
                    </div>
                    <StatusIndicator status={item.status} />
                  </div>

                  <p className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                    {item.url}
                  </p>

                  {isRunning && liveJob && (
                    <div className="space-y-1">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                        <div
                          className="h-full bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE] transition-all"
                          style={{
                            width: `${liveJob.progressPercent ?? 60}%`,
                          }}
                        />
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {(liveJob.retryCount ?? 0) > 0 && (
                          <span className="mr-1.5 font-mono font-semibold text-amber-600 dark:text-amber-400">
                            Retry {liveJob.retryCount}/{liveJob.maxRetries ?? 3} ·
                          </span>
                        )}
                        {liveJob.stageMessage}
                      </p>
                    </div>
                  )}

                  {(item.status === 'failed' || item.status === 'permanently_failed') && item.note && (
                    <p className="text-xs text-rose-600 dark:text-rose-400">
                      {item.note}
                    </p>
                  )}

                  <div className="flex items-center justify-between gap-2 border-t border-slate-200 dark:border-white/[0.08] pt-3">
                    <span className="font-mono text-xs tabular-nums text-slate-400 dark:text-slate-500">
                      {new Date(item.createdAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {isRunning && item.jobId && (
                        <button
                          type="button"
                          onClick={() => void onCancelDownload(item.jobId!)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
                        >
                          Cancel
                        </button>
                      )}
                      {item.status === 'completed' && item.jobId && downloadUrl && !isExpired && (
                        <button
                          type="button"
                          onClick={async () => {
                            setDownloadError(null);
                            const res = await onDownloadFile(item.jobId!, item.fileType);
                            if (!res.ok) setDownloadError(res.error);
                          }}
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                        >
                          <Download className="h-3 w-3" aria-hidden="true" />
                          <span>Save</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onInspectUrl(item.url)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-[#7C3AED] hover:bg-[#8B5CF6]/10 dark:text-[#22D3EE]"
                      >
                        Inspect
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCopy(item.id, item.url)}
                        aria-label="Copy URL"
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/10"
                      >
                        {copiedId === item.id ? (
                          <Check className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => void onRemoveItem(item.id)}
                        aria-label="Remove item"
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-500/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Desktop Data Table */}
          <div className="hidden xl:block overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-[#111827]/75">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-white/[0.08] text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="w-10 py-3.5 pl-5 pr-2">
                    <input
                      ref={selectAllDesktopRef}
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={handleToggleSelectAllVisible}
                      title={
                        allVisibleSelected
                          ? 'Deselect all visible items'
                          : 'Select all visible items'
                      }
                      aria-label={
                        allVisibleSelected
                          ? 'Deselect all visible items'
                          : 'Select all visible items'
                      }
                      className="h-4 w-4 align-middle rounded border-slate-300 text-[#8B5CF6] accent-[#8B5CF6] focus:ring-2 focus:ring-[#8B5CF6] dark:border-white/20 dark:bg-[#080B14] cursor-pointer"
                    />
                  </th>
                  <th className="py-3.5 pl-2 pr-3">Platform &amp; Source</th>
                  <th className="py-3.5 px-3">Media &amp; Format</th>
                  <th className="py-3.5 px-3">Status &amp; Progress</th>
                  <th className="py-3.5 px-3">Added</th>
                  <th className="py-3.5 pl-3 pr-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-white/[0.06] text-sm">
                {filteredItems.map((item) => {
                  const liveJob = item.jobId ? jobsById.get(item.jobId) : undefined;
                  const downloadUrl = liveJob?.downloadUrl || item.downloadUrl;
                  const sizeBytes = liveJob?.verifiedMetadata?.sizeBytes ?? item.sizeBytes;
                  const isExpired =
                    item.expiresAt !== undefined &&
                    Date.now() > Date.parse(item.expiresAt);
                  const isRunning = isRunningStatus(item.status);
                  const isSelected = selectedIds.has(item.id);

                  return (
                    <tr
                      key={item.id}
                      className={`transition-colors ${
                        isSelected
                          ? 'bg-[#8B5CF6]/[0.05] dark:bg-[#8B5CF6]/[0.09]'
                          : 'hover:bg-slate-50 dark:hover:bg-white/[0.02]'
                      }`}
                    >
                      <td className="w-10 py-3.5 pl-5 pr-2">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleItemSelection(item.id)}
                          aria-label={`Select ${item.platformName} entry`}
                          className="h-4 w-4 align-middle rounded border-slate-300 text-[#8B5CF6] accent-[#8B5CF6] focus:ring-2 focus:ring-[#8B5CF6] dark:border-white/20 dark:bg-[#080B14] cursor-pointer"
                        />
                      </td>
                      <td className="py-3.5 pl-2 pr-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <PlatformIcon
                            platform={item.platform}
                            className="h-4 w-4 shrink-0"
                          />
                          <div className="min-w-0">
                            <p className="font-medium text-slate-900 dark:text-slate-100 text-xs">
                              <HighlightedText text={item.platformName} query={searchQuery} />
                            </p>
                            <p
                              title={item.url}
                              className="max-w-[230px] 2xl:max-w-[300px] truncate font-mono text-xs text-slate-500 dark:text-slate-400"
                            >
                              {item.url}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-3 text-xs text-slate-600 dark:text-slate-300">
                        <span>
                          <HighlightedText text={item.mediaType} query={searchQuery} />
                        </span>
                        <span aria-hidden="true" className="mx-1.5 text-slate-400">·</span>
                        <span className="font-mono text-slate-900 dark:text-white">
                          {item.fileType}
                        </span>
                        {sizeBytes ? (
                          <>
                            <span aria-hidden="true" className="mx-1.5 text-slate-400">·</span>
                            <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                              {formatBytes(sizeBytes)}
                            </span>
                          </>
                        ) : liveJob?.verifiedMetadata?.resolutionLabel ? (
                          <>
                            <span aria-hidden="true" className="mx-1.5 text-slate-400">·</span>
                            <span className="font-mono text-slate-500 dark:text-slate-400">
                              {liveJob.verifiedMetadata.resolutionLabel}
                            </span>
                          </>
                        ) : (
                          <>
                            <span aria-hidden="true" className="mx-1.5 text-slate-400">·</span>
                            <span className="text-slate-500 dark:text-slate-400">
                              {item.qualityPreference}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="py-3.5 px-3 whitespace-nowrap">
                        <div className="space-y-1">
                          <StatusIndicator status={item.status} />
                          {isRunning && liveJob && (
                            <div className="space-y-1">
                              <div className="w-28 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                                <div
                                  className="h-full bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE] transition-all"
                                  style={{
                                    width: `${liveJob.progressPercent ?? 60}%`,
                                  }}
                                />
                              </div>
                              {(liveJob.retryCount ?? 0) > 0 && (
                                <p className="font-mono text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                  Retry {liveJob.retryCount}/{liveJob.maxRetries ?? 3}
                                </p>
                              )}
                            </div>
                          )}
                          {(item.status === 'failed' || item.status === 'permanently_failed') && item.note && (
                            <p
                              title={item.note}
                              className="max-w-[200px] truncate text-[11px] text-rose-600 dark:text-rose-400"
                            >
                              {item.note}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-3 whitespace-nowrap font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                        {new Date(item.createdAt).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="py-3.5 pl-3 pr-5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          {isRunning && item.jobId && (
                            <Tooltip content="Cancel active download">
                              <button
                                type="button"
                                onClick={() => void onCancelDownload(item.jobId!)}
                                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
                              >
                                <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>Cancel</span>
                              </button>
                            </Tooltip>
                          )}
                          {item.status === 'completed' && item.jobId && downloadUrl && !isExpired && (
                            <Tooltip content="Save verified media file">
                              <button
                                type="button"
                                onClick={async () => {
                                  setDownloadError(null);
                                  const res = await onDownloadFile(item.jobId!, item.fileType);
                                  if (!res.ok) setDownloadError(res.error);
                                }}
                                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                              >
                                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>Save File</span>
                              </button>
                            </Tooltip>
                          )}
                          <Tooltip content="Re-open link in URL Analyzer">
                            <button
                              type="button"
                              onClick={() => onInspectUrl(item.url)}
                              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-[#7C3AED] hover:bg-[#8B5CF6]/10 dark:text-[#22D3EE] dark:hover:bg-[#22D3EE]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                            >
                              Inspect
                            </button>
                          </Tooltip>
                          <Tooltip content={copiedId === item.id ? 'Copied!' : 'Copy URL'}>
                            <button
                              type="button"
                              onClick={() => void handleCopy(item.id, item.url)}
                              aria-label="Copy URL"
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                            >
                              {copiedId === item.id ? (
                                <Check className="h-3.5 w-3.5 text-emerald-500" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </Tooltip>
                          <Tooltip content="Remove from queue">
                            <button
                              type="button"
                              onClick={() => void onRemoveItem(item.id)}
                              aria-label="Remove item"
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-500/10 dark:hover:text-rose-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
