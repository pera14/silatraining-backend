export default async function globalTeardown(): Promise<void> {
  await globalThis.__SILA_PG__?.stop();
}
