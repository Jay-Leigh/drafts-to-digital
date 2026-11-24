#!/bin/bash
# Hard-kills n8n (simulates a crash / restart: in-flight runs are lost) and starts it again WITHOUT re-importing.
cd "$(dirname "$0")"; . ./env.sh
if [ -f n8n.pid ]; then P=$(cat n8n.pid); pkill -9 -P $P 2>/dev/null; kill -9 $P 2>/dev/null; fi
sleep 2
nohup $N8N start > n8n.log 2>&1 &
echo $! > n8n.pid
for i in $(seq 1 90); do sleep 1; if grep -q "Editor is now accessible" n8n.log; then echo "n8n up after ${i}s"; break; fi; done
