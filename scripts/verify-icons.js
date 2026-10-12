'use strict';

// Read the actual icon pixels in PNG, ICO and Windows PE resources. No Windows
// shell cache, screenshot, external image program or renderer is involved.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');

const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function bounded(buffer, offset, length, label) {
  assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset <= buffer.length - length, 'Truncated or invalid ' + label);
  return buffer.subarray(offset, offset + length);
}

function decodePng(buffer) {
  assert.ok(buffer.subarray(0, 8).equals(PNG_SIGNATURE), 'Invalid PNG signature');
  let width, height, channels, ended = false;
  const compressed = [];
  for (let offset = 8; offset < buffer.length;) {
    bounded(buffer, offset, 12, 'PNG chunk');
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = bounded(buffer, offset + 8, length, 'PNG chunk data');
    bounded(buffer, offset + 8 + length, 4, 'PNG chunk checksum');
    if (type === 'IHDR') {
      assert.equal(width, undefined, 'Duplicate PNG header');
      assert.equal(length, 13, 'Invalid PNG header');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.ok(width > 0 && height > 0 && width <= 4096 && height <= 4096, 'Invalid PNG dimensions');
      assert.equal(data[8], 8, 'Icon PNG must use 8-bit channels');
      assert.ok(data[9] === 6 || data[9] === 2, 'Icon PNG must use RGB or RGBA');
      channels = data[9] === 6 ? 4 : 3;
      assert.ok(data[10] === 0 && data[11] === 0 && data[12] === 0, 'Unsupported PNG encoding');
    } else if (type === 'IDAT') {
      assert.ok(width, 'PNG data precedes header');
      compressed.push(data);
    } else if (type === 'IEND') { ended = true; break; }
    offset += length + 12;
  }
  assert.ok(ended && compressed.length, 'Incomplete PNG');
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
  assert.equal(raw.length, (stride + 1) * height, 'Unexpected PNG decoded length');
  const decoded = Buffer.alloc(stride * height);
  function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4, 'Invalid PNG row filter');
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? decoded[y * stride + x - channels] : 0;
      const above = y ? decoded[(y - 1) * stride + x] : 0;
      const upperLeft = y && x >= channels ? decoded[(y - 1) * stride + x - channels] : 0;
      const adjustment = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)][filter];
      decoded[y * stride + x] = (raw[y * (stride + 1) + x + 1] + adjustment) & 255;
    }
  }
  if (channels === 4) return { width, height, pixels: decoded };
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    decoded.copy(pixels, i * 4, i * 3, i * 3 + 3); pixels[i * 4 + 3] = 255;
  }
  return { width, height, pixels };
}

function decodeIconImage(buffer) {
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return decodePng(buffer);
  bounded(buffer, 0, 40, 'icon bitmap header');
  const header = buffer.readUInt32LE(0), width = buffer.readInt32LE(4), fullHeight = buffer.readInt32LE(8);
  const height = Math.abs(fullHeight) / 2, depth = buffer.readUInt16LE(14), compression = buffer.readUInt32LE(16);
  assert.ok([40, 108, 124].includes(header) && width > 0 && width <= 256 && Number.isInteger(height) && height > 0 && height <= 256, 'Unsupported icon bitmap dimensions');
  assert.ok(buffer.readUInt16LE(12) === 1 && depth === 32 && compression === 0, 'Icon bitmap must use uncompressed 32-bit RGBA');
  const bitmap = bounded(buffer, header, width * height * 4, 'icon bitmap pixels');
  const pixels = Buffer.alloc(bitmap.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = ((fullHeight < 0 ? y : height - 1 - y) * width + x) * 4, dst = (y * width + x) * 4;
      pixels[dst] = bitmap[src + 2]; pixels[dst + 1] = bitmap[src + 1]; pixels[dst + 2] = bitmap[src]; pixels[dst + 3] = bitmap[src + 3];
    }
  }
  return { width, height, pixels };
}

