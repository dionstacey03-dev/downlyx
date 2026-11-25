import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFormatVariants,
  getContainerDescriptor,
  identifyContainerFromUrl,
  normalizeContainerFormat,
  resolveAnalysisContainerSelection,
} from '../src/utils/containerFormat.ts';
import { analyzeUrlIntelligence } from '../server/services/urlIntelligenceService.ts';

describe('Container Identification & Format Variant Selection Utility', () => {
  it('normalizes extensions, aliases, and MIME types into canonical container names', () => {
    assert.equal(normalizeContainerFormat('.mp4'), 'MP4');
    assert.equal(normalizeContainerFormat('jpg'), 'JPEG');
    assert.equal(normalizeContainerFormat('m4v'), 'MP4');
    assert.equal(normalizeContainerFormat('ogv'), 'OGG');
    assert.equal(normalizeContainerFormat('video/webm; codecs="vp9, opus"'), 'WEBM');
    assert.equal(normalizeContainerFormat('audio/mpeg'), 'MP3');
    assert.equal(normalizeContainerFormat('audio/x-m4a'), 'M4A');
    assert.equal(normalizeContainerFormat('video/quicktime'), 'MOV');
    assert.equal(normalizeContainerFormat('image/png'), 'PNG');
    assert.equal(normalizeContainerFormat('text/html'), null);
    assert.equal(normalizeContainerFormat(''), null);
  });

  it('identifies container types from direct URL paths and query hints without false positives on platform links', () => {
    assert.deepEqual(
      identifyContainerFromUrl('https://cdn.example.com/assets/clip.webm?token=abc'),
      { container: 'WEBM', category: 'video', source: 'path_extension' }
    );
    assert.deepEqual(
      identifyContainerFromUrl('https://cdn.example.com/audio/podcast.mp3'),
      { container: 'MP3', category: 'audio', source: 'path_extension' }
    );
    assert.deepEqual(
      identifyContainerFromUrl('https://cdn.example.com/photos/cover.jpg'),
      { container: 'JPEG', category: 'image', source: 'path_extension' }
    );
    assert.deepEqual(
      identifyContainerFromUrl('https://cdn.example.com/stream?id=42&format=m4a'),
      { container: 'M4A', category: 'audio', source: 'query_hint' }
    );
    assert.deepEqual(
      identifyContainerFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
      { container: null, category: 'unknown', source: 'none' }
    );
  });

  it('auto-identifies and selects the analyzed URL container over defaultFormat preference while exposing all format variants', async () => {
    const webmAnalysis = await analyzeUrlIntelligence(
      'https://cdn.example.com/media/trailer.webm',
      { skipNetworkMetadata: true }
    );
    assert.equal(webmAnalysis.httpStatus, 200);
    assert.equal(webmAnalysis.payload.detectedContainer, 'WEBM');
    assert.ok(
      Array.isArray(webmAnalysis.payload.formatVariants) &&
        webmAnalysis.payload.formatVariants.length >= 4
    );

    // Even when user's global preference is "mp4", analyzing a .webm file auto-selects WEBM
    const selection = resolveAnalysisContainerSelection(webmAnalysis.payload, 'mp4');
    assert.equal(selection.detectedContainer, 'WEBM');
    assert.equal(selection.detectedCategory, 'video');
    assert.equal(selection.defaultSelectedFormat, 'WEBM');
    assert.equal(selection.selectionSource, 'detected_container');
    assert.equal(selection.variants[0].container, 'WEBM');
    assert.equal(selection.variants[0].isSourceContainer, true);
    assert.equal(selection.variants[0].requiresConversion, false);

    const mp3Variant = selection.variants.find((v) => v.container === 'MP3');
    assert.ok(mp3Variant);
    assert.equal(mp3Variant.category, 'audio');
    assert.equal(mp3Variant.isSourceContainer, false);
    assert.equal(mp3Variant.requiresConversion, true);
  });

  it('identifies audio and image containers and restricts variants appropriately', async () => {
    const mp3Analysis = await analyzeUrlIntelligence(
      'https://cdn.example.com/tracks/episode-12.mp3',
      { skipNetworkMetadata: true }
    );
    assert.equal(mp3Analysis.payload.detectedContainer, 'MP3');
    const audioSel = resolveAnalysisContainerSelection(mp3Analysis.payload, 'mp4');
    assert.equal(audioSel.defaultSelectedFormat, 'MP3');
    assert.deepEqual(
      audioSel.variants.map((v) => v.container),
      ['MP3', 'M4A', 'WAV', 'OGG']
    );

    const jpgAnalysis = await analyzeUrlIntelligence(
      'https://cdn.example.com/images/banner.jpg',
      { skipNetworkMetadata: true }
    );
    assert.equal(jpgAnalysis.payload.detectedContainer, 'JPEG');
    const imgSel = resolveAnalysisContainerSelection(jpgAnalysis.payload, 'mp4');
    assert.equal(imgSel.defaultSelectedFormat, 'JPEG');
    assert.equal(imgSel.variants.length, 1);
    assert.equal(imgSel.variants[0].isSourceContainer, true);
  });

  it('returns Unverified and empty variants for restricted or non-downloadable platform URLs', async () => {
    const ytAnalysis = await analyzeUrlIntelligence(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      { skipNetworkMetadata: true }
    );
    assert.equal(ytAnalysis.payload.detectedContainer, null);
    const sel = resolveAnalysisContainerSelection(ytAnalysis.payload, 'mp4');
    assert.equal(sel.defaultSelectedFormat, 'Unverified');
    assert.equal(sel.variants.length, 0);
    assert.equal(sel.selectionSource, 'unverified');
  });

  it('builds deduplicated variants with descriptors and falls back cleanly to user preference when source container is not transcodable', () => {
    const variants = buildFormatVariants(['mp4', 'MP4', 'webm', 'mp3'], 'MKV');
    assert.deepEqual(
      variants.map((v) => v.container),
      ['MP4', 'WEBM', 'MP3']
    );
    assert.equal(variants.every((v) => !v.isSourceContainer), true);

    const sel = resolveAnalysisContainerSelection(
      {
        normalizedUrl: 'https://cdn.example.com/video/sample.mkv',
        capabilities: {
          urlDetection: 'supported',
          metadataAvailability: 'not_available',
          authorizedMediaRetrieval: 'supported',
          actualDownloadAvailability: 'supported',
        },
        availableFormats: [],
        permittedOutputFormats: ['MP4', 'WEBM', 'MOV', 'MP3'],
        directMediaVerification: {
          classification: 'probable_media_url',
          expectedContainer: 'MKV',
          verifiedMimeType: null,
          signatureVerified: false,
          reason: 'Probable MKV container',
        },
      },
      'webm'
    );
    assert.equal(sel.detectedContainer, 'MKV');
    assert.equal(sel.defaultSelectedFormat, 'WEBM');
    assert.equal(sel.selectionSource, 'user_preference');
    assert.equal(getContainerDescriptor('WEBM').mimeHint, 'video/webm');
  });
});
