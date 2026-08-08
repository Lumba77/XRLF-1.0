# Foveated Memory Proxy 🧠

This tool provides an **OpenAI-compatible proxy server** that gives any LLM infinite, on-demand foveated memory using XRL Active Recall. 

By running this proxy on your system, you can instantly upgrade the memory architecture of **any local LLM engine** (LM Studio, Ollama, etc.) without needing to modify the model or the host application.

## System-Wide Installation & Usage

Because this proxy mimics the OpenAI API specification perfectly, it can act as a drop-in replacement for any application on your entire operating system that speaks to a local LLM.

### 1. Configure the Proxy
By default, the proxy runs on port `8200` and forwards requests to `http://127.0.0.1:7272` (your LM Studio instance).
If you need to change this, edit `config/default.json`.

### 2. Start the Proxy Server
Run the proxy locally via Node:
```powershell
cd Tools/foveated-memory
node server.js
```
*The proxy will spin up and announce it is listening on `http://localhost:8200`.*

### 3. Apply System-Wide (Or Repo-Wide)
To give a system the upgraded foveated memory, simply change its OpenAI Base URL to point to the proxy instead of LM Studio.

#### For the LUMAX Repo (Already Configured)
The `.env` file in the root of the LUMAX repository has been updated to route all local traffic through this proxy automatically:
```env
LUMAX_LOCAL_BASE_URL=http://127.0.0.1:8200/v1
```

#### For System-Wide Applications (Cline, Cursor, AutoGen, etc.)
Anywhere you configure a "Local Server" or "OpenAI API Base URL" in other applications on your system, change it from:
`http://localhost:7272/v1`
to:
`http://localhost:8200/v1`

Every request they make will now be intercepted, packed with the Foveated Ring memory context, and actively stored in the local SQLite database.

### 4. Application-Separated Memory (Workspaces)
If you are pointing multiple applications (e.g. your Coding AI, and Jen) at this single proxy, you don't want their memories bleeding together!

The proxy dynamically separates memory databases based on the **API Key** (Bearer Token) sent by the application.
*   If your Coding AI sends a request with `API Key = coding_bot`, the proxy creates and uses a memory folder at `./memory_data/coding_bot`.
*   If LUMAX sends a request with `API Key = jen`, the proxy creates and uses a memory folder at `./memory_data/jen`.

You don't need to configure anything. Just type a unique API Key into whatever app you are using, and the proxy will automatically spin up an isolated memory database for it on the fly!

## How It Works (The Foveated Architecture)
Instead of blindly appending the last 10 messages (the "simple tag style"), this proxy:
1. Intercepts the chat request.
2. Compresses older history using a 6-level gradient (Foveated Rings).
3. Injects the compressed context into the system prompt invisibly.
4. Detects `[recall: keywords]` tags in the model's output stream, pauses generation, searches the persistent TF-IDF database, and re-injects the retrieved memory back into the context.

All memory is persistently saved locally in `./memory_data`.
