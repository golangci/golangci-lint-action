#!/bin/bash

echo 'golangci-lint-action: start'
echo " flags:  ${INPUT_FLAGS}"
echo " format: ${INPUT_FORMAT}"

cd "${GITHUB_WORKSPACE}/${INPUT_DIRECTORY}" || exit 1

# shellcheck disable=SC2086
golangci-lint run --out-format ${INPUT_FORMAT} ${INPUT_FLAGS}
