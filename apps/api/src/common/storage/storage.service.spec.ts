import type { AppConfig } from '../../config/app-config.service';
import type { Env } from '../../config/env';
import { contentDisposition, StorageService } from './storage.service';

function storage(overrides: Partial<Env> = {}): StorageService {
  const env: Partial<Env> = {
    S3_ENDPOINT: 'http://minio:9000',
    S3_BUCKET: 'sila-documents',
    S3_ACCESS_KEY: 'sila-api',
    S3_SECRET_KEY: 'secret',
    S3_REGION: 'us-east-1',
    ...overrides,
  };
  const config = { get: (key: keyof Env) => env[key] } as unknown as AppConfig;
  return new StorageService(config);
}

describe('StorageService presigned URLs', () => {
  const put = { key: 'documents/a/b', contentType: 'application/pdf', contentLength: 3 };
  const get = { key: 'documents/a/b', fileName: 'a.pdf', contentType: 'application/pdf' };

  it('signs for S3_ENDPOINT when no public endpoint is set (dev)', async () => {
    const s = storage();
    const { url } = await s.presignPut(put);
    expect(new URL(url).origin).toBe('http://minio:9000');
    expect(new URL(url).pathname).toBe('/sila-documents/documents/a/b');
    s.onModuleDestroy();
  });

  it('signs PUT and GET for S3_PUBLIC_ENDPOINT, the host browsers use (prod)', async () => {
    const s = storage({ S3_PUBLIC_ENDPOINT: 'https://files.example.com' });
    for (const { url } of [await s.presignPut(put), await s.presignGet(get)]) {
      const u = new URL(url);
      expect(u.origin).toBe('https://files.example.com');
      expect(u.pathname).toBe('/sila-documents/documents/a/b');
      // SigV4 binds the signature to the Host header, which must be the public one
      expect(u.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('host');
      expect(u.searchParams.get('X-Amz-Credential')).toMatch(/^sila-api\//);
    }
    s.onModuleDestroy();
  });
});

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
