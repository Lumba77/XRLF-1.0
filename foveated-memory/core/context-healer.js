/**
 * ═══════════════════════════════════════════════════════
 * CONTEXT HEALER — Self-Healing Context Budget Manager
 * ═══════════════════════════════════════════════════════
 *
 * Detects upstream failures caused by context overflow and
 * auto-adjusts the context budget to keep the proxy alive.
 *
 * Lifecycle:
 *   1. DETECT — upstream returns empty, errors, or times out
 *   2. DIAGNOSE — was it a context overflow? (pattern matching)
 *   3. SELF-ADJUST — temporarily lower the context budget
 *   4. RETRY — re-send with reduced context
 *   5. WARN — inject a structured warning into the response
 *   6. AUTO-RESTORE — gradually raise budget back on success
 *
 * Budget is a floating value between MIN_BUDGET and MAX_BUDGET.
 * On failure: budget *= BACKOFF_FACTOR (aggressive shrink)
 * On success: budget += RECOVERY_STEP (gradual restore)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const MAX_BUDGET_CHARS  = parseInt(process.env.LUMAX_CTX_MAX_CHARS   || '50000', 10);
const MIN_BUDGET_CHARS  = parseInt(process.env.LUMAX_CTX_MIN_CHARS   || '4000',  10);
const BACKOFF_FACTOR    = parseFloat(process.env.LUMAX_CTX_BACKOFF   || '0.5');    // halve on failure
const RECOVERY_STEP     = parseInt(process.env.LUMAX_CTX_RECOVERY     || '2000', 10); // +2K chars on success
const MAX_RETRIES       = parseInt(process.env.LUMAX_CTX_MAX_RETRIES || '3',     10);
const COOLDOWN_MS       = parseInt(process.env.LUMAX_CTX_COOLDOWN     || '30000', 10); // 30s before recovery

// ── State ───────────────────────────────────────────────────────────────────
let currentBudget  = MAX_BUDGET_CHARS;
let lastFailureAt  = 0;
let consecutiveOk  = 0;
let totalShrinks   = 0;
let totalRestores  = 0;
const failureLog   = []; // ring buffer of last 20 failures

// ── Upstream error patterns that indicate context overflow ──────────────────
const CTX_OVERFLOW_PATTERNS = [
    /context.{0,20}(?:too.{0,10}long|overflow|exceed|limit)/i,
    /maximum.{0,20}(?:context|token|length)/i,
    /(?:token|context).{0,20}(?:limit|budget|window).{0,20}exceeded/i,
    /reduce.{0,20}(?:context|input|message).{0,20}(?:length|size)/i,
    /input.{0,20}too.{0,10}(?:long|large)/i,
    /(?:413|400|429).{0,30}(?:payload|entity|request).{0,20}(?:too|large)/i,
    /out.{0,5}of.{0,5}memory/i,
    /OOM/i,
    /CUDA.{0,10}out.{0,5}of.{0,5}memory/i,
];

// ── Upstream status codes that suggest context overflow ─────────────────────
const CTX_OVERFLOW_CODES = new Set([400, 413, 429, 500, 502, 503]);

/**
 * Check if an upstream error looks like a context overflow.
 */
function isContextOverflow(statusCode, errorText) {
    if (statusCode && CTX_OVERFLOW_CODES.has(statusCode)) {
        // Check text for overflow patterns
        if (errorText && CTX_OVERFLOW_PATTERNS.some(p => p.test(errorText))) {
            return true;
        }
        // 413 is always context overflow
        if (statusCode === 413) return true;
        // 500/502/503 with empty body often means OOM
        if ([500, 502, 503].includes(statusCode) && (!errorText || errorText.trim().length < 50)) {
            return true;
        }
    }
    return false;
}

/**
 * Check if an empty/truncated response looks like context overflow.
 */
function isEmptyResponseOverflow(fullText, statusCode) {
    // Empty response from upstream that returned 200 = model crashed mid-generation
    if ((!fullText || fullText.trim().length === 0) && statusCode === 200) {
        return true;
    }
    // Very short truncated response (< 10 chars) from a large prompt
    if (fullText && fullText.trim().length < 10 && statusCode === 200) {
        return true;
    }
    return false;
}

/**
 * Get the current context budget (chars).
 */
function getBudget() {
    return currentBudget;
}

/**
 * Get full healer state for health endpoint.
 */
function getState() {
    return {
        currentBudget,
        maxBudget: MAX_BUDGET_CHARS,
        minBudget: MIN_BUDGET_CHARS,
        lastFailureAt: lastFailureAt ? new Date(lastFailureAt).toISOString() : null,
        consecutiveOk,
        totalShrinks,
        totalRestores,
        cooldownActive: (Date.now() - lastFailureAt) < COOLDOWN_MS,
        recentFailures: failureLog.slice(-5),
    };
}

/**
 * Called when upstream succeeds. Gradually restores budget.
 */
function onSuccess() {
    consecutiveOk++;
    
    // Only recover after cooldown period
    if (Date.now() - lastFailureAt < COOLDOWN_MS) {
        return;
    }
    
    // Gradual recovery: step up toward MAX_BUDGET
    if (currentBudget < MAX_BUDGET_CHARS && consecutiveOk >= 3) {
        const prev = currentBudget;
        currentBudget = Math.min(MAX_BUDGET_CHARS, currentBudget + RECOVERY_STEP);
        totalRestores++;
        console.log(`[ContextHealer] 📈 Budget recovering: ${prev} → ${currentBudget} chars (${consecutiveOk} consecutive OK)`);
    }
}

