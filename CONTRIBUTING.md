## How to contribute

### Did you find a bug?

* **Ensure the bug was not already reported** by searching on GitHub under [Issues](https://github.com/golangci/golangci-lint-action/issues).

* If you're unable to find an open issue addressing the problem, [open a new one](https://github.com/golangci/golangci-lint-action/issues/new).
  Be sure to include a **title and clear description**, as much relevant information as possible,
  and a **code sample** or an **executable test case** demonstrating the expected behavior that is not occurring.

* **Do not open up a GitHub issue if the bug is a security vulnerability**,
  and instead to refer to our [security policy](https://github.com/golangci/golangci-lint-action?tab=security-ov-file).

### Do you intend to add a new feature or change an existing one?

* Suggest your change inside an [issue](https://github.com/golangci/golangci-lint-action/issues).

* Do not open a pull request on GitHub until you have collected positive feedback about the change.

### Did you write a patch that fixes a bug?

* Open a new GitHub pull request with the patch.

* Ensure the PR description clearly describes the problem and solution.
  Include the relevant issue number if applicable.

## Development of this action

1. Install [act](https://github.com/nektos/act#installation)
2. Make a symlink for `act` to work properly: `ln -s . golangci-lint-action`
3. Install dependencies: `npm install`
4. Build: `npm run build`
5. Run `npm run local` after any change to test it

### Testing custom plugins

To test the custom plugin support:

1. Create a `.custom-gcl.yml` file in one of the sample directories (e.g., `sample-go-mod/.custom-gcl.yml`)
2. Add a plugin configuration following the [golangci-lint plugin documentation](https://golangci-lint.run/plugins/module-plugins/)
3. Update the `.golangci.yml` file to enable the custom linter
4. Run the action and verify that it builds and uses the custom binary

### Releases

```bash
npm version <major | minor | patch> -m "Upgrade to %s"
```

- https://docs.npmjs.com/cli/v11/commands/npm-version

The "major tag" (ex: `v6`) should be deleted and then recreated manually.
