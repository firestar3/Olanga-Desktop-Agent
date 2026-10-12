'use strict';
// Render the existing CSS orb's vector counterpart with npm run icons:generate.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { decodePng } = require('./verify-icons');
const root = path.resolve(__dirname, '..');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const trayOnly = process.argv.includes('--tray-only');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(root, 'build', 'icon-render-profile'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:">');
  const orbSvg = fs.readFileSync(path.join(root, 'assets/icons/orb.svg'), 'utf8');
  const source = 'data:image/svg+xml;base64,' + Buffer.from(orbSvg).toString('base64');
  async function render(source, sizes, tray = false) {
    const image = new Image();
    image.src = source;
    await image.decode();
    return sizes.map(size => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      if (tray) {
        // Fill the tray slot with the orb itself. A quarter pixel keeps the
        // circular edge antialiased without a rectangular padding border.
        context.drawImage(image, 0.25, 0.25, size - 0.5, size - 0.5);
      } else {
        context.drawImage(image, 0, 0, size, size);
        // Reserve a fully transparent pixel at every edge, including small-DPI frames.
        context.clearRect(0, 0, size, 1); context.clearRect(0, size - 1, size, 1);
        context.clearRect(0, 0, 1, size); context.clearRect(size - 1, 0, 1, size);
      }
      return canvas.toDataURL('image/png').split(',')[1];
    });
  }
  if (!trayOnly) {
  const rendered = await window.webContents.executeJavaScript('(' + render.toString() + ')(' + JSON.stringify(source) + ',' + JSON.stringify([1024, ...sizes]) + ')');
  const [png, ...frames] = rendered.map(value => Buffer.from(value, 'base64'));
  fs.writeFileSync(path.join(root, 'icon.png'), png);
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16, size = sizes[index];
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  fs.writeFileSync(path.join(root, 'assets/icons/icon.ico'), Buffer.concat([header, ...frames]));
  console.log('Generated transparent 1024px PNG and Windows ICO sizes: ' + sizes.join(', ') + '.');
  }
  // Keep the app/installer artwork intact. Crop its same gradient/highlight to
  // the orb circle, omitting the soft halo that is wasted at tray dimensions.
  const traySvg = orbSvg.replace('viewBox="0 0 512 512"', 'viewBox="48 48 416 416"')
    .replace(/\s*<circle[^>]+fill="url\(#halo\)"\s*\/>/, '');
  const traySource = 'data:image/svg+xml;base64,' + Buffer.from(traySvg).toString('base64');
  const trayPngs = await window.webContents.executeJavaScript('(' + render.toString() + ')(' + JSON.stringify(traySource) + ',' + JSON.stringify(sizes) + ',true)');
  const trayFrames = trayPngs.map(value => {
    const image = decodePng(Buffer.from(value, 'base64')), size = image.width;
    const maskStride = Math.ceil(size / 32) * 4;
    const frame = Buffer.alloc(40 + size * size * 4 + maskStride * size);
    frame.writeUInt32LE(40); frame.writeInt32LE(size, 4); frame.writeInt32LE(size * 2, 8);
    frame.writeUInt16LE(1, 12); frame.writeUInt16LE(32, 14);
    frame.writeUInt32LE(frame.length - 40, 20);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const input = (y * size + x) * 4, row = size - y - 1;
        const pixel = 40 + (row * size + x) * 4;
        frame[pixel] = image.pixels[input + 2]; frame[pixel + 1] = image.pixels[input + 1];
        frame[pixel + 2] = image.pixels[input]; frame[pixel + 3] = image.pixels[input + 3];
        // Native 1-bit AND mask preserves transparent pixels even for consumers
        // that do not use the 32-bit alpha channel. Rows are DWORD aligned.
        if (!image.pixels[input + 3]) frame[40 + size * size * 4 + row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return frame;
  });
  const trayHeader = Buffer.alloc(6 + sizes.length * 16);
  trayHeader.writeUInt16LE(1, 2); trayHeader.writeUInt16LE(sizes.length, 4);
  let trayOffset = trayHeader.length;
  trayFrames.forEach((frame, index) => {
    const entry = 6 + index * 16, size = sizes[index];
    trayHeader[entry] = trayHeader[entry + 1] = size % 256;
    trayHeader.writeUInt16LE(1, entry + 4); trayHeader.writeUInt16LE(32, entry + 6);
    trayHeader.writeUInt32LE(frame.length, entry + 8); trayHeader.writeUInt32LE(trayOffset, entry + 12);
    trayOffset += frame.length;
  });
  fs.writeFileSync(path.join(root, 'assets/icons/tray.ico'), Buffer.concat([trayHeader, ...trayFrames]));
  console.log('Generated halo-free Windows tray orb with BGRA pixels and transparency masks: ' + sizes.join(', ') + '.');
  window.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
