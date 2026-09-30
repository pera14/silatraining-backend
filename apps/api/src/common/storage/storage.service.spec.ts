import { contentDisposition } from './storage.service';

describe('contentDisposition', () => {
  it('keeps ASCII names and adds the RFC 5987 UTF-8 form', () => {
    expect(contentDisposition('report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('replaces non-ASCII in the fallback and percent-encodes the UTF-8 name', () => {
    expect(contentDisposition('Đorđe š.pdf')).toBe(
      `attachment; filename="_or_e _.pdf"; filename*=UTF-8''%C4%90or%C4%91e%20%C5%A1.pdf`,
    );
  });

  it('cannot break out of the header value', () => {
    const header = contentDisposition('a"; filename="evil.exe\r\nX-Injected: 1');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.startsWith('attachment; filename="a_; filename=_evil.exe__X-Injected: 1"')).toBe(
      true,
    );
    expect(header).toContain(
      "filename*=UTF-8''a%22%3B%20filename%3D%22evil.exe%0D%0AX-Injected%3A%201",
    );
  });
});
