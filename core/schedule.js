'use strict';
// When a backup set is backed up by itself. schedule: { every, time, weekday }
//   every    'hourly', 'daily', 'weekly' or 'off'
//   time     'HH:MM' for daily and weekly, on the 5-minute grid the app checks at
//   weekday  0 (Sunday) to 6, for weekly
// Every hour, day or week has one moment (a slot): on the hour, at the time, on the weekday at the time. A set is due when
// its last successful backup started before the newest slot that has come, so a backup missed while the computer was
// off or asleep is taken at the next check. A set that was never backed up is due at once.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const DEFAULT = { every: 'hourly', time: '12:00', weekday: 1 };
// After a failure the set is tried again at once when its disk was only missing (cheap to look), otherwise after this.
const RETRY_AFTER = 30 * 60 * 1000;
const RETRY_AT_ONCE = new Set(['TARGET_MISSING']);

const EVERY = ['hourly', 'daily', 'weekly', 'off'];

function normalize(s = {}) {
  const every = EVERY.includes(s.every) ? s.every : DEFAULT.every;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s.time || ''));
  const hh = m ? Math.min(23, Number(m[1])) : 12;
  const mm = m ? Math.min(55, Math.round(Number(m[2]) / 5) * 5) : 0;
  const weekday = Number.isInteger(s.weekday) && s.weekday >= 0 && s.weekday <= 6 ? s.weekday : DEFAULT.weekday;
  return { every, time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, weekday };
}

const at = (date, time) => {
  const [hh, mm] = time.split(':').map(Number);
  const d = new Date(date);
  d.setHours(hh, mm, 0, 0);
  return d;
};

// The newest slot at or before now (a Date), or null when the set has no schedule.
function lastSlot(schedule, now = new Date()) {
  const s = normalize(schedule);
  const n = new Date(now);
  if (s.every === 'off') return null;
  if (s.every === 'hourly') {
    n.setMinutes(0, 0, 0);
    return n;
  }
  let d = at(n, s.time);
  if (s.every === 'daily') {
    if (d > n) d.setDate(d.getDate() - 1);
    return d;
  }
  d.setDate(d.getDate() - ((d.getDay() - s.weekday + 7) % 7));
  if (d > n) d.setDate(d.getDate() - 7);
  return d;
}

// The first slot after now.
function nextSlot(schedule, now = new Date()) {
  const s = normalize(schedule);
  const last = lastSlot(s, now);
  if (!last) return null;
  const d = new Date(last);
  if (s.every === 'hourly') d.setHours(d.getHours() + 1);
  else if (s.every === 'daily') d.setDate(d.getDate() + 1);
  else d.setDate(d.getDate() + 7);
  return d;
}

// state: the set's state ({ lastSuccessAt, lastFailure: { at, code }, skippedAt }); times are ISO strings. A backup the
// user stopped (skippedAt) is not started again before the next slot.
function isDue(schedule, state = {}, now = new Date()) {
  const slot = lastSlot(schedule, now);
  if (!slot) return false;
  const success = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : null;
  if (success !== null && success >= slot.getTime()) return false;
  if (state.skippedAt && Date.parse(state.skippedAt) >= slot.getTime()) return false;
  const failure = state.lastFailure;
  if (failure && !RETRY_AT_ONCE.has(failure.code) && now - Date.parse(failure.at) < RETRY_AFTER) return false;
  return true;
}

// When the next backup is expected: now when it is due, otherwise the next slot.
function nextRun(schedule, state = {}, now = new Date()) {
  if (normalize(schedule).every === 'off') return null;
  return isDue(schedule, state, now) ? new Date(now) : nextSlot(schedule, now);
}

module.exports = { normalize, lastSlot, nextSlot, isDue, nextRun, DEFAULT, EVERY, HOUR, DAY };
