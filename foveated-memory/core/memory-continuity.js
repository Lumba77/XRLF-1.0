/**
 * ═══════════════════════════════════════════════════════
 * MEMORY CONTINUITY SYSTEM
 * ═══════════════════════════════════════════════════════
 *
 * Saves and restores the active foveated ring state across
 * proxy restarts. When the proxy comes back online, it
 * immediately "remembers" what was being worked on.
 *
 * Architecture:
 *  - On each request, the ring block is saved to disk
 *  - On startup, the last ring block is loaded and pre-warmed
 *  - A "continuity snapshot" includes: ring block, active
 *    session ID, last N messages, and a timestamp
 *  - The system prompt is patched with a "resume context"
 *    so the model knows it's continuing, not starting fresh
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const CONTINUITY_DIR = path.join(__dirname, '..', 'memory_data', 'continuity');
const SNAPSHOT_FILE  = path.join(CONTINUITY_DIR, 'latest.json');
const HISTORY_DIR    = path.join(CONTINUITY_DIR, 'history');

// Ensure directories exist
if (!fs.existsSync(CONTINUITY_DIR)) fs.mkdirSync(CONTINUITY_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_DIR))   fs.mkdirSync(HISTORY_DIR,   { recursive: true });

/**
 * Save a continuity snapshot to disk.
 * @param {object} state
 * @param {string} state.ringBlock       - The current foveated ring block
 * @param {string} state.sessionId       - Active session ID
 * @param {string} state.workspaceId     - Active workspace ID
 * @param {Array}  state.recentMessages  - Last few messages (for context)
 * @param {string} state.model           - Model being used
 * @param {object} state.stats           - Optional stats (message count, etc.)
 */
function saveContinuity(state) {
    const snapshot = {
        timestamp:     new Date().toISOString(),
        ringBlock:     state.ringBlock || '',
        sessionId:     state.sessionId || 'default',
        workspaceId:   state.workspaceId || 'default',
        recentMessages: (state.recentMessages || []).slice(-6),
        model:         state.model || 'unknown',
        stats:         state.stats || {},
        version:       1
    };

    try {
        // Save latest snapshot
        fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));

        // Archive to history (keep last 50)
        const histFile = path.join(HISTORY_DIR,
            `${snapshot.timestamp.replace(/[:.]/g, '-')}_${snapshot.sessionId}.json`);
        fs.writeFileSync(histFile, JSON.stringify(snapshot, null, 2));

        // Prune history to 50 files
        const files = fs.readdirSync(HISTORY_DIR)
            .filter(f => f.endsWith('.json'))
            .sort()
            .reverse();
        for (const f of files.slice(50)) {
            fs.unlinkSync(path.join(HISTORY_DIR, f));
        }

        return snapshot;
    } catch (e) {
        console.error('[Continuity] Failed to save snapshot:', e.message);
        return null;
    }
}

/**
 * Load the most recent continuity snapshot.
 * @returns {object|null} The snapshot, or null if none exists
 */
function loadContinuity() {
    try {
        if (!fs.existsSync(SNAPSHOT_FILE)) return null;
        const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
        const snapshot = JSON.parse(raw);

        // Validate structure
        if (!snapshot.timestamp || !snapshot.sessionId) return null;

        const age = Date.now() - new Date(snapshot.timestamp).getTime();
        const ageMinutes = Math.round(age / 60000);

        console.log(`[Continuity] Loaded snapshot from ${ageMinutes}m ago (session: ${snapshot.sessionId})`);
        return snapshot;
    } catch (e) {
        console.error('[Continuity] Failed to load snapshot:', e.message);
        return null;
    }
}

/**
 * Build a "resume context" string for injection into the system prompt.
 * Tells the model it's continuing a previous session.
 * @param {object} snapshot - The continuity snapshot
 * @returns {string} Resume context block
 */
function buildResumeContext(snapshot) {
    if (!snapshot) return '';

    const age = Date.now() - new Date(snapshot.timestamp).getTime();
    const ageStr = age < 60000
        ? 'just now'
        : age < 3600000
            ? `${Math.round(age / 60000)} minutes ago`
            : age < 86400000
                ? `${Math.round(age / 3600000)} hours ago`
                : `${Math.round(age / 86400000)} days ago`;

    let ctx = `\n[SESSION CONTINUITY — Resuming from ${ageStr}]\n`;
    ctx += `Previous session: ${snapshot.sessionId}\n`;
    ctx += `Model: ${snapshot.model}\n`;

    if (snapshot.recentMessages && snapshot.recentMessages.length > 0) {
        ctx += `\nLast exchange before pause:\n`;
        for (const msg of snapshot.recentMessages.slice(-2)) {
            const preview = (msg.content || '').slice(0, 150);
            ctx += `  ${msg.role}: ${preview}${preview.length >= 150 ? '…' : ''}\n`;
        }
    }

    ctx += `\nYou are continuing a work session. Pick up where you left off.\n`;
    return ctx;
}

/**
 * Get continuity history (for the dashboard).
 * @param {number} limit - Max entries to return
 * @returns {Array} List of snapshot summaries
 */
function getHistory(limit = 20) {
    try {
        const files = fs.readdirSync(HISTORY_DIR)
            .filter(f => f.endsWith('.json'))
            .sort()
            .reverse()
            .slice(0, limit);

        return files.map(f => {
            try {
                const raw = fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8');
                const snap = JSON.parse(raw);
                return {
                    timestamp: snap.timestamp,
                    sessionId: snap.sessionId,
                    workspaceId: snap.workspaceId,
                    model: snap.model,
                    messageCount: snap.recentMessages?.length || 0,
                    ringBlockSize: snap.ringBlock?.length || 0
                };
            } catch (_) { return null; }
        }).filter(Boolean);
    } catch (e) {
        return [];
    }
}

/**
 * Clear all continuity data.
 */
function clearContinuity() {
    try {
        if (fs.existsSync(SNAPSHOT_FILE)) fs.unlinkSync(SNAPSHOT_FILE);
        const files = fs.readdirSync(HISTORY_DIR);
        for (const f of files) fs.unlinkSync(path.join(HISTORY_DIR, f));
        console.log('[Continuity] All continuity data cleared');
        return true;
    } catch (e) {
        console.error('[Continuity] Failed to clear:', e.message);
        return false;
    }
}

module.exports = {
    saveContinuity,
    loadContinuity,
    buildResumeContext,
    getHistory,
    clearContinuity
};
