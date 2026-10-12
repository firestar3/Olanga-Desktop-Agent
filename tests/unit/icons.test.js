'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { ICON_SIZES, decodePng, decodeIconImage, readIco, assertOrbImage, assertPeIcons, readPeIconGroups, equalImage, verifyIcons } = require('../../scripts/verify-icons');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(image, filter = 0) {
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data]), result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); bytes.copy(result, 4); result.writeUInt32BE(crc32(bytes), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width); header.writeUInt32BE(image.height, 4); header[8] = 8; header[9] = 6;
  const stride = image.width * 4, rows = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    rows[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? image.pixels[y * stride + x - 4] : 0;
      const b = y ? image.pixels[(y - 1) * stride + x] : 0;
      const c = y && x >= 4 ? image.pixels[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const predictor = [0, a, b, Math.floor((a + b) / 2), [a, b, c][distances.indexOf(Math.min(...distances))]][filter];
      rows[y * (stride + 1) + x + 1] = (image.pixels[y * stride + x] - predictor) & 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function orb(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2), index = (y * size + x) * 4;
      if (distance <= size * 0.4) {
        pixels[index] = 108; pixels[index + 1] = 92; pixels[index + 2] = 231;
        pixels[index + 3] = distance > size * 0.4 - 1 ? 128 : 255;
      }
    }
  }
  return { width: size, height: size, pixels };
}
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16), encoded = images.map(image => png(image));
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, i) => {
    const entry = 6 + i * 16;
    header[entry] = image.width % 256; header[entry + 1] = image.height % 256;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(encoded[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += encoded[i].length;
  });
  return Buffer.concat([header, ...encoded]);
}

// A small valid PE resource hierarchy, with no executable code. It exercises
// resource-address mapping and RT_GROUP_ICON -> RT_ICON lookup without Windows.
function pe(groups, is64 = true) {
  const resources = [];
  let nextIcon = 1;
  groups.forEach((images, groupIndex) => {
    const group = Buffer.alloc(6 + images.length * 14);
    group.writeUInt16LE(1, 2); group.writeUInt16LE(images.length, 4);
    images.forEach((image, i) => {
      const bytes = png(image), entry = 6 + i * 14, id = nextIcon++;
      group[entry] = image.width % 256; group[entry + 1] = image.height % 256;
      group.writeUInt16LE(1, entry + 4); group.writeUInt16LE(32, entry + 6);
      group.writeUInt32LE(bytes.length, entry + 8); group.writeUInt16LE(id, entry + 12);
      resources.push({ keys: [3, id, 1033], data: bytes });
    });
    resources.push({ keys: [14, groupIndex + 1, 1033], data: group });
  });
  const root = { children: new Map() };
  for (const entry of resources) {
    let current = root;
    entry.keys.forEach((key, index) => {
      if (!current.children.has(key)) current.children.set(key, index === 2 ? { data: entry.data } : { children: new Map() });
      current = current.children.get(key);
    });
  }
  let cursor = 0;
  const nodes = [];
  function allocate(node) {
    node.offset = cursor; nodes.push(node);
    cursor += node.children ? 16 + node.children.size * 8 : 16;
    if (node.children) for (const child of node.children.values()) allocate(child);
  }
  allocate(root);
  for (const node of nodes.filter(node => node.data)) { node.dataOffset = cursor; cursor += node.data.length; }
  const resource = Buffer.alloc(cursor);
  for (const node of nodes) {
    if (node.children) {
      resource.writeUInt16LE(node.children.size, node.offset + 14);
      let index = 0;
      for (const [key, child] of node.children) {
        resource.writeUInt32LE(key, node.offset + 16 + index * 8);
        resource.writeUInt32LE((child.offset + (child.children ? 0x80000000 : 0)) >>> 0, node.offset + 20 + index++ * 8);
      }
    } else {
      resource.writeUInt32LE(0x1000 + node.dataOffset, node.offset);
      resource.writeUInt32LE(node.data.length, node.offset + 4); node.data.copy(resource, node.dataOffset);
    }
  }
  const result = Buffer.alloc(0x200 + Math.ceil(cursor / 512) * 512);
  result.write('MZ'); result.writeUInt32LE(0x80, 0x3c); result.writeUInt32LE(0x4550, 0x80); result.writeUInt16LE(1, 0x86);
  const optional = 0x98, optionalSize = is64 ? 240 : 224, directories = is64 ? 112 : 96;
  result.writeUInt16LE(optionalSize, 0x94); result.writeUInt16LE(is64 ? 0x20b : 0x10b, optional);
  result.writeUInt32LE(0x1000, optional + directories + 16); result.writeUInt32LE(cursor, optional + directories + 20);
  const section = optional + optionalSize;
  result.write('.rsrc', section); result.writeUInt32LE(cursor, section + 8);
  result.writeUInt32LE(0x1000, section + 12); result.writeUInt32LE(result.length - 0x200, section + 16); result.writeUInt32LE(0x200, section + 20);
  resource.copy(result, 0x200);
  return result;
}

