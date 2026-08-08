#!/usr/bin/env node
/**
 * xrlf-server CLI entrypoint
 *
 * Usage:
 *   npx xrlf-server
 *   npx xrlf-server --upstream http://localhost:1234 --port 8300
 *   npx xrlf-server --config ./my-config.json
 */

'use strict';

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

const pkg = require('../package.json');

const program = new Command();

program
    .name('xrlf-server')
    .description('XRLF Protocol — Foveated memory proxy with cognitive steering for any local LLM')
    .version(pkg.version)
    .option('-u, --upstream <url>',   'Upstream LLM base URL (e.g. http://localhost:1234 for LM Studio)', '')
    .option('-p, --port <number>',    'Proxy port to listen on', '8300')
    .option('-w, --workspace <id>',   'Workspace/project ID (scopes memory)', '')
    .option('-m, --mode <mode>',      'Workspace mode: personal | work', '')
    .option('-c, --config <path>',    'Path to a custom config.json', '')
    .option('-i, --identity <name>',  'AI identity name (e.g. Aria)', '')
    .option('    --user <name>',      'User name', '')
    .parse(process.argv);

const opts = program.opts();

// Build config override from CLI args
const overrides = {};
if (opts.upstream)   overrides.upstream_url   = opts.upstream;
if (opts.port)       overrides.proxy_port      = parseInt(opts.port, 10);
if (opts.workspace)  overrides.workspace_id    = opts.workspace;
if (opts.mode)       overrides.workspace_mode  = opts.mode;
if (opts.identity)   overrides.identity_name   = opts.identity;
if (opts.user)       overrides.user_name        = opts.user;

// If a custom config path was given, merge it in
if (opts.config) {
    const customPath = path.resolve(opts.config);
    if (!fs.existsSync(customPath)) {
        console.error(`Config file not found: ${customPath}`);
        process.exit(1);
    }
    const custom = JSON.parse(fs.readFileSync(customPath, 'utf8'));
    Object.assign(overrides, custom);
}

// Write overrides to a temp env so server.js can pick them up
// (server.js reads config on require, so we patch the default config file path via env)
process.env.FOVEATED_OVERRIDES = JSON.stringify(overrides);

// Patch loadConfig in server.js by setting env vars before require
// Simple approach: pass as process.env keys
for (const [k, v] of Object.entries(overrides)) {
    process.env[`FM_${k.toUpperCase()}`] = String(v);
}

// Now start the server (inherits overrides via env)
require('../server');
