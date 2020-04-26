#!/bin/bash

echo 'golangci-lint-action: start'

cd "${GITHUB_WORKSPACE}/${DIRECTORY}" || exit 1

# shellcheck disable=SC2086
golangci-lint run --out-format ${FORMAT} ${FLAGS}
