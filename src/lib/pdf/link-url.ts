/** Accommodates GeoGon model state in the fragment while bounding retained text. */
export const MAX_PDF_LINK_URL_LENGTH = 32_768;

/**
 * PDF links are explicit web navigation only. Never infer a scheme/base URL,
 * repair malformed input, or permit embedded credentials or control characters.
 */
export function sanitizePdfLinkUrl(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PDF_LINK_URL_LENGTH
    || /[\s\\\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)
  ) return null;
  const authority = /^https?:\/\/([^/?#]+)/iu.exec(value)?.[1];
  if (!authority || authority.includes("@")) return null;

  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || !url.hostname
      || url.username
      || url.password
      || url.href.length > MAX_PDF_LINK_URL_LENGTH
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}
