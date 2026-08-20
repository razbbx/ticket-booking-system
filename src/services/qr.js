'use strict';

const qrcode = require('qrcode');

// Returns a data URL (base64 PNG) encoding the booking reference.
function bookingQr(bookingRef) {
  return qrcode.toDataURL(bookingRef);
}

module.exports = { bookingQr };
