/**
 * Unsplash API Client
 * Frontend functions to search Unsplash via the backend proxy.
 */

export interface UnsplashPhoto {
  id: string;
  thumbUrl: string;
  smallUrl: string;
  regularUrl: string;
  photographer: string;
  photographerUrl: string;
  photoUrl: string;
  blurHash: string | null;
  downloadLocation: string;
}

export interface UnsplashSearchResult {
  photos: UnsplashPhoto[];
  total: number;
  totalPages: number;
}

import { fetchApi } from './api';

/**
 * Search Unsplash photos via backend proxy.
 */
export async function searchUnsplash(
  query: string,
  page = 1,
  perPage = 20
): Promise<UnsplashSearchResult> {
  const params = new URLSearchParams({
    query,
    page: String(page),
    per_page: String(perPage),
  });

  return fetchApi<UnsplashSearchResult>(`/api/unsplash/search?${params}`);
}

/**
 * Upload a local image as background.
 * Sends raw binary to avoid base64 overhead.
 */
export async function uploadBackgroundImage(file: File): Promise<{ url: string; filename: string }> {
  return fetchApi<{ url: string; filename: string }>('/api/background/upload', {
    method: 'POST',
    headers: {
      'Content-Type': file.type,
      'X-Filename': encodeURIComponent(file.name),
    },
    body: file,
  });
}

/**
 * Trigger Unsplash download event (required by API guidelines).
 */
export async function triggerUnsplashDownload(downloadLocation: string): Promise<void> {
  await fetchApi('/api/unsplash/download', {
    method: 'POST',
    body: JSON.stringify({ downloadLocation }),
  });
}
