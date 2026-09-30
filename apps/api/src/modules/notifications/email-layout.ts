/**
 * Branded, bilingual email layout (SPEC §9 Prompt B): Serbian first, English below as the fallback for clients
 * who do not read Serbian (users have no language preference yet). Inline styles only, because email clients
 * strip <style>. Colors match the web app's tokens (packages/ui).
 */

export interface EmailSection {
  title: string;
  paragraphs: string[];
  /** Optional bullet list under the paragraphs (e.g. expiring packages). */
  items?: string[];
  cta?: { label: string; url: string };
}

export interface EmailContent {
  subject: string;
  sr: EmailSection;
  en: EmailSection;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const COLORS = {
  page: '#f5f6f8',
  card: '#ffffff',
  ink: '#0f1729',
  muted: '#6b7385',
  line: '#e6e8ec',
  brand: '#0089bf',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderEmail(content: EmailContent, appUrl: string): RenderedEmail {
  return {
    subject: content.subject,
    text: `${sectionText(content.sr)}\n\n———\n\n${sectionText(content.en)}\n\n— SILA Training\n${appUrl}\n`,
    html: layoutHtml(content, appUrl),
  };
}

function sectionText(s: EmailSection): string {
  const parts = [s.title, '', ...s.paragraphs.flatMap((p) => [p, ''])];
  if (s.items?.length) parts.push(...s.items.map((i) => `• ${i}`), '');
  if (s.cta) parts.push(`${s.cta.label}: ${s.cta.url}`);
  return parts.join('\n').trimEnd();
}

function sectionHtml(s: EmailSection, primary: boolean): string {
  const size = primary ? 15 : 14;
  const color = primary ? COLORS.ink : COLORS.muted;
  const title = `<h1 style="font-size:${primary ? 22 : 17}px;line-height:1.3;margin:0 0 12px;color:${COLORS.ink}">${escapeHtml(s.title)}</h1>`;
  const paragraphs = s.paragraphs
    .map(
      (p) =>
        `<p style="font-size:${size}px;line-height:1.55;color:${color};margin:0 0 12px">${escapeHtml(p)}</p>`,
    )
    .join('');
  const items = s.items?.length
    ? `<ul style="padding-left:20px;margin:0 0 12px">${s.items
        .map(
          (i) =>
            `<li style="font-size:${size}px;line-height:1.55;color:${color};margin:0 0 4px">${escapeHtml(i)}</li>`,
        )
        .join('')}</ul>`
    : '';
  const cta = s.cta
    ? primary
      ? `<p style="margin:20px 0 4px"><a href="${escapeHtml(s.cta.url)}" style="display:inline-block;background:${COLORS.brand};color:#ffffff;padding:14px 22px;border-radius:14px;text-decoration:none;font-weight:700;font-size:15px">${escapeHtml(s.cta.label)}</a></p>`
      : `<p style="margin:8px 0 0;font-size:${size}px"><a href="${escapeHtml(s.cta.url)}" style="color:${COLORS.brand};font-weight:700">${escapeHtml(s.cta.label)}</a></p>`
    : '';
  return title + paragraphs + items + cta;
}

function layoutHtml(content: EmailContent, appUrl: string): string {
  const mark = `${appUrl}/brand/sila-mark.png`;
  return `<!doctype html>
<html lang="sr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.subject)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.page};font-family:Manrope,-apple-system,'Segoe UI',Arial,sans-serif;color:${COLORS.ink}">
<div style="max-width:480px;margin:0 auto;padding:32px 20px">
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr>
<td style="vertical-align:middle"><img src="${escapeHtml(mark)}" width="36" height="36" alt="SILA" style="display:block;border:0;border-radius:10px"></td>
<td style="vertical-align:middle;padding-left:10px;font-size:18px;font-weight:800;letter-spacing:0.02em">SILA Training</td>
</tr></table>
<div style="background:${COLORS.card};border-radius:18px;padding:24px">
${sectionHtml(content.sr, true)}
<div lang="en" style="border-top:1px solid ${COLORS.line};margin-top:20px;padding-top:18px">
${sectionHtml(content.en, false)}
</div>
</div>
<p style="font-size:12px;line-height:1.5;color:${COLORS.muted};margin:16px 4px 0">Ovu poruku ste dobili jer koristite SILA Training. · You received this email because you use SILA Training.</p>
</div></body></html>`;
}
