(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaIntents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const likedSongs = /^(?:(?:my|the|your)\s+)?(?:liked|saved|favorite|favourite)\s+(?:songs|tracks|music)(?:\s+playlist)?$/i;
  const appNames = /^(?:spotify|discord|chrome|google chrome|edge|microsoft edge|firefox|notepad|calculator|word|excel|powerpoint|outlook|teams|slack|vs code|visual studio code|file explorer)$/i;
  const numberWords = { zero: 0, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, half: 0.5 };
  function number(value) {
    if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
    const words = value.toLowerCase().split(/[ -]+/);
    if (words.length === 1) return numberWords[words[0]];
    if (words.length === 2 && /^(?:one|a)$/.test(words[0]) && words[1] === 'hundred') return 100;
    if (words.length === 2 && numberWords[words[0]] >= 20 && numberWords[words[0]] < 100 && numberWords[words[1]] >= 1 && numberWords[words[1]] < 10) return numberWords[words[0]] + numberWords[words[1]];
    return NaN;
  }
  function action(command, message) { return { command, message }; }
  function single(input) {
    const text = input.replace(/^(?:(?:hey\s+)?olanga[, ]+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?/i, '').replace(/(?:,?\s+please)?[.!?]*$/i, '').trim();
    let match;
    if (/^(?:what(?:'s| is) (?:this song|playing)(?: (?:on spotify|right now))?|what song is (?:this|playing))$/i.test(text)) return action('[MEDIA_STATUS]', 'Checking the current song…');
    if (/^(?:pause|stop)(?: (?:the |my )?(?:music|song|playback|spotify|it))?(?: on spotify)?$/i.test(text)) return action('[MEDIA_PAUSE]', 'Pausing playback…');
    if (/^(?:resume|continue|play)(?: (?:the |my )?(?:music|song|playback|spotify|it))?(?: on spotify)?$/i.test(text)) return action('[MEDIA_PLAY]', 'Resuming playback…');
    if (/^(?:skip(?: (?:this|the))?(?: (?:song|track))?|next(?: (?:song|track))?)(?: on spotify)?$/i.test(text)) return action('[MEDIA_NEXT]', 'Skipping to the next track…');
    if (/^(?:previous|last|go back(?: to the previous)?)(?: (?:song|track))?(?: on spotify)?$/i.test(text)) return action('[MEDIA_PREV]', 'Going to the previous track…');
    if ((match = /^(?:(?:set|raise|increase|lower|decrease|turn|change|adjust|make)\s+)?(?:(?:the|my|system|master)\s+)?volume(?:\s+(?:up|down))?\s+(?:(?:to|at)\s+)?([\w. -]+?)\s*(?:%|per\s*cent)?$/i.exec(text))) {
      const level = number(match[1].trim());
      if (Number.isFinite(level) && level >= 0 && level <= 100) return action(`[VOLUME_SET: ${level}]`, `Setting the volume to ${level}%…`);
    }
    if (/^(?:turn (?:it|the volume) up|volume up|louder|increase (?:the )?volume)$/i.test(text)) return action('[VOLUME_UP]', 'Turning the volume up…');
    if (/^(?:turn (?:it|the volume) down|volume down|quieter|lower (?:the )?volume|decrease (?:the )?volume)$/i.test(text)) return action('[VOLUME_DOWN]', 'Turning the volume down…');
    if (/^(?:reload|restart) spotify(?: and (?:resume|play)(?: (?:the |my )?(?:current )?(?:song|music))?)?$/i.test(text)) return action('[SPOTIFY_RELOAD]', 'Restarting Spotify…');
    if ((match = /^(?:play|put on|start|listen to)\s+(.+?)(?:\s+(?:on|in|using)\s+spotify)?$/i.exec(text))) {
      const target = match[1].trim();
      if (likedSongs.test(target)) return action('[SPOTIFY_LIKED]', 'Opening your Liked Songs…');
      const named = /^(?:(my|the)\s+)?(playlist|album|artist|song|track)\s+(.+)$/i.exec(target);
      if (named) {
        const kind = named[2].toLowerCase();
        const name = named[3].replace(/^["“]|["”]$/g, '').trim();
        if (kind === 'playlist' && likedSongs.test(name)) return action('[SPOTIFY_LIKED]', 'Opening your Liked Songs…');
        const type = kind === 'playlist' && named[1]?.toLowerCase() === 'my' ? 'LIBRARY' : kind === 'track' ? 'SONG' : kind.toUpperCase();
        return action(`[SPOTIFY_${type}: ${name}]`, `Finding ${name} on Spotify…`);
      }
    }
    if ((match = /^(?:open|launch|start)\s+(.+)$/i.exec(text)) && appNames.test(match[1])) return action(`[OPEN_APP: ${match[1]}]`, `Opening ${match[1]}…`);
    if ((match = /^(?:set|start)(?: a)?(?: timer for)?\s+([\w. -]+?)\s*(seconds?|minutes?|hours?)(?: timer)?(?: (?:called|named|for) (.+))?$/i.exec(text))) {
      const seconds = number(match[1].trim()) * (/^hour/i.test(match[2]) ? 3600 : /^minute/i.test(match[2]) ? 60 : 1);
      if (Number.isInteger(seconds) && seconds > 0 && seconds <= 86400) return action(`[SET_TIMER: ${seconds}, ${match[3] || 'Timer'}]`, 'Setting your timer…');
    }
    return null;
  }
  function clauses(input) {
    const parts = [];
    let start = 0;
    let quote = null;
    for (let index = 0; index < input.length; index++) {
      const character = input[index];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === '“') {
        quote = character === '“' ? '”' : '"';
      } else {
        const separator = /^,?\s+(?:and(?:\s+then)?|then)\s+/i.exec(input.slice(index));
        if (separator) {
          parts.push(input.slice(start, index).trim());
          index += separator[0].length - 1;
          start = index + 1;
        }
      }
    }
    if (quote) return null;
    parts.push(input.slice(start).trim());
    return parts;
  }
  function parse(input) {
    if (typeof input !== 'string' || !input.trim() || input.length > 1000 || /[\[\]\r\n]/.test(input)) return null;
    const complete = single(input.trim());
    if (complete?.command === '[SPOTIFY_RELOAD]') return [complete];
    const parts = clauses(input.trim());
    if (!parts || parts.length > 4) return null;
    const actions = parts.map(single);
    return actions.every(Boolean) ? actions : null;
  }
  return { parse, isLikedSongs: text => likedSongs.test(String(text).trim()) };
});
