# Security Policy

## Supported Versions

`codevis` is developed on `main`. Only the latest release receives fixes.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

Open an issue at `<repository-url>/issues` with the `security` label.

**Issues are public from the moment you file them.** There is no private
reporting channel for this project, so a report is a public disclosure. If you
have found something you believe should be coordinated rather than disclosed
immediately, say so in a minimal issue without the exploit details and a
maintainer will follow up.

Expect an initial response within a week. Accepted reports are fixed on `main`
and noted in the release that carries the fix; declined reports get an
explanation of why.

## Threat model

`codevis` is a local developer tool that reads a Git repository and serves the
result. Two properties are worth stating explicitly, because both are easy to
get wrong by accident:

- **`timeline.json` is sensitive.** It contains the analyzed repository's full
  commit history, including every author's name and email address. For a
  private repository, treat the file — and any server exposing it — as
  confidential.
- **`codevis serve` binds loopback by default.** Passing `--host 0.0.0.0` (or
  publishing the container port on all interfaces) exposes that data to your
  network with no authentication. That is an explicit opt-in, never a default.
- **Multi-project mode (the default `serve` behavior) has no authentication.**
  Anyone who can reach the port can register a project pointing at any local
  filesystem path the server process can read, or a git URL for the server to
  clone, and trigger an analyze run. Combining `--host 0.0.0.0` with this mode
  is a materially larger exposure than the old single-file server: a remote
  client can now cause the server to *read and clone*, not just serve a
  pre-existing file. Treat `--host 0.0.0.0` the same way regardless of mode —
  an explicit choice for a trusted network, never a default.

The frontend also resolves contributor avatars from Gravatar and the public
GitHub API, which sends commit-author email hashes and repository slugs to
those third parties. Set `?avatars=local` on the page URL to disable all
third-party avatar requests.

**Credentials embedded in a git URL are redacted before they can leave the
process.** Registering a project as `https://TOKEN@github.com/org/repo.git`
lets the server clone/fetch with that credential, but `redact_url()`
(`src/git_source.rs`) masks the userinfo segment (`https://***@github.com/...`)
everywhere the URL could otherwise surface: API responses (`Project::redacted()`
in `src/registry.rs`, applied at the HTTP boundary in `src/projects_api.rs`)
and `git` failure messages. The *unredacted* URL is still written to
`registry.json` on disk — re-cloning needs the real credential — so treat that
file with the same care as `timeline.json`.

## Scope

In scope: anything that lets a third party read repository data they should not
reach, or that turns analyzing an untrusted repository into code execution.

Out of scope: exposure that results from deliberately passing `--host 0.0.0.0`
on an untrusted network, and denial of service from analyzing a pathologically
large repository.
