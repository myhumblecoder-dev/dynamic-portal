#!/usr/bin/env bash
# Sign in to the hub's MCP endpoint once, before an MCP host needs it.
#
# Claude Desktop tears down an MCP server that has not finished `initialize`
# within its startup timeout, and respawns it. mcp-remote opens a browser on
# every start, so an interactive login — which no human completes inside that
# window — produces a sign-in tab per respawn rather than one login: three or
# four tabs, none of which can succeed, because each new process invalidates the
# previous one's PKCE verifier.
#
# Running the same bridge by hand first removes the race. Nothing is waiting on
# this process, so the browser can sit open as long as it takes; the token lands
# in ~/.mcp-auth, and every instance Desktop later spawns finds it and connects
# in milliseconds.
#
# Usage: scripts/mcp-login.sh [url] [callback-port]
set -euo pipefail

URL="${1:-http://localhost:3000/api/mcp}"
PORT="${2:-47110}"
VERSION="mcp-remote@0.8.3"   # keep in step with claude_desktop_config.json

if pgrep -f "node.*mcp-remote" >/dev/null 2>&1; then
  echo "A mcp-remote process is already running (probably Claude Desktop)." >&2
  echo "Quit Claude Desktop first, or its instance will race this one." >&2
  exit 1
fi

echo "Signing in to $URL"
echo "A browser will open. Log in, then this exits on its own."
echo

# The bridge speaks MCP on stdin/stdout. Feeding it one initialize request and
# closing stdin is enough: it will not reach the request until authorization has
# completed, so a reply means the token is written and cached.
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-login","version":"1.0.0"}}}' \
  | npx -y "$VERSION" "$URL" "$PORT" >/tmp/mcp-login-out.json 2>/tmp/mcp-login-err.log || true

if grep -q '"serverInfo"' /tmp/mcp-login-out.json 2>/dev/null; then
  echo "Signed in. Token cached in ~/.mcp-auth."
  echo "Start Claude Desktop now — it will connect without opening a browser."
else
  echo "Sign-in did not complete. Last lines from the bridge:" >&2
  tail -15 /tmp/mcp-login-err.log >&2
  exit 1
fi
