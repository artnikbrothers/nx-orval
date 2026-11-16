# Security policy

## Supported versions

Security fixes go into the latest release.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Report it through GitHub private vulnerability reporting:

https://github.com/artnikbrothers/nx-orval/security/advisories/new

Include the affected version, what an attacker can do, and steps to reproduce. You can expect a first reply within a week.

## Scope

nx-orval loads and evaluates the `orval.config.*` files of the workspace it runs in, and runs the Orval CLI on them. That is by design: a workspace's own configs are trusted code. Reports about running untrusted configs are out of scope. Anything that makes the plugin read or write outside the workspace, run code from a config it was not asked to load, or leak environment values is in scope.
