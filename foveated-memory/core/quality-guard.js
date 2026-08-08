/**
 * ═══════════════════════════════════════════════════════
 * RESPONSE QUALITY GUARD
 * ═══════════════════════════════════════════════════════
 *
 * Detects and handles problematic LLM responses:
 *  1. Truncated responses (cut off mid-sentence)
 *  2. Infinite loops (repeated text patterns)
 *  3. Hallucination patterns (confident but nonsensical)
 *  4. Empty/near-empty responses
 *
 * When a quality issue is detected, the guard can:
 *  - Inject a warning into the response
 *  - Flag the response for retry
 *  - Log the issue for monitoring
 */

'use strict';

/**
 * Quality check result.
 * @typedef {object} QualityResult
 * @property {boolean} passed      - Whether the response passed all checks
 * @property {string[]} issues     - List of detected issues
 * @property {number}  qualityScore - 0-100 quality score
 * @property {string}  recommendation - What to do about it
 */

/**
 * Run all quality checks on a response.
 * @param {string} text - The full response text
 * @param {object} opts  - Options
 * @param {number} opts.minLength - Minimum acceptable response length (default 10)
 * @param {number} opts.maxRepeatRatio - Max allowed repetition ratio (default 0.4)
 * @returns {QualityResult}
 */
function checkQuality(text, opts = {}) {
    const minLength = opts.minLength || 10;
    const maxRepeatRatio = opts.maxRepeatRatio || 0.4;
    const issues = [];
    let qualityScore = 100;

    if (!text || typeof text !== 'string') {
        return {
            passed: false,
            issues: ['Empty or non-string response'],
            qualityScore: 0,
            recommendation: 'retry'
        };
    }

    const trimmed = text.trim();

    // ── 1. Empty / near-empty check ──────────────────────────────────────
    if (trimmed.length < minLength) {
        issues.push(`Response too short (${trimmed.length} chars, min ${minLength})`);
        qualityScore = Math.max(0, qualityScore - 50);
    }

    // ── 2. Truncation detection ──────────────────────────────────────────
    const truncationPatterns = [
        // Mid-word cutoff
        { pattern: /\b\w{1,2}$/, weight: 5, label: 'Mid-word cutoff' },
        // Unclosed code block
        { pattern: /```[^`]*$/, weight: 15, label: 'Unclosed code block' },
        // Unclosed parenthesis/bracket
        { pattern: /\([^)]*$/, weight: 8, label: 'Unclosed parenthesis' },
        { pattern: /\[[^\]]*$/, weight: 8, label: 'Unclosed bracket' },
        // Trailing ellipsis (model-generated, not intentional)
        { pattern: /\.\.\.\s*$/, weight: 3, label: 'Trailing ellipsis' },
        // Sentence cut off mid-word
        { pattern: /\s\w{1,3}$/, weight: 5, label: 'Sentence cut short' },
        // Unclosed XML/HTML tag
        { pattern: /<[^>]*$/, weight: 10, label: 'Unclosed XML/HTML tag' }
    ];

    for (const { pattern, weight, label } of truncationPatterns) {
        if (pattern.test(trimmed)) {
            issues.push(`Possible truncation: ${label}`);
            qualityScore = Math.max(0, qualityScore - weight);
        }
    }

    // ── 3. Infinite loop / repetition detection ─────────────────────────
    const repeatResult = detectRepetition(trimmed);
    if (repeatResult.isRepeating) {
        issues.push(`Repetition detected: ${repeatResult.pattern} (${Math.round(repeatResult.ratio * 100)}% repeated)`);
        qualityScore = Math.max(0, qualityScore - 30);
    }

    // ── 4. Hallucination pattern detection ───────────────────────────────
    const hallucinationScore = detectHallucinationPatterns(trimmed);
    if (hallucinationScore > 0) {
        issues.push(`Hallucination indicators: score ${hallucinationScore}/10`);
        qualityScore = Math.max(0, qualityScore - hallucinationScore * 5);
    }

    // ── 5. Gibberish / high entropy check ────────────────────────────────
    const entropyScore = checkEntropy(trimmed);
    if (entropyScore > 0.9) {
        issues.push('High entropy (possible gibberish)');
        qualityScore = Math.max(0, qualityScore - 20);
    }

    // ── 6. Excessive length check (runaway generation) ───────────────────
    if (trimmed.length > 50000) {
        issues.push(`Excessive response length (${trimmed.length} chars)`);
        qualityScore = Math.max(0, qualityScore - 10);
    }

    // ── Determine recommendation ─────────────────────────────────────────
    let recommendation = 'accept';
    if (qualityScore < 30) {
        recommendation = 'retry';
    } else if (qualityScore < 60) {
        recommendation = 'warn';
    }

    return {
        passed: qualityScore >= 60,
        issues,
        qualityScore: Math.round(qualityScore),
        recommendation
    };
}

