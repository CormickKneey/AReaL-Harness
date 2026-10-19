[中文](CHANGELOG.md) | **English**

# Changelog

## Unreleased

- CLI entry updates retain complete old packages and keep running backends intact. Concurrent installers are excluded; download, validation and switch failures preserve installations and user data.
- CLI installation verifies the program version and reports PATH conflicts. Preview CLI builds can upgrade to the matching formal version.
- GUI update-check errors are visible. Native validation timeouts keep the backend running; unknown backend-stop results cannot trigger repeated installation.
- Back up configuration and history before upgrading. GUI previews require manual installation; older versions may not read newer data formats.

Installation, upgrade and verification commands: [CLI guide](docs/guides/installation.en.md) and [GUI guide](clients/gui/README.en.md#installation-and-updates).
