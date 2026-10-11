const TIME_ZONE = 'Europe/London' as const;

const londonPartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getParts(date: Date): DateParts {
  const parts = londonPartsFormatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function londonMidnightUtc(year: number, month: number, day: number): Date {
  const utcMidnight = Date.UTC(year, month - 1, day);
  // In the UK, the clock changes after local midnight. The UTC-midnight sample therefore has
  // the same offset as the start of this London date, including the autumn change day.
  const localAtUtcMidnight = getParts(new Date(utcMidnight));
  const localAsUtc = Date.UTC(
    localAtUtcMidnight.year,
    localAtUtcMidnight.month - 1,
    localAtUtcMidnight.day,
    localAtUtcMidnight.hour,
    localAtUtcMidnight.minute,
    localAtUtcMidnight.second
  );
  return new Date(utcMidnight - (localAsUtc - utcMidnight));
}

/** The current Europe/London calendar day as an inclusive/exclusive UTC interval. */
export function getLondonDayWindow(now: Date = new Date()) {
  const local = getParts(now);
  const nextDate = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const from = londonMidnightUtc(local.year, local.month, local.day);
  const to = londonMidnightUtc(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate()
  );
  return {
    localDate: `${String(local.year).padStart(4, '0')}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`,
    timeZone: TIME_ZONE,
    from: from.toISOString(),
    to: to.toISOString(),
  } as const;
}