/**
 * Detect repeated text patterns (infinite loop detection).
 * @param {string} text
 * @returns {{ isRepeating: boolean, pattern: string, ratio: number }}
 */
function detectRepetition(text) {
    if (text.length < 100) return { isRepeating: false, pattern: '', ratio: 0 };

    // Split into sentences
    const sentences = text.split(/[.!?\n]+/).filter(s => s.trim().length > 10);

    if (sentences.length < 3) return { isRepeating: false, pattern: '', ratio: 0 };

    // Count repeated sentences
    const seen = new Map();
    for (const s of sentences) {
        const normalized = s.trim().toLowerCase().slice(0, 80);
        seen.set(normalized, (seen.get(normalized) || 0) + 1);
    }

    let maxRepeat = 0;
    let repeatPattern = '';
    for (const [pattern, count] of seen) {
        if (count > maxRepeat) {
            maxRepeat = count;
            repeatPattern = pattern;
        }
    }

    const ratio = maxRepeat / sentences.length;
    return {
        isRepeating: ratio > 0.4 && maxRepeat >= 3,
        pattern: repeatPattern,
        ratio
    };
}

/**
 * Detect common hallucination patterns.
 * @param {string} text
 * @returns {number} Hallucination score 0-10
 */
function detectHallucinationPatterns(text) {
    let score = 0;

    // Overly confident but vague statements
    const vagueConfidence = [
        /I (am|certainly|definitely|absolutely|100%) sure that/i,
        /without (any|a) doubt/i,
        /I can (confirm|guarantee|assure you) that/i,
        /it is (absolutely|certainly|definitely) (true|correct|right) that/i
    ];
    for (const pattern of vagueConfidence) {
        if (pattern.test(text)) score += 1;
    }

    // Made-up URLs or file paths
    const fakeUrls = text.match(/https?:\/\/[^\s]{50,}/g);
    if (fakeUrls && fakeUrls.length > 2) score += 2;

    // Impossible version numbers
    const impossibleVersions = text.match(/v\d{3,}\.\d{3,}\.\d{3,}/g);
    if (impossibleVersions && impossibleVersions.length > 0) score += 1;

    // Self-contradiction markers
    const contradictions = [
        /on the other hand.*however.*but/i,
        /this is (correct|right).*actually.*(wrong|incorrect)/i,
        /I (was|am) (wrong|mistaken).*actually.*(right|correct)/i
    ];
    for (const pattern of contradictions) {
        if (pattern.test(text)) score += 1;
    }

    // Excessive hedging (indicates uncertainty / possible hallucination)
    const hedgingPhrases = text.match(/(?:I think|I believe|probably|maybe|perhaps|possibly|might be|could be)/gi);
    if (hedgingPhrases && hedgingPhrases.length > 5) score += 1;

    return Math.min(10, score);
}

/**
 * Check text entropy as a rough gibberish detector.
 * High entropy = random-looking text.
 * @param {string} text
 * @returns {number} Entropy ratio 0-1
 */
function checkEntropy(text) {
    if (text.length < 50) return 0;

    // Count unique character bigrams vs total bigrams
    const bigrams = new Map();
    let totalBigrams = 0;

    for (let i = 0; i < text.length - 1; i++) {
        const bigram = text.slice(i, i + 2);
        bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
        totalBigrams++;
    }

    if (totalBigrams === 0) return 0;

    // Shannon entropy on bigram distribution
    let entropy = 0;
    for (const count of bigrams.values()) {
        const p = count / totalBigrams;
        entropy -= p * Math.log2(p);
    }

    // Normalize: max entropy for 2-char bigrams is log2(256*256) ≈ 16
    // But natural language is much lower (~4-6)
    // Return ratio where >0.7 is suspicious
    const maxEntropy = Math.log2(bigrams.size);
    if (maxEntropy === 0) return 0;

    return Math.min(1, entropy / maxEntropy);
}

/**
 * Quick inline check — returns a warning string if quality is poor,
 * or empty string if quality is acceptable.
 * @param {string} text
 * @returns {string} Warning message or empty string
 */
function quickCheck(text) {
    const result = checkQuality(text);
    return result;
}

module.exports = { checkQuality, quickCheck, detectRepetition, detectHallucinationPatterns, checkEntropy };
