import { Logger } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.service';
import { MailerService } from './mailer.service';

describe('MailerService (log transport)', () => {
  it('prints the email instead of sending it', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const config = {
      get: (key: string) => (key === 'MAIL_TRANSPORT' ? 'log' : undefined),
    } as unknown as AppConfig;
    const mailer = new MailerService(config);

    const ok = await mailer.send({
      to: 'ana@sila.test',
      subject: 'Reset your password',
      text: 'Open http://localhost:3001/reset/abc',
    });

    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('ana@sila.test');
    expect(printed).toContain('http://localhost:3001/reset/abc');
    log.mockRestore();
  });
});
