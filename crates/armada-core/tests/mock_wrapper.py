# Launcher that keeps the real agent as a child with inherited stdio (like npm/npx/codex.js/grok-bootstrap.js).
import subprocess, sys, os
p = subprocess.Popen([sys.executable] + sys.argv[1:])
sys.exit(p.wait())
