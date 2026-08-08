# Task: Fix PowerShell path errors in settings.html actions

## Steps
- [x] Read settings.html and server.js to understand root cause
- [x] Plan approved by user
- [ ] Add `resolvePwshPath()` function to server.js
- [ ] Replace hardcoded `PWSH` constant with auto-detecting resolver
- [ ] Verify no other hardcoded PowerShell paths remain
