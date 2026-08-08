'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class AuthManager {
    constructor(dbPath) {
        this.dbFile = path.resolve(dbPath, 'auth.json');
        this.data = {
            teams: {}, // teamId -> { name, created }
            tokens: {} // token -> { teamId, userId, role }
        };
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.dbFile)) {
                const raw = fs.readFileSync(this.dbFile, 'utf8');
                this.data = JSON.parse(raw);
            } else {
                this.save();
            }
        } catch (e) {
            console.error('[AuthManager] Error loading auth db:', e.message);
        }
    }

    save() {
        try {
            const dir = path.dirname(this.dbFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.dbFile, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (e) {
            console.error('[AuthManager] Error saving auth db:', e.message);
        }
    }

    createTeam(teamId, name) {
        if (!this.data.teams) this.data.teams = {};
        if (this.data.teams[teamId]) return false;
        
        this.data.teams[teamId] = {
            name: name || teamId,
            created: new Date().toISOString()
        };
        this.save();
        return true;
    }

    generateToken(teamId, userId, role = 'member') {
        if (!this.data.teams[teamId]) {
            throw new Error(`Team ${teamId} does not exist`);
        }
        
        // Generate a random token
        const token = `lmx_${crypto.randomBytes(16).toString('hex')}`;
        
        if (!this.data.tokens) this.data.tokens = {};
        this.data.tokens[token] = {
            teamId,
            userId,
            role,
            created: new Date().toISOString()
        };
        
        this.save();
        return token;
    }

    resolveToken(token) {
        // First check if it's a registered multi-user token
        if (this.data.tokens && this.data.tokens[token]) {
            return this.data.tokens[token];
        }
        
        // Try reloading from disk in case it was created by another process
        this.load();
        if (this.data.tokens && this.data.tokens[token]) {
            return this.data.tokens[token];
        }
        
        // Fallback for legacy / solo mode: the token IS the workspace ID.
        // We sanitize it to use as a folder name.
        if (token && token !== 'lm-studio') {
            const sanitized = token.replace(/[^a-zA-Z0-9_-]/g, '_');
            return {
                teamId: sanitized,
                userId: 'solo_user',
                role: 'admin',
                isLegacy: true
            };
        }
        
        // Default fallback
        return {
            teamId: 'default',
            userId: 'anonymous',
            role: 'guest',
            isLegacy: true
        };
    }
}

// Singleton instance for the server
let instance = null;
function getAuthManager(dbPath) {
    if (!instance) {
        instance = new AuthManager(dbPath);
    }
    return instance;
}

module.exports = { getAuthManager, AuthManager };
