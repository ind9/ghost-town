#!/bin/sh
set -e

source ~/.nvm/nvm.sh
nvm install 7.9
nvm use 7.9

npm version $GO_PIPELINE_LABEL
npm install
npm test
npm publish