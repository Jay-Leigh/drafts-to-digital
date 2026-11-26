#!/bin/bash
# Rebuild v1..v8, validate, unit-test, then e2e against a local n8n 2.29.7 (mock Upstash/Gemini/DoH, real Redis 7 on :6390).
# needs: redis-server on 6390 (e2e) and 6391 (Lua unit tests), node e2e/mock.js running, /etc/hosts alias "127.0.0.1 a.pub.test" (scrape tests)
cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"
node build.js && node validate.js | tail -1 || exit 1
for v in v1-additive v2-enforce v3-studio v4-jobs v5-flashcards v6-quiz; do cmp sth-workflow-$v.json $REPO/sth-workflow-$v.json || { echo "$v changed"; exit 1; }; done
cmp sth-workflow-v7-bundle.json $REPO/sth-workflow-v7-bundle.json || { echo 'v7 changed (it must stay byte-identical: rollback copy)'; exit 1; }
cp sth-workflow-v8-bundle.json $REPO/sth-workflow-v8-bundle.json
node tests/t-safefetch.js && node tests/t-other.js && node tests/t-studio.js && node tests/t-jobs.js || exit 1
# v5 unit tests, and the v3/v4 suites against v5 (everything v4 asserts must still hold)
node tests/t-flashcards.js || exit 1
STU_WF=sth-workflow-v5-flashcards.json node tests/t-studio.js || exit 1
JOBS_WF=sth-workflow-v5-flashcards.json node tests/t-jobs.js || exit 1
e2e/reload.sh v1-additive && node -r ./e2e/retry-fetch.js e2e/run-e2e.js v1 || exit 1
e2e/reload.sh v2-enforce && node -r ./e2e/retry-fetch.js e2e/run-e2e.js v2 || exit 1
# v3: everything v2 does must still pass (regression), then the Studio branch on a copy whose Gemini call timeout is 6 s
e2e/reload.sh v3-studio && node -r ./e2e/retry-fetch.js e2e/run-e2e.js v3 || exit 1
STUDIO_TEST_TIMEOUT_MS=6000 e2e/reload.sh v3-studio && node -r ./e2e/retry-fetch.js e2e/run-studio.js || exit 1
# v4: the same two suites against v4 (sync responses unchanged), then the job suites
e2e/reload.sh v4-jobs && node -r ./e2e/retry-fetch.js e2e/run-e2e.js v3 || exit 1
STUDIO_TEST_TIMEOUT_MS=6000 e2e/reload.sh v4-jobs && node -r ./e2e/retry-fetch.js e2e/run-studio.js || exit 1
STUDIO_TEST_TIMEOUT_MS=6000 JOB_TEST_TUTOR_TIMEOUT_MS=4000 e2e/reload.sh v4-jobs && node -r ./e2e/retry-fetch.js e2e/run-jobs.js main || exit 1
JOB_TEST_DEADLINES=tutor=8,studio_mindmap=10 JOB_TEST_GRACE=2 JOB_TEST_TUTOR_TIMEOUT_MS=30000 STUDIO_TEST_TIMEOUT_MS=30000 e2e/reload.sh v4-jobs && node -r ./e2e/retry-fetch.js e2e/run-jobs.js short || exit 1
# v5: the v3 / v4 e2e suites again (regression), then the flashcards suites (sync, job main, job short)
e2e/reload.sh v5-flashcards && node -r ./e2e/retry-fetch.js e2e/run-e2e.js v3 || exit 1
STUDIO_TEST_TIMEOUT_MS=6000 e2e/reload.sh v5-flashcards && node -r ./e2e/retry-fetch.js e2e/run-studio.js && node -r ./e2e/retry-fetch.js e2e/run-flashcards.js || exit 1
STUDIO_TEST_TIMEOUT_MS=6000 JOB_TEST_TUTOR_TIMEOUT_MS=4000 e2e/reload.sh v5-flashcards && WF_V5=1 node -r ./e2e/retry-fetch.js e2e/run-jobs.js main && node -r ./e2e/retry-fetch.js e2e/run-jobs-fc.js main || exit 1
JOB_TEST_DEADLINES=tutor=8,studio_mindmap=10,studio_flashcards=10 JOB_TEST_GRACE=2 JOB_TEST_TUTOR_TIMEOUT_MS=30000 STUDIO_TEST_TIMEOUT_MS=30000 e2e/reload.sh v5-flashcards && WF_V5=1 node -r ./e2e/retry-fetch.js e2e/run-jobs.js short && node -r ./e2e/retry-fetch.js e2e/run-jobs-fc.js short
# v6: the unit suites against v6 (everything v5 asserts must still hold), then the quiz unit tests
node tests/t-quiz.js || exit 1
FC_WF=sth-workflow-v6-quiz.json node tests/t-flashcards.js || exit 1
STU_WF=sth-workflow-v6-quiz.json node tests/t-studio.js || exit 1
JOBS_WF=sth-workflow-v6-quiz.json node tests/t-jobs.js || exit 1
# v6: the v3 / v4 / v5 e2e suites again (regression), then the quiz suites (sync, job main, job short)
e2e/reload.sh v6-quiz && node -r ./e2e/retry-fetch.js e2e/run-e2e.js v3 || exit 1
STUDIO_TEST_TIMEOUT_MS=6000 e2e/reload.sh v6-quiz && node -r ./e2e/retry-fetch.js e2e/run-studio.js && node -r ./e2e/retry-fetch.js e2e/run-flashcards.js && node -r ./e2e/retry-fetch.js e2e/run-quiz.js || exit 1
STUDIO_TEST_TIMEOUT_MS=6000 JOB_TEST_TUTOR_TIMEOUT_MS=4000 e2e/reload.sh v6-quiz && WF_V6=1 node -r ./e2e/retry-fetch.js e2e/run-jobs.js main && WF_V6=1 node -r ./e2e/retry-fetch.js e2e/run-jobs-fc.js main && node -r ./e2e/retry-fetch.js e2e/run-jobs-qz.js main || exit 1
JOB_TEST_DEADLINES=tutor=8,studio_mindmap=10,studio_flashcards=10,studio_quiz=10 JOB_TEST_GRACE=2 JOB_TEST_TUTOR_TIMEOUT_MS=30000 STUDIO_TEST_TIMEOUT_MS=30000 e2e/reload.sh v6-quiz && WF_V6=1 node -r ./e2e/retry-fetch.js e2e/run-jobs.js short && WF_V6=1 node -r ./e2e/retry-fetch.js e2e/run-jobs-fc.js short && node -r ./e2e/retry-fetch.js e2e/run-jobs-qz.js short
# v7 (WF_V6=1 WF_V7=1: the v6 expectations that v7 changes on purpose switch over: 15 sources, ten hello modes, J4 meter factor 8.33)
export WF_V6=1 WF_V7=1
node tests/t-v7.js || exit 1
e2e/reload.sh v7-bundle && node -r ./e2e/retry-fetch.js e2e/run-e2e.js v3 || exit 1
STUDIO_TEST_TIMEOUT_MS=6000 e2e/reload.sh v7-bundle && node -r ./e2e/retry-fetch.js e2e/run-studio.js && node -r ./e2e/retry-fetch.js e2e/run-flashcards.js && node -r ./e2e/retry-fetch.js e2e/run-quiz.js && node -r ./e2e/retry-fetch.js e2e/run-infographic.js && node -r ./e2e/retry-fetch.js e2e/run-slides.js && node -r ./e2e/retry-fetch.js e2e/run-digest.js || exit 1
STUDIO_TEST_TIMEOUT_MS=6000 JOB_TEST_TUTOR_TIMEOUT_MS=4000 e2e/reload.sh v7-bundle && node -r ./e2e/retry-fetch.js e2e/run-jobs.js main && node -r ./e2e/retry-fetch.js e2e/run-jobs-fc.js main && node -r ./e2e/retry-fetch.js e2e/run-jobs-qz.js main || exit 1
JOB_TEST_DEADLINES=tutor=8,studio_mindmap=10,studio_flashcards=10,studio_quiz=10 JOB_TEST_GRACE=2 JOB_TEST_TUTOR_TIMEOUT_MS=30000 STUDIO_TEST_TIMEOUT_MS=30000 e2e/reload.sh v7-bundle && node -r ./e2e/retry-fetch.js e2e/run-jobs.js short && node -r ./e2e/retry-fetch.js e2e/run-jobs-fc.js short && node -r ./e2e/retry-fetch.js e2e/run-jobs-qz.js short || exit 1
STUDIO_TEST_TIMEOUT_MS=6000 J4_TEST_TIMEOUT_MS=8000 JOB_TEST_TUTOR_TIMEOUT_MS=4000 e2e/reload.sh v7-bundle && node -r ./e2e/retry-fetch.js e2e/run-jobs-j4.js && node -r ./e2e/retry-fetch.js e2e/run-v7.js || exit 1
# v8 = v7 + token renewal, auth epoch, job claim / collected, hello v 8. Unit suites first (auth / renewal rules, claim / ack Lua on real Redis, the extra-origin build)
node tests/t-auth.js && node tests/t-v8.js || exit 1
# then every v7 e2e suite against v8 (nothing may regress; WF_V8 = the hello says 8), then the renewal / pickup suite, then the extra-origin build
export WF_V8=1
e2e/reload.sh v8-bundle && node -r ./e2e/retry-fetch.js e2e/run-e2e.js v3 || exit 1
STUDIO_TEST_TIMEOUT_MS=6000 e2e/reload.sh v8-bundle && node -r ./e2e/retry-fetch.js e2e/run-studio.js && node -r ./e2e/retry-fetch.js e2e/run-flashcards.js && node -r ./e2e/retry-fetch.js e2e/run-quiz.js && node -r ./e2e/retry-fetch.js e2e/run-infographic.js && node -r ./e2e/retry-fetch.js e2e/run-slides.js && node -r ./e2e/retry-fetch.js e2e/run-digest.js || exit 1
STUDIO_TEST_TIMEOUT_MS=6000 JOB_TEST_TUTOR_TIMEOUT_MS=4000 e2e/reload.sh v8-bundle && node -r ./e2e/retry-fetch.js e2e/run-jobs.js main && node -r ./e2e/retry-fetch.js e2e/run-jobs-fc.js main && node -r ./e2e/retry-fetch.js e2e/run-jobs-qz.js main && node -r ./e2e/retry-fetch.js e2e/run-renew.js || exit 1
JOB_TEST_DEADLINES=tutor=8,studio_mindmap=10,studio_flashcards=10,studio_quiz=10 JOB_TEST_GRACE=2 JOB_TEST_TUTOR_TIMEOUT_MS=30000 STUDIO_TEST_TIMEOUT_MS=30000 e2e/reload.sh v8-bundle && node -r ./e2e/retry-fetch.js e2e/run-jobs.js short && node -r ./e2e/retry-fetch.js e2e/run-jobs-fc.js short && node -r ./e2e/retry-fetch.js e2e/run-jobs-qz.js short || exit 1
STUDIO_TEST_TIMEOUT_MS=6000 J4_TEST_TIMEOUT_MS=8000 JOB_TEST_TUTOR_TIMEOUT_MS=4000 e2e/reload.sh v8-bundle && node -r ./e2e/retry-fetch.js e2e/run-jobs-j4.js && node -r ./e2e/retry-fetch.js e2e/run-v7.js || exit 1
# the extra-origin build (review B1): all five webhooks answer both origins; built into a temp folder, never into the repo
EXTRA_DIR="$(mktemp -d)"; STH_EXTRA_ORIGIN=https://school.example.org STH_OUT_DIR="$EXTRA_DIR" node build.js > /dev/null && WF_DIR="$EXTRA_DIR" e2e/reload.sh v8-bundle && node -r ./e2e/retry-fetch.js e2e/run-renew.js extra; rc=$?; rm -rf "$EXTRA_DIR"; exit $rc
