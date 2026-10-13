'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Release notes live below docs/releases, but a GitHub release body has no
// repository-relative base. Resolve destinations against the source document
// before publishing, leaving the checked-in Markdown useful locally.
function rewriteReleaseNotes(markdown, { repository, ref, sourcePath, serverUrl = 'https://github.com' }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Expected a GitHub owner/repository.');
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('A release tag or commit is required.');
  const server = new URL(serverUrl);
  if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash) throw new Error('Expected an HTTPS GitHub server URL.');
  const source = String(sourcePath || '').replace(/\\/g, '/');
  if (!source || path.posix.isAbsolute(source) || /^[A-Za-z]:/.test(source) || source.split('/').includes('..')) throw new Error('The source notes path must be repository-relative.');
  const base = server.href.replace(/\/$/, '') + '/' + repository + '/blob/' + encodeURIComponent(ref) + '/';

  function resolveDestination(destination) {
    // Keep external, protocol-relative, same-document and query-only links.
    if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/|#|\?)/.test(destination)) return destination;
    const split = destination.search(/[?#]/);
    const file = split < 0 ? destination : destination.slice(0, split);
    const suffix = split < 0 ? '' : destination.slice(split);
    if (!file) return destination;
    const resolved = path.posix.normalize(file.startsWith('/') ? file.slice(1) : path.posix.join(path.posix.dirname(source), file));
    if (resolved === '..' || resolved.startsWith('../')) throw new Error('A release-note link escapes the repository: ' + destination);
    const encoded = resolved.split('/').map(segment => encodeURIComponent(segment).replace(/%25([0-9A-Fa-f]{2})/g, '%$1')).join('/');
    return base + encoded + suffix;
  }

  function rewriteLinks(text) {
    // Inline links/images (including angle-wrapped destinations and titles).
    text = text.replace(/(\]\(\s*)(<[^>\r\n]+>|[^\s()<]+)(?=\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)\r\n]*\))\s*\)|\s*\))/g, (match, prefix, target) => {
      const angled = target.startsWith('<');
      const destination = angled ? target.slice(1, -1) : target;
      const resolved = resolveDestination(destination);
      return prefix + (angled ? '<' + resolved + '>' : resolved);
    });
    // Reference-style link definitions.
    return text.replace(/^(\s{0,3}\[[^\]\r\n]+\]:\s*)(<[^>\r\n]+>|[^\s]+)(?=\s|$)/, (match, prefix, target) => {
      const angled = target.startsWith('<');
      const resolved = resolveDestination(angled ? target.slice(1, -1) : target);
      return prefix + (angled ? '<' + resolved + '>' : resolved);
    });
  }

  let fence = null;
  return String(markdown).split(/(\r?\n)/).map(line => {
    const marker = line.match(/^\s{0,3}(\x60{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return line;
    }
    if (fence || /^\s{4}|\t/.test(line)) return line;
    // Do not turn illustrative Markdown inside inline code into real links.
    return line.split(/(\x60+[^\x60]*\x60+)/).map((part, index) => index % 2 ? part : rewriteLinks(part)).join('');
  }).join('');
}

if (require.main === module) {
  const [sourcePath, outputPath, repository, ref] = process.argv.slice(2);
  if (!sourcePath || !outputPath) throw new Error('Usage: node scripts/prepare-release-notes.js <source> <output> <owner/repository> <tag-or-commit>');
  const output = rewriteReleaseNotes(fs.readFileSync(sourcePath, 'utf8'), {
    sourcePath, repository, ref, serverUrl: process.env.GITHUB_SERVER_URL || 'https://github.com'
  });
  fs.writeFileSync(outputPath, output, 'utf8');
}

module.exports = { rewriteReleaseNotes };