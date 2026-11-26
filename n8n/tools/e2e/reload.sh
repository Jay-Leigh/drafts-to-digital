#!/bin/bash
# usage: reload.sh v1-additive|v2-enforce|...   (WF_DIR=<folder> takes the workflow file from there instead of ..; used for the extra-origin build)
cd "$(dirname "$0")"; . ./env.sh
V=$1
if [ -f n8n.pid ]; then kill $(cat n8n.pid) 2>/dev/null; sleep 4; fi
node make-test-copy.js "${WF_DIR:-..}/sth-workflow-$V.json" test-$V.json 5801
$N8N import:credentials --input=creds.json >/dev/null 2>&1
$N8N import:workflow --input=test-$V.json > import.log 2>&1
$N8N publish:workflow --id=dT6ZBofuwIcBjAUS > publish.log 2>&1
nohup $N8N start > n8n.log 2>&1 &
echo $! > n8n.pid
for i in $(seq 1 90); do sleep 1; if grep -q "Editor is now accessible" n8n.log; then echo "n8n up after ${i}s"; break; fi; done
grep -i "activated workflow\|error" n8n.log | head -5
