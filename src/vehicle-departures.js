export function parseVehicleMeeting(meeting = '') {
  const raw = String(meeting), text = raw.trim();
  const match = text.match(/^((?:[01]\d|2[0-3]):[0-5]\d)(?:\s*[·・|｜]\s*|\s*$)([\s\S]*)$/u);
  return match ? {time: match[1], location: match[2].trim()} : {time: '', location: text};
}

export function formatVehicleMeeting(time, location, original) {
  time = String(time ?? '').trim(); location = String(location ?? '').trim();
  if (time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('請填寫有效的出發時間。');
  const previous = parseVehicleMeeting(original);
  if (typeof original === 'string' && time === previous.time && location === previous.location) return original;
  if (!location) throw new Error('請填寫出發地點。');
  const meeting = time ? `${time} · ${location}` : location;
  if (meeting.length > 150) throw new Error('出發時間與地點合計最多 150 字。');
  return meeting;
}

export function vehicleDepartures(state, date) {
  if (date !== state.trip.startDate) return [];
  return state.vehicles.map(vehicle => ({vehicle, ...parseVehicleMeeting(vehicle.meeting)}))
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
}