function readIco(buffer) {
  bounded(buffer, 0, 6, 'ICO header');
  assert.ok(buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1, 'Invalid ICO header');
  const count = buffer.readUInt16LE(4);
  assert.ok(count > 0 && count <= 64, 'Invalid ICO image count');
  bounded(buffer, 6, count * 16, 'ICO directory');
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + index * 16;
    const dataOffset = buffer.readUInt32LE(entry + 12), length = buffer.readUInt32LE(entry + 8);
    assert.ok(dataOffset >= 6 + count * 16, 'ICO image overlaps directory');
    const image = decodeIconImage(bounded(buffer, dataOffset, length, 'ICO image'));
    assert.equal(image.width, buffer[entry] || 256, 'ICO width does not match image');
    assert.equal(image.height, buffer[entry + 1] || 256, 'ICO height does not match image');
    return image;
  });
}

function assertOrbImage(image, label = 'Icon') {
  const { width, height, pixels } = image;
  assert.equal(width, height, label + ' must be square');
  assert.equal(pixels.length, width * height * 4, label + ' pixel length');
  let visible = 0, opaque = 0, translucent = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, alpha = pixels[i + 3];
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) assert.equal(alpha, 0, label + ' has an opaque or clipped outer border');
      if (alpha) visible++;
      if (alpha === 255) opaque++;
      if (alpha > 0 && alpha < 255) translucent++;
    }
  }
  const center = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  assert.equal(pixels[center + 3], 255, label + ' center must be opaque');
  assert.ok(pixels[center + 2] > pixels[center + 1] && pixels[center + 2] > pixels[center] && pixels[center + 2] >= 180, label + ' center must retain the purple Olanga orb');
  assert.ok(visible > width * height * 0.35 && opaque > width * height * 0.25, label + ' orb is too small or faded');
  assert.ok(translucent > 0, label + ' must have antialiased transparent edges');
}

function assertTrayImage(image, label = 'Tray icon') {
  const { width, height, pixels } = image;
  assert.equal(width, height, label + ' must be square');
  assert.equal(pixels.length, width * height * 4, label + ' pixel length');
  for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
    assert.equal(pixels[(y * width + x) * 4 + 3], 0, label + ' must have transparent corners');
  }
  let opaque = 0, translucent = 0, coverage = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    coverage += pixels[index] / 255;
    if (pixels[index] === 255) opaque++;
    else if (pixels[index]) translucent++;
  }
  assert.ok(coverage >= width * height * 0.7 && coverage <= width * height * 0.8, label + ' must be a full circular orb without a halo');
  assert.ok(opaque > width * height * 0.55 && translucent > 0, label + ' must have an opaque core and antialiased edges');
  const mid = Math.floor(width / 2), center = (mid * width + mid) * 4;
  assert.equal(pixels[center + 3], 255, label + ' center must be opaque');
  assert.ok(pixels[center + 2] > pixels[center] && pixels[center + 2] > pixels[center + 1] && pixels[center + 2] >= 180, label + ' center must retain the purple orb');
  for (const [x, y] of [[0, mid], [width - 1, mid], [mid, 0], [mid, height - 1]]) {
    assert.ok(pixels[(y * width + x) * 4 + 3] > 0, label + ' must fill the tray slot without rectangular padding');
  }
}

function assertTrayIco(buffer, label = 'Tray ICO') {
  const images = readIco(buffer);
  assert.deepEqual(images.map(image => image.width), ICON_SIZES, label + ' must contain all Windows DPI sizes');
  images.forEach((image, index) => {
    assertTrayImage(image, label + ' ' + image.width + 'px');
    const entry = 6 + index * 16, start = buffer.readUInt32LE(entry + 12), length = buffer.readUInt32LE(entry + 8);
    const frame = bounded(buffer, start, length, 'tray icon bitmap');
    const size = image.width, maskStride = Math.ceil(size / 32) * 4;
    assert.equal(frame.readUInt32LE(0), 40, label + ' must use native 32-bit bitmap frames');
    assert.equal(frame.length, 40 + size * size * 4 + maskStride * size, label + ' needs a complete transparency mask');
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const offset = 40 + size * size * 4 + (size - y - 1) * maskStride + (x >> 3);
        const mask = !!(frame[offset] & (0x80 >> (x & 7)));
        assert.equal(mask, image.pixels[(y * size + x) * 4 + 3] === 0, label + ' AND mask must match transparent pixels');
      }
    }
  });
  return images;
}

