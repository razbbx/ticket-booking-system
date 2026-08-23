import QRCodeModule from 'qrcode';

const QRCode = QRCodeModule && QRCodeModule.default ? QRCodeModule.default : QRCodeModule;

export async function bookingQr(bookingRef) {
  // Generate high-resolution PNG data URL for universal email & browser compatibility
  return await QRCode.toDataURL(bookingRef, {
    width: 300,
    margin: 2,
    color: {
      dark: '#0f172a',
      light: '#ffffff'
    }
  });
}