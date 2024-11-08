# golangci-lint-action

[![Build Status](https://github.com/golangci/golangci-lint-action/workflows/build-and-test/badge.svg)](https://github.com/golangci/golangci-lint-action/actions)

It's the official GitHub action for [golangci-lint](https://github.com/golangci/golangci-lint) from its authors.

The action runs [golangci-lint](https://github.com/golangci/golangci-lint) and reports issues from linters.

![GitHub Annotations](./static/annotations.png)

![Logs](./static/colored-line-number.png)

## Supporting Us

<!-- [![GitHub Sponsors](https://img.shields.io/badge/GitHub-Donate-blue?logo=github&style=for-the-badge)](https://github.com/sponsors/golangci) -->
[![Open Collective backers and sponsors](https://img.shields.io/badge/OpenCollective-Donate-blue?logo=opencollective&style=for-the-badge)](https://opencollective.com/golangci-lint)
[![Linter Authors](https://img.shields.io/badge/Linter_Authors-Donate-blue?style=for-the-badge)](https://golangci-lint.run/product/thanks/)

`golangci-lint` is a free and open-source project built by volunteers.

If you value it, consider supporting us, we appreciate it! :heart:

## How to use

We recommend running this action in a job separate from other jobs (`go test`, etc.)
because different jobs [run in parallel](https://help.github.com/en/actions/getting-started-with-github-actions/core-concepts-for-github-actions#job).

Add `.github/workflows/golangci-lint.yml` with the following contents:

<details>
<summary>Simple Example</summary>

```yaml
name: golangci-lint
on:
  push:
    branches:
      - main
      - master
  pull_request:

permissions:
  contents: read
  # Optional: allow read access to pull request. Use with `only-new-issues` option.
  # pull-requests: read

jobs:
  golangci:
    name: lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: stable
      - name: golangci-lint
        uses: golangci/golangci-lint-action@v6
        with:
          version: v1.60
```

</details>

<details>
<summary>Multiple OS Example</summary>

```yaml
name: golangci-lint
on:
  push:
    branches:
      - main
      - master
  pull_request:

permissions:
  contents: read
  # Optional: allow read access to pull request. Use with `only-new-issues` option.
  # pull-requests: read

jobs:
  golangci:
    strategy:
      matrix:
        go: [stable]
        os: [ubuntu-latest, macos-latest, windows-latest]
    name: lint
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: ${{ matrix.go }}
      - name: golangci-lint
        uses: golangci/golangci-lint-action@v6
        with:
          version: v1.60
```

You will also likely need to add the following `.gitattributes` file to ensure that line endings for Windows builds are properly formatted:

```.gitattributes
*.go text eol=lf
```

</details>

<details>
<summary>Go Workspace Example</summary>

```yaml
name: golangci-lint

on:
  pull_request:
  push:
    branches:
      - "main"
      - "master"

env:
  GO_VERSION: stable
  GOLANGCI_LINT_VERSION: v1.60

jobs:
  detect-modules:
    runs-on: ubuntu-latest
    outputs:
      modules: ${{ steps.set-modules.outputs.modules }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: ${{ env.GO_VERSION }}
      - id: set-modules
        run: echo "modules=$(go list -m -json | jq -s '.' | jq -c '[.[].Dir]')" >> $GITHUB_OUTPUT

  golangci-lint:
    needs: detect-modules
    runs-on: ubuntu-latest
    strategy:
      matrix:
        modules: ${{ fromJSON(needs.detect-modules.outputs.modules) }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: ${{ env.GO_VERSION }}
      - name: golangci-lint ${{ matrix.modules }}
        uses: golangci/golangci-lint-action@v6
        with:
          version: ${{ env.GOLANGCI_LINT_VERSION }}
          working-directory: ${{ matrix.modules }}
```

</details>

<details>
<summary>Go Workspace Example (Multiple OS)</summary>

```yaml
# ./.github/workflows/golangci-lint.yml
name: golangci-lint (multi OS)

on:
  pull_request:
  push:
    branches:
      - "main"
      - "master"

jobs:
  golangci-lint:
    strategy:
      matrix:
        go-version: [ stable, oldstable ]
        os: [ubuntu-latest, macos-latest, windows-latest]
    uses: ./.github/workflows/.golangci-lint-reusable.yml
    with:
      os: ${{ matrix.os }}
      go-version: ${{ matrix.go-version }}
      golangci-lint-version: v1.60
```

```yaml
# ./.github/workflows/.golangci-lint-reusable.yml
name: golangci-lint-reusable

on:
  workflow_call:
    inputs:
      os:
        description: 'OS'
        required: true
        type: string
      go-version:
        description: 'Go version'
        required: true
        type: string
        default: stable
      golangci-lint-version:
        description: 'Golangci-lint version'
        type: string
        default: 'v1.60'

jobs:
  detect-modules:
    runs-on: ${{ inputs.os }}
    outputs:
      modules: ${{ steps.set-modules.outputs.modules }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: ${{ inputs.go-version }}
      - id: set-modules
        shell: bash # require for Windows to be able to use $GITHUB_OUTPUT https://github.com/actions/runner/issues/2224
        run: echo "modules=$(go list -m -json | jq -s '.' | jq -c '[.[].Dir]')" >> $GITHUB_OUTPUT

  golangci-lint:
    needs: detect-modules
    runs-on: ${{ inputs.os }}
    strategy:
      matrix:
        modules: ${{ fromJSON(needs.detect-modules.outputs.modules) }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: ${{ inputs.go-version }}
      - name: golangci-lint ${{ matrix.modules }}
        uses: golangci/golangci-lint-action@v6
        with:
          version: ${{ inputs.golangci-lint-version }}
          working-directory: ${{ matrix.modules }}
```

You will also likely need to add the following `.gitattributes` file to ensure that line endings for Windows builds are properly formatted:

```.gitattributes
*.go text eol=lf
```

</details>

## Compatibility

* `v6.0.0+` removes `annotations` option, removes the default output format (`github-actions`).
* `v5.0.0+` removes `skip-pkg-cache` and `skip-build-cache` because the cache related to Go itself is already handled by `actions/setup-go`.
* `v4.0.0+` requires an explicit `actions/setup-go` installation step before using this action: `uses: actions/setup-go@v5`.
  The `skip-go-installation` option has been removed.
* `v2.0.0+` works with `golangci-lint` version >= `v1.28.3`
* `v1.2.2` is deprecated due to we forgot to change the minimum version of `golangci-lint` to `v1.28.3` ([issue](https://github.com/golangci/golangci-lint-action/issues/39))
* `v1.2.1` works with `golangci-lint` version >= `v1.14.0` ([issue](https://github.com/golangci/golangci-lint-action/issues/39))

## Options

### `version`

(required)

The version of golangci-lint to use.

When `install-mode` is:
* `binary` (default): the value can be v1.2 or v1.2.3 or `latest` to use the latest version.
* `goinstall`: the value can be v1.2.3, `latest`, or the hash of a commit.
* `none`: the value is ignored.

<details>
<summary>Example</summary>

```yml
uses: golangci/golangci-lint-action@v6
with:
  version: v1.58
  # ...
```

</details>

### `install-mode`

(optional)

The mode to install golangci-lint: it can be `binary`, `goinstall`, or `none`.

The default value is `binary`.

<details>
<summary>Example</summary>

```yml
uses: golangci/golangci-lint-action@v6
with:
  install-mode: "goinstall"
  # ...
```

</details>

### `github-token`

(optional)

When using `only-new-issues` option, the GitHub API is used, so a token is required.

By default, it uses the `github.token` from the action.

<details>
<summary>Example</summary>

```yml
uses: golangci/golangci-lint-action@v6
with:
  github-token: xxx
  # ...
```

</details>

### `only-new-issues`

(optional)

Show only new issues.

The default value is `false`.

* `pull_request` and `pull_request_target`: the action gets the diff of the PR content from the [GitHub API](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request) and use it with `--new-from-patch`.
* `push`: the action gets the diff of the push content (difference between commits before and after the push) from the [GitHub API](https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28#compare-two-commits) and use it with `--new-from-patch`.
* `merge_group`: the action gets the diff by using `--new-from-rev` option (relies on git).
  You should add the option `fetch-depth: 0` to `actions/checkout` step.

<details>
<summary>Example</summary>

```yml
uses: golangci/golangci-lint-action@v6
with:
  only-new-issues: true
  # ...
```

</details>

### `working-directory`

(optional)

Working directory, useful for monorepos.

<details>
<summary>Example</summary>

```yml
uses: golangci/golangci-lint-action@v6
with:
  working-directory: somedir
  # ...
```

</details>

### `args`

(optional)

golangci-lint command line arguments.

Note: By default, the `.golangci.yml` file should be at the root of the repository.
The location of the configuration file can be changed by using `--config=`

<details>
<summary>Example</summary>

```yml
uses: golangci/golangci-lint-action@v6
with:
  args: --timeout=30m --config=/my/path/.golangci.yml --issues-exit-code=0
  # ...
```

</details>

### `problem-matchers`

(optional)

Force the usage of the embedded problem matchers.

By default, the [problem matcher of Go (`actions/setup-go`)](https://github.com/actions/setup-go/blob/main/matchers.json) already handles the golangci-lint output (`colored-line-number`).

Works only with `colored-line-number` (the golangci-lint default).

https://golangci-lint.run/usage/configuration/#output-configuration

The default value is `false`.

<details>
<summary>Example</summary>

```yml
uses: golangci/golangci-lint-action@v6
with:
  problem-matchers: true
  # ...
```

</details>

### `skip-cache`

(optional)

If set to `true`, then all caching functionality will be completely disabled,
takes precedence over all other caching options.

The default value is `false`.

<details>
<summary>Example</summary>

```yml
uses: golangci/golangci-lint-action@v6
with:
  skip-cache: true
  # ...
```

</details>

### `skip-save-cache`

(optional)

If set to `true`, caches will not be saved, but they may still be restored, required `skip-cache: false`.

The default value is `false`.

<details>
<summary>Example</summary>

```yml
uses: golangci/golangci-lint-action@v6
with:
  skip-save-cache: true
  # ...
```

</details>

### `cache-invalidation-interval`

(optional)

Periodically invalidate the cache every `cache-invalidation-interval` days to ensure that outdated data is removed and fresh data is loaded.

The default value is `7`.

If set the number is `<= 0`, the cache will be always invalidate (Not recommended).

<details>
<summary>Example</summary>

```yml
uses: golangci/golangci-lint-action@v6
with:
  cache-invalidation-interval: 15
  # ...
```

</details>

## Annotations

Currently, GitHub parses the action's output and creates [annotations](https://github.blog/2018-12-14-introducing-check-runs-and-annotations/).

The restrictions of annotations are the following:

1. Currently, they don't support Markdown formatting (see the [feature request](https://github.community/t5/GitHub-API-Development-and/Checks-Ability-to-include-Markdown-in-line-annotations/m-p/56704))
2. They aren't shown in the list of comments.
   If you would like to have comments - please, up-vote [the issue](https://github.com/golangci/golangci-lint-action/issues/5).
3. The number of annotations is [limited](https://github.com/actions/toolkit/blob/main/docs/problem-matchers.md#limitations).

To enable annotations, you need to add the `checks` permission to your action.

```yaml annotate
permissions:
  # Required: allow read access to the content for analysis.
  contents: read
  # Optional: allow read access to pull request. Use with `only-new-issues` option.
  pull-requests: read
  # Optional: allow write access to checks to allow the action to annotate code in the PR.
  checks: write
```

## Performance

The action was implemented with performance in mind:

1. We cache data from golangci-lint analysis between builds by using [@actions/cache](https://github.com/actions/toolkit/tree/master/packages/cache). 
2. We don't use Docker because image pulling is slow.
3. We do as much as we can in parallel, e.g. we download cache, and golangci-lint binary in parallel.

For example, in a repository of [golangci-lint](https://github.com/golangci/golangci-lint) running this action without the cache takes 50s, but with cache takes 14s:
  * in parallel:
    * 4s to restore 50 MB of cache
    * 1s to find and install `golangci-lint`
  * 1s to run `golangci-lint` (it takes 35s without cache)

## Internals

We use JavaScript-based action.
We don't use Docker-based action because:

1. Docker pulling is slow currently
2. it's easier to use caching from [@actions/cache](https://github.com/actions/toolkit/tree/master/packages/cache)

We support different platforms, such as `ubuntu`, `macos`, and `windows` with `x32` and `x64` archs.

Inside our action, we perform 3 steps:

1. Setup environment running in parallel:
   * restore [cache](https://github.com/actions/cache) of previous analyses
   * fetch [action config](https://github.com/golangci/golangci-lint/blob/master/assets/github-action-config.json) and find the latest `golangci-lint` patch version for needed version
     (users of this action can specify only minor version of `golangci-lint`).
     After that install [golangci-lint](https://github.com/golangci/golangci-lint) using [@actions/tool-cache](https://github.com/actions/toolkit/tree/master/packages/tool-cache)
2. Run `golangci-lint` with specified by user `args`
3. Save cache for later builds

### Caching internals

1. We save and restore the following directory: `~/.cache/golangci-lint`.
2. The primary caching key looks like `golangci-lint.cache-{runner_os}-{working_directory}-{interval_number}-{go.mod_hash}`.
   Interval number ensures that we periodically invalidate our cache (every 7 days).
   `go.mod` hash ensures that we invalidate the cache early - as soon as dependencies have changed.
3. We use [restore keys](https://help.github.com/en/actions/configuring-and-managing-workflows/caching-dependencies-to-speed-up-workflows#matching-a-cache-key):
   `golangci-lint.cache-{runner_os}-{working_directory}-{interval_number}-`.
   GitHub matches keys by prefix if we have no exact match for the primary cache.

This scheme is basic and needs improvements. Pull requests and ideas are welcome.

## Development of this action

1. Install [act](https://github.com/nektos/act#installation)
2. Make a symlink for `act` to work properly: `ln -s . golangci-lint-action`
3. Install dependencies: `npm install`
4. Build: `npm run build`
5. Run `npm run local` after any change to test it