function readPeIconGroups(buffer) {
  bounded(buffer, 0, 64, 'DOS header');
  assert.equal(buffer.toString('ascii', 0, 2), 'MZ', 'Invalid DOS signature');
  const pe = buffer.readUInt32LE(0x3c);
  bounded(buffer, pe, 24, 'PE header');
  assert.equal(buffer.readUInt32LE(pe), 0x4550, 'Invalid PE signature');
  const sectionCount = buffer.readUInt16LE(pe + 6), optionalSize = buffer.readUInt16LE(pe + 20), optional = pe + 24;
  bounded(buffer, optional, optionalSize, 'PE optional header');
  const magic = buffer.readUInt16LE(optional), directories = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;
  assert.ok(directories > 0 && optionalSize >= directories + 24, 'Unsupported PE optional header');
  const resourceRva = buffer.readUInt32LE(optional + directories + 16);
  const resourceSize = buffer.readUInt32LE(optional + directories + 20);
  assert.ok(resourceRva && resourceSize, 'Executable has no native resources');
  const sectionStart = optional + optionalSize;
  bounded(buffer, sectionStart, sectionCount * 40, 'PE section table');
  const sections = Array.from({ length: sectionCount }, (_, i) => {
    const start = sectionStart + i * 40;
    return { address: buffer.readUInt32LE(start + 12), size: buffer.readUInt32LE(start + 16), offset: buffer.readUInt32LE(start + 20) };
  });
  function map(rva, length) {
    const section = sections.find(item => rva >= item.address && rva - item.address <= item.size - length);
    assert.ok(section, 'Native resource address is outside PE data');
    const offset = section.offset + rva - section.address;
    bounded(buffer, offset, length, 'PE resource');
    return offset;
  }
  const resourceBase = map(resourceRva, Math.min(resourceSize, 16));
  function resource(offset, length) {
    assert.ok(offset >= 0 && offset <= resourceSize - length, 'Native resource offset is out of bounds');
    return bounded(buffer, resourceBase + offset, length, 'native resource directory');
  }
  const leaves = [];
  function visit(offset, ids) {
    assert.ok(ids.length <= 3, 'Unexpected native resource depth');
    const header = resource(offset, 16), count = header.readUInt16LE(12) + header.readUInt16LE(14);
    assert.ok(count <= 65535, 'Too many native resource entries');
    const entries = resource(offset + 16, count * 8);
    for (let i = 0; i < count; i++) {
      const name = entries.readUInt32LE(i * 8), value = entries.readUInt32LE(i * 8 + 4);
      const next = ids.concat(name);
      if (value & 0x80000000) visit(value & 0x7fffffff, next);
      else {
        assert.equal(next.length, 3, 'Invalid native resource hierarchy');
        const data = resource(value, 16), length = data.readUInt32LE(4);
        leaves.push({ type: next[0], id: next[1], language: next[2], data: bounded(buffer, map(data.readUInt32LE(0), length), length, 'native resource image') });
      }
    }
  }
  visit(0, []);
  const groups = leaves.filter(entry => entry.type === 14).map(group => {
    const data = group.data;
    bounded(data, 0, 6, 'native icon group');
    assert.ok(data.readUInt16LE(0) === 0 && data.readUInt16LE(2) === 1, 'Invalid native icon group');
    const count = data.readUInt16LE(4);
    assert.ok(count > 0 && count <= 64, 'Invalid native icon group size');
    bounded(data, 6, count * 14, 'native icon group entries');
    const images = Array.from({ length: count }, (_, i) => {
      const entry = 6 + i * 14, id = data.readUInt16LE(entry + 12);
      const icon = leaves.find(item => item.type === 3 && item.id === id && item.language === group.language) || leaves.find(item => item.type === 3 && item.id === id && item.language === 0);
      assert.ok(icon, 'Native icon group references a missing image');
      assert.equal(icon.data.length, data.readUInt32LE(entry + 8), 'Native icon resource length differs from group');
      const image = decodeIconImage(icon.data);
      assert.equal(image.width, data[entry] || 256, 'Native icon width differs from group');
      assert.equal(image.height, data[entry + 1] || 256, 'Native icon height differs from group');
      return image;
    });
    return { id: group.id, language: group.language, images };
  });
  assert.ok(groups.length, 'Executable has no native icon group');
  return groups;
}

