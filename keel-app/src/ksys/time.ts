/** America/New_York wall-clock handling. "wall" = the New York clock reading stored as if it were UTC, so date math is simple. */
const fmts = new Map<string, Intl.DateTimeFormat>();
function fmt(zone: string) {
  let f = fmts.get(zone);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); fmts.set(zone, f); }
  return f;
}
export function wallOf(utc: number, zone = 'America/New_York'): number {
  const p = Object.fromEntries(fmt(zone).formatToParts(new Date(utc)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}
/** A wall-clock time in a zone back to real UTC (handles daylight saving). */
export function utcOf(wall: number, zone: string): number {
  let guess = wall;
  for (let k = 0; k < 3; k++) guess = guess - (wallOf(guess, zone) - wall);
  return guess;
}
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Globex session: 18:00 to 17:00 ET. session_key = date(bar_open_time + 6h). */
export const sessionKey = (wall: number) => ymd(wall + 6 * 3600_000);
/** Weeks by Globex session date, week ending Friday. Key = that Friday's date. */
export function weekKey(sess: string): string {
  const d = Date.parse(sess + 'T00:00:00Z'), dow = new Date(d).getUTCDay();
  return ymd(d + ((5 - dow + 7) % 7) * 86_400_000);
}
export const hourOf = (wall: number) => new Date(wall).getUTCHours();
