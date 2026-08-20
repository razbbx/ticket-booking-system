import QRCodeModule from 'qrcode';

const QRCode = QRCodeModule && QRCodeModule.default ? QRCodeModule.default : QRCodeModule;

export async function bookingQr(bookingRef) {
  const svg = await QRCode.toString(bookingRef, { type: 'svg', margin: 1 });
  return 'data:image/svg+xml;base64,' + btoa(svg);
}