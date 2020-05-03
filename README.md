# golangci-lint-action

![docker image](https://github.com/golangci/golangci-lint-action/workflows/docker%20image/badge.svg)

Action that runs [golangci-lint](https://github.com/golangci/golangci-lint) and reports issues from linters.

You can put `.github/workflows/lint.yml` with following contents:

```yaml
name: golangci
on: [push]
jobs:
  golangci:
    name: lint
    runs-on: ubuntu-latest
    steps:
      - name: Check out code into the Go module directory
        uses: actions/checkout@v1
      - name: golangci-lint
        uses: golangci/golangci-lint-action@v0.0.2
        # with:
          # github_token: ${{ secrets.github_token }} #Optional Default: ''
          # flags: --timeout 30m (golang-ci-lint flags) #Optional Default: ''
          # directory: Working Directory #Optional Default: ''
          # format: Output format of issues #Optional Default: 'github-actions'
```

Based on [reviewdog action](https://github.com/reviewdog/action-golangci-lint).
