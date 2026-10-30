'use strict';

function parseTime(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  const h = m ? Math.min(23, Number(m[1])) : 12;
  const min = m ? Math.min(59, Number(m[2])) : 0;
  return [h, min];
}

// The most recent daily slot at or before `now` (local time).
function lastSlot(time, now = new Date()) {
  const [h, m] = parseTime(time);
  const slot = new Date(now);
  slot.setHours(h, m, 0, 0);
  if (slot > now) slot.setDate(slot.getDate() - 1);
  return slot;
}

function nextSlot(time, now = new Date()) {
  const slot = lastSlot(time, now);
  slot.setDate(slot.getDate() + 1);
  return slot;
}

// Due when the last daily run is older than the most recent slot; a missed slot (device off) runs at the next check.
function isDailyDue({ time, lastAt, now = new Date() }) {
  if (!lastAt) return true;
  const last = new Date(lastAt);
  return Number.isNaN(last.getTime()) || last < lastSlot(time, now);
}

module.exports = { lastSlot, nextSlot, isDailyDue, parseTime };
