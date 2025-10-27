#!/bin/bash

set -euo pipefail

if [[ "${BUILDKITE_SOURCE}" != "webhook" ]]; then
  echo "Not a webhook trigger, exiting"
  exit 0
fi

echo "--- :package: Installing dependencies"
npm install

echo "--- :incoming_envelope: Routing webhook event"
echo "Trigger ID: ${BUILDKITE_TRIGGER_ID}"

case "${BUILDKITE_TRIGGER_ID}" in
  "${FIX_BUILD_BUILDKITE_TRIGGER_ID}")
    npm run fix-build:trigger:buildkite
    ;;

  "${FIX_BUILD_GITHUB_TRIGGER_ID}")
    npm run fix-build:trigger:github
    ;;

  "${COMPLETE_TASK_TRIGGER_ID}")
    npm run complete-task:trigger:linear
    ;;

  "${ANALYZE_REQUEST_TRIGGER_ID}")
    ./scripts/analyze-request/trigger-linear.sh
    ;;

  "${FIX_BUG_TRIGGER_ID}")
    ./scripts/fix-bug/trigger-bugsnag.sh
    ;;

  *)
    echo "No event processor configured for this trigger"
    exit 0
    ;;
esac
