import type {
  DownloadJob,
  DownloadStatus,
  HistoryItem,
  PlatformId,
} from '../types/media.ts';

export interface HistoryFilterCriteria {
  searchQuery?: string;
  statusFilter?: 'all' | DownloadStatus;
  platformFilter?: 'all' | PlatformId;
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

export function filterHistoryItems(
  items: HistoryItem[],
  criteria: HistoryFilterCriteria = {}
): HistoryItem[] {
  const statusFilter = criteria.statusFilter ?? 'all';
  const platformFilter = criteria.platformFilter ?? 'all';
  const query = (criteria.searchQuery ?? '').trim().toLowerCase();

  return items.filter((item) => {
    if (statusFilter !== 'all' && item.status !== statusFilter) {
      return false;
    }
    if (platformFilter !== 'all' && item.platform !== platformFilter) {
      return false;
    }
    if (!query) {
      return true;
    }

    const platformName = (item.platformName || '').toLowerCase();
    const mediaType = (item.mediaType || '').toLowerCase();

    return platformName.includes(query) || mediaType.includes(query);
  });
}

export function splitHighlightSegments(
  text: string,
  searchQuery: string
): HighlightSegment[] {
  const needle = searchQuery.trim().toLowerCase();
  if (!text || !needle) {
    return text ? [{ text, match: false }] : [];
  }

  const lowerText = text.toLowerCase();
  const segments: HighlightSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = lowerText.indexOf(needle, cursor);
    if (matchIndex === -1) {
      segments.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (matchIndex > cursor) {
      segments.push({ text: text.slice(cursor, matchIndex), match: false });
    }
    segments.push({
      text: text.slice(matchIndex, matchIndex + needle.length),
      match: true,
    });
    cursor = matchIndex + needle.length;
  }

  return segments;
}

export function toggleSelectId(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export function getVisibleSelectionState(
  selected: Set<string>,
  visibleItems: HistoryItem[]
): {
  selectedVisibleCount: number;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
} {
  if (visibleItems.length === 0) {
    return {
      selectedVisibleCount: 0,
      allVisibleSelected: false,
      someVisibleSelected: false,
    };
  }
  let selectedVisibleCount = 0;
  for (const item of visibleItems) {
    if (selected.has(item.id)) {
      selectedVisibleCount += 1;
    }
  }
  return {
    selectedVisibleCount,
    allVisibleSelected: selectedVisibleCount === visibleItems.length,
    someVisibleSelected:
      selectedVisibleCount > 0 && selectedVisibleCount < visibleItems.length,
  };
}

export function toggleSelectAllVisible(
  selected: Set<string>,
  visibleItems: HistoryItem[]
): Set<string> {
  if (visibleItems.length === 0) return selected;
  const { allVisibleSelected } = getVisibleSelectionState(selected, visibleItems);
  const next = new Set(selected);
  if (allVisibleSelected) {
    for (const item of visibleItems) {
      next.delete(item.id);
    }
  } else {
    for (const item of visibleItems) {
      next.add(item.id);
    }
  }
  return next;
}

export function pruneSelectedIds(
  selected: Set<string>,
  history: HistoryItem[]
): Set<string> {
  if (selected.size === 0) return selected;
  const existingIds = new Set(history.map((item) => item.id));
  const next = new Set<string>();
  let changed = false;
  for (const id of selected) {
    if (existingIds.has(id)) {
      next.add(id);
    } else {
      changed = true;
    }
  }
  return changed ? next : selected;
}

export interface DownloadsSummary {
  totalDownloads: number;
  completedCount: number;
  completedTotalBytes: number;
  failedCount: number;
}

export function summarizeDownloadsHistory(
  history: HistoryItem[],
  downloadJobs: DownloadJob[] = []
): DownloadsSummary {
  const jobsById = new Map<string, DownloadJob>();
  for (const job of downloadJobs) {
    jobsById.set(job.id, job);
  }

  let completedCount = 0;
  let completedTotalBytes = 0;
  let failedCount = 0;

  for (const item of history) {
    if (item.status === 'completed') {
      completedCount += 1;
      const liveJob = item.jobId ? jobsById.get(item.jobId) : undefined;
      const sizeBytes = liveJob?.verifiedMetadata?.sizeBytes ?? item.sizeBytes;
      if (typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > 0) {
        completedTotalBytes += sizeBytes;
      }
    } else if (item.status === 'failed' || item.status === 'permanently_failed') {
      failedCount += 1;
    }
  }

  return {
    totalDownloads: history.length,
    completedCount,
    completedTotalBytes,
    failedCount,
  };
}

export type HistorySortField = 'date' | 'size' | 'platform';
export type HistorySortDirection = 'asc' | 'desc';

export const DEFAULT_SORT_DIRECTION: Record<
  HistorySortField,
  HistorySortDirection
> = {
  date: 'desc',
  size: 'desc',
  platform: 'asc',
};

export function sortHistoryItems(
  items: HistoryItem[],
  sortBy: HistorySortField,
  sortDirection: HistorySortDirection,
  downloadJobs: DownloadJob[] = []
): HistoryItem[] {
  if (items.length <= 1) return [...items];

  const jobsById = new Map<string, DownloadJob>();
  for (const job of downloadJobs) {
    jobsById.set(job.id, job);
  }

  const getSize = (item: HistoryItem): number => {
    const liveJob = item.jobId ? jobsById.get(item.jobId) : undefined;
    const raw = liveJob?.verifiedMetadata?.sizeBytes ?? item.sizeBytes ?? 0;
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
  };

  const getTime = (item: HistoryItem): number => {
    const parsed = Date.parse(item.createdAt);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const dir = sortDirection === 'asc' ? 1 : -1;

  return [...items].sort((a, b) => {
    if (sortBy === 'size') {
      const diff = getSize(a) - getSize(b);
      if (diff !== 0) return diff * dir;
    } else if (sortBy === 'platform') {
      const cmp = (a.platformName || '').localeCompare(b.platformName || '', undefined, {
        sensitivity: 'base',
      });
      if (cmp !== 0) return cmp * dir;
    } else {
      const timeDiff = getTime(a) - getTime(b);
      if (timeDiff !== 0) return timeDiff * dir;
    }

    // Deterministic fallback: newest first, then ID
    const fallbackTime = getTime(b) - getTime(a);
    if (fallbackTime !== 0) return fallbackTime;
    return a.id.localeCompare(b.id);
  });
}


