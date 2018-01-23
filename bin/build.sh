#!/bin/sh
set -e

source ~/.nvm/nvm.sh
nvm install 9.4
nvm use 9.4

npm version $GO_PIPELINE_LABEL
npm install
npm test
npm publish
