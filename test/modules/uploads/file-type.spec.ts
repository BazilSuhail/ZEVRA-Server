import { detectAllowedMime } from '../../../src/modules/uploads/file-type';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('detectAllowedMime', () => {
  it('detects images from magic bytes regardless of declared type', () => {
    expect(detectAllowedMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpg')).toBe('image/jpeg');
    expect(
      detectAllowedMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'application/octet-stream'),
    ).toBe('image/png');
    expect(detectAllowedMime(Buffer.from('GIF89a....'), 'image/gif')).toBe('image/gif');
    expect(detectAllowedMime(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 '), 'image/webp')).toBe('image/webp');
    expect(detectAllowedMime(Buffer.from('%PDF-1.7\n'), 'application/pdf')).toBe('application/pdf');
  });

  it('rejects a spoofed MIME type', () => {
    expect(detectAllowedMime(Buffer.from('<script>alert(1)</script>'), 'image/png')).toBeNull();
    expect(detectAllowedMime(Buffer.from('MZ\x90\x00'), 'application/pdf')).toBeNull();
  });

  it('only accepts containers when declared as the matching document type', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    expect(detectAllowedMime(zip, DOCX)).toBe(DOCX);
    expect(detectAllowedMime(zip, 'application/zip')).toBeNull();
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(detectAllowedMime(ole, 'application/msword')).toBe('application/msword');
  });

  it('accepts UTF-8 text but not binary declared as text', () => {
    expect(detectAllowedMime(Buffer.from('hello ünïcode\n'), 'text/plain')).toBe('text/plain');
    expect(detectAllowedMime(Buffer.from([0x68, 0x00, 0x69]), 'text/plain')).toBeNull();
    expect(detectAllowedMime(Buffer.from([0xc3, 0x28]), 'text/plain')).toBeNull();
  });
});
