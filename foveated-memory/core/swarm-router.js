'use strict';

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // Re-use the existing node-fetch dependency

class SwarmRouter {
    constructor(configPath) {
        this.configFile = path.resolve(configPath, 'swarm_nodes.json');
        this.nodes = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.configFile)) {
                const raw = fs.readFileSync(this.configFile, 'utf8');
                this.nodes = JSON.parse(raw);
            } else {
                // Default fallback to the standard upstream URL (e.g., LM Studio / Ollama)
                this.nodes = [
                    {
                        url: process.env.UPSTREAM_URL || 'http://127.0.0.1:1234/v1',
                        status: 'active',
                        capabilities: ['general', 'coding'],
                        vram: 8, // Approximate GB
                        weight: 1
                    }
                ];
                this.save();
            }
        } catch (e) {
            console.error('[SwarmRouter] Error loading swarm nodes:', e.message);
            this.nodes = [];
        }
    }

    save() {
        try {
            const dir = path.dirname(this.configFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.configFile, JSON.stringify(this.nodes, null, 2), 'utf8');
        } catch (e) {
            console.error('[SwarmRouter] Error saving swarm nodes:', e.message);
        }
    }

    registerNode(nodeUrl, capabilities = ['general'], vram = 8, weight = 1) {
        const existing = this.nodes.find(n => n.url === nodeUrl);
        if (existing) {
            existing.capabilities = capabilities;
            existing.vram = vram;
            existing.weight = weight;
            existing.status = 'active';
        } else {
            this.nodes.push({ url: nodeUrl, capabilities, vram, weight, status: 'active' });
        }
        this.save();
        return true;
    }

    /**
     * Highly simplified MoE routing:
     * - Returns the first active node with the specified capability.
     * - If no specific capability required, returns the active node with highest weight.
     */
    route(capability = 'general') {
        this.load(); // Hot-reload from disk

        const activeNodes = this.nodes.filter(n => n.status === 'active');
        if (activeNodes.length === 0) return null;

        const capableNodes = activeNodes.filter(n => n.capabilities.includes(capability));
        if (capableNodes.length > 0) {
            // Sort by weight descending
            capableNodes.sort((a, b) => b.weight - a.weight);
            return capableNodes[0].url;
        }
        
        // Fallback to highest weight node overall
        activeNodes.sort((a, b) => b.weight - a.weight);
        return activeNodes[0].url;
    }
    
    // Quick heuristic to guess the capability needed from the messages
    detectCapability(messages) {
        if (!messages || messages.length === 0) return 'general';
        const lastMsg = messages[messages.length - 1]?.content || '';
        if (typeof lastMsg === 'string') {
            if (/function|class|code|python|javascript|typescript|c\+\+|rust|html|css/i.test(lastMsg)) {
                return 'coding';
            }
        }
        return 'general';
    }
}

let instance = null;
function getSwarmRouter(configPath) {
    if (!instance) {
        instance = new SwarmRouter(configPath);
    }
    return instance;
}

module.exports = { getSwarmRouter, SwarmRouter };
