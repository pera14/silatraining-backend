import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { AppConfig } from '../../config/app-config.service';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Thin mail wrapper. `MAIL_TRANSPORT=smtp` sends via SMTP (Brevo/Postmark in prod, Mailpit with dev:docker);
 * `log` (local dev default when SMTP_HOST is empty) prints each email to the API console instead.
 * Templates live with their feature (notifications module, Agent B). Sending failures are logged, never
 * thrown into the request, so a mail outage cannot break booking or sign-up.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transport: Transporter | null;

  constructor(private readonly config: AppConfig) {
    if (config.get('MAIL_TRANSPORT') === 'log') {
      this.transport = null;
      this.logger.log('MAIL_TRANSPORT=log: emails are printed here instead of being sent');
      return;
    }
    const user = config.get('SMTP_USER');
    this.transport = createTransport({
      host: config.get('SMTP_HOST'),
      port: config.get('SMTP_PORT'),
      secure: config.get('SMTP_SECURE'),
      auth: user ? { user, pass: config.get('SMTP_PASS') } : undefined,
    });
  }

  async send(message: MailMessage): Promise<boolean> {
    if (!this.transport) {
      this.logger.log(
        `\n✉  To: ${message.to}\n   Subject: ${message.subject}\n\n${message.text}\n`,
      );
      return true;
    }
    try {
      await this.transport.sendMail({ from: this.config.get('MAIL_FROM'), ...message });
      return true;
    } catch (err) {
      this.logger.error(`Failed to send "${message.subject}" to ${message.to}: ${String(err)}`);
      return false;
    }
  }
}

/** Minimal branded HTML wrapper; Agent B may replace with richer templates in the notifications module. */
export function simpleEmailHtml(opts: {
  title: string;
  body: string;
  cta?: { label: string; url: string };
}): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const cta = opts.cta
    ? `<p style="margin:24px 0"><a href="${esc(opts.cta.url)}" style="background:#0089bf;color:#fff;padding:14px 22px;border-radius:14px;text-decoration:none;font-weight:700">${esc(opts.cta.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Manrope,Arial,sans-serif;color:#0f1729">
<div style="max-width:480px;margin:0 auto;padding:32px 24px">
<div style="font-size:18px;font-weight:800;margin-bottom:24px">Sila Training</div>
<div style="background:#fff;border-radius:18px;padding:24px">
<h1 style="font-size:22px;margin:0 0 12px">${esc(opts.title)}</h1>
<p style="font-size:15px;line-height:1.5;color:#6b7385;margin:0">${esc(opts.body)}</p>${cta}
</div></div></body></html>`;
}
