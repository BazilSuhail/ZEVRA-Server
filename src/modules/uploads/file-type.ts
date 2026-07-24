export type AllowedMime =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'application/pdf'
  | 'application/msword'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'text/plain';

export const IMAGE_MIMES: ReadonlySet<AllowedMime> = new Set<AllowedMime>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function isProbablyUtf8Text(buf: Buffer): boolean {
  const sample = buf.subarray(0, 64 * 1024);
  if (sample.includes(0)) return false;
  try {
    // stream: true tolerates a multi-byte sequence cut off at the sample edge.
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: buf.length > sample.length });
    return true;
  } catch {
    return false;
  }
}

/**
 * Determines the real type of an upload from its leading bytes. The client
 * MIME type is only used to disambiguate containers (OLE/ZIP) and plain
 * text, which have no unique signature. Returns null when not allowed.
 */
export function detectAllowedMime(buf: Buffer, declaredMime: string): AllowedMime | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38]) && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return 'image/gif';
  }
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';

  const declared = (declaredMime || '').toLowerCase().split(';')[0].trim();
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return declared === 'application/msword' ? 'application/msword' : null;
  }
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    return declared === DOCX ? DOCX : null;
  }
  if (declared === 'text/plain' && buf.length > 0 && isProbablyUtf8Text(buf)) {
    return 'text/plain';
  }
  return null;
}
