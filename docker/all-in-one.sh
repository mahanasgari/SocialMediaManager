#!/bin/sh
# Single-container entrypoint.
#
# Supervises api, worker and web in one process tree. If ANY child exits the
# container exits, so the orchestrator restarts the whole unit rather than
# leaving it running silently degraded — a container that is "up" while its
# worker is dead is worse than one that is down, because nothing alerts on it.
#
# Costs roughly 150-250MB extra RSS over separate containers, and loses the
# ability to scale the worker independently. Documented in the README rather
# than hidden.
set -eu

node apps/api/dist/main.js &                   API=$!
node apps/worker/dist/main.js &                WORKER=$!
node web-standalone/apps/web/server.js &       WEB=$!

# Signals are forwarded so each child runs its own graceful shutdown. Without
# the trap, tini kills this shell and the children are orphaned into a SIGKILL.
trap 'kill -TERM $API $WORKER $WEB 2>/dev/null || true' TERM INT

wait -n $API $WORKER $WEB
echo "all-in-one: a child process exited; shutting down the container" >&2
kill -TERM $API $WORKER $WEB 2>/dev/null || true

# Give the others a moment to drain before the container goes.
sleep 5
exit 1
