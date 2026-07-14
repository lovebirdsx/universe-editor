export function buildSwarmReviewUrl(
  baseUrl: string | undefined,
  reviewId: string,
): string | undefined {
  const base = baseUrl?.trim().replace(/\/+$/, '')
  return base ? `${base}/reviews/${encodeURIComponent(reviewId)}` : undefined
}
