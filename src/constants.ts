export enum Inputs {
  Key = "key",
  Path = "path",
  RestoreKeys = "restore-keys",
}

export enum State {
  CachePrimaryKey = "CACHE_KEY",
  CacheMatchedKey = "CACHE_RESULT",
}

export enum Events {
  Key = "GITHUB_EVENT_NAME",
  Push = "push",
  PullRequest = "pull_request",
}

export enum Env {
  LintPath = "GOLANGCI_LINT_ACTION_LINT_PATH",
  PatchPath = "GOLANGCI_LINT_ACTION_PATCH_PATH",
  CheckRunIdent = "GOLANGCI_LINT_ACTION_CHECK_RUN_IDENT",
}

export const RefKey = "GITHUB_REF"
