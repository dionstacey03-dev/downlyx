import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DownloadJob, HistoryItem } from '../src/types/media.ts';
import {
  filterHistoryItems,
  getVisibleSelectionState,
  pruneSelectedIds,
  sortHistoryItems,
  splitHighlightSegments,
  summarizeDownloadsHistory,
  toggleSelectAllVisible,
  toggleSelectId,
} from '../src/utils/historyFilter.ts';

const SAMPLE_ITEMS: HistoryItem[] = [
  {
    id: '1',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    platform: 'youtube',
    platformName: 'YouTube',
    mediaType: 'Video',
    fileType: 'MP4',
    qualityPreference: 'Best Available',
    status: 'analyzed',
    resourceId: 'dQw4w9WgXcQ',
    createdAt: '2026-11-24T10:00:00.000Z',
    note: 'Validated by URL Intelligence Engine',
  },
  {
    id: '2',
    url: 'https://www.instagram.com/reel/C8x123abc/',
    platform: 'instagram',
    platformName: 'Instagram',
    mediaType: 'Reel',
    fileType: 'MP4',
    qualityPreference: 'Best Available',
    status: 'analyzed',
    resourceId: 'C8x123abc',
    createdAt: '2026-11-24T10:05:00.000Z',
    note: 'Requires authorization',
  },
  {
    id: '3',
    url: 'https://cdn.example.com/tracks/youtube-podcast.mp3',
    platform: 'direct',
    platformName: 'Direct Media URL',
    mediaType: 'Audio',
    fileType: 'mp3',
    qualityPreference: 'Original Verified',
    status: 'completed',
    resourceId: 'youtube-podcast.mp3',
    createdAt: '2026-11-24T10:10:00.000Z',
    note: 'Verified and ready for download.',
  },
  {
    id: '4',
    url: 'https://cdn.example.com/clips/demo.mp4',
    platform: 'direct',
    platformName: 'Direct Media URL',
    mediaType: 'Short Video',
    fileType: 'mp4',
    qualityPreference: 'Original Verified',
    status: 'completed',
    resourceId: 'demo.mp4',
    createdAt: '2026-11-24T10:15:00.000Z',
    note: 'Verified and ready for download.',
  },
];

