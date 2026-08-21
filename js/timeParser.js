/**
 * Trek YSWS - Time Spent Parser
 * 
 * Ported from Hack Club Forge's TimeSpentParser (lib/time_spent_parser.rb)
 * Converts flexible human-readable build duration inputs into normalized decimal hours.
 */

export class TrekTimeParser {
    /**
     * Parses time spent strings into decimal hours.
     * Tries patterns in order:
     * 1. Hours and minutes together (e.g. "6h35", "6 hours 35 minutes", "1h 30m")
     * 2. Colon format (e.g. "6:35", "1:30")
     * 3. Hours only (e.g. "6h", "6.5 hours", "2.25 hrs")
     * 4. Minutes only (e.g. "30 minutes", "45 mins", "90m")
     * 5. Plain numeric fallback (assumed as hours)
     * 
     * @param {string | number} input
     * @returns {number | null} Normalized decimal hours rounded to 2 decimal places, or null if unparseable
     */
    static parse(input) {
        if (typeof input === 'number') {
            return isNaN(input) || input < 0 ? null : Math.round(input * 100) / 100;
        }

        if (!input || typeof input !== 'string') {
            return null;
        }

        const value = input.trim().toLowerCase();
        if (value.length === 0) return null;

        // Pattern 1: Hours and minutes together (e.g. "6h35", "6 h 35 m", "1hour 30mins", "2 hours, 15 minutes", "1h30")
        const hmMatch = value.match(/^(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s*[,\s]*(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)?$/);
        if (hmMatch) {
            const hours = parseFloat(hmMatch[1]);
            const minutes = parseFloat(hmMatch[2]);
            return Math.round((hours + minutes / 60.0) * 100) / 100;
        }

        // Pattern 2: Colon format (e.g. "6:35", "1:30")
        const colonMatch = value.match(/^(\d+):(\d+)$/);
        if (colonMatch) {
            const hours = parseInt(colonMatch[1], 10);
            const minutes = parseInt(colonMatch[2], 10);
            return Math.round((hours + minutes / 60.0) * 100) / 100;
        }

        // Pattern 3: Hours only (e.g. "6h", "6.5 hours", "3 hrs", "2 hr")
        const hMatch = value.match(/^(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)$/);
        if (hMatch) {
            return Math.round(parseFloat(hMatch[1]) * 100) / 100;
        }

        // Pattern 4: Minutes only (e.g. "30 minutes", "45 mins", "90m", "45 min", "22m")
        const mMatch = value.match(/^(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)$/);
        if (mMatch) {
            const minutes = parseFloat(mMatch[1]);
            return Math.round((minutes / 60.0) * 100) / 100;
        }

        // Pattern 5: Plain number fallback (assumed as hours)
        if (/^\d+(?:\.\d+)?$/.test(value)) {
            return Math.round(parseFloat(value) * 100) / 100;
        }

        // Unrecognized format
        return null;
    }

    /**
     * Formats decimal hours into a friendly human string (e.g. 2.5 -> "2 Hours 30 Minutes", 0.37 -> "22 Minutes")
     * @param {number} decimalHours
     * @returns {string}
     */
    static formatFriendly(decimalHours) {
        if (!decimalHours || decimalHours <= 0) return '0 Hours';
        const hours = Math.floor(decimalHours);
        const minutes = Math.round((decimalHours - hours) * 60);

        if (hours > 0 && minutes > 0) {
            const hStr = hours === 1 ? '1 Hour' : `${hours} Hours`;
            const mStr = minutes === 1 ? '1 Minute' : `${minutes} Minutes`;
            return `${hStr} ${mStr}`;
        } else if (hours > 0) {
            return `${hours} ${hours === 1 ? 'Hour' : 'Hours'}`;
        } else {
            return `${minutes} ${minutes === 1 ? 'Minute' : 'Minutes'}`;
        }
    }
}
