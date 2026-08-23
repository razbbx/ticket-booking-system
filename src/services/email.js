const DEFAULT_FROM = 'no-reply@ticketbook.local';
const DEFAULT_FROM_NAME = 'Ticket Booking System';

export async function sendEmail(env, { to, subject, text, html }) {
  if (env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM || `Ticket Booking <onboarding@resend.dev>`,
        to,
        subject,
        text,
        html,
      }),
    });
    if (!res.ok) {
      console.error('[EMAIL][resend]', res.status, await res.text().catch(() => ''));
    } else {
      const body = await res.json().catch(() => ({}));
      console.log('[EMAIL][resend] sent to', to, '| id:', body.id || 'unknown');
    }
    return;
  }

  if (env.EMAIL && typeof env.EMAIL.send === 'function') {
    try {
      await env.EMAIL.send({
        to,
        from: { email: env.EMAIL_FROM || DEFAULT_FROM, name: env.EMAIL_FROM_NAME || DEFAULT_FROM_NAME },
        subject,
        text,
        html,
      });
    } catch (err) {
      console.error('[EMAIL][cloudflare]', err && err.message);
    }
    return;
  }

  console.log('[EMAIL]', JSON.stringify({ to, subject, text, html: html ? '(html)' : undefined }));
}

export async function sendTicket(env, { to, name, event, bookings }) {
  const subject = `Your ticket(s) for ${event.title}`;
  const lines = bookings.map(
    (b) => `${b.booking_ref} | Row ${b.row}, Col ${b.col} | ${b.category} | price ${b.price}`
  );
  const text = [
    `Hi ${name},`,
    `Your booking is confirmed for "${event.title}" on ${event.date} at ${event.time}.`,
    '',
    ...lines,
    '',
    'Thank you for booking with us.',
  ].join('\n');

  const htmlRows = bookings
    .map(
      (b) =>
        `<tr><td>${b.booking_ref}</td><td>Row ${b.row}, Col ${b.col}</td><td>${b.category}</td><td>${b.price}</td><td>${
          b.qr ? `<img src="${b.qr}" alt="QR" style="width:90px;height:90px"/>` : ''
        }</td></tr>`
    )
    .join('');
  const html = `<p>Hi ${name},</p><p>Your booking is confirmed for <b>${event.title}</b> on ${event.date} at ${event.time}.</p><table border="1" cellpadding="6"><tr><th>Booking ref</th><th>Seat</th><th>Category</th><th>Price</th><th>QR</th></tr>${htmlRows}</table><p>Thank you for booking with us.</p>`;

  await sendEmail(env, { to, subject, text, html });
}

export async function sendOfferEmail(env, { to, category, claimUrl, ttlMinutes }) {
  const subject = 'A seat just opened up for your waitlisted event';
  const text = `Good news! A seat in category "${category}" is now available.\nClaim it within ${ttlMinutes} minutes:\n${claimUrl}`;
  const html = `<p>Good news! A seat in category <b>${category}</b> is now available.</p><p>Claim it within <b>${ttlMinutes}</b> minutes:</p><p><a href="${claimUrl}">${claimUrl}</a></p>`;
  await sendEmail(env, { to, subject, text, html });
}