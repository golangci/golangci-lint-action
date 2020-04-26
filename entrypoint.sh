#!/bin/bash

# shellcheck disable=SC2086
golangci-lint run --out-format github-actions ${FLAGS}
