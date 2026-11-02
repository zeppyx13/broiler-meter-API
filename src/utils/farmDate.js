function localDate(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function dayAge(placementDate, calendarDate) {
  return Math.round((Date.parse(calendarDate) - Date.parse(placementDate)) / 86400000) + 1;
}

module.exports = { localDate, dayAge };
