#!/bin/sh
set -e

npm version $GO_PIPELINE_LABEL
npm install
npm test
npm publish