/**
 * Called when upstream fails. Diagnoses and shrinks budget if needed.
 * @param {number} statusCode - HTTP status from upstream
 * @param {string} errorText - Error body from upstream
 * @param {string} fullText - Collected response text (for empty-response detection)
 * @returns {{ shrunk: boolean, newBudget: number, reason: string, shouldRetry: boolean }}
 */
function onFailure(statusCode, errorText, fullText) {
    const now = Date.now();
    lastFailureAt = now;
    consecutiveOk = 0;
    
    const isOverflow = isContextOverflow(statusCode, errorText) 
                     || isEmptyResponseOverflow(fullText, statusCode);
    
    failureLog.push({
        timestamp: new Date(now).toISOString(),
        statusCode,
        isOverflow,
        errorSnippet: (errorText || '').slice(0, 200),
        budgetBefore: currentBudget,
    });
    if (failureLog.length > 20) failureLog.shift();
    
    if (!isOverflow) {
        console.log(`[ContextHealer] ℹ️ Upstream failure (status=${statusCode}) — not context-related, no shrink`);
        return { shrunk: false, newBudget: currentBudget, reason: 'non-context failure', shouldRetry: false };
    }
    
    // Shrink budget
    const prev = currentBudget;
    currentBudget = Math.max(MIN_BUDGET_CHARS, Math.floor(currentBudget * BACKOFF_FACTOR));
    totalShrinks++;
    
    const reason = statusCode === 200
        ? `empty response (likely OOM/crash from ${prev} char context)`
        : `status ${statusCode}: ${(errorText || '').slice(0, 100)}`;
    
    console.log(`[ContextHealer] 🔻 Budget shrunk: ${prev} → ${currentBudget} chars (reason: ${reason})`);
    
    const shouldRetry = currentBudget >= MIN_BUDGET_CHARS;
    return { shrunk: true, newBudget: currentBudget, reason, shouldRetry };
}

/**
 * Apply the current budget to a messages array.
 * Truncates oldest non-system messages to fit within budget.
 * Injects a warning system message if truncation occurred.
 *
 * @param {Array} messages
 * @param {number} keepLast - minimum messages to keep at the end
 * @returns {{ messages: Array, truncated: boolean, originalChars: number, finalChars: number, warning: string|null }}
 */
function applyBudget(messages, keepLast = 4) {
    // Count chars
    let totalChars = 0;
    for (const m of messages) {
        totalChars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
    }
    
    if (totalChars <= currentBudget) {
        return { messages, truncated: false, originalChars: totalChars, finalChars: totalChars, warning: null };
    }
    
    // Separate system messages (preserved) from conversation
    const systemMsgs = messages.filter(m => m.role === 'system');
    const convoMsgs  = messages.filter(m => m.role !== 'system');
    
    const keep = Math.max(2, keepLast);
    let truncated = convoMsgs.slice(-keep);
    const dropped = convoMsgs.length - keep;
    
    // Preserve system messages
    const result = [...systemMsgs, ...truncated];
    
    let finalChars = 0;
    for (const m of result) {
        finalChars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
    }
    
    const warning = `⚠️ Context overflow protection: ${dropped} messages dropped (${totalChars} → ${finalChars} chars). Budget: ${currentBudget}/${MAX_BUDGET_CHARS} chars. The proxy auto-shrunk to prevent upstream crash. Budget will auto-restore after stable operation.`;
    
    console.log(`[ContextHealer] ✂️ Truncated ${dropped} messages (${totalChars} → ${finalChars} chars, budget=${currentBudget})`);
    
    return { messages: result, truncated: true, originalChars: totalChars, finalChars, warning };
}

/**
 * Inject a context warning into the response content.
 * Appends a non-intrusive note that the client can parse.
 */
function injectWarning(content, warning) {
    if (!warning) return content;
    // Add as an HTML-comment-style marker that's parseable but unobtrusive
    return content + `\n\n<!-- LUMAX_CTX_WARNING: ${warning} -->`;
}

/**
 * Force-reset the budget to max (for admin/debug use).
 */
function resetBudget() {
    const prev = currentBudget;
    currentBudget = MAX_BUDGET_CHARS;
    lastFailureAt = 0;
    consecutiveOk = 0;
    console.log(`[ContextHealer] 🔄 Budget force-reset: ${prev} → ${currentBudget}`);
    return { previous: prev, current: currentBudget };
}

/**
 * Manually set budget to a specific value (within min/max range).
 */
function setBudget(value) {
    const clamped = Math.max(MIN_BUDGET_CHARS, Math.min(MAX_BUDGET_CHARS, value));
    const prev = currentBudget;
    currentBudget = clamped;
    console.log(`[ContextHealer] 🎯 Budget manually set: ${prev} → ${currentBudget}`);
    return { previous: prev, current: currentBudget };
}

module.exports = {
    getBudget,
    getState,
    onSuccess,
    onFailure,
    applyBudget,
    injectWarning,
    resetBudget,
    setBudget,
    isContextOverflow,
    isEmptyResponseOverflow,
    MAX_BUDGET_CHARS,
    MIN_BUDGET_CHARS,
};