describe('Downloads Page History Search Filter', () => {
  it('filters history items strictly by checking whether platformName contains the query', () => {
    const yt = filterHistoryItems(SAMPLE_ITEMS, { searchQuery: 'youtube' });
    // Item 3 URL has "youtube" in path, but its platformName is Direct Media URL and mediaType is Audio -> excluded
    assert.deepEqual(
      yt.map((i) => i.id),
      ['1']
    );

    const direct = filterHistoryItems(SAMPLE_ITEMS, { searchQuery: '  DIRECT MEDIA ' });
    assert.deepEqual(
      direct.map((i) => i.id),
      ['3', '4']
    );
  });

  it('filters history items strictly by checking whether mediaType contains the query', () => {
    const videos = filterHistoryItems(SAMPLE_ITEMS, { searchQuery: 'video' });
    assert.deepEqual(
      videos.map((i) => i.id),
      ['1', '4']
    );

    const shortVideos = filterHistoryItems(SAMPLE_ITEMS, { searchQuery: 'short video' });
    assert.deepEqual(
      shortVideos.map((i) => i.id),
      ['4']
    );

    const reels = filterHistoryItems(SAMPLE_ITEMS, { searchQuery: 'REEL' });
    assert.deepEqual(
      reels.map((i) => i.id),
      ['2']
    );

    const audio = filterHistoryItems(SAMPLE_ITEMS, { searchQuery: 'audio' });
    assert.deepEqual(
      audio.map((i) => i.id),
      ['3']
    );
  });

  it('combines searchQuery cleanly with statusFilter and platformFilter', () => {
    const completedVideo = filterHistoryItems(SAMPLE_ITEMS, {
      searchQuery: 'video',
      statusFilter: 'completed',
    });
    assert.deepEqual(
      completedVideo.map((i) => i.id),
      ['4']
    );

    const instaReel = filterHistoryItems(SAMPLE_ITEMS, {
      searchQuery: 'reel',
      platformFilter: 'instagram',
    });
    assert.deepEqual(
      instaReel.map((i) => i.id),
      ['2']
    );
  });

  it('splits matching text segments case-insensitively while preserving original casing', () => {
    assert.deepEqual(splitHighlightSegments('Direct Media URL', 'media'), [
      { text: 'Direct ', match: false },
      { text: 'Media', match: true },
      { text: ' URL', match: false },
    ]);

    assert.deepEqual(splitHighlightSegments('Short Video', 'o'), [
      { text: 'Sh', match: false },
      { text: 'o', match: true },
      { text: 'rt Vide', match: false },
      { text: 'o', match: true },
    ]);

    assert.deepEqual(splitHighlightSegments('X / Twitter', '  '), [
      { text: 'X / Twitter', match: false },
    ]);

    assert.deepEqual(splitHighlightSegments('X / Twitter', '/'), [
      { text: 'X ', match: false },
      { text: '/', match: true },
      { text: ' Twitter', match: false },
    ]);
  });

  it('manages checkbox batch selection, tri-state Select All, and deleted ID pruning', () => {
    let selected = new Set<string>();
    assert.deepEqual(getVisibleSelectionState(selected, SAMPLE_ITEMS), {
      selectedVisibleCount: 0,
      allVisibleSelected: false,
      someVisibleSelected: false,
    });

    // Individual checkbox toggle produces partial / indeterminate visible state
    selected = toggleSelectId(selected, '1');
    assert.deepEqual(getVisibleSelectionState(selected, SAMPLE_ITEMS), {
      selectedVisibleCount: 1,
      allVisibleSelected: false,
      someVisibleSelected: true,
    });

    // Select All while filtered only selects visible filtered items without dropping out-of-filter selections
    const directItems = filterHistoryItems(SAMPLE_ITEMS, { searchQuery: 'Direct Media' });
    selected = toggleSelectAllVisible(selected, directItems);
    assert.deepEqual(Array.from(selected).sort(), ['1', '3', '4']);
    assert.deepEqual(getVisibleSelectionState(selected, directItems), {
      selectedVisibleCount: 2,
      allVisibleSelected: true,
      someVisibleSelected: false,
    });

    // Toggling Select All when all visible items are checked unchecks only visible items
    selected = toggleSelectAllVisible(selected, directItems);
    assert.deepEqual(Array.from(selected), ['1']);

    // Select All on all items checks every item, and pruning removes IDs no longer in history
    selected = toggleSelectAllVisible(selected, SAMPLE_ITEMS);
    assert.equal(selected.size, 4);
    const pruned = pruneSelectedIds(
      selected,
      SAMPLE_ITEMS.filter((item) => item.id !== '2' && item.id !== '4')
    );
    assert.deepEqual(Array.from(pruned).sort(), ['1', '3']);
  });

  it('summarizes total downloads, completed file size, and failed attempts accurately', () => {
    assert.deepEqual(summarizeDownloadsHistory([]), {
      totalDownloads: 0,
      completedCount: 0,
      completedTotalBytes: 0,
      failedCount: 0,
    });

    const mixedHistory: HistoryItem[] = [
      {
        ...SAMPLE_ITEMS[2],
        id: 'h-comp-1',
        jobId: 'job-1',
        status: 'completed',
        sizeBytes: 1024,
      },
      {
        ...SAMPLE_ITEMS[3],
        id: 'h-comp-2',
        jobId: 'job-2',
        status: 'completed',
        sizeBytes: undefined,
      },
      {
        ...SAMPLE_ITEMS[0],
        id: 'h-fail-1',
        status: 'failed',
        sizeBytes: 999999, // Failed item size must not count toward completed size
      },
      {
        ...SAMPLE_ITEMS[1],
        id: 'h-fail-2',
        status: 'permanently_failed',
      },
      {
        ...SAMPLE_ITEMS[0],
        id: 'h-cancel-1',
        status: 'cancelled',
      },
    ];

    const liveJobs: DownloadJob[] = [
      {
        id: 'job-2',
        url: 'https://cdn.example.com/clips/demo.mp4',
        platform: 'direct',
        platformName: 'Direct Media URL',
        mediaType: 'Video',
        targetFormat: 'mp4',
        status: 'completed',
        progressPercent: 100,
        bytesDownloaded: 2048,
        totalBytes: 2048,
        stageMessage: 'Verified',
        createdAt: '2026-11-24T10:15:00.000Z',
        updatedAt: '2026-11-24T10:15:05.000Z',
        verifiedMetadata: {
          mimeType: 'video/mp4',
          container: 'MP4',
          sizeBytes: 2048,
        },
      },
    ];

    assert.deepEqual(summarizeDownloadsHistory(mixedHistory, liveJobs), {
      totalDownloads: 5,
      completedCount: 2,
      completedTotalBytes: 3072,
      failedCount: 2,
    });
  });

  it('sorts history items by Date Added, File Size, and Platform Name in both directions', () => {
    const sortable: HistoryItem[] = [
      {
        ...SAMPLE_ITEMS[0], // YouTube, 10:00
        id: 'yt-1',
        sizeBytes: 500,
      },
      {
        ...SAMPLE_ITEMS[1], // Instagram, 10:05
        id: 'ig-2',
        sizeBytes: undefined,
      },
      {
        ...SAMPLE_ITEMS[2], // Direct Media URL, 10:10
        id: 'dir-3',
        jobId: 'job-live-3',
        sizeBytes: 100,
      },
    ];

    const liveJobs: DownloadJob[] = [
      {
        id: 'job-live-3',
        url: SAMPLE_ITEMS[2].url,
        platform: 'direct',
        platformName: 'Direct Media URL',
        mediaType: 'Audio',
        targetFormat: 'mp3',
        status: 'completed',
        progressPercent: 100,
        bytesDownloaded: 8192,
        totalBytes: 8192,
        stageMessage: 'Verified',
        createdAt: '2026-11-24T10:10:00.000Z',
        updatedAt: '2026-11-24T10:10:05.000Z',
        verifiedMetadata: {
          mimeType: 'audio/mpeg',
          container: 'MP3',
          sizeBytes: 8192,
        },
      },
    ];

    assert.deepEqual(
      sortHistoryItems(sortable, 'date', 'desc', liveJobs).map((i) => i.id),
      ['dir-3', 'ig-2', 'yt-1']
    );
    assert.deepEqual(
      sortHistoryItems(sortable, 'date', 'asc', liveJobs).map((i) => i.id),
      ['yt-1', 'ig-2', 'dir-3']
    );

    assert.deepEqual(
      sortHistoryItems(sortable, 'size', 'desc', liveJobs).map((i) => i.id),
      ['dir-3', 'yt-1', 'ig-2']
    );
    assert.deepEqual(
      sortHistoryItems(sortable, 'size', 'asc', liveJobs).map((i) => i.id),
      ['ig-2', 'yt-1', 'dir-3']
    );

    assert.deepEqual(
      sortHistoryItems(sortable, 'platform', 'asc', liveJobs).map((i) => i.id),
      ['dir-3', 'ig-2', 'yt-1']
    );
    assert.deepEqual(
      sortHistoryItems(sortable, 'platform', 'desc', liveJobs).map((i) => i.id),
      ['yt-1', 'ig-2', 'dir-3']
    );
  });
});
