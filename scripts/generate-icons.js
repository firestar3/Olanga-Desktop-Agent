'use strict';
// Render the existing CSS orb's vector counterpart with npm run icons:generate.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
app.disableHardwareAcceleration();
app.setPath('userData', path.join(root, 'build', 'icon-render-profile'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:">');
  const source = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(root, 'assets/icons/orb.svg')).toString('base64');
  async function render(source, sizes) {
    const image = new Image();
    image.src = source;
    await image.decode();
    return sizes.map(size => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, size, size);
      // Reserve a fully transparent pixel at every edge, including small-DPI frames.
      context.clearRect(0, 0, size, 1); context.clearRect(0, size - 1, size, 1);
      context.clearRect(0, 0, 1, size); context.clearRect(size - 1, 0, 1, size);
      return canvas.toDataURL('image/png').split(',')[1];
    });
  }
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
  window.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
