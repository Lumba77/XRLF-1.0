/**
 * ═══════════════════════════════════════════════════════
 * SMART ROUTER — Middleman-Based Message Routing
 * ═══════════════════════════════════════════════════════
 *
 * Routes messages through a middleman model for intelligent
 * compression and context management before sending to upstream.
 *
 * This module was missing, causing crashes when XRLF_REPO_ENABLED=true.
 */

'use strict';

const fetch = require('node-fetch');

/**
 * Route messages through the smart router for compression.
 *
 * @param {Array} messages - The messages array to route
 * @param {string} middleman - The middleman model name
 * @param {string} upstream - The upstream URL
 * @returns {Promise<Array>} - The routed/compressed messages
 */
async function smartRouteMessages(messages, middleman = 'qwen2.5-0.5b-instruct', upstream = 'http://127.0.0.1:7272') {
    // Skip routing if no messages or too few messages
    if (!messages || messages.length < 3) {
        return messages;
    }

    try {
        // Clean upstream URL
        const baseUrl = upstream.replace(/\/v1\/?$/, '');

        // Build routing prompt for the middleman
        const routingPrompt = buildRoutingPrompt(messages);

        // Call the middleman model
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: middleman,
                messages: [
                    { role: 'system', content: 'You are a message routing assistant. Analyze the conversation and output a JSON array of message indices to keep or compress.' },
                    { role: 'user', content: routingPrompt }
                ],
                max_tokens: 500,
                temperature: 0.1,
                stream: false
            }),
            signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
            console.warn('[SmartRouter] Middleman call failed:', response.status);
            return messages;
        }

        const data = await response.json();
        const routingDecision = data.choices?.[0]?.message?.content;

        // Parse routing decision and apply
        const routedMessages = applyRoutingDecision(messages, routingDecision);

        console.log(`[SmartRouter] Routed ${messages.length} → ${routedMessages.length} messages`);
        return routedMessages;

    } catch (error) {
        console.warn('[SmartRouter] Routing failed:', error.message);
        return messages; // Fallback to original messages
    }
}

/**
 * Build a prompt for the middleman to decide which messages to keep.
 */
function buildRoutingPrompt(messages) {
    const summary = messages.map((m, i) => {
        const preview = typeof m.content === 'string'
            ? m.content.slice(0, 100).replace(/\n/g, ' ')
            : JSON.stringify(m.content).slice(0, 100);
        return `[${i}] ${m.role}: ${preview}...`;
    }).join('\n');

    return `Analyze this conversation and decide which messages are essential:\n\n${summary}\n\nRespond with JSON: {"keep": [indices], "compress": [indices]}`;
}

/**
 * Apply the routing decision to filter/compress messages.
 */
function applyRoutingDecision(messages, decision) {
    try {
        // Try to parse JSON decision
        const parsed = JSON.parse(decision);

        if (parsed.keep && Array.isArray(parsed.keep)) {
            // Filter to only kept messages, preserving order
            const keepSet = new Set(parsed.keep);
            return messages.filter((_, i) => keepSet.has(i));
        }

        return messages;
    } catch {
        // If parsing fails, return original messages
        return messages;
    }
}

/**
 * Get router statistics.
 */
function getRouterStats() {
    return {
        enabled: true,
        module: 'smart-router',
        version: '1.0.0'
    };
}

module.exports = {
    smartRouteMessages,
    getRouterStats
};