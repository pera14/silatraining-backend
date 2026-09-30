import { objectKey, sanitizeFileName } from './documents.service';

describe('sanitizeFileName', () => {
  it.each([
    ['../../etc/passwd.pdf', 'passwd.pdf'],
    ['C:\\Users\\ana\\nalaz.pdf', 'nalaz.pdf'],
    ['.hidden.png', 'hidden.png'],
    ['bad\u0000name\u001f.pdf', 'badname.pdf'],
    ['   ', 'document'],
    ['folder/', 'document'],
    ['Nalaz – Đorđe.pdf', 'Nalaz – Đorđe.pdf'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });
});

describe('objectKey', () => {
  it('is built from ids only', () => {
    expect(objectKey('c1', 'd1')).toBe('documents/c1/d1');
  });
});
