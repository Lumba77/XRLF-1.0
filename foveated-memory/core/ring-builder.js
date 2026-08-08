/**
 * ═══════════════════════════════════════════════════════
 * RING BUILDER — Foveated Memory Ring Block Generator
 * ═══════════════════════════════════════════════════════
 *
 * Builds the 6-ring foveated memory block that gets injected
 * into every context window at session start.
 *
 * Ring 0 (Fovea)         — 6 raw messages, 0% compression
 * Ring 1 (Parafovea)     — recent session themes, ~50% compressed
 * Ring 2 (Near Periphery)— this week, ~75% compressed
 * Ring 3 (Mid Periphery) — this month, ~88% compressed
 * Ring 4 (Far Periphery) — older, ~95% compressed (hash refs)
 * Ring 5 (Outer Periphery)— deep past, ~98% compressed (atomic hashes)
 *
 * Total token budget: configurable, default ~400 tokens.
 */

'use strict';

const xrl = require('./xrl-compressor');

/**
 * Build the full foveated ring block string.
 *
 * @param {import('../memory/store').MemoryStore} store
 * @param {object} config - The proxy config object
 * @param {string} sessionId - Current session ID
 * @returns {string} The formatted ring block (ready for system prompt injection)
 */
async function buildRingBlock(store, config, sessionId) {
    const budgets = config.ring_budgets || {
        0: 180, 1: 80, 2: 60, 3: 40, 4: 25, 5: 15
    };

    const sections = [];

    try {
        // ── Task Board ───────────────────────────────────────────────────
        const tasks = await store.getTasks(sessionId);
        if (tasks && tasks.length > 0) {
            const pending = tasks.filter(t => !t.done);
            const done = tasks.filter(t => t.done);
            let taskBlock = `[ACTIVE TASK BOARD — ${pending.length} pending, ${done.length} completed]\n`;
            if (pending.length > 0) {
                taskBlock += pending.map(t => `- [ ] ${t.text}`).join('\n') + '\n';
            }
            if (done.length > 0) {
                taskBlock += done.map(t => `- [x] ${t.text}`).join('\n') + '\n';
            }
            taskBlock += `> To update, output \`- [x] task text\` in your response.`;
            sections.push(taskBlock);
        }

        // ── Ring 0 — Fovea: last N raw messages ──────────────────────────
        const foveaCount = config.fovea_message_count || 6;
        const foveaMessages = await store.getRecent(foveaCount);
        const foveaIds = new Set(foveaMessages.map(m => m._id));

        if (foveaMessages.length > 0) {
            const compressed = xrl.compress(foveaMessages, 0, budgets[0]);
            sections.push(`[FOVEA — last ${foveaMessages.length} messages, full resolution]\n${compressed}`);
        }

        // ── Ring 1 — Parafovea: messages from last 24h not in fovea ──────
        const day1Raw = await store.getByAge(1, 0, 30);
        const day1 = Array.isArray(day1Raw) ? day1Raw : [];
        const day1Filtered = day1.filter(m => !foveaIds.has(m._id));
        if (day1Filtered.length > 0) {
            const compressed = xrl.compress(day1Filtered, 1, budgets[1]);
            if (compressed.trim()) {
                sections.push(`[PARAFOVEA — last 24h, light compression]\n${compressed}`);
            }
        }

        // ── Ring 2 — Near Periphery: 1–7 days ago ────────────────────────
        const weekRaw = await store.getByAge(7, 1, 40);
        const week = Array.isArray(weekRaw) ? weekRaw : [];
        if (week.length > 0) {
            const compressed = xrl.compress(week, 2, budgets[2]);
            if (compressed.trim()) {
                sections.push(`[NEAR PERIPHERY — last week, medium compression]\n${compressed}`);
            }
        }

        // ── Ring 3 — Mid Periphery: 7–30 days ago ────────────────────────
        const monthRaw = await store.getByAge(30, 7, 40);
        const month = Array.isArray(monthRaw) ? monthRaw : [];
        if (month.length > 0) {
            const compressed = xrl.compress(month, 3, budgets[3]);
            if (compressed.trim()) {
                sections.push(`[MID PERIPHERY — last month, deep compression]\n${compressed}`);
            }
        }

        // ── Ring 4 — Far Periphery: 30–365 days ago ──────────────────────
        const yearRaw = await store.getByAge(365, 30, 30);
        const year = Array.isArray(yearRaw) ? yearRaw : [];
        if (year.length > 0) {
            const compressed = xrl.compress(year, 4, budgets[4]);
            if (compressed.trim()) {
                sections.push(`[FAR PERIPHERY — last year, ultra compression (hash refs)]\n${compressed}`);
            }
        }

        // ── Ring 5 — Outer Periphery: older than 1 year ──────────────────
        const deepRaw = await store.getByAge(9999, 365, 20);
        const deep = Array.isArray(deepRaw) ? deepRaw : [];
        if (deep.length > 0) {
            const compressed = xrl.compress(deep, 5, budgets[5]);
            if (compressed.trim()) {
                sections.push(`[OUTER PERIPHERY — deep past, atomic hashes only]\n${compressed}`);
            }
        }

    } catch (err) {
        console.error('[RingBuilder] Error building rings:', err.message);
    }

    if (sections.length === 0) return '';

    const block = [
        '━━━ FOVEATED MEMORY RINGS ━━━',
        ...sections,
        '━━━ END OF MEMORY RINGS ━━━'
    ].join('\n\n');

    return block;
}

/**
 * Remove ring entries matching specific XRL hashes or content snippets.
 * Used by the saccade engine to free tokens after a recall.
 *
 * @param {string} ringBlock - The current ring block string
 * @param {string[]} removePatterns - Strings/hashes to strip from the block
 * @returns {string} Updated ring block
 */
function removeFromRingBlock(ringBlock, removePatterns) {
    let updated = ringBlock;
    for (const pat of removePatterns) {
        // Remove any line containing this pattern
        const lines = updated.split('\n').filter(l => !l.includes(pat));
        updated = lines.join('\n');
    }
    return updated;
}

module.exports = { buildRingBlock, removeFromRingBlock };
