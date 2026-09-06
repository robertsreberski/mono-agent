const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const integer = (value: string, max: number): number | undefined => {
  if (!/^\d{1,2}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return parsed <= max ? parsed : undefined;
};

/** Presentation only: recognize a small grammar, never calculate a firing. */
export function formatCronSchedule(expression?: string, timezone?: string): string {
  const normalized = expression?.trim().replace(/\s+/gu, " ");
  if (!normalized) return "Schedule unavailable";
  const zone = timezone?.trim() || "UTC";
  const fallback = `${normalized} (${zone})`;
  const fields = normalized.split(" ");
  if (fields.length !== 5) return fallback;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  if (day !== "*" || month !== "*") return fallback;
  if (hour === "*" && weekday === "*") {
    if (minute === "*") return "Every minute";
    if (minute.startsWith("*/")) {
      const step = integer(minute.slice(2), 59);
      if (step !== undefined && step > 0 && 60 % step === 0) {
        return step === 1 ? "Every minute" : `Every ${step} minutes`;
      }
      return fallback;
    }
  }
  const minutes = integer(minute, 59);
  if (minutes === undefined) return fallback;
  const paddedMinute = String(minutes).padStart(2, "0");
  if (hour === "*" && weekday === "*") return `Every hour at :${paddedMinute} (${zone})`;
  const hours = integer(hour, 23);
  if (hours === undefined) return fallback;
  const time = `${String(hours).padStart(2, "0")}:${paddedMinute} (${zone})`;
  if (weekday === "*") return `Every day at ${time}`;
  if (weekday === "1-5") return `Weekdays at ${time}`;
  const dayIndex = integer(weekday, 7);
  return dayIndex === undefined ? fallback : `Every ${WEEKDAYS[dayIndex]} at ${time}`;
}
