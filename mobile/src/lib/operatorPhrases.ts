// Shared text helpers for the live AI 911 operator call:
//   1. End-call phrase detection — so the caller can hang up by SAYING (or
//      typing) a phrase, not only by tapping the End button.
//   2. Location-shortcut detection + highlighting — when the caller says
//      "my location" / "current location" / "my area" (etc.) we surface that as
//      their actual location (taken from the map) instead of making them read
//      out coordinates. The backend operator is told the same thing; this is the
//      client-side highlight so the caller can SEE the shortcut was understood.
//
// Pure + dependency-free so it can be unit-reasoned about and reused anywhere.

function normalize(s: string): string {
  // Lowercase, drop punctuation (keep apostrophes), collapse whitespace.
  return s
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── End-call phrases ────────────────────────────────────────────────────────
// The canonical phrase we advertise in the UI. Several natural variants are
// accepted so a flustered caller doesn't have to remember an exact wording.
export const END_CALL_HINT = 'end call';

const END_CALL_PHRASES = [
  'end the call',
  'end call',
  'end this call',
  'end the emergency call',
  'hang up',
  'hangup',
  'disconnect the call',
  'disconnect',
  'stop the call',
  "that's all",
  'thats all',
  'that is all',
  'that will be all',
  "i'm done",
  'im done',
  'i am done',
  'goodbye',
  'good bye',
].map(normalize);

/** True when the caller's message is a request to end the call. */
export function matchesEndCall(text: string): boolean {
  const n = normalize(text);
  if (!n) return false;
  return END_CALL_PHRASES.some((p) => n === p || n.includes(p));
}

// ── Location shortcuts ──────────────────────────────────────────────────────
// Longest phrases first so the combined regex prefers the most specific match.
const LOCATION_PHRASES = [
  'my current location',
  'current location',
  'my location',
  'current position',
  'my position',
  'where i am',
  "where i'm at",
  'this location',
  'my coordinates',
  'my area',
  'my place',
  'my spot',
  'right here',
  'over here',
  'here',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-bounded, case-insensitive, global. Rebuilt fresh per call (regex with the
// `g` flag is stateful, so we never share a single instance across calls).
function locationRegex(): RegExp {
  return new RegExp(`\\b(${LOCATION_PHRASES.map(escapeRegExp).join('|')})\\b`, 'gi');
}

/** True if the message contains a "my location"-style shortcut. */
export function hasLocationPhrase(text: string): boolean {
  return locationRegex().test(text);
}

export type TextSegment = { text: string; isLocation: boolean };

/**
 * Split `text` into segments, flagging the location-shortcut spans so the chat
 * bubble can highlight them. Always returns at least one segment.
 */
export function splitLocationPhrases(text: string): TextSegment[] {
  const re = locationRegex();
  const out: TextSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), isLocation: false });
    out.push({ text: m[0], isLocation: true });
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width loops
  }
  if (last < text.length) out.push({ text: text.slice(last), isLocation: false });
  return out.length ? out : [{ text, isLocation: false }];
}