function equalImage(actual, expected) {
  if (actual.width !== expected.width || actual.height !== expected.height) return false;
  for (let i = 0; i < expected.pixels.length; i += 4) {
    if (actual.pixels[i + 3] !== expected.pixels[i + 3]) return false;
    if (expected.pixels[i + 3] && !actual.pixels.subarray(i, i + 3).equals(expected.pixels.subarray(i, i + 3))) return false;
  }
  return true;
}

function assertPeIcons(buffer, expected, label = 'Executable') {
  const groups = readPeIconGroups(buffer);
  // Windows uses the first icon group for EXE and default shortcut icons.
  const primary = groups[0];
  for (const image of expected) {
    assert.ok(primary.images.some(actual => equalImage(actual, image)), label + ' primary native icon does not match the intended ' + image.width + 'px orb');
  }
  return { groups: groups.length, sizes: expected.map(image => image.width) };
}

function verifyIcons({ root = path.resolve(__dirname, '..'), packaged = false, buildDir = process.env.OLANGA_BUILD_DIR || 'dist', uninstaller } = {}) {
  const source = decodePng(fs.readFileSync(path.join(root, 'icon.png')));
  assert.equal(source.width, 1024, 'Source icon must be 1024px');
  assertOrbImage(source, 'icon.png');
  const expected = readIco(fs.readFileSync(path.join(root, 'assets/icons/icon.ico')));
  assert.deepEqual(expected.map(image => image.width).sort((a, b) => a - b), ICON_SIZES, 'ICO must contain each required Windows icon size once');
  for (const image of expected) assertOrbImage(image, 'ICO ' + image.width + 'px');
  const trayBytes = fs.readFileSync(path.join(root, 'assets/icons/tray.ico'));
  assertTrayIco(trayBytes);
  const verified = [];
  if (packaged) {
    const dist = path.resolve(root, buildDir);
    const packagedTray = fs.readFileSync(path.join(dist, 'win-unpacked/resources/app.asar.unpacked/assets/icons/tray.ico'));
    assert.ok(packagedTray.equals(trayBytes), 'Packaged native tray asset must match the verified source');
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const candidates = [path.join(dist, 'win-unpacked/Olanga.exe'), path.join(dist, 'Olanga-Setup-' + version + '.exe')];
    const unpackedUninstaller = path.join(dist, 'win-unpacked/Uninstall Olanga.exe');
    if (fs.existsSync(unpackedUninstaller)) candidates.push(unpackedUninstaller);
    if (uninstaller) candidates.push(path.resolve(root, uninstaller));
    for (const file of candidates) {
      assertPeIcons(fs.readFileSync(file), expected, path.basename(file));
      verified.push(file);
    }
  } else if (uninstaller) throw new Error('--uninstaller requires --packaged');
  return { sourceSize: source.width, icoSizes: ICON_SIZES, traySizes: ICON_SIZES, executables: verified };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) {
      const argument = args.shift();
      if (argument === '--packaged') options.packaged = true;
      else if (argument === '--uninstaller' && args.length) options.uninstaller = args.shift();
      else throw new Error('Unknown or incomplete argument: ' + argument);
    }
    const result = verifyIcons(options);
    console.log('Verified transparent Olanga app and tray orbs at native sizes ' + result.icoSizes.join(', ') + 'px.' + (result.executables.length ? '\nVerified embedded pixels in:\n' + result.executables.join('\n') : ''));
  } catch (error) { console.error('Icon verification failed: ' + error.message); process.exitCode = 1; }
}

module.exports = { ICON_SIZES, decodePng, decodeIconImage, readIco, assertOrbImage, assertTrayImage, assertTrayIco, readPeIconGroups, assertPeIcons, equalImage, verifyIcons };
