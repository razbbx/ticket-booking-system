'use strict';

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || 'no-reply@ticketbook.local';

// Sends an email. When SMTP is not configured the message is logged to the
// console instead so the booking flow still completes during development.
function sendMail({ to, subject, text, html }) {
  if (!SMTP_HOST) {
    console.log('[EMAIL]', JSON.stringify({ to, subject, text, html: html ? '(<html>' : undefined }));
    return Promise.resolve({ logged: true });
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  return transporter.sendMail({ from: SMTP_FROM, to, subject, text, html });
}

// Builds a plain-text + HTML ticket message for a confirmed booking.
function sendTicket({ to, name, event, bookings }) {
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

  return sendMail({ to, subject, text, html });
}

module.exports = { sendMail, sendTicket };
