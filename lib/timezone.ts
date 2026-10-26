// datetime-local carries no offset. Interpret it in the campaign's selected timezone.
export function dateTimeInZone(value: string | Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export function zonedDateTimeToIso(value: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("Choose a valid date and time");
  const wallClock = Date.parse(value + ":00Z");
  const offsets = new Set<number>();
  for (const delta of [-86400000, 0, 86400000]) {
    const instant = wallClock + delta;
    offsets.add(Date.parse(dateTimeInZone(new Date(instant), timezone) + ":00Z") - instant);
  }
  const matches = [...offsets].map(offset => new Date(wallClock - offset)).filter(date => dateTimeInZone(date, timezone) === value).sort((a, b) => a.getTime() - b.getTime());
  if (!matches.length) throw new Error("This local time does not exist in the selected timezone. Choose another time.");
  return matches[0].toISOString();
}
