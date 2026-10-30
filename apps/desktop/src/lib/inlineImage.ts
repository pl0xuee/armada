/** Largest inline `data:` picture (characters of the URL, about 3 MB of image) an agent may put in a reply. */
export const MAX_INLINE_IMAGE_CHARS = 4_000_000;

const INLINE_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i;

/**
 * A reply's `![alt](data:image/png;base64,…)` picture, when it is a small raster image. Shown directly:
 * nothing is fetched. SVG is left out on purpose.
 */
export function inlineImageSrc(url: string): string | null {
  const s = url.trim();
  return s.length <= MAX_INLINE_IMAGE_CHARS && INLINE_IMAGE_RE.test(s) ? s : null;
}
