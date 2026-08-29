/**
 * A conversation's age, at the precision a sidebar row can use: recency matters
 * for the last week, and after that only the date does. Shared so the
 * conversation list and its search results cannot drift apart.
 */
export const relativeTime = (date: string): string => {
  const elapsed = Math.max(0, Date.now() - Date.parse(date));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  const days = Math.floor(hours / 24);
  return days < 7
    ? `${String(days)}d`
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(date));
};
