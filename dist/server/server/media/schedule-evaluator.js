const MINUTES_END_OF_DAY_INPUT = 23 * 60 + 59;
function parseHhMmToMinutes(hhmm) {
    const [hStr, mStr] = hhmm.split(':');
    const h = Number(hStr);
    const m = Number(mStr);
    if (Number.isNaN(h) || Number.isNaN(m))
        return 0;
    return h * 60 + m;
}
export function isScheduleActiveAt(rules, now) {
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const todayDay = now.getDay(); // 0 (Sun) .. 6 (Sat)
    const yesterdayDay = (todayDay + 6) % 7;
    for (const rule of rules) {
        if (!rule.enabled || rule.daysOfWeek.length === 0)
            continue;
        const startMin = parseHhMmToMinutes(rule.startTime);
        let endMin = parseHhMmToMinutes(rule.endTime);
        if (startMin === endMin) {
            // 24-hour full day rule on selected days
            if (rule.daysOfWeek.includes(todayDay))
                return true;
            continue;
        }
        // 23:59 is the latest time the UI/API accepts, so treat it as "end of day" (24:00).
        // Otherwise a rule ending at 23:59 leaves a one-minute gap before the next day's 00:00 rule.
        if (endMin === MINUTES_END_OF_DAY_INPUT)
            endMin = 24 * 60;
        if (startMin < endMin) {
            // Standard same-day window (e.g., 08:00 -> 17:00)
            if (rule.daysOfWeek.includes(todayDay) &&
                currentMinutes >= startMin &&
                currentMinutes < endMin) {
                return true;
            }
        }
        else {
            // Overnight midnight-crossing window (e.g., 22:00 -> 06:00)
            if (currentMinutes >= startMin && rule.daysOfWeek.includes(todayDay)) {
                return true;
            }
            if (currentMinutes < endMin && rule.daysOfWeek.includes(yesterdayDay)) {
                return true;
            }
        }
    }
    return false;
}
