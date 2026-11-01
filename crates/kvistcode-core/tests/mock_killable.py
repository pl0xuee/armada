"""mock_modes.py (normal) that first records its pid in ./agent.pid so a test can kill it."""
import os, sys
with open("agent.pid.tmp", "w") as f:
    f.write(str(os.getpid()))
os.replace("agent.pid.tmp", "agent.pid")
here = os.path.dirname(os.path.abspath(__file__))
sys.argv = [os.path.join(here, "mock_modes.py"), "normal"]
exec(compile(open(sys.argv[0]).read(), sys.argv[0], "exec"))