test('checked-in source and all native Windows sizes have transparent orb edges', () => {
  assert.deepEqual(verifyIcons().icoSizes, ICON_SIZES);
});
test('PNG decoding supports all five row filters without losing alpha', () => {
  const expected = orb(24);
  for (let filter = 0; filter <= 4; filter++) assert.deepEqual(decodePng(png(expected, filter)), expected);
});
test('ICO parsing follows independent images including the 256px directory sentinel', () => {
  const images = ICON_SIZES.map(orb);
  assert.deepEqual(readIco(ico(images)), images);
});
test('opaque black squares and faint or tiny icon replacements fail source validation', () => {
  const good = orb(32); assertOrbImage(good);
  const matte = { ...good, pixels: Buffer.from(good.pixels) };
  for (let i = 3; i < matte.pixels.length; i += 4) matte.pixels[i] = 255;
  assert.throws(() => assertOrbImage(matte), /border/);
  const faded = { ...good, pixels: Buffer.from(good.pixels) };
  for (let i = 3; i < faded.pixels.length; i += 4) if (faded.pixels[i]) faded.pixels[i] = 90;
  assert.throws(() => assertOrbImage(faded), /opaque/);
  const empty = { ...good, pixels: Buffer.alloc(good.pixels.length) };
  assert.throws(() => assertOrbImage(empty), /opaque/);
});
test('native PE32 and PE32+ icon groups match every intended ICO size', () => {
  const images = ICON_SIZES.map(orb);
  for (const is64 of [false, true]) {
    const executable = pe([images], is64);
    assert.deepEqual(assertPeIcons(executable, images).sizes, ICON_SIZES);
    assert.deepEqual(readPeIconGroups(executable)[0].images, images);
  }
});
test('native verification rejects stale artwork, missing sizes and a wrong primary group', () => {
  const images = [orb(16), orb(32)], changed = { ...images[0], pixels: Buffer.from(images[0].pixels) };
  changed.pixels[(8 * 16 + 8) * 4] = 10;
  assert.throws(() => assertPeIcons(pe([[changed, images[1]]]), images), /16px/);
  assert.throws(() => assertPeIcons(pe([[images[0]]]), images), /32px/);
  assert.throws(() => assertPeIcons(pe([[changed, images[1]], images]), images), /primary/);
});
test('pixel comparison ignores invisible RGB bytes but never alpha or visible colors', () => {
  const expected = orb(16), actual = { ...expected, pixels: Buffer.from(expected.pixels) };
  actual.pixels[0] = 255;
  assert.equal(equalImage(actual, expected), true);
  actual.pixels[3] = 1;
  assert.equal(equalImage(actual, expected), false);
});
test('malformed PNG, ICO and native resource pointers fail closed', () => {
  assert.throws(() => decodePng(Buffer.alloc(16)), /signature/);
  const truncated = png(orb(16)).subarray(0, 35);
  assert.throws(() => decodePng(truncated), /Incomplete|Truncated/);
  const icon = ico([orb(16)]);
  icon.writeUInt32LE(0xffffffff, 18);
  assert.throws(() => readIco(icon), /invalid/);
  const executable = pe([[orb(16)]]);
  executable.writeUInt32LE(0x7fffffff, 0x98 + 112 + 16);
  assert.throws(() => readPeIconGroups(executable), /outside/);
  assert.throws(() => readPeIconGroups(Buffer.alloc(64)), /signature/);
});

test('native 32-bit icon bitmaps preserve bottom-up BGRA colors and alpha', () => {
  const image = orb(16), bitmap = Buffer.alloc(40 + image.pixels.length + 16 * 4);
  bitmap.writeUInt32LE(40); bitmap.writeInt32LE(16, 4); bitmap.writeInt32LE(32, 8);
  bitmap.writeUInt16LE(1, 12); bitmap.writeUInt16LE(32, 14);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const source = (y * 16 + x) * 4, target = 40 + ((15 - y) * 16 + x) * 4;
      bitmap[target] = image.pixels[source + 2]; bitmap[target + 1] = image.pixels[source + 1];
      bitmap[target + 2] = image.pixels[source]; bitmap[target + 3] = image.pixels[source + 3];
    }
  }
  assert.deepEqual(decodeIconImage(bitmap), image);
  bitmap.writeUInt16LE(24, 14);
  assert.throws(() => decodeIconImage(bitmap), /32-bit/);
});