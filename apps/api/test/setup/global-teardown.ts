export default async function globalTeardown(): Promise<void> {
  await Promise.all([globalThis.__SILA_PG__?.stop(), globalThis.__SILA_MINIO__?.stop()]);
}
