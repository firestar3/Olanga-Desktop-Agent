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
    const half = /^(.+?) and a half$/i.exec(value);
    if (half) return number(half[1]) + 0.5;
    const words = value.toLowerCase().split(/[ -]+/);
    if (words.length === 1) return numberWords[words[0]];
    if (words.length === 2 && /^(?:one|a)$/.test(words[0]) && words[1] === 'hundred') return 100;
    if (words.length === 2 && numberWords[words[0]] >= 20 && numberWords[words[0]] < 100 && numberWords[words[1]] >= 1 && numberWords[words[1]] < 10) return numberWords[words[0]] + numberWords[words[1]];
    return NaN;
  }
  function action(command, message) { return { command, message }; }
  function duration(input) {
    let text = input.trim().toLowerCase(), total = 0, count = 0;
    while (text) {
      const match = /^(\d+(?:\.\d+)?|[a-z -]+?)\s*(seconds?|minutes?|hours?)(?=$|\s|\d)/i.exec(text);
      if (!match) return null;
      const value = number(match[1].replace(/^half (?:a|an)$/, 'half'));
      if (!Number.isFinite(value) || value < 0) return null;
      const unit = /^hour/.test(match[2]) ? 3600 : /^minute/.test(match[2]) ? 60 : 1;
      total += value * unit;
      text = text.slice(match[0].length).trim();
      // "an hour and a half" adds half of the unit that was just named.
      if (/^and a half(?=$|\s)/.test(text)) { total += unit / 2; text = text.slice('and a half'.length).trim(); }
      text = text.replace(/^and\s+/, '');
      if (++count > 3) return null;
    }
    return total > 0 && total <= 86400 && Number.isInteger(total) ? total : null;
  }
  function unquote(text) { return text.replace(/^["“]|["”]$/g, '').trim(); }
  const hourWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  // Returns "h:mm", "h:mm AM" or "h:mm PM", optionally followed by " tomorrow".
  // A bare hour such as "at 5" keeps no meridiem: the next occurrence is chosen
  // when the alarm is created, never while parsing.
  function clockTime(input) {
    let text = String(input || '').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\b([ap])\.?\s?m\b\.?/g, '$1m').replace(/\s+/g, ' ');
    let meridiem = null, tomorrow = false;
    const take = pattern => {
      const found = pattern.exec(text);
      if (found) text = `${text.slice(0, found.index)} ${text.slice(found.index + found[0].length)}`.replace(/\s+/g, ' ').trim();
      return !!found;
    };
    const setMeridiem = value => { meridiem = meridiem && meridiem !== value ? 'conflict' : value; };
    if (take(/\btomorrow\b/)) tomorrow = true;
    if (take(/\b(?:in the morning|this morning|morning)\b/)) setMeridiem('AM');
    if (take(/\b(?:in the (?:afternoon|evening)|this (?:afternoon|evening)|afternoon|evening|tonight|at night|night)\b/)) setMeridiem('PM');
    text = text.replace(/^(?:at|by|for) /, '').trim();
    const suffix = /(?:^|(?<=\d)| )(am|pm)$/.exec(text);
    if (suffix) { setMeridiem(suffix[1].toUpperCase()); text = text.slice(0, suffix.index).trim(); }
    let hour, minute = 0, twentyFourHour = false, found;
    if (/^(?:noon|midday)$/.test(text)) { hour = 12; setMeridiem('PM'); }
    else if (text === 'midnight') { hour = 12; setMeridiem('AM'); }
    else if ((found = /^(\d{1,2})(?:[:.]?(\d{2}))?(?: o'?clock)?$/.exec(text))) {
      hour = Number(found[1]); minute = found[2] ? Number(found[2]) : 0;
      twentyFourHour = (found[1].length === 2 && found[1][0] === '0') || hour === 0 || hour > 12;
    } else if ((found = /^([a-z]+)(?: (o'?clock|oh [a-z]+|[a-z]+(?:[ -][a-z]+)?))?$/.exec(text)) && hourWords[found[1]]) {
      hour = hourWords[found[1]];
      if (found[2] && !/^o'?clock$/.test(found[2])) {
        const leadingZero = found[2].startsWith('oh ');
        minute = number(leadingZero ? found[2].slice(3) : found[2]);
        if (!Number.isInteger(minute) || minute < 1 || minute > (leadingZero ? 9 : 59)) return null;
      }
    } else return null;
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59 || meridiem === 'conflict') return null;
    if (twentyFourHour) {
      if (hour > 23 || (meridiem && (hour >= 12 ? 'PM' : 'AM') !== meridiem)) return null;
      meridiem = hour >= 12 ? 'PM' : 'AM';
      hour = hour % 12 || 12;
    } else if (hour < 1 || hour > 12) return null;
    return `${hour}:${String(minute).padStart(2, '0')}${meridiem ? ` ${meridiem}` : ''}${tomorrow ? ' tomorrow' : ''}`;
  }
  // Reminder text is the user's own words. It is spoken back later and never
  // becomes a command, so it may contain conjunctions or other command words.
  function reminderText(value) {
    const text = unquote(String(value || '').trim().replace(/^(?:to|that|about)\s+/i, ''));
    return text.length >= 2 && text.length <= 120 && !/^(?:me|it|that|this)$/i.test(text) ? text : null;
  }
  function reminder(textValue, whenValue) {
    let body = textValue, when = whenValue.trim();
    const moved = /\s+((?:tomorrow|tonight)(?: (?:morning|afternoon|evening|night))?)$/i.exec(body);
    if (moved) { body = body.slice(0, moved.index); when = `${moved[1]} ${when}`; }
    const text = reminderText(body);
    if (!text) return null;
    const relative = /^(?:in|after|for) (.+)$/i.exec(when);
    const seconds = relative ? duration(relative[1]) : null;
    if (seconds) return action(`[SET_REMINDER: ${seconds}, ${text}]`, 'Setting your reminder…');
    const time = clockTime(when.replace(/^for\s+/i, ''));
    return time ? action(`[SET_ALARM: ${time}, ${text}]`, 'Setting your reminder…') : null;
  }
  const REMINDER_PATTERNS = [
    [/^remind me (?:to|that|about) (.+) ((?:in|after) .+)$/i, 1, 2],
    [/^remind me (?:to|that|about) (.+) ((?:at|by) .+)$/i, 1, 2],
    [/^remind me ((?:in|after) .+?) (?:to|that|about) (.+)$/i, 2, 1],
    [/^remind me ((?:at|by|tomorrow|tonight|this) .+?) (?:to|that|about) (.+)$/i, 2, 1],
    [/^(?:set|create|add|make) (?:a |an )?reminder ((?:for|in|at|after) .+?) (?:to|that|about) (.+)$/i, 2, 1],
    [/^(?:set|create|add|make) (?:a |an )?reminder (?:to|that|about) (.+) ((?:in|after|at|by|for) .+)$/i, 1, 2]
  ];
  // Free-text commands keep the whole request when splitting on "and" or
  // "then" cannot produce a complete supported list.
  const FREE_TEXT_COMMAND = /^\[(?:SET_REMINDER|SET_ALARM|REMEMBER|FORGET):/;
  function resolveApp(text, options) {
    if (appNames.test(text)) return text;
    const alias = (Array.isArray(options?.aliases) ? options.aliases : []).find(item => typeof item?.alias === 'string' && item.alias.toLowerCase() === text.toLowerCase());
    return alias && appNames.test(alias.target) ? alias.target : null;
  }
  function single(input, options) {
    const text = input.replace(/^(?:(?:hey\s+)?olanga[, ]+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?/i, '').replace(/(?:,?\s+please)?[.!?]*$/i, '').trim();
    const plain = text.replace(/[’‘]/g, "'");
    let match;
    if (/^(?:what(?:'s| is) the (?:current )?time(?: right now| now)?|what time is it(?: right now| now)?|(?:tell me|check) the time)$/i.test(plain)) return action('[TIME_STATUS]', 'Checking the time…');
    if (/^(?:what(?:'s| is) (?:the date|the day|today(?:'s date)?)(?: today)?|what (?:day|date) is (?:it|today)(?: today)?|(?:tell me|check) (?:the |today's )?date)$/i.test(plain)) return action('[DATE_STATUS]', 'Checking the date…');
    if (/^(?:help|what (?:else )?can you do|what can i (?:say|ask)(?: you)?|what (?:commands|things) (?:do you (?:know|support|understand)|can you do|can i say)|how (?:can|do) you help(?: me)?|(?:show|list|tell)(?: me)? (?:your|the|all(?: your)?) commands)$/i.test(plain)) return action('[HELP]', 'Here is what I can do…');
    if (/^(?:never ?mind|forget (?:it|that|about it)|nothing|no thanks?|no,? thank you|that'?s all|that is all|that(?:'ll| will) be all|ignore that)$/i.test(plain)) return action('[DISMISS]', 'Okay.');
    if (/^(?:brief me|(?:give me |read me |start |play )?(?:my |the |a |today's )?(?:daily |morning |evening )?(?:briefing|brief|rundown)|(?:what(?:'s| is| does)|how(?:'s| is| does)) my day look(?:ing)?(?: like)?(?: today)?|what(?:'s| is) on my (?:agenda|plate)(?: today| for today)?)$/i.test(plain)) return action('[DAILY_BRIEFING]', 'Preparing your briefing…');
    if (/^(?:what do you (?:remember|know)(?: about me)?|what (?:have i|did i) (?:asked|ask|told|tell) you to remember|what(?:'s| is) in your memory|(?:list|show|read)(?: me)? (?:my |your |all(?: my| your)? )?memories)$/i.test(plain)) return action('[MEMORY_STATUS]', 'Checking what you asked me to remember…');
    if (/^(?:forget|delete|clear|erase|wipe) (?:everything(?: you (?:remember|know)(?: about me)?)?|all (?:of )?(?:my |your |the )?memories|(?:my |your )?memories|your memory)$/i.test(plain)) return action('[CLEAR_MEMORIES]', 'Clearing your memories…');
    if ((match = /^remember that (.+)$/i.exec(plain)) || (match = /^remember ((?:my|mine|i|i'm|i am|i've|i have|our|we|we're|we've)\s.+)$/i.exec(plain))) {
      const fact = match[1].trim();
      if (fact.length >= 3 && fact.length <= 300 && !/^to\s/i.test(fact)) return action(`[REMEMBER: ${fact}]`, 'Saving that to memory…');
    }
    if ((match = /^forget (?:that |about )?(.+)$/i.exec(plain)) && match[1].trim().length >= 2 && !/^(?:it|that|this|everything)$/i.test(match[1].trim())) return action(`[FORGET: ${match[1].trim()}]`, 'Updating your memories…');
    if ((match = /^(?:set|create|make|add|start) (?:an |a |my )?alarm (?:for |at )?(.+?)(?: (?:called|named|labell?ed) (.+))?$/i.exec(plain)) || (match = /^alarm (?:for |at )(.+?)(?: (?:called|named) (.+))?$/i.exec(plain))) {
      const label = match[2] ? reminderText(match[2]) : 'Alarm', time = clockTime(match[1]);
      if (time && label) return action(`[SET_ALARM: ${time}, ${label}]`, 'Setting your alarm…');
      const relative = /^in (.+)$/i.exec(match[1]), seconds = relative && duration(relative[1]);
      if (seconds && label) return action(`[SET_TIMER: ${seconds}, ${label}]`, 'Setting your timer…');
    }
    if ((match = /^wake me(?: up)? (.+)$/i.exec(plain))) {
      const time = clockTime(match[1]);
      if (time) return action(`[SET_ALARM: ${time}, Wake up]`, 'Setting your alarm…');
      const relative = /^in (.+)$/i.exec(match[1]), seconds = relative && duration(relative[1]);
      if (seconds) return action(`[SET_TIMER: ${seconds}, Wake up]`, 'Setting your timer…');
    }
    for (const [pattern, textIndex, whenIndex] of REMINDER_PATTERNS) {
      const result = (match = pattern.exec(plain)) && reminder(match[textIndex], match[whenIndex]);
      if (result) return result;
    }
    if (/^(?:(?:cancel|stop|delete|dismiss|end|silence|turn off|shut off) (?:the |my |this |that )?(?:timer|alarm|reminder)|dismiss(?: it)?|stop (?:the )?(?:ringing|beeping))$/i.test(plain)) return action('[STOP_TIMER]', 'Stopping the alarm…');
    if (/^(?:what(?:'s| is) (?:the |my |system )?volume(?: (?:level|at))?|(?:check|show|get) (?:the |my |system )?volume)$/i.test(text)) return action('[VOLUME_STATUS]', 'Checking system volume…');
    if (/^(?:(?:show|list|check) (?:my |the |all )?(?:active )?timers|what timers (?:are running|do i have))$/i.test(text)) return action('[TIMER_STATUS]', 'Checking your timers…');
    if (/^(?:cancel|clear|stop|delete) all (?:my |the )?timers$/i.test(text)) return action('[CLEAR_ALL_TIMERS]', 'Clearing your timers…');
    if ((match = /^(?:cancel|stop|delete) (?:the |my )?timer(?: (?:called|named))? (.+)$/i.exec(text)) || (match = /^(?:cancel|stop|delete) (?:the |my )?(.+?) timer$/i.exec(text))) return action(`[CANCEL_TIMER: ${unquote(match[1])}]`, 'Cancelling your timer…');
    if (/^(?:show|list|check) (?:my |the |all )?(?:tasks|checklist)$/i.test(text)) return action('[TASK_STATUS]', 'Checking your checklist…');
    if ((match = /^add (.+?) to (?:my |the )?(?:tasks|checklist)$/i.exec(text)) && !match[1].includes(',')) return action(`[ADD_TASK: ${unquote(match[1])}]`, 'Adding your task…');
    if ((match = /^(?:complete|finish|check off) (?:the |my )?task (.+)$/i.exec(text))) return action(`[COMPLETE_TASK: ${unquote(match[1])}]`, 'Updating your checklist…');
    if ((match = /^(?:remove|delete) (?:the |my )?task (.+)$/i.exec(text))) return action(`[REMOVE_TASK: ${unquote(match[1])}]`, 'Updating your checklist…');
    if ((match = /^(?:reopen|uncheck) (?:the |my )?task (.+)$/i.exec(text))) return action(`[UNCOMPLETE_TASK: ${unquote(match[1])}]`, 'Updating your checklist…');
    if ((match = /^(?:move|snap|arrange) (.+?) (?:to |on )?(?:the )?(left|right)(?: (?:side|half))?$/i.exec(text))) {
      const app = resolveApp(unquote(match[1]), options);
      if (app) return action(`[ARRANGE_APP: ${app}, ${match[2].toLowerCase()}]`, `Moving ${app} to the ${match[2].toLowerCase()}…`);
    }
    if ((match = /^maximize (.+)$/i.exec(text))) {
      const app = resolveApp(unquote(match[1]), options);
      if (app) return action(`[ARRANGE_APP: ${app}, maximize]`, `Maximizing ${app}…`);
    }
    if (/^(?:what(?:'s| is) (?:this song|playing)(?: (?:on spotify|right now))?|what song is (?:this|playing))$/i.test(text)) return action('[MEDIA_STATUS]', 'Checking the current song…');
    // A bare "stop" still pauses playback. The assistant substitutes STOP_TIMER
    // only while a timer, alarm or reminder is actually ringing.
    if (/^stop(?: it)?$/i.test(text)) return { ...action('[MEDIA_PAUSE]', 'Pausing playback…'), stopsAlarm: true };
    if (/^(?:pause|stop)(?: (?:the |my )?(?:music|song|playback|spotify|it))?(?: on spotify)?$/i.test(text)) return action('[MEDIA_PAUSE]', 'Pausing playback…');
    if (/^(?:resume|continue|play)(?: (?:the |my )?(?:music|song|playback|spotify|it))?(?: on spotify)?$/i.test(text)) return action('[MEDIA_PLAY]', 'Resuming playback…');
    if (/^(?:skip(?: (?:this|the))?(?: (?:song|track))?|next(?: (?:song|track))?)(?: on spotify)?$/i.test(text)) return action('[MEDIA_NEXT]', 'Skipping to the next track…');
    if (/^(?:previous|last|go back(?: to the previous)?)(?: (?:song|track))?(?: on spotify)?$/i.test(text)) return action('[MEDIA_PREV]', 'Going to the previous track…');
    if ((match = /^(mute|unmute) (?:the |my )?(?:(?:system|master) )?(?:volume|audio|sound|speakers)$/i.exec(text))) {
      const mute = match[1].toLowerCase() === 'mute';
      return action(mute ? '[VOLUME_MUTE_ON]' : '[VOLUME_MUTE_OFF]', mute ? 'Muting system audio…' : 'Unmuting system audio…');
    }
    if (/^toggle (?:the )?(?:system|volume|audio|sound) mute$/i.test(text)) return action('[VOLUME_MUTE]', 'Toggling system mute…');
    if ((match = /^(?:(set|raise|increase|lower|decrease|turn|change|adjust|make)\s+)?(?:(?:the|my|system|master)\s+)?volume(?:\s+(up|down))?\s+(?:(to|at)\s+)?([\w. -]+?)\s*(?:%|per\s*cent)?$/i.exec(text))) {
      // Directional wording without "to"/"at" can mean a relative change.
      // Do not turn "volume down 10%" into an absolute target of 10%.
      const directional = /^(?:raise|increase|lower|decrease)$/i.test(match[1] || '') || !!match[2];
      const amount = match[4].trim();
      // "Half" without a percent unit usually means half volume, while a bare
      // article is an incomplete target. Let interpretation resolve either.
      if (/^(?:half|a|an)$/i.test(amount) && !/(?:%|per\s*cent)$/i.test(text)) return null;
      const level = number(amount);
      if ((!directional || match[3]) && Number.isFinite(level) && level >= 0 && level <= 100) return action(`[VOLUME_SET: ${level}]`, `Setting the volume to ${level}%…`);
    }
    if (/^(?:turn (?:it|the volume) up|volume up|louder|increase (?:the )?volume)$/i.test(text)) return action('[VOLUME_UP]', 'Turning the volume up…');
    if (/^(?:turn (?:it|the volume) down|volume down|quieter|lower (?:the )?volume|decrease (?:the )?volume)$/i.test(text)) return action('[VOLUME_DOWN]', 'Turning the volume down…');
    if (/^(?:reload|restart) spotify(?: and (?:resume|play)(?: (?:the |my )?(?:current )?(?:song|music))?)?$/i.test(text)) return action('[SPOTIFY_RELOAD]', 'Restarting Spotify…');
    if ((match = /^(?:play|put on|start|listen to)\s+(.+?)(?:\s+(?:on|in|using)\s+spotify)?$/i.exec(text))) {
      const target = match[1].trim();
      if (likedSongs.test(target)) return action('[SPOTIFY_LIKED]', 'Opening your Liked Songs…');
      const saved = (Array.isArray(options?.playlists) ? options.playlists : []).find(item => typeof item?.alias === 'string' && item.alias.toLowerCase() === unquote(target.replace(/^my\s+/i, '')).toLowerCase());
      if (saved && typeof saved.target === 'string' && saved.target.length <= 100 && !/[\[\]\r\n]/.test(saved.target)) return action(`[SPOTIFY_LIBRARY: ${saved.target}]`, 'Finding your saved playlist…');
      const named = /^(?:(my|the)\s+)?(playlist|album|artist|song|track)\s+(.+)$/i.exec(target);
      if (named) {
        const kind = named[2].toLowerCase();
        const name = named[3].replace(/^["“]|["”]$/g, '').trim();
        if (kind === 'playlist' && likedSongs.test(name)) return action('[SPOTIFY_LIKED]', 'Opening your Liked Songs…');
        const type = kind === 'playlist' && named[1]?.toLowerCase() === 'my' ? 'LIBRARY' : kind === 'track' ? 'SONG' : kind.toUpperCase();
        return action(`[SPOTIFY_${type}: ${name}]`, `Finding ${name} on Spotify…`);
      }
    }
    if ((match = /^(?:open|launch|start)\s+(.+)$/i.exec(text))) {
      const app = resolveApp(unquote(match[1]), options);
      if (app) return action(`[OPEN_APP: ${app}]`, `Opening ${app}…`);
    }
    if ((match = /^(?:set|start)(?: a)?(?: timer for)?\s+(.+?)(?: timer)?(?: (?:called|named|for) (.+))?$/i.exec(text))) {
      const seconds = duration(match[1]);
      if (seconds) return action(`[SET_TIMER: ${seconds}, ${match[2] ? unquote(match[2]) : 'Timer'}]`, 'Setting your timer…');
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
  function compound(parts, options) {
    const merged = [];
    for (const part of parts) {
      const previous = merged.at(-1);
      const durationPart = part.replace(/\s+(?:named|called|for)\s+.+$/i, '');
      if (previous && /^a half(?=$|\s)/i.test(part)) merged[merged.length - 1] += ` and ${part}`;
      else if (previous && /^\[SET_TIMER: \d+, Timer\]$/.test(single(previous, options)?.command || '') && duration(durationPart) && !/\b(?:named|called)\b/i.test(previous)) merged[merged.length - 1] += ` and ${part}`;
      else merged.push(part);
    }
    if (merged.length > 4) return null;
    const actions = merged.map(part => single(part, options));
    return actions.every(Boolean) ? actions : null;
  }
  function parse(input, options = {}) {
    if (typeof input !== 'string' || !input.trim() || input.length > 1000 || /[\[\]\r\n]/.test(input)) return null;
    const complete = single(input.trim(), options);
    if (complete?.command === '[SPOTIFY_RELOAD]') return [complete];
    const parts = clauses(input.trim());
    const actions = parts && compound(parts, options);
    if (actions) return actions;
    return complete && FREE_TEXT_COMMAND.test(complete.command) ? [complete] : null;
  }
  const isDismissal = text => typeof text === 'string' && text.trim().length > 0 && text.length <= 200 && single(text.trim(), {})?.command === '[DISMISS]';
  return { parse, duration, clockTime, isDismissal, isLikedSongs: text => likedSongs.test(String(text).trim()) };
});
